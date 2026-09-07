import fs from 'fs-extra';
import path from 'node:path';
import crypto from 'node:crypto';
import { workRoot, readWork, parseWork } from './store.js';
import { safePath, readSafeFile } from '../security/files.js';
import { encryptBuffer, decryptBuffer } from '../security/encryption.js';
import { withSessionLock } from '../session/lock.js';
import { LEDGER, WORK_LIMIT, SNAPSHOT_DIR, SNAPSHOT_KEEP, digest, serializeWork, snapshotFiles, readSnapshot, saveSnapshot, durableWrite, pruneSnapshots, snapshotName } from './snapshots.js';

const EXPORT_TYPE = 'memoir-project-handoff';
const EXPORT_LIMIT = WORK_LIMIT + 16384;
async function locked(project, operation) {
  const root = await workRoot(project);
  return withSessionLock(await safePath(root, '.memoir/work.lock', { createParents: true }), () => operation(root));
}

async function currentState(root) {
  let raw;
  try { raw = await readSafeFile(root, LEDGER); }
  catch (error) {
    if (error.code === 'ENOENT') return { state: 'missing', fingerprint: 'missing', raw: null };
    throw error;
  }
  try { return { state: 'healthy', fingerprint: digest(raw), raw, data: parseWork(raw) }; }
  catch { return { state: 'damaged', fingerprint: digest(raw), raw }; }
}

async function inventory(root) {
  const valid = []; let invalid = 0;
  for (const id of await snapshotFiles(root)) {
    try {
      const data = parseWork(await readSnapshot(root, id));
      const stat = await fs.stat(await safePath(root, SNAPSHOT_DIR + '/' + id));
      valid.push({ id, revision: data.revision, saved_at: data.updated_at || null, time: stat.mtimeMs });
    } catch { invalid++; }
  }
  valid.sort((a, b) => b.time - a.time || b.revision - a.revision);
  return { snapshots: valid.map(({ time, ...entry }) => entry), invalid_snapshots: invalid };
}

export async function doctorWork(project) {
  return locked(project, async root => {
    const current = await currentState(root), backups = await inventory(root);
    const protectedCopy = current.data && backups.snapshots.some(s => s.id === snapshotName(current.data));
    const state = current.state === 'missing' && !backups.snapshots.length && !backups.invalid_snapshots ? 'empty' : current.state;
    const healthy = state === 'healthy' && !!protectedCopy && !backups.invalid_snapshots && backups.snapshots.length <= SNAPSHOT_KEEP + 2;
    return { state, healthy, revision: current.data?.revision ?? null, recovery_id: current.data?.recovery_id ?? null,
      protected: !!protectedCopy, ...backups,
      retention: SNAPSHOT_KEEP, local_only: true,
      next: state === 'empty' ? 'Run memoir work setup, then save your first project record.' : state !== 'healthy'
        ? 'Run memoir work recover to preview a recovery. The original is preserved on apply.'
        : !protectedCopy ? 'Run memoir work backup to protect the existing handoff.'
        : backups.invalid_snapshots || backups.snapshots.length > SNAPSHOT_KEEP + 2 ? 'Inspect the backup folder locally; damaged copies or failed cleanup need attention.'
        : 'Automatic snapshots are working. Use memoir work backup --output PATH for an encrypted copy outside this project.' };
  });
}

function requirePassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.trim().length < 12 || passphrase.length > 4096) throw new Error('Use a recovery passphrase of at least 12 characters. It is never saved by Memoir.');
}

async function externalFile(filename) {
  const absolute = path.resolve(filename);
  const parent = await fs.realpath(path.dirname(absolute));
  return { root: parent, relative: path.basename(absolute) };
}

export async function backupWork(project, { output, passphrase } = {}) {
  if (output) requirePassphrase(passphrase);
  return locked(project, async root => {
    const data = await readWork(root);
    if (!data.revision) throw new Error('No project records to back up yet.');
    const id = await saveSnapshot(root, data);
    let destination;
    if (output) {
      const target = await externalFile(output);
      const payload = Buffer.from(JSON.stringify({ type: EXPORT_TYPE, version: 1, ledger: data }));
      const encrypted = await encryptBuffer(payload, passphrase);
      // Verify the encryption result before publishing the export file.
      if (!(await decryptBuffer(encrypted, passphrase)).equals(payload)) throw new Error('Encrypted backup verification failed.');
      await durableWrite(target.root, target.relative, encrypted, { exclusive: true });
      destination = path.join(target.root, target.relative);
    }
    let cleanup_warning = false;
    await pruneSnapshots(root, [id]).catch(() => { cleanup_warning = true; });
    return { snapshot: id, revision: data.revision, encrypted: !!output, ...(destination ? { output: destination } : {}), cleanup_warning,
      message: output ? 'Encrypted project handoff saved. Keep the passphrase separately; test recovery before relying on it.' : 'Local recovery snapshot saved. Automatic snapshots accompany future changes.' };
  });
}

async function recoverySource(root, { snapshot, from, passphrase }) {
  if (snapshot && from) throw new Error('Choose a local snapshot or an encrypted file, not both.');
  if (from) {
    requirePassphrase(passphrase);
    const target = await externalFile(from);
    const raw = await readSafeFile(target.root, target.relative, { maxBytes: EXPORT_LIMIT });
    let payload;
    try { payload = JSON.parse((await decryptBuffer(raw, passphrase)).toString()); }
    catch { throw new Error('Cannot open the encrypted handoff. Check the passphrase and file integrity. Nothing was replaced.'); }
    if (!payload || payload.type !== EXPORT_TYPE || payload.version !== 1 || Object.keys(payload).sort().join() !== 'ledger,type,version') throw new Error('This file is not a supported project handoff export.');
    const data = parseWork(serializeWork(payload.ledger));
    return { data, source: 'encrypted-export', source_digest: digest(raw) };
  }
  const id = snapshot || (await inventory(root)).snapshots[0]?.id;
  if (!id) throw new Error('No valid local recovery snapshot is available. Use --from with a previously exported encrypted handoff.');
  const raw = await readSnapshot(root, id);
  return { data: parseWork(raw), source: id, source_digest: digest(raw) };
}

export async function recoverWork(project, options = {}) {
  return locked(project, async root => {
    const current = await currentState(root);
    const source = await recoverySource(root, options);
    // Bind approval to the exact source, destination folder and current bytes.
    // A changed file or concurrent save requires a new review, even if its
    // numeric revision happens to be unchanged.
    const expected = digest(JSON.stringify([root, current.fingerprint, source.source_digest]));
    const preview = { current_state: current.state, current_revision: current.data?.revision ?? null,
      source: source.source, restore_revision: source.data.revision,
      branches: [...new Set([...source.data.records, ...source.data.checks].map(r => r.branch))],
      records: source.data.records.length, checks: source.data.checks.length,
      expect: expected, applied: false,
      message: 'Replaces this project handoff, including all branches and history. Original bytes are preserved. A snapshot may include an interrupted save. Review the source, then repeat with --apply --expect and this fingerprint. All clients must resume after recovery.' };
    if (!options.apply) return preview;
    if (options.expect !== expected) throw new Error('Recovery preview changed or is missing. Preview again before applying; nothing was replaced.');
    const restored = { ...source.data, recovery_id: crypto.randomUUID(), updated_at: new Date().toISOString() };
    const raw = serializeWork(restored);
    parseWork(raw); // Validate the final result before any replacement.
    let preserved;
    if (current.raw) {
      preserved = '.memoir/work-quarantine/before-' + crypto.randomUUID() + '.json';
      await durableWrite(root, preserved, current.raw, { exclusive: true });
    }
    if (current.data) await saveSnapshot(root, current.data);
    const id = await saveSnapshot(root, restored);
    await durableWrite(root, LEDGER, raw);
    let cleanup_warning = false;
    await pruneSnapshots(root, [id]).catch(() => { cleanup_warning = true; });
    return { ...preview, applied: true, preserved: preserved || null, recovery_id: restored.recovery_id, cleanup_warning,
      message: 'Handoff recovered. Resume in every connected tool before saving. The previous handoff is preserved locally; personal memory and client settings were untouched.' };
  });
}
