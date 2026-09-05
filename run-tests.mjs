#!/usr/bin/env node
// Aggregating test runner. Runs every suite regardless of individual failures
// (the old `&&` chain short-circuited and masked co-occurring failures), prints
// a summary, and exits non-zero if any suite failed. The bash e2e suites are
// skipped on Windows (no bash) — the Node unit suites still cover the
// platform-specific home-key path logic there.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const isWin = process.platform === 'win32';

// ── Real-state tripwire ────────────────────────────────────────────────
// Tests MUST run against a scratch HOME and never touch the developer's real
// ~/.config/memoir. On 2026-07-13 test-decisions-hidden.mjs imported a ./src
// module before shimming $HOME — state.js binds paths.session from
// os.homedir() at module load, so the fixture write landed on the REAL
// session.json and destroyed live data (twice, before it was caught).
//
// The per-file fix is to shim $HOME first. THIS is the backstop: a generic
// guard that catches any future leak from any suite by any mechanism. It
// looks for test-fixture signatures in the real session.json rather than
// diffing the whole file, because a legitimate `memoir push`/autopush from a
// concurrent Claude Code session can rewrite it mid-run — a hash compare
// would false-positive on that; a fixture-marker match cannot.
const REAL_SESSION = path.join(os.homedir(), '.config', 'memoir', 'session.json');
const FIXTURE_MARKERS = [
  'Use Redis for caching',
  'Use Memcached for caching',
  'test-machine',
  'hello-from-test',
  'concurrent-action-',
];

function scanRealStateForFixtures(label) {
  let raw;
  try {
    raw = fs.readFileSync(REAL_SESSION, 'utf8');
  } catch {
    return null; // no real store on this machine (CI) — nothing to protect
  }
  const hits = FIXTURE_MARKERS.filter((m) => raw.includes(m));
  if (hits.length === 0) return null;
  return { label, hits, raw };
}

// If the real store is ALREADY contaminated before we start, say so loudly but
// don't fail — the developer may be mid-recovery. Only a leak introduced BY
// this run is a hard failure.
const preExisting = scanRealStateForFixtures('pre-existing');
if (preExisting) {
  console.log(
    `\n\x1b[33mWARNING\x1b[0m real session.json already contains test-fixture markers before the suite ran: ` +
      `${preExisting.hits.join(', ')}\n  ${REAL_SESSION}\n  (Not failing — assuming you are mid-recovery. It will not be re-checked as a new leak.)\n`
  );
}

const suites = [
  { name: 'audit reliability (integration)', cmd: 'node', args: ['test-audit-reliability.mjs'] },
  { name: 'cross-machine (unit)', cmd: 'node', args: ['test-cross-machine.mjs'] },
  { name: 'session (unit)', cmd: 'node', args: ['test-session.mjs'] },
  { name: 'capture-quality (unit)', cmd: 'node', args: ['test-capture-quality.mjs'] },
  { name: 'auto-activate (unit)', cmd: 'node', args: ['test-auto-activate.mjs'] },
  { name: 'tidy/lean-memory (unit)', cmd: 'node', args: ['test-tidy.mjs'] },
  { name: 'encryption (unit)', cmd: 'node', args: ['test-encryption.mjs'] },
  { name: 'cloud (unit)', cmd: 'node', args: ['test-cloud.mjs'] },
  { name: 'secret-scan (unit)', cmd: 'node', args: ['test-secret-scan.mjs'] },
  { name: 'mcp-contract (unit)', cmd: 'node', args: ['test-mcp-contract.mjs'] },
  { name: 'session-lock (unit)', cmd: 'node', args: ['test-session-lock.mjs'] },
  { name: 'schema-migration (unit)', cmd: 'node', args: ['test-schema-migration.mjs'] },
  { name: 'decisions-hidden (unit)', cmd: 'node', args: ['test-decisions-hidden.mjs'] },
  { name: 'recall (unit)', cmd: 'node', args: ['test-recall.mjs'] },
  { name: 'event-log (unit)', cmd: 'node', args: ['test-event-log.mjs'] },
  { name: 'parking-and-sync (unit)', cmd: 'node', args: ['test-parking-and-sync.mjs'] },
  { name: 'events-summary (unit)', cmd: 'node', args: ['test-events-summary.mjs'] },
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
  // DO_NOT_TRACK so the suite (incl. e2e `memoir push` runs) never emits telemetry.
  const r = spawnSync(s.cmd, s.args, { stdio: 'inherit', env: { ...process.env, DO_NOT_TRACK: '1' } });
  results.push({ name: s.name, status: r.status === 0 ? 'pass' : 'fail', code: r.status });
}

// ── Real-state tripwire: did this run leak fixtures into the real store? ──
let leaked = false;
if (!preExisting) {
  const post = scanRealStateForFixtures('post-run');
  if (post) {
    leaked = true;
    console.error(
      `\n\x1b[31m╔══════════════════════════════════════════════════════════════╗\x1b[0m\n` +
        `\x1b[31m║  TEST SUITE LEAKED INTO YOUR REAL MEMOIR STORE               ║\x1b[0m\n` +
        `\x1b[31m╚══════════════════════════════════════════════════════════════╝\x1b[0m\n\n` +
        `  ${REAL_SESSION}\n` +
        `  now contains test-fixture markers: ${post.hits.join(', ')}\n\n` +
        `  A suite wrote to the real ~/.config/memoir instead of a scratch HOME.\n` +
        `  Almost always cause: a \`./src\` import that runs BEFORE the test file\n` +
        `  sets process.env.HOME — src/session/state.js binds its paths from\n` +
        `  os.homedir() at module load, so the shim must come first.\n\n` +
        `  Your real data may have been overwritten. Recover from the newest\n` +
        `  clean backup in ~/.config/memoir/ or from your memoir git remote.\n`
    );
  }
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
if (leaked) console.log(`  \x1b[31m+ REAL-STATE LEAK DETECTED (see above)\x1b[0m`);

process.exit(failed.length > 0 || leaked ? 1 : 0);
