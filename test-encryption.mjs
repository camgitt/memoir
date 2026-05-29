#!/usr/bin/env node
// Unit tests for the AES-256-GCM encryption path.
// Plain node, no framework. Uses os.tmpdir() for directory round-trip tests.

import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { randomBytes } from 'crypto';

import {
  deriveKey,
  encryptBuffer,
  decryptBuffer,
  encryptDirectory,
  decryptDirectory,
  createVerifyToken,
  verifyPassphrase,
} from './src/security/encryption.js';

const BOLD = '\x1b[1m', GREEN = '\x1b[32m', RED = '\x1b[31m', CYAN = '\x1b[36m', RESET = '\x1b[0m';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ${GREEN}PASS${RESET} ${msg}`); pass++; }
  else      { console.log(`  ${RED}FAIL${RESET} ${msg}`); fail++; }
}

const PASS1 = 'correct horse battery staple';
const PASS2 = 'wrong passphrase entirely';

// ── encryptBuffer / decryptBuffer ─────────────────────────────────
console.log(`\n${BOLD}${CYAN}encryptBuffer / decryptBuffer${RESET}\n`);

// 1. Round-trip returns the original bytes exactly
{
  const plaintext = Buffer.from('the quick brown fox jumps over the lazy dog 🦊', 'utf8');
  const encrypted = await encryptBuffer(plaintext, PASS1);
  const decrypted = await decryptBuffer(encrypted, PASS1);
  assert(Buffer.isBuffer(encrypted), 'encryptBuffer returns a Buffer');
  assert(!encrypted.equals(plaintext), 'ciphertext differs from plaintext');
  assert(decrypted.equals(plaintext), 'round-trip recovers the exact original bytes');
}

// 2. Round-trip on binary (non-text) data
{
  const plaintext = randomBytes(4096);
  const encrypted = await encryptBuffer(plaintext, PASS1);
  const decrypted = await decryptBuffer(encrypted, PASS1);
  assert(decrypted.equals(plaintext), 'binary round-trip recovers exact bytes');
}

// 3. Empty buffer round-trips
{
  const plaintext = Buffer.alloc(0);
  const encrypted = await encryptBuffer(plaintext, PASS1);
  const decrypted = await decryptBuffer(encrypted, PASS1);
  assert(decrypted.length === 0, 'empty buffer round-trips to empty');
}

// 4. Wrong passphrase does NOT return the plaintext (mandatory negative case)
{
  const plaintext = Buffer.from('top secret memory bundle', 'utf8');
  const encrypted = await encryptBuffer(plaintext, PASS1);
  let threw = false, leaked = false;
  try {
    const result = await decryptBuffer(encrypted, PASS2);
    // If GCM somehow did not throw, the bytes must NOT equal the plaintext.
    leaked = result.equals(plaintext);
  } catch {
    threw = true;
  }
  assert(threw || !leaked, 'wrong passphrase throws or yields garbage (never the plaintext)');
  assert(threw, 'GCM auth tag rejects wrong passphrase (throws)');
}

// 5. Tampered ciphertext is rejected (auth tag integrity)
{
  const plaintext = Buffer.from('integrity matters', 'utf8');
  const encrypted = await encryptBuffer(plaintext, PASS1);
  // Flip a byte deep in the ciphertext body (past MAGIC|salt|iv|tag headers).
  const tampered = Buffer.from(encrypted);
  tampered[tampered.length - 1] ^= 0xff;
  let threw = false;
  try { await decryptBuffer(tampered, PASS1); } catch { threw = true; }
  assert(threw, 'tampered ciphertext is rejected');
}

// 6. Bad header (not a memoir file) is rejected
{
  let threw = false;
  try { await decryptBuffer(Buffer.from('not encrypted at all'), PASS1); } catch { threw = true; }
  assert(threw, 'non-memoir data rejected by header check');
}

// 7. Two encryptions of the same input produce DIFFERENT ciphertext (no IV/salt reuse)
{
  const plaintext = Buffer.from('determinism is a vulnerability', 'utf8');
  const a = await encryptBuffer(plaintext, PASS1);
  const b = await encryptBuffer(plaintext, PASS1);
  assert(!a.equals(b), 'same input → different ciphertext (IV/salt randomized)');
  // Salt lives at bytes 8..40, IV at 40..52 — both must differ.
  assert(!a.subarray(8, 40).equals(b.subarray(8, 40)), 'salt is not reused');
  assert(!a.subarray(40, 52).equals(b.subarray(40, 52)), 'IV is not reused');
  // Both still decrypt back to the same plaintext.
  assert((await decryptBuffer(a, PASS1)).equals(plaintext), 'first ciphertext decrypts');
  assert((await decryptBuffer(b, PASS1)).equals(plaintext), 'second ciphertext decrypts');
}

// ── deriveKey ─────────────────────────────────────────────────────
console.log(`\n${BOLD}${CYAN}deriveKey${RESET}\n`);

// 8. Same passphrase + same salt → same key (deterministic KDF)
{
  const { key: k1, salt } = await deriveKey(PASS1);
  const { key: k2 } = await deriveKey(PASS1, salt);
  assert(k1.length === 32, 'derived key is 256 bits (32 bytes)');
  assert(salt.length === 32, 'salt is 256 bits (32 bytes)');
  assert(k1.equals(k2), 'same passphrase + salt → identical key');
}

// 9. Different salt → different key
{
  const { key: k1 } = await deriveKey(PASS1);
  const { key: k2 } = await deriveKey(PASS1);
  assert(!k1.equals(k2), 'fresh random salts → different keys');
}

// ── encryptDirectory / decryptDirectory ───────────────────────────
console.log(`\n${BOLD}${CYAN}encryptDirectory / decryptDirectory${RESET}\n`);

// 10. Encrypt → decrypt reproduces the file tree + content identically
{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-enc-test-'));
  const srcDir = path.join(root, 'src');
  const encDir = path.join(root, 'enc');
  const outDir = path.join(root, 'out');

  // Build a nested tree with text, binary, and a deep subdirectory.
  const files = {
    'top.txt': Buffer.from('top-level file\nline two\n', 'utf8'),
    'notes/memory.md': Buffer.from('# Memory\n\n- remembered thing\n', 'utf8'),
    'notes/deep/blob.bin': randomBytes(2048),
    'empty.txt': Buffer.alloc(0),
  };
  for (const [rel, buf] of Object.entries(files)) {
    const p = path.join(srcDir, rel);
    await fs.ensureDir(path.dirname(p));
    await fs.writeFile(p, buf);
  }

  const encCount = await encryptDirectory(srcDir, encDir, PASS1);
  assert(encCount === Object.keys(files).length, 'encryptDirectory reports all files encrypted');
  assert(await fs.pathExists(path.join(encDir, 'manifest.enc')), 'manifest.enc written');
  assert(await fs.pathExists(path.join(encDir, 'salt')), 'salt written');

  const decCount = await decryptDirectory(encDir, outDir, PASS1);
  assert(decCount === Object.keys(files).length, 'decryptDirectory reports all files decrypted');

  // Every original file is reproduced with identical content.
  let allMatch = true;
  for (const [rel, buf] of Object.entries(files)) {
    const outPath = path.join(outDir, rel);
    if (!(await fs.pathExists(outPath))) { allMatch = false; break; }
    const got = await fs.readFile(outPath);
    if (!got.equals(buf)) { allMatch = false; break; }
  }
  assert(allMatch, 'decrypted tree matches source tree + content exactly');

  await fs.remove(root);
}

// 11. Encrypted directory hides real filenames (names are hashed)
{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-enc-test-'));
  const srcDir = path.join(root, 'src');
  const encDir = path.join(root, 'enc');
  await fs.ensureDir(srcDir);
  await fs.writeFile(path.join(srcDir, 'secret-filename.txt'), 'hidden');

  await encryptDirectory(srcDir, encDir, PASS1);
  const dataFiles = await fs.readdir(path.join(encDir, 'data'));
  assert(dataFiles.length === 1, 'one encrypted data file produced');
  assert(!dataFiles.some(f => f.includes('secret-filename')), 'real filename not exposed on disk');
  assert(dataFiles[0].endsWith('.enc'), 'encrypted file has .enc extension');

  await fs.remove(root);
}

// 12. decryptDirectory with the WRONG passphrase fails (manifest is authenticated)
{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-enc-test-'));
  const srcDir = path.join(root, 'src');
  const encDir = path.join(root, 'enc');
  const outDir = path.join(root, 'out');
  await fs.ensureDir(srcDir);
  await fs.writeFile(path.join(srcDir, 'a.txt'), 'data');

  await encryptDirectory(srcDir, encDir, PASS1);
  let threw = false;
  try { await decryptDirectory(encDir, outDir, PASS2); } catch { threw = true; }
  assert(threw, 'wrong passphrase cannot decrypt the directory');

  await fs.remove(root);
}

// ── createVerifyToken / verifyPassphrase ──────────────────────────
console.log(`\n${BOLD}${CYAN}createVerifyToken / verifyPassphrase${RESET}\n`);

// 13. Correct passphrase accepted, wrong rejected
{
  const token = await createVerifyToken(PASS1);
  assert(await verifyPassphrase(token, PASS1) === true, 'correct passphrase accepted');
  assert(await verifyPassphrase(token, PASS2) === false, 'wrong passphrase rejected');
}

// 14. verifyPassphrase returns false on garbage token (does not throw)
{
  const bogus = Buffer.from('this is not a valid token');
  let threw = false, result;
  try { result = await verifyPassphrase(bogus, PASS1); } catch { threw = true; }
  assert(!threw, 'verifyPassphrase swallows errors instead of throwing');
  assert(result === false, 'garbage token verifies as false');
}

// ── Results ───────────────────────────────────────────────────────
console.log(`\n${BOLD}═══════════════════════════════════${RESET}`);
if (fail === 0) console.log(`${BOLD}${GREEN}  ALL ${pass} TESTS PASSED${RESET}`);
else console.log(`${BOLD}${RED}  ${fail} FAILED${RESET}, ${GREEN}${pass} passed${RESET}`);
console.log(`${BOLD}═══════════════════════════════════${RESET}\n`);

process.exit(fail > 0 ? 1 : 0);
