import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import { constants } from 'fs';

export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
export const MAX_SNAPSHOT_FILES = 50_000;

// Windows can briefly report access denied while another process deletes a
// file (notably the project lock). Retry the inspection, never skip it.
export async function inspectFile(file) {
  for (let attempt = 0; ; attempt++) {
    try { return await fs.lstat(file); }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code) || attempt >= 5) throw error;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
}

// Validate both Windows and POSIX paths regardless of the restoring OS.
export function relativeFile(value) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f:]/.test(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) throw new Error('Invalid relative memory path');
  const parts = value.replace(/\\/g, '/').split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p))) throw new Error('Invalid relative memory path');
  return parts.join('/');
}

export function memoryFilename(value) {
  const name = relativeFile(value.endsWith('.md') ? value : value + '.md');
  if (name.includes('/')) throw new Error('Memory filename must be a bare .md name');
  return name;
}

// Platform root aliases such as /tmp are supported; child symlinks are not.
export async function safePath(root, relative, { createParents = false } = {}) {
  const rel = relativeFile(relative);
  if (createParents) await fs.ensureDir(root, { mode: 0o700 });
  const base = await fs.realpath(root);
  const parts = rel.split('/');
  let current = base;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let st;
    try { st = await inspectFile(current); }
    catch (err) {
      if (err.code !== 'ENOENT') throw err;
      if (createParents && i < parts.length - 1) {
        await fs.mkdir(current, { mode: 0o700 }).catch(err => { if (err.code !== 'EEXIST') throw err; });
        st = await inspectFile(current);
      }
    }
    if (st?.isSymbolicLink()) throw new Error('Symlinks are not allowed in memory paths');
    if (st && i < parts.length - 1 && !st.isDirectory()) throw new Error('Memory parent is not a directory');
    if (st && i === parts.length - 1 && !st.isFile()) throw new Error('Memory path is not a regular file');
  }
  return current;
}

export async function readSafeFile(root, relative, { maxBytes = MAX_FILE_BYTES } = {}) {
  const full = await safePath(root, relative);
  const fd = await fs.open(full, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const st = await fs.fstat(fd);
    if (!st.isFile() || st.size > maxBytes) throw new Error('Memory file is not regular or exceeds the size limit');
    await safePath(root, relative);
    return await fs.readFile(fd);
  } finally { await fs.close(fd); }
}

// One inventory refresh may inspect thousands of files sharing the same
// parents. Validate each parent once within this short-lived context, while
// always lstat'ing the leaf. This is a metadata optimization only: content
// reads still use readSafeFile, and search revalidates returned sources with
// safePath. Never retain this context across queries or use it for writes.
export async function createReadInventory(root) {
  const base = await fs.realpath(root);
  const parents = new Map();
  const parent = dir => {
    if (!parents.has(dir)) parents.set(dir, (async () => {
      if (dir !== base) await parent(path.dirname(dir));
      const st = await fs.lstat(dir);
      if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('Memory parent is not a regular directory');
    })());
    return parents.get(dir);
  };
  return {
    root: base,
    async stat(relative) {
      const rel = relativeFile(relative);
      const full = path.join(base, rel);
      await parent(path.dirname(full));
      const stat = await fs.lstat(full);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new Error('Memory file is not regular or exceeds the size limit');
      return { full, stat, relative: rel };
    },
  };
}

export async function writeSafeFile(root, relative, content) {
  const full = await safePath(root, relative, { createParents: true });
  const tmp = path.join(path.dirname(full), '.memoir-write-' + crypto.randomUUID());
  try {
    await fs.writeFile(tmp, content, { flag: 'wx', mode: 0o600 });
    await safePath(root, relative);
    await fs.rename(tmp, full);
  } finally { await fs.remove(tmp).catch(() => {}); }
}

export async function listSafeFiles(root) {
  const result = [];
  const base = await fs.realpath(root);
  async function walk(dir, prefix = '') {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const rel = relativeFile(prefix + entry.name);
      if (entry.isSymbolicLink()) throw new Error('Snapshot contains a symlink: ' + rel);
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel + '/');
      else if (entry.isFile()) result.push(rel);
      else throw new Error('Snapshot contains a non-regular file: ' + rel);
      if (result.length > MAX_SNAPSHOT_FILES) throw new Error('Snapshot file limit exceeded');
    }
  }
  await walk(base);
  return result;
}

// Validate everything, build a replacement beside the destination, then swap.
// Corrupt/incomplete snapshots cannot partially overwrite the prior destination.
export async function restoreFileSet(dest, entries) {
  if (!Array.isArray(entries) || entries.length > MAX_SNAPSHOT_FILES) throw new Error('Invalid snapshot file list');
  const seen = new Set();
  let bytes = 0;
  for (const entry of entries) {
    entry.path = relativeFile(entry.path);
    const key = entry.path.normalize('NFC').toLowerCase();
    if (seen.has(key)) throw new Error('Duplicate snapshot path');
    seen.add(key);
    if (!Buffer.isBuffer(entry.content) || entry.content.length > MAX_FILE_BYTES) throw new Error('Snapshot file limit exceeded');
    bytes += entry.content.length;
    if (bytes > MAX_SNAPSHOT_BYTES) throw new Error('Snapshot size limit exceeded');
  }
  for (const key of seen) {
    const parts = key.split('/');
    while (parts.length > 1) {
      parts.pop();
      if (seen.has(parts.join('/'))) throw new Error('Conflicting snapshot paths');
    }
  }
  const absolute = path.resolve(dest);
  await fs.ensureDir(path.dirname(absolute));
  const prior = await fs.lstat(absolute).catch(err => { if (err.code !== 'ENOENT') throw err; return null; });
  if (prior && (!prior.isDirectory() || prior.isSymbolicLink())) throw new Error('Restore destination must be a directory, not a symlink');
  if (prior) for (const entry of entries) await safePath(absolute, entry.path);
  const staged = await fs.mkdtemp(path.join(path.dirname(absolute), '.memoir-restore-'));
  const previous = staged + '-previous';
  let moved = false;
  try {
    if (prior) await fs.copy(absolute, staged, { dereference: false });
    for (const entry of entries) await writeSafeFile(staged, entry.path, entry.content);
    if (prior) { await fs.rename(absolute, previous); moved = true; }
    try { await fs.rename(staged, absolute); }
    catch (err) { if (moved) await fs.rename(previous, absolute); throw err; }
    if (moved) await fs.remove(previous);
  } finally { await fs.remove(staged).catch(() => {}); }
  return entries.length;
}
