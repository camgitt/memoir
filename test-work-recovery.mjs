import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { recordWork, readWork, resumeWork, refreshWork, retractWork, runWorkCheck } from './src/work/store.js';
import { backupWork, doctorWork, recoverWork } from './src/work/recovery.js';
import { LEDGER, SNAPSHOT_DIR, SNAPSHOT_KEEP, digest, readSnapshot } from './src/work/snapshots.js';
import { startWorkView } from './src/work/view.js';
import { encryptBuffer } from './src/security/encryption.js';

const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-work-recovery-')));
let count = 0, sequence = 0;
const cli = fileURLToPath(new URL('./bin/memoir-work.js', import.meta.url));
const source = id => ({ id, kind: 'decision', text: 'Project recovery decision', source: 'Synthetic recovery fixture' });
const create = async () => { const root = path.join(scratch, 'project-' + sequence++); await fs.ensureDir(root); return root; };
const apply = async (root, options = {}) => { const preview = await recoverWork(root, options); return recoverWork(root, { ...options, snapshot: options.from ? undefined : preview.source, apply: true, expect: preview.expect }); };
const run = (root, args) => spawnSync(process.execPath, [cli, '--project', root, ...args], { encoding: 'utf8', timeout: 20000, env: { ...process.env, DO_NOT_TRACK: '1' } });
async function test(name, fn) { await fn(); count++; console.log('PASS ' + name); }
try {
  await test('every acknowledged save has a verified copy, with private permissions', async () => {
    const root = await create();
    const first = await recordWork(root, source('first'));
    await recordWork(root, { ...source('first'), text: 'Corrected decision', expected_revision: first.revision });
    const health = await doctorWork(root);
    assert.equal(health.healthy, true); assert.equal(health.protected, true);
    assert.equal(JSON.parse(await readSnapshot(root, health.snapshots[0].id)).revision, 2);
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(path.join(root, LEDGER))).mode & 0o777, 0o600);
      assert.equal((await fs.stat(path.join(root, SNAPSHOT_DIR))).mode & 0o777, 0o700);
    }
  });
  await test('existing version-1 ledgers are protected on resume without changing their history', async () => {
    const root = await create(); await recordWork(root, source('old'));
    await fs.remove(path.join(root, SNAPSHOT_DIR));
    const original = await fs.readFile(path.join(root, LEDGER));
    assert.equal((await doctorWork(root)).protected, false);
    await refreshWork(root);
    assert.deepEqual(await fs.readFile(path.join(root, LEDGER)), original);
    assert.equal((await doctorWork(root)).protected, true);
  });
  await test('damaged JSON is preserved, preview is read-only, apply retains original bytes', async () => {
    const root = await create(); await recordWork(root, source('saved'));
    const broken = Buffer.from('{ incomplete fixture'); await fs.writeFile(path.join(root, LEDGER), broken);
    assert.equal((await doctorWork(root)).state, 'damaged');
    const preview = await recoverWork(root); assert.equal(preview.applied, false);
    assert.deepEqual(await fs.readFile(path.join(root, LEDGER)), broken);
    await assert.rejects(recoverWork(root, { apply: true }), /preview/);
    const result = await recoverWork(root, { snapshot: preview.source, expect: preview.expect, apply: true });
    assert.deepEqual(await fs.readFile(path.join(root, result.preserved)), broken);
    assert.equal((await resumeWork(root)).records[0].id, 'saved');
    assert.equal((await doctorWork(root)).healthy, true);
  });
  await test('a missing ledger cannot silently reset or overwrite existing recovery copies', async () => {
    const root = await create(); await recordWork(root, source('saved'));
    await fs.remove(path.join(root, LEDGER));
    await assert.rejects(resumeWork(root), /missing.*recovery/);
    await assert.rejects(recordWork(root, source('unsaved')), /missing.*recovery/);
    assert.equal((await doctorWork(root)).state, 'missing');
    await apply(root); assert.equal((await resumeWork(root)).records[0].id, 'saved');
    assert.equal((await doctorWork(await create())).state, 'empty');
  });
  await test('a changed destination or source invalidates the exact recovery preview', async () => {
    const root = await create(); await recordWork(root, source('saved'));
    const preview = await recoverWork(root);
    await recordWork(root, source('newer'));
    await assert.rejects(recoverWork(root, { snapshot: preview.source, expect: preview.expect, apply: true }), /preview changed/);
    assert.equal((await readWork(root)).revision, 2);
    const other = await create();
    await fs.copy(path.join(root, SNAPSHOT_DIR), path.join(other, SNAPSHOT_DIR));
    await assert.rejects(recoverWork(other, { snapshot: preview.source, expect: preview.expect, apply: true }), /preview changed/);
  });
  await test('recovery invalidates stale CLI and browser writes, including reused numeric revisions', async () => {
    const root = await create(); const record = await recordWork(root, source('saved'));
    const viewer = await startWorkView(root);
    try {
      const token = new URLSearchParams(new URL(viewer.url).hash.slice(1)).get('token');
      const headers = { Authorization: 'Bearer ' + token, Origin: viewer.origin, 'Content-Type': 'application/json' };
      const result = await apply(root);
      await assert.rejects(recordWork(root, { ...source('saved'), expected_revision: record.revision }), /was recovered/);
      await assert.rejects(recordWork(root, source('new')), /was recovered/);
      await assert.rejects(retractWork(root, { id: 'saved', expected_revision: record.revision }), /was recovered/);
      const input = { action: 'save', branch: null, id: 'saved', expected_revision: record.revision, fields: { kind: 'decision', text: 'New correction', status: 'open' } };
      const rejected = await fetch(viewer.origin + '/api/action', { method: 'POST', headers, body: JSON.stringify(input) });
      assert.equal(rejected.status, 409); assert.equal((await rejected.json()).code, 'refresh_required');
      const accepted = await fetch(viewer.origin + '/api/action', { method: 'POST', headers, body: JSON.stringify({ ...input, expected_recovery: result.recovery_id }) });
      assert.equal(accepted.status, 200);
      assert.equal((await resumeWork(root)).records[0].text, 'New correction');
    } finally { await viewer.close(); }
  });
  await test('checks finishing across recovery cannot overwrite restored evidence', async () => {
    const root = await create(); await recordWork(root, source('saved'));
    await fs.writeFile(path.join(root, 'check.cjs'), "const fs=require('fs');fs.writeFileSync('started','yes');setInterval(()=>{if(fs.existsSync('finish'))process.exit(0);},10);setTimeout(()=>process.exit(2),10000);");
    const check = runWorkCheck(root, { id: 'pending', title: 'Interrupted check', command: [process.execPath, 'check.cjs'], files: ['check.cjs'] });
    // Attach the rejection handler immediately so a busy CI worker cannot emit
    // an unhandled rejection while waiting for the started marker.
    const rejected = assert.rejects(check, /was recovered/);
    for (let i = 0; i < 200 && !await fs.pathExists(path.join(root, 'started')); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(await fs.pathExists(path.join(root, 'started')));
    await apply(root); await fs.writeFile(path.join(root, 'finish'), 'yes'); await rejected;
    assert.equal((await resumeWork(root)).checks.length, 0);
  });
  await test('encrypted export restores all branches, corrections, removals, receipts and next actions', async () => {
    const root = await create(), target = await create();
    const git = (...args) => { const r = spawnSync('git', ['-C', root, '-c', 'core.hooksPath=' + path.join(scratch,'no-hooks'), '-c', 'init.templateDir=' + path.join(scratch,'no-template'), ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:path.join(scratch,'gitconfig'), GIT_CONFIG_COUNT:'0' } }); assert.equal(r.status, 0, r.stderr); };
    git('init', '-b', 'main');
    const record = await recordWork(root, source('saved'));
    await recordWork(root, { ...source('saved'), text: 'Corrected on main', expected_revision: record.revision });
    const gone = await recordWork(root, source('gone')); await retractWork(root, { id: gone.id, expected_revision: gone.revision });
    await recordWork(root, { id: 'next', kind: 'next', text: 'Complete the task', source: 'Fixture', status: 'done' });
    await fs.writeFile(path.join(root, 'check.cjs'), 'process.exit(0)');
    await runWorkCheck(root, { id: 'check', title: 'Fixture receipt', command: [process.execPath, 'check.cjs'], files: ['check.cjs'] });
    git('checkout', '-b', 'second'); await recordWork(root, source('second'));
    const passphrase = 'Synthetic recovery phrase with sufficient length';
    const output = path.join(scratch, 'project-only.memoir');
    // These must never enter the export, even when they live beside the ledger.
    await fs.outputFile(path.join(root, '.codex/config.toml'), 'private-settings-canary');
    await fs.outputFile(path.join(root, '.memoir/private.md'), 'personal-memory-canary');
    const original = await readWork(root);
    await backupWork(root, { output, passphrase });
    const raw = await fs.readFile(output); assert.ok(!raw.includes(Buffer.from('Corrected on main')));
    await assert.rejects(backupWork(root, { output, passphrase }), /EEXIST/);
    assert.deepEqual(await fs.readFile(output), raw);
    await assert.rejects(recoverWork(target, { from: output, passphrase: 'incorrect recovery passphrase' }), /Cannot open/);
    await assert.rejects(backupWork(root, { output: path.join(scratch, 'weak'), passphrase: 'short' }), /at least 12/);
    const restored = await apply(target, { from: output, passphrase });
    const actual = await readWork(target);
    assert.deepEqual(actual.records, original.records); assert.deepEqual(actual.checks, original.checks); assert.deepEqual(actual.retractions, original.retractions);
    assert.equal(actual.recovery_id, restored.recovery_id);
    assert.doesNotMatch(JSON.stringify(actual), /private-settings-canary|personal-memory-canary/);
    assert.ok(!await fs.pathExists(path.join(target, '.codex')));
    const tampered = Buffer.from(raw); tampered[tampered.length - 1] ^= 1;
    await fs.writeFile(path.join(scratch, 'tampered.memoir'), tampered);
    await assert.rejects(recoverWork(target, { from: path.join(scratch, 'tampered.memoir'), passphrase }), /Cannot open/);
    assert.deepEqual(await readWork(target), actual);
    const preview = await recoverWork(target, { from: output, passphrase });
    await fs.remove(output); await backupWork(root, { output, passphrase });
    await assert.rejects(recoverWork(target, { from: output, passphrase, apply: true, expect: preview.expect }), /preview changed/);
  });
  await test('damaged, forged, secret-bearing and future-version imports cannot replace data', async () => {
    const root = await create(); await recordWork(root, source('saved'));
    const before = await fs.readFile(path.join(root, LEDGER));
    const passphrase = 'Synthetic malicious import passphrase';
    const payloads = [ { type: 'other', version: 1, ledger: JSON.parse(before) },
      { type: 'memoir-project-handoff', version: 2, ledger: JSON.parse(before) },
      { type: 'memoir-project-handoff', version: 1, ledger: { ...JSON.parse(before), version: 2 } },
      { type: 'memoir-project-handoff', version: 1, ledger: { ...JSON.parse(before), records: [] } },
      { type: 'memoir-project-handoff', version: 1, ledger: { ...JSON.parse(before), records: [{ ...JSON.parse(before).records[0], text: 'sk_test_' + 'z'.repeat(30) }] } } ];
    for (let i = 0; i < payloads.length; i++) {
      const from = path.join(scratch, 'unsafe-' + i);
      await fs.writeFile(from, await encryptBuffer(Buffer.from(JSON.stringify(payloads[i])), passphrase));
      await assert.rejects(recoverWork(root, { from, passphrase, apply: true }));
      assert.deepEqual(await fs.readFile(path.join(root, LEDGER)), before);
    }
    const newest = (await doctorWork(root)).snapshots[0].id;
    await fs.writeFile(path.join(root, SNAPSHOT_DIR, newest), '{}');
    assert.equal((await doctorWork(root)).invalid_snapshots, 1);
    await assert.rejects(recoverWork(root, { snapshot: newest }), /integrity/);
    await assert.rejects(recoverWork(root, { snapshot: '../../escape' }), /snapshot ID/);
  });
  await test('symlinked backups, exports and quarantine paths fail without following the link', async () => {
    if (process.platform === 'win32') return; // Windows symlink permission is not guaranteed.
    const root = await create(), outside = await create(); await recordWork(root, source('saved'));
    const before = await fs.readFile(path.join(root, LEDGER));
    await fs.symlink(outside, path.join(root, '.memoir/work-quarantine'));
    await assert.rejects(apply(root), /Symlinks/); assert.deepEqual(await fs.readFile(path.join(root, LEDGER)), before);
    await fs.remove(path.join(root, '.memoir/work-quarantine'));
    const exported = path.join(scratch, 'linked-export'); await fs.symlink(path.join(root, LEDGER), exported);
    await assert.rejects(backupWork(root, { output: exported, passphrase: 'Synthetic passphrase for symlinks' }), /Symlinks/);
    await fs.remove(path.join(root, SNAPSHOT_DIR)); await fs.symlink(outside, path.join(root, SNAPSHOT_DIR));
    await assert.rejects(recordWork(root, source('new')), /Symlinks/);
    assert.deepEqual(await fs.readFile(path.join(root, LEDGER)), before);
  });
  await test('backup failure and interrupted primary replacement preserve the prior handoff', async () => {
    const root = await create(); await recordWork(root, source('saved'));
    const before = await fs.readFile(path.join(root, LEDGER));
    const link = fs.link;
    fs.link = async (...args) => { if (args[1].includes('work-backups')) throw Object.assign(new Error('Synthetic full disk'), { code: 'ENOSPC' }); return link(...args); };
    try { await assert.rejects(recordWork(root, source('blocked')), /full disk/); }
    finally { fs.link = link; }
    assert.deepEqual(await fs.readFile(path.join(root, LEDGER)), before);
    const rename = fs.rename;
    fs.rename = async (...args) => { if (args[1] === path.join(root, LEDGER)) throw new Error('Synthetic interruption before replacement'); return rename(...args); };
    try { await assert.rejects(recordWork(root, source('interrupted')), /interruption/); }
    finally { fs.rename = rename; }
    assert.deepEqual(await fs.readFile(path.join(root, LEDGER)), before);
    const pending = await recoverWork(root); assert.equal(pending.restore_revision, 2);
    assert.match(pending.message, /interrupted save/);
    await apply(root); assert.equal((await resumeWork(root)).records.length, 2);
  });
  await test('a process crash leaves recoverable data and a dead lock is reclaimed after its grace period', async () => {
    const root = await create(); await recordWork(root, source('saved'));
    const before = await fs.readFile(path.join(root, LEDGER));
    const childScript = `import fs from 'fs-extra';
      import {recordWork} from './src/work/store.js';
      const rename=fs.rename;
      fs.rename=async(...args)=>{if(args[1]===${JSON.stringify(path.join(root,LEDGER))})process.exit(86);return rename(...args);};
      await recordWork(${JSON.stringify(root)},${JSON.stringify(source('crashed'))});`;
    const child = spawnSync(process.execPath, ['--input-type=module','-e',childScript], { encoding:'utf8', timeout:20000 });
    assert.equal(child.status,86,child.stderr); assert.deepEqual(await fs.readFile(path.join(root,LEDGER)),before);
    const old = new Date(Date.now()-60000); await fs.utimes(path.join(root,'.memoir/work.lock'),old,old);
    await apply(root);
    assert.equal((await resumeWork(root)).records.length,2);
    assert.ok(!await fs.pathExists(path.join(root,'.memoir/work.lock')));
  });
  await test('concurrent saves retain every record and snapshot retention is bounded', async () => {
    const root = await create();
    await Promise.all(Array.from({ length: 8 }, (_, i) => recordWork(root, source('parallel.' + i))));
    for (let i = 0; i < SNAPSHOT_KEEP + 2; i++) await recordWork(root, source('sequential.' + i));
    const health = await doctorWork(root);
    assert.equal((await readWork(root)).revision, 8 + SNAPSHOT_KEEP + 2);
    assert.ok(health.snapshots.length <= SNAPSHOT_KEEP + 2); assert.equal(health.protected, true);
    await fs.remove(path.join(root, LEDGER)); await apply(root);
    assert.equal((await resumeWork(root)).records.length, 8 + SNAPSHOT_KEEP + 2);
  });
  await test('CLI doctor and recovery give actionable errors without damaged-content leakage', async () => {
    const root = await create(); await recordWork(root, source('saved'));
    assert.equal(run(root, ['doctor']).status, 0);
    const secret = 'sk_test_' + 'x'.repeat(30); await fs.writeFile(path.join(root, LEDGER), '{"secret":"' + secret);
    const result = run(root, ['resume']); assert.equal(result.status, 1); assert.match(result.stderr, /doctor/); assert.ok(!result.stderr.includes(secret));
    const health = run(root, ['doctor']); assert.equal(health.status, 1); assert.equal(JSON.parse(health.stdout).state, 'damaged');
    assert.ok(!health.stdout.includes(secret));
    const preview = JSON.parse(run(root, ['recover']).stdout);
    const applied = run(root, ['recover', preview.source, '--apply', '--expect', preview.expect]); assert.equal(applied.status, 0, applied.stderr);
    assert.equal(run(root, ['resume']).status, 0); assert.equal(run(root, ['doctor']).status, 0);
  });
  console.log(`${count} project recovery groups passed`);
} finally { await fs.remove(scratch); }
