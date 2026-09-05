import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { gzip, gunzip } from 'zlib';
import { promisify } from 'util';
import crypto from 'crypto';
import { listSafeFiles, readSafeFile, restoreFileSet, relativeFile, MAX_SNAPSHOT_BYTES, MAX_FILE_BYTES } from '../security/files.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY, STORAGE_BUCKET, MAX_BACKUPS_FREE, MAX_BACKUPS_PRO } from './constants.js';
import { encryptBuffer, decryptBuffer } from '../security/encryption.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const CLOUD_MAGIC = Buffer.from('MEMOIRC2');

async function bundleDir(dir) {
  const files = [];
  let bytes = 0;
  for (const rel of await listSafeFiles(dir)) {
    const content = await readSafeFile(dir, rel);
    bytes += content.length;
    if (bytes > MAX_SNAPSHOT_BYTES) throw new Error('Snapshot size limit exceeded');
    files.push({ path: rel, content: content.toString('base64') });
  }
  return gzipAsync(Buffer.from(JSON.stringify(files)), { level: 9 });
}

async function unbundleToDir(gzipped, destDir) {
  const raw = await gunzipAsync(gzipped, { maxOutputLength: MAX_SNAPSHOT_BYTES * 2 });
  const files = JSON.parse(raw.toString('utf8'));
  if (!Array.isArray(files)) throw new Error('Invalid cloud snapshot');
  const entries = files.map(file => {
    if (typeof file?.content !== 'string' || file.content.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 || file.content.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(file.content)) throw new Error('Invalid snapshot content');
    const content = Buffer.from(file.content, 'base64');
    if (content.toString('base64') !== file.content) throw new Error('Invalid base64 content');
    return { path: file.path, content };
  });
  return restoreFileSet(destDir, entries);
}

// New writes require a secret supplied by the user, never account identity.
// The secret is not placed in metadata or sent to the server.
function cloudPassphrase(options = {}) {
  const passphrase = options.passphrase || process.env.MEMOIR_CLOUD_PASSPHRASE || process.env.MEMOIR_PASSPHRASE;
  if (typeof passphrase !== 'string' || passphrase.length < 12) throw new Error('Cloud backup requires a user-held passphrase of at least 12 characters. Set MEMOIR_CLOUD_PASSPHRASE; keep it in your password manager for recovery on other devices.');
  return passphrase;
}

// Upload backup to Supabase Storage + insert metadata
export async function uploadBackup(stagingDir, session, toolResults, options = {}) {
  const passphrase = cloudPassphrase(options);
  const gzipped = await bundleDir(stagingDir);

  // Versioned user-secret encryption; legacy identity-keyed backups are read-only.
  const encrypted = Buffer.concat([CLOUD_MAGIC, await encryptBuffer(gzipped, passphrase)]);

  // Allocation is atomic across clients. Never fall back to max(version)+1:
  // a missing migration must fail safely rather than creating duplicate versions.
  const versionRes = await fetch(SUPABASE_URL + '/rest/v1/rpc/memoir_next_backup_version', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + session.access_token, apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!versionRes.ok) throw new Error('Cloud version allocation failed. Apply the Memoir backup-version database migration before enabling this writer. The previous backups are unchanged.');
  const nextVersion = Number(await versionRes.json());
  if (!Number.isSafeInteger(nextVersion) || nextVersion < 1) throw new Error('Invalid cloud backup version');

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
      id: backupId,
      encryption_format: 'user-passphrase-v2',
      source_backup_id: options.sourceBackupId || null,
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

function ownedStoragePath(backup, session) {
  const rel = relativeFile(backup.storage_path);
  if (!rel.startsWith(session.user.id + '/')) throw new Error('Backup does not belong to this account');
  return rel;
}

export async function readBoundedResponse(res) {
  const limit = MAX_SNAPSHOT_BYTES * 2;
  if (Number(res.headers?.get('content-length')) > limit) throw new Error('Cloud snapshot exceeds size limit');
  if (!res.body?.getReader) {
    const raw = Buffer.from(await res.arrayBuffer());
    if (raw.length > limit) throw new Error('Cloud snapshot exceeds size limit');
    return raw;
  }
  const reader = res.body.getReader(), chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) { await reader.cancel(); throw new Error('Cloud snapshot exceeds size limit'); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, bytes);
  } finally { reader.releaseLock(); }
}

// Download a specific backup
export async function downloadBackup(backup, destDir, session, options = {}) {
  ownedStoragePath(backup, session);
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${backup.storage_path}`, {
    headers: {
      'Authorization': `Bearer ${session.access_token}`,
      'apikey': SUPABASE_ANON_KEY,
    },
  });

  if (!res.ok) throw new Error(`Download failed: ${await res.text()}`);

  const raw = await readBoundedResponse(res);

  // Decrypt if encrypted (check for MEMOIR01 magic header)
  let gzipped;
  if (raw.subarray(0, 8).equals(CLOUD_MAGIC)) {
    gzipped = await decryptBuffer(raw.subarray(8), cloudPassphrase(options));
  } else if (raw.subarray(0, 8).toString() === 'MEMOIR01') {
    process.stderr.write('memoir: restoring a legacy cloud backup protected by a server-known key. Create a new user-passphrase backup to replace this protection.\n');
    gzipped = await decryptBuffer(raw, 'memoir-cloud:' + session.user.id);
  } else {
    // Legacy unencrypted backup
    process.stderr.write('memoir: restoring a legacy unencrypted cloud backup.\n');
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
    await deleteBackup(backup, session);

    deleted++;
  }

  return deleted;
}

export { bundleDir, unbundleToDir };

export async function deleteBackup(backup, session) {
  ownedStoragePath(backup, session);
  const headers = { Authorization: 'Bearer ' + session.access_token, apikey: SUPABASE_ANON_KEY };
  const object = await fetch(SUPABASE_URL + '/storage/v1/object/' + STORAGE_BUCKET + '/' + backup.storage_path, { method: 'DELETE', headers });
  if (!object.ok && object.status !== 404) throw new Error('Backup object deletion failed; metadata retained');
  const row = await fetch(SUPABASE_URL + '/rest/v1/backups?id=eq.' + encodeURIComponent(backup.id), { method: 'DELETE', headers });
  if (!row.ok) throw new Error('Backup metadata deletion failed');
}

// Default is a reviewable plan. --apply replaces legacy backups one at a time,
// deleting each old object only after a downloaded replacement is byte-verified.
export async function migrateCloudBackups(session, { apply = false, passphrase } = {}) {
  const backups = await listBackups(session);
  const legacy = backups.filter(b => b.encryption_format !== 'user-passphrase-v2');
  if (!apply) return { planned: legacy.length, migrated: 0, legacyVersions: legacy.map(b => b.version) };
  const secret = cloudPassphrase({ passphrase });
  let migrated = 0;
  for (const old of legacy) {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-cloud-migration-'));
    try {
      const source = path.join(scratch, 'source'), verified = path.join(scratch, 'verified');
      await downloadBackup(old, source, session, { passphrase: secret });
      // Resume an interrupted migration without creating another replacement.
      let replacement = backups.find(b => b.source_backup_id === old.id && b.encryption_format === 'user-passphrase-v2');
      if (!replacement) replacement = await uploadBackup(source, session, (old.tools || []).map(name => ({ adapter: { name } })), { passphrase: secret, sourceBackupId: old.id });
      await downloadBackup(replacement, verified, session, { passphrase: secret });
      const expected = (await listSafeFiles(source)).sort(), actual = (await listSafeFiles(verified)).sort();
      if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('Migration verification failed: file set differs; legacy backup retained');
      for (const rel of expected) {
        if (!(await readSafeFile(source, rel)).equals(await readSafeFile(verified, rel))) throw new Error('Migration verification failed: content differs; legacy backup retained');
      }
      await deleteBackup(old, session);
      migrated++;
    } finally { await fs.remove(scratch); }
  }
  return { planned: legacy.length, migrated };
}
