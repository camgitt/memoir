import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-index-test-'));
const actualHomedir = os.homedir;
os.homedir = () => scratch;
process.env.DO_NOT_TRACK = '1';
globalThis.fetch = async () => { throw new Error('No network in retrieval tests'); };
let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log('PASS ' + name); };
try {
  const { adapters } = await import('./src/adapters/index.js');
  adapters.splice(0, adapters.length);
  const { LexicalIndex } = await import('./src/memory/lexical-index.js');
  const { buildDoc, scoreDoc, queryTerms, searchMemories, clearSearchCache, readMemoryFiles } = await import('./src/memory/search.js');
  const { memoryRoot, rememberMemory, forgetStoredMemory, restoreStoredMemories } = await import('./src/memory/store.js');
  const { projectIdentity, memoryVisibility } = await import('./src/memory/scope.js');
  const project = path.join(scratch, 'alpha'), other = path.join(scratch, 'beta');
  await fs.ensureDir(project); await fs.ensureDir(other);
  const recall = (query, options = {}) => searchMemories(query, { root: project, project, ...options });

  await check('postings reproduce the exhaustive scorer for exact, prefix, field, Unicode and numeric matches', () => {
    const vocabulary = ['auth', 'authentication', 'authenticate', 'deploy', 'deployment', 'deploying', 'class', 'classes', 'policy', 'policies', '3.13.3', 'résumé', 'révision', '数据库迁移', '認証更新', 'foo_bar', 'ring', 'in', 'session', 'sessions', 'rollback'];
    const docs = Array.from({ length: 120 }, (_, i) => buildDoc({ path: 'entry-' + i + '.md', tool: 'fixture', content: ['---', 'name: ' + vocabulary[i % vocabulary.length], 'aliases: ["' + vocabulary[(i + 3) % vocabulary.length] + '"]', 'description: ' + vocabulary[(i + 7) % vocabulary.length], '---', '# ' + vocabulary[(i + 11) % vocabulary.length], ...Array.from({ length: 6 }, (_, j) => vocabulary[(i + j * 3) % vocabulary.length])].join('\n') }));
    const index = new LexicalIndex(); index.sync(docs);
    for (const query of [...vocabulary, 'auth deployment', 'authentication session', '数据库', 'révision policy', 'unknownneedle']) {
      const terms = queryTerms(query), found = index.lookup(terms);
      for (const doc of docs) {
        const expected = scoreDoc(doc, terms);
        assert.equal(found.documents.has(doc), expected.score > 0, query + ' candidate coverage');
        assert.deepEqual(scoreDoc(doc, terms, found.matches), expected, query + ' weighted score');
      }
    }
    index.sync(docs.slice(0, 3));
    assert.equal(index.documents.size, 3);
    for (const posting of index.postings.values()) for (const doc of posting) assert(docs.slice(0, 3).includes(doc));
    index.clear(); assert.equal(index.lookup(['auth']).documents.size, 0);
  });

  let saved;
  await check('canonical save/edit are immediately visible and old terms disappear', async () => {
    saved = await rememberMemory({ filename: 'decision', content: 'cobaltwalrus choose transactions.', project });
    assert.equal((await recall('cobaltwalrus')).results[0]?.id, saved.id);
    await rememberMemory({ filename: 'decision', content: 'amberkingfisher choose idempotency.', project });
    assert.equal((await recall('cobaltwalrus')).total, 0);
    assert.equal((await recall('amberkingfisher')).results[0]?.id, saved.id);
  });

  await check('canonical parses are reused; same-size external edits with restored mtime invalidate them', async () => {
    const original = fs.readFile; let reads = 0;
    fs.readFile = async (...args) => { reads++; return original(...args); };
    try {
      await recall('amberkingfisher'); const before = reads;
      await recall('amberkingfisher'); assert.equal(reads, before);
      const filename = path.join(memoryRoot, saved.path), st = await fs.stat(filename);
      const raw = await original(filename, 'utf8');
      await new Promise(resolve => setTimeout(resolve, 30));
      await fs.writeFile(filename, raw.replace('amberkingfisher', 'violetkingfishr'));
      await fs.utimes(filename, st.atime, st.mtime);
      assert.equal((await recall('amberkingfisher')).total, 0);
      assert.equal((await recall('violetkingfishr')).results[0]?.id, saved.id);
    } finally { fs.readFile = original; }
  });

  await check('project switches never carry another project through postings or IDF', async () => {
    await rememberMemory({ filename: 'beta', content: 'violetkingfishr private beta answer.', project: other });
    const alpha = await recall('violetkingfishr');
    const beta = await recall('violetkingfishr', { project: other });
    assert.equal(alpha.results.length, 1); assert.equal(beta.results.length, 1);
    assert.notEqual(alpha.results[0].id, beta.results[0].id);
    assert.deepEqual(await recall('violetkingfishr'), alpha);
  });

  await check('scope and time gates apply to every refreshed query, even without a file edit', async () => {
    const a = projectIdentity(project), b = projectIdentity(other);
    const docs = [{ project: a }, { project: b }, { project: 'shared' }, { project: a, hidden: true }, { project: a, status: 'superseded' }, { project: a, valid_until: '2026-01-02T00:00:00Z' }, { project: a, valid_from: '2026-01-02T00:00:00Z' }];
    assert.deepEqual(docs.map(memoryVisibility({ project, now: Date.parse('2026-01-01') })), [true, false, true, false, false, true, false]);
    assert.deepEqual(docs.map(memoryVisibility({ project, now: Date.parse('2026-01-03') })), [true, false, true, false, false, false, true]);
    assert.deepEqual(docs.map(memoryVisibility({ project, allProjects: true, now: Date.parse('2026-01-03') })), [true, true, true, false, false, false, true]);
  });

  await check('purge wins over indexed text, old history, and a stale restored copy', async () => {
    const stale = path.join(scratch, 'stale', 'memoir-memories'); await fs.ensureDir(stale);
    await fs.copy(path.join(memoryRoot, saved.path), path.join(stale, saved.path));
    await forgetStoredMemory(saved.id, { project, purge: true });
    assert.equal((await recall('violetkingfishr')).total, 0);
    await restoreStoredMemories(path.dirname(stale));
    assert.equal((await recall('violetkingfishr')).total, 0);
    clearSearchCache(); assert.equal((await recall('violetkingfishr')).total, 0);
    assert(!(await fs.pathExists(path.join(memoryRoot, 'history', saved.id))));
  });

  await check('adapter additions, removal, directory rename and rebuild agree with exhaustive search', async () => {
    const source = path.join(scratch, 'adapter'); await fs.ensureDir(path.join(source, 'nested'));
    adapters.push({ name: 'Fixture', source, filter: () => true });
    await fs.writeFile(path.join(source, 'nested', 'note.md'), 'scarletbadger recovery evidence.');
    assert.equal((await recall('scarletbadger')).total, 1);
    await fs.rename(path.join(source, 'nested'), path.join(source, 'moved'));
    assert.equal((await recall('scarletbadger')).results[0].path, 'moved/note.md');
    assert.deepEqual(await recall('scarletbadger'), await recall('scarletbadger', { engine: 'scan' }));
    await fs.remove(path.join(source, 'moved')); assert.equal((await recall('scarletbadger')).total, 0);
    clearSearchCache(); assert.equal((await recall('scarletbadger')).total, 0);
  });

  await check('a cached file cannot acquire another adapter identity', async () => {
    const source = path.join(scratch, 'projection'); await fs.ensureDir(source);
    await fs.writeFile(path.join(source, 'note.md'), 'projection memory');
    const a = await readMemoryFiles({ name: 'First', source, files: ['note.md'], customExtract: true });
    const b = await readMemoryFiles({ name: 'Second', source, files: ['note.md'], customExtract: true });
    assert.equal(a[0].tool, 'First'); assert.equal(b[0].tool, 'Second');
  });

  await check('new project instructions are found immediately, including a deeply nested active checkout', async () => {
    await recall('projectcanary');
    await fs.writeFile(path.join(project, 'AGENTS.md'), 'projectcanary current plan');
    assert.equal((await recall('projectcanary')).total, 1);
    await fs.remove(path.join(project, 'AGENTS.md'));
    assert.equal((await recall('projectcanary')).total, 0);
    const deep = path.join(scratch, 'one', 'two', 'three', 'four', 'repo');
    await fs.ensureDir(deep); await fs.writeFile(path.join(deep, 'AGENTS.md'), 'deepcheckoutcanary next action');
    assert.equal((await searchMemories('deepcheckoutcanary', { project: deep })).total, 1);
  });

  await check('replacing a cached file or parent with a symlink never exposes the target', async () => {
    const source = path.join(scratch, 'links'), outside = path.join(scratch, 'outside');
    await fs.ensureDir(source); await fs.ensureDir(outside);
    await fs.writeFile(path.join(source, 'note.md'), 'canarybefore safe record');
    await fs.writeFile(path.join(outside, 'note.md'), 'canaryoutside private target');
    adapters.splice(0, adapters.length, { name: 'Links', source, filter: () => true });
    assert.equal((await recall('canarybefore')).total, 1);
    await fs.remove(path.join(source, 'note.md'));
    try { await fs.symlink(path.join(outside, 'note.md'), path.join(source, 'note.md')); }
    catch (e) { if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(e.code)) throw e; }
    assert.equal((await recall('canaryoutside')).total, 0);
    assert.equal((await recall('canarybefore')).total, 0);
    await fs.ensureDir(path.join(source, 'nested')); await fs.writeFile(path.join(source, 'nested', 'note.md'), 'canarynested safe record');
    assert.equal((await recall('canarynested')).total, 1);
    await fs.remove(path.join(source, 'nested'));
    await fs.symlink(outside, path.join(source, 'nested'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await recall('canaryoutside')).total, 0);
    assert.equal((await recall('canarynested')).total, 0);
  });

  await check('ranking, passages, source lines and budgets match the full-scan reference', async () => {
    adapters.splice(0, adapters.length);
    for (let i = 0; i < 60; i++) {
      const id = crypto.createHash('sha256').update('parity' + i).digest('hex');
      await fs.writeFile(path.join(memoryRoot, id + '.md'), ['---', 'id: ' + id, 'project: ' + projectIdentity(project), 'name: Auth policy ' + i, '---', '# Deployment', 'Authentication classes need transaction policies.', i % 3 ? 'Database migration uses a verified snapshot.' : '数据库迁移 nécessite une révision.'].join('\n'));
    }
    for (const query of ['auth', 'authentication policy', 'classes deploy', '数据库', 'révision', '3.13.3', 'missingphrase']) {
      for (const budget of [256, 1000, 6000]) {
        assert.deepEqual(await recall(query, { budget }), await recall(query, { budget, engine: 'scan' }), query);
      }
    }
  });

  await check('final validation drops a cached source removed during the inventory refresh', async () => {
    const source = path.join(scratch, 'raced-source'); await fs.ensureDir(source);
    const file = path.join(source, 'note.md'); await fs.writeFile(file, 'racecanary only safe while the source exists');
    const canonicalFile = await fs.realpath(file);
    adapters.splice(0, adapters.length, { name: 'Race', source, filter: () => true });
    assert.equal((await recall('racecanary')).results.length, 1);
    const lstat = fs.lstat; let removed = false;
    fs.lstat = async (...args) => {
      const result = await lstat(...args);
      if (path.resolve(String(args[0])) === canonicalFile && !removed) {
        removed = true; await fs.remove(file);
      }
      return result;
    };
    try { assert.equal((await recall('racecanary')).results.length, 0); }
    finally { fs.lstat = lstat; }
    assert(removed);
  });
  console.log(checks + ' retrieval-index groups passed');
} finally {
  os.homedir = actualHomedir;
  await fs.remove(scratch);
}
