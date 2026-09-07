// Private, bounded recovery copies. Only the project ledger belongs here.
import fs from 'fs-extra';
import path from 'node:path';
import crypto from 'node:crypto';
import { safePath, readSafeFile } from '../security/files.js';

export const LEDGER = '.memoir/work.json';
export const WORK_LIMIT = 2 * 1024 * 1024;
export const SNAPSHOT_DIR = '.memoir/work-backups';
export const SNAPSHOT_KEEP = 20;
export const digest = raw => crypto.createHash('sha256').update(raw).digest('hex');
// Stable object ordering keeps a snapshot's identity unchanged after schema
// validation, which may reconstruct objects in a different property order.
export const serializeWork = data => Buffer.from(JSON.stringify(data, (_key, value) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value, 2) + '\n');
const snapshotPattern = /^r[0-9]{1,16}-[a-f0-9]{64}\.json$/;
export const snapshotName = data => `r${data.revision}-${digest(serializeWork(data))}.json`;

async function syncDirectory(directory) {
  // Windows does not expose directory fsync through Node. Atomic replacement
  // still applies there; power-loss durability depends on the filesystem.
  if (process.platform === 'win32') return;
  const fd = await fs.open(directory, 'r');
  try { await fs.fsync(fd); } finally { await fs.close(fd); }
}

export async function durableWrite(root, relative, raw, { exclusive = false } = {}) {
  const full = await safePath(root, relative, { createParents: true });
  const temporary = path.join(path.dirname(full), '.memoir-write-' + crypto.randomUUID());
  let fd;
  try {
    fd = await fs.open(temporary, 'wx', 0o600);
    await fs.writeFile(fd, raw);
    await fs.fsync(fd);
    await fs.close(fd); fd = undefined;
    await safePath(root, relative);
    // link publishes without clobbering an existing export/quarantine file.
    if (exclusive) await fs.link(temporary, full);
    else await fs.rename(temporary, full);
    await syncDirectory(path.dirname(full));
  } finally {
    if (fd !== undefined) await fs.close(fd).catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}

export async function snapshotFiles(root) {
  // safePath validates parents without accepting a symlinked backup folder.
  const probe = await safePath(root, SNAPSHOT_DIR + '/probe');
  let entries;
  try { entries = await fs.readdir(path.dirname(probe), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (entries.length > 1000) throw new Error('Too many recovery files. Inspect the backup folder locally.');
  return entries.filter(e => snapshotPattern.test(e.name)).map(e => e.name);
}

export async function readSnapshot(root, id) {
  if (!snapshotPattern.test(id)) throw new Error('Choose a snapshot ID from memoir work doctor.');
  const raw = await readSafeFile(root, SNAPSHOT_DIR + '/' + id, { maxBytes: WORK_LIMIT });
  if (!id.endsWith('-' + digest(raw) + '.json')) throw new Error('Recovery snapshot failed its integrity check.');
  return raw;
}

export async function saveSnapshot(root, data) {
  const id = snapshotName(data), raw = serializeWork(data);
  if (raw.length > WORK_LIMIT) throw new Error('Project handoff is full. No records were dropped.');
  try { if ((await readSnapshot(root, id)).equals(raw)) return id; }
  catch (error) {
    if (error.code !== 'ENOENT') throw error; // Never silently overwrite a damaged copy.
  }
  await durableWrite(root, SNAPSHOT_DIR + '/' + id, raw, { exclusive: true });
  return id;
}

export async function pruneSnapshots(root, protectedIds = []) {
  const entries = await Promise.all((await snapshotFiles(root)).map(async id => {
    const full = await safePath(root, SNAPSHOT_DIR + '/' + id);
    return { id, full, time: (await fs.stat(full)).mtimeMs };
  }));
  entries.sort((a, b) => b.time - a.time || b.id.localeCompare(a.id));
  const keep = new Set([...protectedIds, ...entries.slice(0, SNAPSHOT_KEEP).map(e => e.id)]);
  for (const entry of entries) if (!keep.has(entry.id)) {
    await readSnapshot(root, entry.id); // Preserve evidence of corruption for inspection.
    await fs.unlink(await safePath(root, SNAPSHOT_DIR + '/' + entry.id));
  }
}
