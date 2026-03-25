import crypto from 'crypto';
import { promisify } from 'util';
import fs from 'fs-extra';
import path from 'path';

const scryptAsync = promisify(crypto.scrypt);

// --- Constants ---
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;          // 96 bits, recommended for GCM
const TAG_LENGTH = 16;         // 128-bit auth tag
const SALT_LENGTH = 32;        // 256-bit salt
const KEY_LENGTH = 32;         // 256 bits for AES-256
const SCRYPT_COST = 2 ** 14;   // N=16384 — fast but secure enough for passphrase KDF
const MAGIC = Buffer.from('MEMOIR01');  // 8-byte header for format versioning

// --- Key Derivation ---

/**
 * Derive a 256-bit key from a passphrase using scrypt (async, non-blocking).
 */
export async function deriveKey(passphrase, salt = null) {
  if (!salt) salt = crypto.randomBytes(SALT_LENGTH);
  const key = await scryptAsync(passphrase, salt, KEY_LENGTH, {
    N: SCRYPT_COST,
    r: 8,
    p: 1,
  });
  return { key, salt };
}

// --- Encrypt / Decrypt Buffers ---

/**
 * Encrypt a buffer with AES-256-GCM.
 * Output format: MEMOIR01 | salt (32) | iv (12) | authTag (16) | ciphertext
 */
export async function encryptBuffer(plaintext, passphrase) {
  const { key, salt } = await deriveKey(passphrase);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([MAGIC, salt, iv, tag, encrypted]);
}

/**
 * Decrypt a buffer. Throws on wrong passphrase or tampered data.
 */
export async function decryptBuffer(data, passphrase) {
  const magic = data.subarray(0, 8);
  if (!magic.equals(MAGIC)) {
    throw new Error('Not a memoir-encrypted file (bad header)');
  }

  let offset = 8;
  const salt = data.subarray(offset, offset + SALT_LENGTH);       offset += SALT_LENGTH;
  const iv = data.subarray(offset, offset + IV_LENGTH);           offset += IV_LENGTH;
  const tag = data.subarray(offset, offset + TAG_LENGTH);         offset += TAG_LENGTH;
  const ciphertext = data.subarray(offset);

  const { key } = await deriveKey(passphrase, salt);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// --- Directory-level encryption ---

/**
 * Encrypt all files in srcDir → destDir.
 * File names are HMAC-hashed (hidden). Manifest maps hashes → real paths.
 */
export async function encryptDirectory(srcDir, destDir, passphrase, spinner = null) {
  const startTime = Date.now();

  // Phase 1: Derive encryption key
  if (spinner) spinner.text = 'Deriving encryption key (scrypt)...';
  const { key, salt } = await deriveKey(passphrase);

  const dataDir = path.join(destDir, 'data');
  await fs.ensureDir(dataDir);

  // Phase 2: Index files
  if (spinner) spinner.text = 'Indexing files...';
  const fileList = [];
  async function index(dir, relBase = '') {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.join(relBase, entry.name);
      if (entry.isDirectory()) {
        await index(fullPath, relPath);
      } else {
        const stat = await fs.stat(fullPath);
        fileList.push({ fullPath, relPath, size: stat.size });
      }
    }
  }
  await index(srcDir);

  const totalFiles = fileList.length;
  const totalBytes = fileList.reduce((sum, f) => sum + f.size, 0);

  // Phase 3: Encrypt files
  const manifest = {};
  let count = 0;
  let bytesProcessed = 0;

  for (const { fullPath, relPath, size } of fileList) {
    const hashedName = crypto
      .createHmac('sha256', key)
      .update(relPath)
      .digest('hex')
      .slice(0, 24);

    const plaintext = await fs.readFile(fullPath);
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    await fs.writeFile(
      path.join(dataDir, `${hashedName}.enc`),
      Buffer.concat([iv, tag, encrypted])
    );

    manifest[hashedName] = relPath;
    count++;
    bytesProcessed += size;

    if (spinner) {
      const pct = Math.round((count / totalFiles) * 100);
      const sizeStr = formatBytes(bytesProcessed);
      const totalStr = formatBytes(totalBytes);
      spinner.text = `Encrypting (AES-256-GCM) ${count}/${totalFiles} files — ${sizeStr}/${totalStr} [${pct}%]`;
    }
  }

  // Phase 4: Encrypt manifest
  if (spinner) spinner.text = 'Encrypting file manifest...';
  const manifestJson = Buffer.from(JSON.stringify(manifest));
  const manifestEncrypted = await encryptBuffer(manifestJson, passphrase);
  await fs.writeFile(path.join(destDir, 'manifest.enc'), manifestEncrypted);

  // Salt is not secret — store it so decrypt can re-derive the same key
  await fs.writeFile(path.join(destDir, 'salt'), salt);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  if (spinner) spinner.text = `Encrypted ${count} files (${formatBytes(totalBytes)}) in ${elapsed}s`;

  return count;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Decrypt an encrypted directory back to plaintext.
 */
export async function decryptDirectory(encDir, destDir, passphrase, spinner = null) {
  const startTime = Date.now();

  // Phase 1: Decrypt manifest
  if (spinner) spinner.text = 'Decrypting file manifest...';
  const manifestData = await fs.readFile(path.join(encDir, 'manifest.enc'));
  const manifestJson = await decryptBuffer(manifestData, passphrase);
  const manifest = JSON.parse(manifestJson.toString('utf8'));

  // Phase 2: Derive key
  if (spinner) spinner.text = 'Deriving decryption key (scrypt)...';
  const salt = await fs.readFile(path.join(encDir, 'salt'));
  const { key } = await deriveKey(passphrase, salt);

  const dataDir = path.join(encDir, 'data');
  const totalFiles = Object.keys(manifest).length;
  let count = 0;
  let bytesProcessed = 0;

  // Phase 3: Decrypt files
  for (const [hashedName, relPath] of Object.entries(manifest)) {
    const encFilePath = path.join(dataDir, `${hashedName}.enc`);
    if (!(await fs.pathExists(encFilePath))) continue;

    const data = await fs.readFile(encFilePath);
    const iv = data.subarray(0, IV_LENGTH);
    const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = data.subarray(IV_LENGTH + TAG_LENGTH);

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    const outPath = path.join(destDir, relPath);
    await fs.ensureDir(path.dirname(outPath));
    await fs.writeFile(outPath, decrypted);
    count++;
    bytesProcessed += decrypted.length;

    if (spinner) {
      const pct = Math.round((count / totalFiles) * 100);
      spinner.text = `Decrypting ${count}/${totalFiles} files — ${formatBytes(bytesProcessed)} [${pct}%]`;
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  if (spinner) spinner.text = `Decrypted ${count} files (${formatBytes(bytesProcessed)}) in ${elapsed}s`;

  return count;
}

/**
 * Quick passphrase verification token — encrypt a known string,
 * try to decrypt it to check if passphrase is correct before decrypting everything.
 */
export async function createVerifyToken(passphrase) {
  return encryptBuffer(Buffer.from('memoir-ok'), passphrase);
}

export async function verifyPassphrase(token, passphrase) {
  try {
    const result = await decryptBuffer(token, passphrase);
    return result.toString('utf8') === 'memoir-ok';
  } catch {
    return false;
  }
}
