import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { createGzip, createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { Readable, Writable } from 'stream';
import { SUPABASE_URL, SUPABASE_ANON_KEY, STORAGE_BUCKET, MAX_BACKUPS_FREE, MAX_BACKUPS_PRO } from './constants.js';
import { encryptBuffer, decryptBuffer } from '../security/encryption.js';

// Bundle a directory into a JSON manifest + gzip
async function bundleDir(dir) {
  const files = [];

  async function walk(currentDir, prefix = '') {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(fullPath, relPath);
      } else {
        const content = await fs.readFile(fullPath);
        files.push({
          path: relPath,
          content: content.toString('base64'),
        });
      }
    }
  }

  await walk(dir);
  const json = JSON.stringify(files);
  const buffer = Buffer.from(json, 'utf-8');

  // Gzip
  return new Promise((resolve, reject) => {
    const chunks = [];
    const gzip = createGzip({ level: 9 });
    gzip.on('data', chunk => chunks.push(chunk));
    gzip.on('end', () => resolve(Buffer.concat(chunks)));
    gzip.on('error', reject);
    gzip.end(buffer);
  });
}

// Unbundle gzipped JSON back to a directory
async function unbundleToDir(gzipped, destDir) {
  const decompressed = await new Promise((resolve, reject) => {
    const chunks = [];
    const gunzip = createGunzip();
    gunzip.on('data', chunk => chunks.push(chunk));
    gunzip.on('end', () => resolve(Buffer.concat(chunks)));
    gunzip.on('error', reject);
    gunzip.end(gzipped);
  });

  const files = JSON.parse(decompressed.toString('utf-8'));

  for (const file of files) {
    const fullPath = path.join(destDir, file.path);
    await fs.ensureDir(path.dirname(fullPath));
    await fs.writeFile(fullPath, Buffer.from(file.content, 'base64'));
  }

  return files.length;
}

// Derive a stable encryption passphrase from the user's identity
// Uses only user_id (immutable) — NOT email, which can change
function cloudPassphrase(session) {
  return `memoir-cloud:${session.user.id}`;
}

// Upload backup to Supabase Storage + insert metadata
export async function uploadBackup(stagingDir, session, toolResults) {
  const gzipped = await bundleDir(stagingDir);

  // Encrypt before upload (AES-256-GCM, keyed to user identity)
  const encrypted = await encryptBuffer(gzipped, cloudPassphrase(session));

  const backupId = crypto.randomUUID();
  const storagePath = `${session.user.id}/${backupId}.gz`;

  // Upload to Storage
  const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${storagePath}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${session.access_token}`,
      'apikey': SUPABASE_ANON_KEY,
      'Content-Type': 'application/octet-stream',
    },
    body: encrypted,
  });

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    throw new Error(`Upload failed: ${err}`);
  }

  // Get next version number
  const versionRes = await fetch(
    `${SUPABASE_URL}/rest/v1/backups?select=version&user_id=eq.${session.user.id}&order=version.desc&limit=1`,
    {
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'apikey': SUPABASE_ANON_KEY,
      },
    }
  );
  const versionData = await versionRes.json();
  const nextVersion = (versionData.length > 0 ? versionData[0].version : 0) + 1;

  // Count files in staging dir
  let fileCount = 0;
  const countFiles = async (dir) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) await countFiles(path.join(dir, e.name));
      else fileCount++;
    }
  };
  await countFiles(stagingDir);

  // Insert metadata
  const tools = toolResults.map(r => r.adapter.name);
  const metaRes = await fetch(`${SUPABASE_URL}/rest/v1/backups`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${session.access_token}`,
      'apikey': SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify({
      user_id: session.user.id,
      tool_count: tools.length,
      file_count: fileCount,
      size_bytes: encrypted.length,
      tools,
      storage_path: storagePath,
      machine_name: os.hostname(),
      version: nextVersion,
    }),
  });

  if (!metaRes.ok) {
    const err = await metaRes.text();
    throw new Error(`Failed to save backup metadata: ${err}`);
  }

  const backup = (await metaRes.json())[0];
  return { ...backup, sizeBytes: encrypted.length };
}

// Download a specific backup
export async function downloadBackup(backup, destDir, session) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${backup.storage_path}`, {
    headers: {
      'Authorization': `Bearer ${session.access_token}`,
      'apikey': SUPABASE_ANON_KEY,
    },
  });

  if (!res.ok) throw new Error(`Download failed: ${await res.text()}`);

  const raw = Buffer.from(await res.arrayBuffer());

  // Decrypt if encrypted (check for MEMOIR01 magic header)
  let gzipped;
  if (raw.length >= 8 && raw.subarray(0, 8).toString() === 'MEMOIR01') {
    gzipped = await decryptBuffer(raw, cloudPassphrase(session));
  } else {
    // Legacy unencrypted backup
    gzipped = raw;
  }

  const fileCount = await unbundleToDir(gzipped, destDir);
  return fileCount;
}

// List backups for user
export async function listBackups(session) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/backups?select=*&user_id=eq.${session.user.id}&order=created_at.desc`,
    {
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'apikey': SUPABASE_ANON_KEY,
      },
    }
  );

  if (!res.ok) throw new Error('Failed to fetch backup history');
  return res.json();
}

// Delete old backups beyond the limit
export async function cleanupOldBackups(session, isPro) {
  const maxBackups = isPro ? MAX_BACKUPS_PRO : MAX_BACKUPS_FREE;
  const backups = await listBackups(session);

  if (backups.length <= maxBackups) return 0;

  const toDelete = backups.slice(maxBackups);
  let deleted = 0;

  for (const backup of toDelete) {
    // Delete from storage
    await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${backup.storage_path}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'apikey': SUPABASE_ANON_KEY,
      },
    });

    // Delete metadata row
    await fetch(`${SUPABASE_URL}/rest/v1/backups?id=eq.${backup.id}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'apikey': SUPABASE_ANON_KEY,
      },
    });

    deleted++;
  }

  return deleted;
}

export { bundleDir, unbundleToDir };
