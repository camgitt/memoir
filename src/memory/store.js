import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { parseFrontmatter } from '../commands/validate.js';
import { memoryFilename, readSafeFile, writeSafeFile, listSafeFiles, safePath, MAX_FILE_BYTES } from '../security/files.js';
import { withSessionLock } from '../session/lock.js';
import { projectIdentity } from './scope.js';

export const memoryRoot = path.join(os.homedir(), '.config', 'memoir', 'memories');

export async function rememberMemory({ filename, content, project, scope = 'project', tool = 'memoir', aliases = [], tags = [] }) {
  const name = memoryFilename(filename);
  if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error('Memory exceeds the size limit');
  const projectId = scope === 'shared' ? 'shared' : projectIdentity(project);
  const id = crypto.createHash('sha256').update(projectId + '\0' + name).digest('hex');
  return withSessionLock(path.join(memoryRoot, '.write.lock'), async () => {
    const rel = id + '.md';
    let prior = null;
    try { prior = parseFrontmatter((await readSafeFile(memoryRoot, rel)).toString('utf8')); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
    if (prior?.fields.hidden === true) throw new Error('This memory identity was forgotten. Choose a new filename for a new memory.');
    const parsed = parseFrontmatter(content);
    if (parsed.error) throw new Error(parsed.error);
    const now = new Date().toISOString();
    const fields = {
      ...parsed.fields,
      id, name: parsed.fields.name || name.replace(/\.md$/, ''),
      type: parsed.fields.type || 'fact',
      project: projectId, source_tool: tool, updated: now,
      created: prior?.fields.created || now,
      revision: Number(prior?.fields.revision || 0) + 1,
      verification: 'unverified',
      aliases: [...new Set([...(Array.isArray(parsed.fields.aliases) ? parsed.fields.aliases : []), ...aliases])],
      tags: [...new Set([...(Array.isArray(parsed.fields.tags) ? parsed.fields.tags : []), ...tags])],
    };
    const lines = ['---'];
    for (const [key, value] of Object.entries(fields)) {
      if (!/^[a-z][a-z0-9_]*$/i.test(key)) continue;
      if (Array.isArray(value)) lines.push(key + ':', ...value.map(v => '  - ' + JSON.stringify(String(v))));
      else if (value != null && typeof value !== 'object') lines.push(key + ': ' + JSON.stringify(value));
    }
    const rendered = lines.concat(['---', parsed.body]).join('\n');
    // Keep previous revisions separate from the searchable current record.
    if (prior) await writeSafeFile(memoryRoot, 'history/' + id + '/' + crypto.randomUUID() + '.md', await readSafeFile(memoryRoot, rel));
    await writeSafeFile(memoryRoot, rel, rendered);
    return { id, revision: fields.revision, project: projectId, path: rel };
  });
}

export async function readStoredMemories() {
  if (!await fs.pathExists(memoryRoot)) return [];
  const docs = [];
  for (const entry of await fs.readdir(memoryRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.md$/.test(entry.name)) continue;
    docs.push({ path: entry.name, absPath: path.join(memoryRoot, entry.name), content: (await readSafeFile(memoryRoot, entry.name)).toString('utf8'), tool: 'Memoir' });
  }
  return docs;
}

export async function stageMemories(dest) {
  if (!await fs.pathExists(memoryRoot)) return 0;
  let count = 0;
  for (const rel of await listSafeFiles(memoryRoot)) {
    if (rel.endsWith('.lock') || rel.includes('.memoir-write-')) continue;
    await writeSafeFile(dest, 'memoir-memories/' + rel, await readSafeFile(memoryRoot, rel));
    count++;
  }
  return count;
}

export async function restoreStoredMemories(source) {
  const dir = path.join(source, 'memoir-memories');
  if (!await fs.pathExists(dir)) return 0;
  return withSessionLock(path.join(memoryRoot, '.write.lock'), async () => {
    const entries = [], purged = new Set();
    // Parse and validate the entire incoming set before modifying records.
    for (const rel of await listSafeFiles(dir)) {
      if (!/^(?:[a-f0-9]{64}\.md|history\/[a-f0-9]{64}\/[a-f0-9-]+\.md)$/.test(rel)) throw new Error('Invalid canonical memory path');
      const id = rel.startsWith('history/') ? rel.split('/')[1] : rel.slice(0, -3);
      const incoming = await readSafeFile(dir, rel);
      const parsed = parseFrontmatter(incoming.toString());
      if (parsed.error || parsed.fields.id !== id || !/^(?:shared|(?:git|local):[a-f0-9]{32})$/.test(parsed.fields.project || '')) throw new Error('Invalid canonical memory record');
      await safePath(memoryRoot, rel);
      let local;
      try { local = await readSafeFile(memoryRoot, rel); } catch (err) { if (err.code !== 'ENOENT') throw err; }
      if (!rel.startsWith('history/') && (parsed.fields.purged === true || (local && parseFrontmatter(local.toString()).fields.purged === true))) purged.add(id);
      entries.push({ rel, id, incoming, parsed, local });
    }
    // A stale backup might contain history without its current record.
    for (const entry of await readStoredMemories()) {
      const fields = parseFrontmatter(entry.content).fields;
      if (fields.purged === true) purged.add(fields.id);
    }
    let count = 0;
    for (const { rel, id, incoming, parsed, local } of entries) {
      if (rel.startsWith('history/') && purged.has(id)) continue;
      if (local && !local.equals(incoming) && !rel.startsWith('history/')) {
        const a = parseFrontmatter(local.toString()).fields, b = parsed.fields;
        const rank = fields => fields.purged === true ? 2 : fields.hidden === true ? 1 : 0;
        const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
        const incomingWins = rank(b) > rank(a) || (rank(b) === rank(a) &&
          (String(b.updated || '') > String(a.updated || '') ||
          (String(b.updated || '') === String(a.updated || '') && digest(incoming) > digest(local))));
        if (!purged.has(id)) await writeSafeFile(memoryRoot, 'history/' + id + '/' + crypto.randomUUID() + '.md', incomingWins ? local : incoming);
        if (!incomingWins) continue;
      }
      await writeSafeFile(memoryRoot, rel, incoming);
      count++;
    }
    for (const id of purged) await fs.remove(path.join(memoryRoot, 'history', id));
    return count;
  });
}

// Hiding is durable and syncable. Purge affects this device's current record
// and its local revision history, not older remote snapshots or Git history.
export async function forgetStoredMemory(id, { purge = false, project } = {}) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid memory ID');
  return withSessionLock(path.join(memoryRoot, '.write.lock'), async () => {
    const rel = id + '.md';
    const raw = await readSafeFile(memoryRoot, rel);
    const { fields, body } = parseFrontmatter(raw.toString());
    const { visibleMemory } = await import('./scope.js');
    if (!visibleMemory(fields, { project })) throw new Error('Memory is hidden or outside this project');
    const metadata = purge ? { id, project: fields.project, type: fields.type || 'fact' } : fields;
    metadata.hidden = true;
    if (purge) metadata.purged = true;
    metadata.hidden_at = new Date().toISOString();
    metadata.updated = metadata.hidden_at;
    metadata.revision = Number(fields.revision || 0) + 1;
    const lines = ['---'];
    for (const [key, value] of Object.entries(metadata)) {
      if (Array.isArray(value)) lines.push(key + ':', ...value.map(v => '  - ' + JSON.stringify(v)));
      else if (value != null && typeof value !== 'object') lines.push(key + ': ' + JSON.stringify(value));
    }
    await writeSafeFile(memoryRoot, rel, lines.concat(['---', purge ? '[purged]' : body]).join('\n'));
    if (purge) await fs.remove(path.join(memoryRoot, 'history', id));
    return { id, hidden: true, purged: purge };
  });
}
