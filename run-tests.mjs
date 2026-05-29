#!/usr/bin/env node
// Aggregating test runner. Runs every suite regardless of individual failures
// (the old `&&` chain short-circuited and masked co-occurring failures), prints
// a summary, and exits non-zero if any suite failed. The bash e2e suites are
// skipped on Windows (no bash) — the Node unit suites still cover the
// platform-specific home-key path logic there.
import { spawnSync } from 'node:child_process';

const isWin = process.platform === 'win32';

const suites = [
  { name: 'cross-machine (unit)', cmd: 'node', args: ['test-cross-machine.mjs'] },
  { name: 'session (unit)', cmd: 'node', args: ['test-session.mjs'] },
  { name: 'encryption (unit)', cmd: 'node', args: ['test-encryption.mjs'] },
  { name: 'cloud (unit)', cmd: 'node', args: ['test-cloud.mjs'] },
  { name: 'secret-scan (unit)', cmd: 'node', args: ['test-secret-scan.mjs'] },
  { name: 'cross-machine (e2e)', cmd: 'bash', args: ['test-cross-machine-e2e.sh'], bash: true },
  { name: 'session-sync (e2e)', cmd: 'bash', args: ['test-session-sync.sh'], bash: true },
];

const results = [];
for (const s of suites) {
  if (s.bash && isWin) {
    console.log(`\n── SKIP (Windows, no bash): ${s.name}`);
    results.push({ name: s.name, status: 'skip' });
    continue;
  }
  console.log(`\n═══ ${s.name} ═══`);
  const r = spawnSync(s.cmd, s.args, { stdio: 'inherit' });
  results.push({ name: s.name, status: r.status === 0 ? 'pass' : 'fail', code: r.status });
}

const failed = results.filter((r) => r.status === 'fail');
const passed = results.filter((r) => r.status === 'pass').length;
const skipped = results.filter((r) => r.status === 'skip').length;

console.log('\n──────────── SUMMARY ────────────');
for (const r of results) {
  const tag = r.status === 'pass' ? 'PASS' : r.status === 'fail' ? 'FAIL' : 'SKIP';
  const extra = r.status === 'fail' && r.code != null ? ` (exit ${r.code})` : '';
  console.log(`  ${tag}  ${r.name}${extra}`);
}
console.log(`\n  ${passed} passed, ${failed.length} failed, ${skipped} skipped`);

process.exit(failed.length > 0 ? 1 : 0);
