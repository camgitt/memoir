import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-audit-regression-'));
process.env.HOME = scratch;
process.env.USERPROFILE = scratch;
process.env.APPDATA = path.join(scratch, 'AppData', 'Roaming');
process.env.XDG_CONFIG_HOME = path.join(scratch, '.config');
process.env.DO_NOT_TRACK = '1';
process.env.CI = '1';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = path.join(scratch, 'gitconfig');
const projectA = path.join(scratch, 'client-a', 'api');
const projectB = path.join(scratch, 'client-b', 'api');
await fs.ensureDir(projectA);
await fs.ensureDir(projectB);
process.env.MEMOIR_PROJECT_ROOT = projectA;

const files = await import('./src/security/files.js');
const encryption = await import('./src/security/encryption.js');
const storage = await import('./src/cloud/storage.js');
const state = await import('./src/session/state.js');
const { searchMemories, clearSearchCache } = await import('./src/memory/search.js');
const { withSessionLock } = await import('./src/session/lock.js');
const { syncToGit } = await import('./src/providers/index.js');
const { extractMemories } = await import('./src/adapters/index.js');
const { spawnMcpClient } = await import('./test-mcp-helpers.mjs');
const spinner = { text: '', start() { return this; }, stop() {}, succeed() {}, fail() {}, info() {} };
const passphrase = 'synthetic recovery secret for tests';
let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log('PASS ' + name);
}
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Network prohibited in regression tests'); };
let mcp;
try {
  await check('portable path validation rejects traversal, absolute paths and metadata paths', async () => {
    for (const bad of ['../escape.md', '/tmp/escape.md', 'C:\\escape.md', '\\\\server\\share\\x.md', 'a/../../x.md', '.git/config', 'CON.txt', 'a/../b.md']) {
      assert.throws(() => files.relativeFile(bad));
    }
    assert.equal(files.relativeFile('nested\\世界.md'), 'nested/世界.md');
  });

  const safeRoot = path.join(scratch, 'safe');
  await fs.ensureDir(safeRoot);
  const outside = path.join(scratch, 'outside.txt');
  await fs.writeFile(outside, 'outside-original');
  if (process.platform !== 'win32') {
    await fs.symlink(outside, path.join(safeRoot, 'link.md'));
    await check('read and write reject symlinks without changing their targets', async () => {
      await assert.rejects(files.readSafeFile(safeRoot, 'link.md'));
      await assert.rejects(files.writeSafeFile(safeRoot, 'link.md', 'bad'));
      assert.equal(await fs.readFile(outside, 'utf8'), 'outside-original');
    });
  }

  const encSource = path.join(scratch, 'encrypt-source');
  const encDir = path.join(scratch, 'encrypted');
  await fs.ensureDir(encSource);
  await fs.writeFile(path.join(encSource, 'a.md'), 'alpha');
  await fs.writeFile(path.join(encSource, 'b.md'), 'bravo');
  await encryption.encryptDirectory(encSource, encDir, passphrase);
  const dest = path.join(scratch, 'restore-destination');
  await fs.ensureDir(dest);
  await fs.writeFile(path.join(dest, 'keep.txt'), 'unchanged');
  await check('missing encrypted blob fails before any destination changes', async () => {
    const manifest = JSON.parse((await encryption.decryptBuffer(await fs.readFile(path.join(encDir, 'manifest.enc')), passphrase)).toString());
    const missing = path.join(encDir, 'data', Object.keys(manifest.files)[1] + '.enc');
    const data = await fs.readFile(missing);
    await fs.remove(missing);
    await assert.rejects(encryption.decryptDirectory(encDir, dest, passphrase));
    assert.deepEqual(await fs.readdir(dest), ['keep.txt']);
    await fs.writeFile(missing, data);
  });
  await check('ciphertext cannot be swapped between manifest entries', async () => {
    const names = await fs.readdir(path.join(encDir, 'data'));
    const a = await fs.readFile(path.join(encDir, 'data', names[0]));
    const b = await fs.readFile(path.join(encDir, 'data', names[1]));
    await fs.writeFile(path.join(encDir, 'data', names[0]), b);
    await fs.writeFile(path.join(encDir, 'data', names[1]), a);
    await assert.rejects(encryption.decryptDirectory(encDir, dest, passphrase));
    assert.deepEqual(await fs.readdir(dest), ['keep.txt']);
  });
  await check('cloud restore rejects traversal and duplicate paths transactionally', async () => {
    for (const entries of [
      [{ path: 'ok.md', content: 'b2s=' }, { path: '../escape.md', content: 'YmFk' }],
      [{ path: 'same.md', content: 'b2s=' }, { path: 'SAME.md', content: 'YmFk' }],
      [{ path: 'dir', content: 'b2s=' }, { path: 'dir/file.md', content: 'YmFk' }],
    ]) {
      await assert.rejects(storage.unbundleToDir(gzipSync(JSON.stringify(entries)), dest));
      assert.deepEqual(await fs.readdir(dest), ['keep.txt']);
    }
  });
  await check('cloud writes need a user secret and cannot be decrypted from account ID', async () => {
    const session = { user: { id: 'synthetic-user' }, access_token: 'synthetic-token' };
    const oldPass = process.env.MEMOIR_PASSPHRASE;
    delete process.env.MEMOIR_PASSPHRASE;
    delete process.env.MEMOIR_CLOUD_PASSPHRASE;
    await assert.rejects(storage.uploadBackup(encSource, session, []), /user-held passphrase/);
    let ciphertext;
    globalThis.fetch = async (url, options = {}) => {
      if (String(url).includes('/storage/') && options.method === 'POST') {
        ciphertext = options.body;
        return { ok: true };
      }
      if (String(url).includes('memoir_next_backup_version')) return { ok: true, json: async () => 1 };
      if (String(url).includes('/rest/') && options.method === 'POST') {
        assert.ok(!options.body.includes(passphrase));
        return { ok: true, json: async () => [{ ...JSON.parse(options.body), id: 'test-backup' }] };
      }
      if (String(url).includes('/storage/')) return { ok: true, arrayBuffer: async () => ciphertext };
      throw new Error('Unexpected fetch');
    };
    const backup = await storage.uploadBackup(encSource, session, [], { passphrase });
    assert.equal(ciphertext.subarray(0, 8).toString(), 'MEMOIRC2');
    await assert.rejects(encryption.decryptBuffer(ciphertext.subarray(8), 'memoir-cloud:' + session.user.id));
    const restored = path.join(scratch, 'cloud-restored');
    assert.equal(await storage.downloadBackup(backup, restored, session, { passphrase }), 2);
    assert.equal(await fs.readFile(path.join(restored, 'b.md'), 'utf8'), 'bravo');
    if (oldPass) process.env.MEMOIR_PASSPHRASE = oldPass;
    globalThis.fetch = async () => { throw new Error('Network prohibited'); };
  });

  await check('contended or old living locks never execute an unlocked callback', async () => {
    const lock = path.join(scratch, 'held.lock');
    await fs.writeFile(lock, String(process.pid));
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lock, old, old);
    let ran = false;
    await assert.rejects(withSessionLock(lock, async () => { ran = true; }, { maxWaitMs: 80 }), { code: 'ELOCKED' });
    assert.equal(ran, false);
    assert.equal(await fs.readFile(lock, 'utf8'), String(process.pid));
    await fs.remove(lock);
  });

  await check('older decisions remain durable and searchable beyond the working-set cap', async () => {
    for (let i = 0; i < 35; i++) await state.addNote('durable-memory-' + i, { why: 'verified rationale' });
    const session = await state.readSession();
    assert.equal(session.current.decisions.filter(d => !d.hidden).length, 10);
    assert.equal(state.allDecisions(session).filter(d => !d.hidden).length, 35);
    const result = await searchMemories('durable-memory-0', { project: projectA });
    assert.ok(result.results.some(r => r.passage.includes('durable-memory-0')));
  });
  await check('more than ten deletions survive stale-replica merges', async () => {
    const stale = await state.readSession();
    for (let i = 0; i < 20; i++) assert.equal((await state.hideDecision('durable-memory-' + i)).hidden, true);
    const merged = state.mergeSessions(await state.readSession(), stale);
    for (let i = 0; i < 20; i++) assert.ok(!state.allDecisions(merged).some(d => d.text === 'durable-memory-' + i && !d.hidden));
    await state.writeSession(merged);
  });

  await fs.ensureDir(path.join(scratch, '.gemini'));
  await fs.writeFile(path.join(scratch, '.gemini', 'oauth_creds.json'), '{"token":"synthetic-not-a-real-key"}');
  mcp = await spawnMcpClient({ scratchHome: scratch, env: { MEMOIR_PROJECT_ROOT: projectA } });
  await mcp.initialize();
  const text = r => r.content.map(c => c.text || '').join('\n');
  await check('MCP file boundary rejects traversal and excluded credentials', async () => {
    assert.equal((await mcp.callTool('memoir_remember', { filename: '../../escape.md', content: 'bad' })).isError, true);
    assert.equal((await mcp.callTool('memoir_read', { tool: 'gemini', filepath: 'oauth_creds.json' })).isError, true);
    await fs.writeFile(path.join(scratch, 'private.txt'), 'synthetic-private');
    assert.equal((await mcp.callTool('memoir_read', { tool: 'aider', filepath: 'private.txt' })).isError, true);
  });
  await check('Gemini-origin memory is immediately recallable across clients', async () => {
    const saved = await mcp.callTool('memoir_remember', { filename: 'gemini-test.md', content: 'quartznebula uses deterministic recovery', tool: 'gemini' });
    assert.notEqual(saved.isError, true);
    const result = await mcp.callTool('memoir_recall', { query: 'quartznebula' });
    assert.match(text(result), /deterministic recovery/);
    const id = text(saved).match(/[a-f0-9]{64}/)[0];
    assert.match(text(await mcp.callTool('memoir_read', { tool: 'memoir', filepath: id + '.md' })), /quartznebula/);
  });
  await check('same-name memories remain isolated by project', async () => {
    await mcp.callTool('memoir_remember', { filename: 'choice.md', content: 'isolationmarker client-a-only', project: projectA });
    await mcp.callTool('memoir_remember', { filename: 'choice.md', content: 'isolationmarker client-b-only', project: projectB });
    const a = text(await mcp.callTool('memoir_recall', { query: 'isolationmarker' }));
    assert.match(a, /client-a-only/);
    assert.doesNotMatch(a, /client-b-only/);
    const b = text(await mcp.callTool('memoir_recall', { query: 'isolationmarker', project: projectB }));
    assert.match(b, /client-b-only/);
    assert.doesNotMatch(b, /client-a-only/);
  });
  await check('hidden memories and forgotten decisions are excluded from every recall view', async () => {
    await mcp.callTool('memoir_remember', { filename: 'hidden.md', content: '---\nhidden: true\n---\nneverreturnsecretmarker' });
    assert.match(text(await mcp.callTool('memoir_recall', { query: 'neverreturnsecretmarker' })), /No memories found/);
    await mcp.callTool('memoir_note', { text: 'temporary-secret-marker' });
    assert.notEqual((await mcp.callTool('memoir_forget', { text: 'temporary-secret-marker' })).isError, true);
    assert.doesNotMatch(text(await mcp.callTool('memoir_session', {})), /temporary-secret-marker/);
    assert.match(text(await mcp.callTool('memoir_recall', { query: 'temporary-secret-marker' })), /No memories found/);
  });
  await check('Unicode recall finds saved Chinese evidence', async () => {
    await mcp.callTool('memoir_remember', { filename: 'database.md', content: '数据库使用 PostgreSQL，备份每天运行。' });
    assert.match(text(await mcp.callTool('memoir_recall', { query: '数据库' })), /PostgreSQL/);
  });
  await check('MCP consolidation uses scoped readable records without handler errors', async () => {
    const result = await mcp.callTool('memoir_consolidate', {});
    assert.notEqual(result.isError, true);
    assert.match(text(result), /Consolidation Report/);
    assert.doesNotMatch(text(result), /oauth_creds/);
  });
  await mcp.close();
  mcp = null;

  await check('same-basename project exports preserve both source projects', async () => {
    await fs.writeFile(path.join(projectA, 'CLAUDE.md'), 'source project A');
    await fs.writeFile(path.join(projectB, 'CLAUDE.md'), 'source project B');
    const staging = path.join(scratch, 'project-staging');
    await fs.ensureDir(staging);
    await extractMemories(staging, spinner, ['projects']);
    const manifest = await fs.readJson(path.join(staging, 'projects.json'));
    assert.equal(Object.values(manifest).filter(p => p.name === 'api').length, 2);
    const saved = await Promise.all(Object.keys(manifest).map(key => fs.readFile(path.join(staging, 'projects', key, 'CLAUDE.md'), 'utf8')));
    assert.ok(saved.includes('source project A'));
    assert.ok(saved.includes('source project B'));
  });

  await check('partial Git updates preserve another tool and files absent locally', async () => {
    const remote = path.join(scratch, 'backup.git');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', remote], { stdio: 'ignore' });
    const full = path.join(scratch, 'git-full'), partial = path.join(scratch, 'git-partial');
    await fs.outputFile(path.join(full, 'claude-cli', 'a.md'), 'alpha');
    await fs.outputFile(path.join(full, 'claude-cli', 'other-machine.md'), 'other machine');
    await fs.outputFile(path.join(full, 'gemini-cli', 'b.md'), 'bravo');
    await syncToGit({ gitRepo: remote }, full, spinner);
    await fs.outputFile(path.join(partial, 'claude-cli', 'a.md'), 'updated');
    await syncToGit({ gitRepo: remote }, partial, spinner, { additive: true });
    const tree = execFileSync('git', ['--git-dir=' + remote, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' });
    assert.match(tree, /gemini-cli\/b.md/);
    assert.match(tree, /claude-cli\/other-machine.md/);
  });

  await check('repeated encrypted real pushes preserve session and migrate plaintext', async () => {
    const { pushCommand } = await import('./src/commands/push.js');
    const backup = path.join(scratch, 'local-backup');
    const configPath = process.platform === 'win32' ? path.join(process.env.APPDATA, 'memoir', 'config.json') : path.join(scratch, '.config', 'memoir', 'config.json');
    const config = { version: 2, activeProfile: 'default', profiles: { default: { provider: 'local', localPath: backup, encrypt: false } } };
    await fs.outputJson(configPath, config);
    await fs.writeFile(path.join(scratch, '.gemini', 'GEMINI.md'), 'synthetic tool configuration');
    await pushCommand({ only: 'gemini' });
    assert.ok(await fs.pathExists(path.join(backup, 'session.json')));
    config.profiles.default.encrypt = true;
    await fs.writeJson(configPath, config);
    process.env.MEMOIR_PASSPHRASE = passphrase;
    for (let i = 0; i < 10; i++) {
      await pushCommand({ only: 'gemini' });
      assert.ok(!await fs.pathExists(path.join(backup, 'session.json')));
      const restored = path.join(scratch, 'roundtrip-' + i);
      await encryption.decryptDirectory(backup, restored, passphrase);
      const restoredState = await fs.readJson(path.join(restored, 'session.json'));
      assert.ok(state.allDecisions(restoredState).length >= 35);
      assert.ok(await fs.pathExists(path.join(restored, 'memoir-memories')));
    }
  });

  await check('canonical purge cannot be undone by stale current records or history', async () => {
    const store = await import('./src/memory/store.js');
    const record = await store.rememberMemory({ filename: 'purge-regression.md', content: 'purge-marker-original', project: projectA });
    await store.rememberMemory({ filename: 'purge-regression.md', content: 'purge-marker-revised', project: projectA });
    const stale = path.join(scratch, 'stale-canonical');
    await store.stageMemories(stale);
    await store.forgetStoredMemory(record.id, { purge: true, project: projectA });
    await store.restoreStoredMemories(stale);
    assert.ok(!await fs.pathExists(path.join(store.memoryRoot, 'history', record.id)));
    const current = await fs.readFile(path.join(store.memoryRoot, record.id + '.md'), 'utf8');
    assert.match(current, /purged: true/);
    assert.doesNotMatch(current, /purge-marker/);
    assert.equal((await searchMemories('purge-marker', { project: projectA })).results.length, 0);
    const before = await fs.readFile(path.join(store.memoryRoot, record.id + '.md'));
    await fs.outputFile(path.join(stale, 'memoir-memories', 'f'.repeat(64) + '.md'), 'invalid metadata');
    await assert.rejects(store.restoreStoredMemories(stale), /Invalid canonical/);
    assert.deepEqual(await fs.readFile(path.join(store.memoryRoot, record.id + '.md')), before);
  });

  await check('client setup preserves configuration, is idempotent, and starts the server', async () => {
    const { setupIntegrations } = await import('./src/integrations/setup.js');
    const { parse } = await import('smol-toml');
    const project = path.join(scratch, 'integration-project');
    await fs.outputFile(path.join(project, '.codex', 'config.toml'), '# user comment\nmodel = "user-choice"\n');
    await fs.outputJson(path.join(project, '.mcp.json'), { mcpServers: { existing: { command: 'preserved' } }, custom: true });
    const first = await setupIntegrations({ project, tool: 'all' });
    assert.ok(first.every(r => r.status === 'configured' && r.verified));
    const config = await fs.readJson(path.join(project, '.mcp.json'));
    assert.equal(config.mcpServers.existing.command, 'preserved');
    assert.equal(config.custom, true);
    const toml = await fs.readFile(path.join(project, '.codex/config.toml'), 'utf8');
    assert.match(toml, /# user comment/);
    assert.equal(parse(toml).model, 'user-choice');
    assert.equal(parse(toml).mcp_servers.memoir.env.MEMOIR_PROJECT_ROOT, await fs.realpath(project));
    const second = await setupIntegrations({ project, tool: 'all', check: false });
    assert.ok(second.every(r => r.status === 'ready'));
    assert.equal(await fs.readFile(path.join(project, '.codex/config.toml'), 'utf8'), toml);
  });

  await check('resume brief scopes goals and reports checkout drift without claiming tests pass', async () => {
    const { buildResumeBrief } = await import('./src/session/brief.js');
    const project = path.join(scratch, 'resume-project');
    await fs.ensureDir(project);
    const git = args => execFileSync('git', args, { cwd: project, stdio: 'ignore' });
    git(['init']);
    await fs.writeFile(path.join(project, 'file.txt'), 'one');
    git(['add', '.']); git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'one']);
    process.env.MEMOIR_PROJECT_ROOT = project;
    await state.addGoal('resume-only-goal');
    await state.addNext('verify-current-checkout');
    await state.recordSessionEnd({ summary: 'Saved observed checkout', project });
    assert.equal((await buildResumeBrief(project)).code_changed_since_observation, false);
    await fs.writeFile(path.join(project, 'file.txt'), 'two');
    git(['add', '.']); git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'two']);
    const brief = await buildResumeBrief(project);
    assert.equal(brief.code_changed_since_observation, true);
    assert.equal(brief.objective.text, 'resume-only-goal');
    assert.match(brief.verification, /No current test result is implied/);
    assert.notEqual((await buildResumeBrief(projectA)).objective?.text, 'resume-only-goal');
    const { resumeCommand } = await import('./src/commands/resume.js');
    await fs.writeFile(path.join(project, 'AGENTS.md'), '# Project rules\nPreserve these instructions.\n');
    await resumeCommand({ project, inject: true, to: 'codex' });
    const once = await fs.readFile(path.join(project, 'AGENTS.md'), 'utf8');
    await resumeCommand({ project, inject: true, to: 'codex' });
    assert.equal(await fs.readFile(path.join(project, 'AGENTS.md'), 'utf8'), once);
    assert.match(once, /Preserve these instructions/);
    await resumeCommand({ project, inject: true, to: 'cursor' });
    assert.ok((await fs.readFile(path.join(project, '.cursor/rules/memoir-resume.mdc'), 'utf8')).startsWith('---\n'));

    process.env.MEMOIR_PROJECT_ROOT = projectA;
  });

  await check('cloud legacy migration plans first, retains failed originals, and resumes verified replacement', async () => {
    const session = { user: { id: 'migration-user' }, access_token: 'test' };
    const old = { id: 'legacy-one', user_id: session.user.id, version: 1, storage_path: 'migration-user/old.gz', tools: ['gemini'], encryption_format: 'legacy' };
    const objects = new Map([[old.storage_path, await encryption.encryptBuffer(await storage.bundleDir(encSource), 'memoir-cloud:' + session.user.id)]]);
    const rows = [old];
    let version = 1, uploads = 0, deletes = 0, corrupt = true;
    globalThis.fetch = async (url, options = {}) => {
      const target = String(url), method = options.method || 'GET';
      if (target.includes('memoir_next_backup_version')) return { ok: true, json: async () => ++version };
      if (target.includes('/storage/')) {
        const key = target.slice(target.indexOf('/migration-user/') + 1);
        if (method === 'POST') { objects.set(key, options.body); uploads++; return { ok: true }; }
        if (method === 'DELETE') {
          assert.ok(target.endsWith('/storage/v1/object/memoir-backups'));
          const { prefixes } = JSON.parse(options.body);
          assert.equal(prefixes.length, 1);
          objects.delete(prefixes[0]); deletes++; return { ok: true };
        }
        return { ok: true, arrayBuffer: async () => corrupt && key !== old.storage_path ? Buffer.from('corrupt') : objects.get(key) };
      }
      if (method === 'POST') { const row = JSON.parse(options.body); rows.unshift(row); return { ok: true, json: async () => [row] }; }
      if (method === 'DELETE') { rows.splice(rows.findIndex(row => target.includes(encodeURIComponent(row.id))), 1); return { ok: true }; }
      return { ok: true, json: async () => [...rows] };
    };
    assert.equal((await storage.migrateCloudBackups(session)).planned, 1);
    assert.equal(uploads, 0);
    await assert.rejects(storage.migrateCloudBackups(session, { apply: true, passphrase }));
    assert.equal(deletes, 0);
    assert.ok(objects.has(old.storage_path));
    corrupt = false;
    assert.equal((await storage.migrateCloudBackups(session, { apply: true, passphrase })).migrated, 1);
    assert.equal(uploads, 1);
    assert.equal(deletes, 1);
    assert.ok(!objects.has(old.storage_path));
    globalThis.fetch = async () => { throw new Error('Network prohibited'); };
  });

  await check('workspace snapshots are explicit, bounded, verified, and recover into a separate directory', async () => {
    const { scanWorkspace, restoreWorkspace } = await import('./src/workspace/tracker.js');
    const project = path.join(scratch, 'workspace-project');
    await fs.outputFile(path.join(project, 'src', 'app.js'), 'export const answer = 42;\n');
    await fs.writeFile(path.join(project, '.env'), 'PASSWORD=synthetic-private');
    const backup = path.join(scratch, 'workspace-backup');
    const manifest = await scanWorkspace(backup, spinner, { project });
    assert.equal(manifest.projects.length, 1);
    assert.ok(manifest.projects[0].omitted.some(f => f.path === '.env'));
    const result = await restoreWorkspace(backup, spinner, true);
    assert.equal(result.unpacked.length, 1);
    assert.notEqual(result.unpacked[0].path, project);
    assert.equal(await fs.readFile(path.join(result.unpacked[0].path, 'src/app.js'), 'utf8'), 'export const answer = 42;\n');
    manifest.projects[0].files[0].path = '../escape.js';
    await fs.writeJson(path.join(backup, 'workspace.json'), manifest);
    await assert.rejects(restoreWorkspace(backup, spinner, true));
    await fs.writeJson(path.join(backup, 'workspace.json'), { version: 1, projects: [{ bundleFile: 'evil.tar.gz' }] });
    await assert.rejects(restoreWorkspace(backup, spinner, true), /Legacy workspace/);
  });

  await check('consolidation archives can be undone and never overwrite a new file', async () => {
    const { archiveFile, undoArchive } = await import('./src/commands/consolidate.js');
    const { adapters } = await import('./src/adapters/index.js');
    const adapter = adapters.find(a => a.name.toLowerCase().includes('gemini'));
    const content = 'recovery-only-fixture';
    await fs.writeFile(path.join(adapter.source, 'GEMINI.md'), content);
    const id = await archiveFile({ tool: adapter.name, path: 'GEMINI.md', content });
    assert.ok(!await fs.pathExists(path.join(adapter.source, 'GEMINI.md')));
    await undoArchive(id);
    assert.equal(await fs.readFile(path.join(adapter.source, 'GEMINI.md'), 'utf8'), content);
    await assert.rejects(undoArchive(id), /target exists/);
  });


  await check('Git reads main even when remote HEAD is master and preserves prior files during encryption', async () => {
    const { cloneForSync, remoteHasFile } = await import('./src/providers/index.js');
    const remote = path.join(scratch, 'master-default.git');
    execFileSync('git', ['init','--bare','--initial-branch=master',remote], {stdio:'ignore'});
    const old = path.join(scratch, 'old-git-files');
    await fs.outputFile(path.join(old,'gemini-cli','only-on-prior-machine.md'),'prior snapshot without session');
    await fs.outputJson(path.join(old,'projects.json'),{'remote-only-project':{relative_path:'remote-project',identity:'local:'+'a'.repeat(32)}});
    await syncToGit({gitRepo:remote},old,spinner);
    execFileSync('git',['--git-dir='+remote,'update-ref','refs/heads/master','refs/heads/main'],{stdio:'ignore'});
    const newer = path.join(scratch,'new-main-files');
    await fs.outputFile(path.join(newer,'gemini-cli','new-main-only.md'),'new main content');
    await syncToGit({gitRepo:remote},newer,spinner,{additive:true});
    const peek = path.join(scratch,'main-peek'); await fs.ensureDir(peek);
    cloneForSync(remote,peek);
    assert.equal(remoteHasFile(peek,'gemini-cli/new-main-only.md'),true);
    const configPath = process.platform === 'win32' ? path.join(process.env.APPDATA,'memoir/config.json') : path.join(scratch,'.config/memoir/config.json');
    await fs.outputJson(configPath,{version:2,activeProfile:'default',profiles:{default:{provider:'git',gitRepo:remote,encrypt:true}}});
    const { pushCommand } = await import('./src/commands/push.js');
    await pushCommand({only:'gemini'});
    const tree = execFileSync('git',['--git-dir='+remote,'ls-tree','-r','--name-only','main'],{encoding:'utf8'});
    assert.doesNotMatch(tree, /gemini-cli|session.json|memoir-memories/);
    const encrypted = path.join(scratch,'encrypted-git-read'); await fs.ensureDir(encrypted);
    cloneForSync(remote,encrypted);
    const { checkoutFromRemote } = await import('./src/providers/index.js');
    assert.equal(checkoutFromRemote(encrypted,'.'),true);
    const plain = path.join(scratch,'encrypted-git-plain');
    await encryption.decryptDirectory(encrypted,plain,passphrase);
    assert.equal(await fs.readFile(path.join(plain,'gemini-cli/only-on-prior-machine.md'),'utf8'),'prior snapshot without session');
    assert.equal(await fs.readFile(path.join(plain,'gemini-cli/new-main-only.md'),'utf8'),'new main content');
    assert.ok((await fs.readJson(path.join(plain,'projects.json')))['remote-only-project']);

  });

  await check('local backup lock covers the entire read-merge-write operation', async () => {
    const { withLocalBackupLock } = await import('./src/providers/index.js');
    const config = { localPath: path.join(scratch, 'concurrent-backup') };
    let active = 0, maximum = 0, completed = 0;
    const operation = () => withLocalBackupLock(config, async () => {
      active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 60));
      completed++; active--;
    });
    await Promise.all([operation(), operation(), operation()]);
    assert.equal(maximum, 1);
    assert.equal(completed, 3);
  });

  console.log('\n' + passed + ' audit regression groups passed');
} finally {
  if (mcp) await mcp.close();
  globalThis.fetch = originalFetch;
  await fs.remove(scratch);
}
