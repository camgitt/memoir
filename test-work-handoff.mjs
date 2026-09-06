import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parse as parseToml } from 'smol-toml';
import { recordWork, runWorkCheck, retractWork, resumeWork, refreshWork, formatWork, readWork } from './src/work/store.js';
import { setupWork, workCommand } from './src/work/setup.js';

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-work-'));
const repo = path.join(scratch, "project with spaces and 'quotes'");
await fs.ensureDir(repo);
const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
git('init', '-b', 'main');
await fs.writeFile(path.join(repo, 'source.js'), 'export const amount = 10;\n');
await fs.writeFile(path.join(repo, 'check.cjs'), 'process.exit(0);\n');
await fs.writeFile(path.join(repo, 'package.json'), '{"name":"handoff-fixture","private":true}');
git('add', '.');
git('-c', 'user.name=Memoir Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Fixture');
let count = 0;
async function test(label, fn) { await fn(); count++; console.log('PASS ' + label); }
const answer = { id: 'answer.provider', kind: 'answer', text: 'Payment provider?', answer: 'ExamplePay', source: 'User in handoff fixture' };
const check = { id: 'checkout', title: 'Local checkout smoke', command: [process.execPath, 'check.cjs'], files: ['source.js', 'check.cjs'] };
try {
  await test('answers and rationale survive a fresh read; stale corrections fail', async () => {
    const saved = await recordWork(repo, answer);
    await assert.rejects(recordWork(repo, { ...answer, answer: 'Changed' }), /expected_revision/);
    await recordWork(repo, { ...answer, answer: 'CorrectedPay', expected_revision: saved.revision });
    await recordWork(repo, { id: 'decision.retry', kind: 'decision', text: 'Use stable event IDs', why: 'Retries must not double count', source: 'Project decision' });
    const view = await resumeWork(repo);
    assert.equal(view.records.find(r => r.id === answer.id).answer, 'CorrectedPay');
    assert.equal((await readWork(repo)).records.filter(r => r.id === answer.id).length, 2);
  });
  await test('personal scopes and known secrets never enter the handoff', async () => {
    for (const input of [{ ...answer, scope: 'personal' }, { ...answer, id: 'secret', answer: 'sk_test_' + 'x'.repeat(30) }, { ...answer, id: 'credential', answer: 'password: abcdefg' }]) await assert.rejects(recordWork(repo, input));
    const raw = await fs.readFile(path.join(repo, '.memoir/work.json'), 'utf8');
    assert.ok(!raw.includes('sk_test_') && !raw.includes('abcdefg'));
  });
  await test('captured execution includes evidence and automatically includes manifests', async () => {
    const receipt = await runWorkCheck(repo, check);
    assert.equal(receipt.exit_code, 0);
    assert.ok(receipt.inputs['package.json']);
    assert.equal((await resumeWork(repo)).checks[0].freshness, 'inputs-match');
  });
  await test('unrelated edits preserve results; uncommitted input edits explain a recheck', async () => {
    await fs.writeFile(path.join(repo, 'unrelated.md'), 'New copy');
    assert.equal((await resumeWork(repo)).checks[0].freshness, 'inputs-match');
    await fs.appendFile(path.join(repo, 'source.js'), '// changed\n');
    const stale = (await resumeWork(repo)).checks[0];
    assert.equal(stale.freshness, 'needs-recheck');
    assert.ok(stale.reasons.includes('Changed input: source.js'));
    await runWorkCheck(repo, check);
    assert.equal((await resumeWork(repo)).checks[0].freshness, 'inputs-match');
  });
  await test('failed, timed out and externally scoped checks cannot appear current', async () => {
    await runWorkCheck(repo, { ...check, id: 'failed', command: [process.execPath, '-e', 'process.exit(1)'] });
    await runWorkCheck(repo, { ...check, id: 'timeout', timeout_ms: 100, command: [process.execPath, '-e', 'setTimeout(()=>{},10000)'] });
    await runWorkCheck(repo, { ...check, id: 'external', environment: 'external' });
    for (const c of (await resumeWork(repo)).checks.filter(c => c.id !== 'checkout')) assert.equal(c.freshness, 'needs-recheck');
  });
  await test('a newly added lockfile invalidates earlier dependency observations', async () => {
    await fs.writeFile(path.join(repo, 'package-lock.json'), '{"lockfileVersion":3}');
    assert.ok((await resumeWork(repo)).checks.find(c => c.id === 'checkout').reasons.includes('New dependency input: package-lock.json'));
    await runWorkCheck(repo, check);
    assert.equal((await resumeWork(repo)).checks.find(c => c.id === 'checkout').freshness, 'inputs-match');
  });
  await test('checks changing their own inputs are marked for recheck', async () => {
    await runWorkCheck(repo, { ...check, id: 'changes-input', command: [process.execPath, '-e', "require('fs').appendFileSync('source.js','// during check\\n')"] });
    assert.ok((await resumeWork(repo)).checks.find(c => c.id === 'changes-input').reasons.includes('Inputs changed while the check ran.'));
  });
  await test('raw command output and its secrets are not retained', async () => {
    const secret = 'whsec_' + 'x'.repeat(30);
    await fs.writeFile(path.join(repo, 'output.cjs'), `console.log(${JSON.stringify(secret)}); console.log('PERSONAL_CANARY');`);
    const receipt = await runWorkCheck(repo, { ...check, id: 'private-output', command: [process.execPath, 'output.cjs'], files: ['output.cjs'] });
    assert.ok(receipt.output_bytes > 0);
    await refreshWork(repo);
    for (const file of ['work.json', 'HANDOFF.md']) {
      const raw = await fs.readFile(path.join(repo, '.memoir', file), 'utf8');
      assert.ok(!raw.includes(secret) && !raw.includes('PERSONAL_CANARY'));
    }
  });
  await test('check input traversal, symlinks and credential files are rejected', async () => {
    await fs.writeFile(path.join(scratch, 'outside'), 'private');
    if (process.platform !== 'win32') await fs.symlink(path.join(scratch, 'outside'), path.join(repo, 'link'));
    for (const input of ['../outside', '.env', ...(process.platform !== 'win32' ? ['link'] : [])]) await assert.rejects(runWorkCheck(repo, { ...check, files: [input] }));
  });
  await test('branch changes exclude prior branch decisions and answers', async () => {
    git('checkout', '-b', 'other');
    assert.equal((await resumeWork(repo)).records.length, 0);
    assert.equal((await resumeWork(repo)).checks.length, 0);
    git('checkout', 'main');
    assert.ok((await resumeWork(repo)).records.length > 0);
  });
  await test('completion and retraction are durable and reversible by explicit correction', async () => {
    const next = await recordWork(repo, { id: 'next.test', kind: 'next', text: 'Add test', source: 'Fixture' });
    const done = await recordWork(repo, { id: 'next.test', kind: 'next', text: 'Add test', source: 'Fixture result', status: 'done', expected_revision: next.revision });
    await retractWork(repo, { id: done.id, expected_revision: done.revision });
    assert.ok(!(await resumeWork(repo)).records.some(r => r.id === done.id));
    await recordWork(repo, { id: done.id, kind: 'next', text: 'Add test', source: 'Correction', expected_revision: done.revision });
    assert.equal((await resumeWork(repo)).records.find(r => r.id === done.id).status, 'open');
  });
  await test('concurrent writes are serialized without dropping records', async () => {
    await Promise.all(Array.from({ length: 8 }, (_, i) => recordWork(repo, { id: 'parallel.' + i, kind: 'decision', text: 'Decision ' + i, source: 'Fixture' })));
    assert.equal((await resumeWork(repo)).records.filter(r => r.id.startsWith('parallel.')).length, 8);
  });
  await test('setup preserves existing settings and instructions, with exact backups', async () => {
    await fs.outputFile(path.join(repo, '.codex/config.toml'), '# user comment\nmodel_reasoning_effort = "low"\n');
    await fs.outputJson(path.join(repo, '.cursor/mcp.json'), { mcpServers: { existing: { command: 'unchanged' } }, other: true });
    await fs.writeFile(path.join(repo, 'AGENTS.md'), '# Existing instructions\nKeep this exactly.\n');
    const setup = await setupWork(repo);
    assert.equal(setup.verified_server, true);
    assert.match(await fs.readFile(path.join(repo, 'AGENTS.md'), 'utf8'), /^# Existing instructions\nKeep this exactly\.\n/);
    const config = await fs.readFile(path.join(repo, '.codex/config.toml'), 'utf8');
    assert.match(config, /^# user comment\n/);
    assert.equal(parseToml(config).model_reasoning_effort, 'low');
    assert.equal((await fs.readJson(path.join(repo, '.cursor/mcp.json'))).mcpServers.existing.command, 'unchanged');
    assert.equal(await fs.readFile(path.join(repo, setup.backup, 'AGENTS.md'), 'utf8'), '# Existing instructions\nKeep this exactly.\n');
    assert.deepEqual((await setupWork(repo)).updated, []);
  });
  await test('existing different project connection is preserved with an explicit warning', async () => {
    const file = path.join(repo, '.cursor/mcp.json');
    const value = await fs.readJson(file);
    value.mcpServers['memoir-work'].command = 'existing-custom-command';
    await fs.writeJson(file, value);
    const before = await fs.readFile(file, 'utf8');
    const result = await setupWork(repo);
    assert.equal(await fs.readFile(file, 'utf8'), before);
    assert.ok(result.warnings.some(w => w.includes('preserved')));
  });
  await test('real MCP clients share the record across server restarts', async () => {
    const server = fileURLToPath(new URL('./src/work/server.js', import.meta.url));
    for (let i = 0; i < 2; i++) {
      const client = new Client({ name: 'handoff-client-' + i, version: '1' });
      const transport = new StdioClientTransport({ command: process.execPath, args: [server], env: { ...process.env, MEMOIR_PROJECT_ROOT: repo, DO_NOT_TRACK: '1' }, stderr: 'pipe' });
      try {
        await client.connect(transport);
        assert.equal((await client.listTools()).tools.length, 4);
        if (!i) assert.ok(!(await client.callTool({ name: 'memoir_work_record', arguments: { record: { id: 'answer.cross-client', kind: 'answer', text: 'Chosen approach?', answer: 'Content fingerprints', source: 'First client' } } })).isError);
        const result = await client.callTool({ name: 'memoir_work_resume', arguments: {} });
        assert.match(result.content[0].text, /Content fingerprints/);
      } finally { await client.close(); }
    }
  });
  await test('CLI fallback works with spaces in paths and captures a real check', async () => {
    const cli = fileURLToPath(new URL('./bin/memoir-work.js', import.meta.url));
    const result = spawnSync(process.execPath, [cli, '--project', repo, 'check', 'cli', '--title', 'CLI check', '--files', 'source.js', '--', process.execPath, 'check.cjs'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).exit_code, 0);
    if (process.platform !== 'win32') {
      const fallback = spawnSync('/bin/sh', ['-c', `${workCommand(repo)} resume`], { encoding: 'utf8' });
      assert.equal(fallback.status, 0, fallback.stderr);
      assert.match(fallback.stdout, /CorrectedPay/);
    }
  });
  await test('damaged and foreign-scope imported ledgers are preserved and rejected', async () => {
    const file = path.join(repo, '.memoir/work.json');
    const before = await fs.readFile(file, 'utf8');
    const foreign = JSON.parse(before); foreign.records[0].scope = 'personal';
    await fs.writeJson(file, foreign);
    await assert.rejects(resumeWork(repo));
    await fs.writeFile(file, '{ damaged');
    await assert.rejects(recordWork(repo, answer));
    assert.equal(await fs.readFile(file, 'utf8'), '{ damaged');
    await fs.writeFile(file, before);
  });
  console.log(`${count} project handoff groups passed`);
} finally { await fs.remove(scratch); }
