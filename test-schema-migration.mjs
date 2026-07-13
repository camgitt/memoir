#!/usr/bin/env node
// Schema versioning + migration hardening.
//
// Covers:
//   1. migrateSessionData (pure, no I/O) — version absent/0/1/1+unknown-fields/future.
//   2. readSession() file-based behavior — corrupt JSON quarantine (existing
//      pattern), future-version quarantine (NEW — backs up + degrades safely,
//      warns once, never throws), and a full read->mutate->write->re-read
//      round-trip that's byte-stable for unrelated fields.
//   3. REAL-DATA VERIFICATION against a READ-ONLY copy of Cam's actual live
//      ~/.config/memoir/session.json — the single most important test here:
//      proves the migration path loses nothing against real production data,
//      not just synthetic fixtures. The real file is only ever READ; nothing
//      is written back to it.
//   4. PUSH-MERGE REGRESSION — the second real bug this commit fixes: `memoir
//      push` used to blind-overwrite the remote session.json instead of
//      merging first. Simulates two machines pushing to a shared local bare
//      git repo (standing in for the remote) without either restoring the
//      other's changes first, and asserts BOTH machines' decisions survive.

import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const BOLD = '\x1b[1m', GREEN = '\x1b[32m', RED = '\x1b[31m', CYAN = '\x1b[36m', RESET = '\x1b[0m';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ${GREEN}PASS${RESET} ${msg}`); pass++; }
  else      { console.log(`  ${RED}FAIL${RESET} ${msg}`); fail++; }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEMOIR_BIN = path.join(__dirname, 'bin', 'memoir.js');

// ── 1. migrateSessionData — pure, no I/O ────────────────────────────────
console.log(`\n${BOLD}${CYAN}migrateSessionData (pure)${RESET}\n`);

const { migrateSessionData, SCHEMA_VERSION, emptySession } = await import('./src/session/migrations.js');

{
  // version absent
  const { future, state } = migrateSessionData({ current: { goals: [{ text: 'g1', set_on: '2026-01-01T00:00:00.000Z' }] } });
  assert(future === false, 'version-absent: not flagged as future');
  assert(state.version === SCHEMA_VERSION, 'version-absent: normalized to current SCHEMA_VERSION');
  assert(state.current.goals.length === 1 && state.current.goals[0].text === 'g1', 'version-absent: existing data preserved');
}

{
  // version 0
  const { future, state } = migrateSessionData({ version: 0, current: { next_actions: [{ text: 'n1', added: '2026-01-01T00:00:00.000Z' }] } });
  assert(future === false, 'version 0: not flagged as future');
  assert(state.version === SCHEMA_VERSION, 'version 0: normalized to current SCHEMA_VERSION');
  assert(state.current.next_actions.length === 1 && state.current.next_actions[0].text === 'n1', 'version 0: existing data preserved');
}

{
  // version 1 (current) — full valid shape passes through
  const input = emptySession();
  input.current.decisions.push({ text: 'Use Postgres', why: 'reliability', machine_id: 'm1', date: '2026-01-01T00:00:00.000Z' });
  const { future, state } = migrateSessionData(input);
  assert(future === false, 'version 1 (current): not flagged as future');
  assert(state.version === SCHEMA_VERSION, 'version 1 (current): version unchanged');
  assert(state.current.decisions[0].text === 'Use Postgres', 'version 1 (current): decision preserved');
}

{
  // version 1 with unknown extra fields — must not throw, and the unknown
  // field must survive (no data loss for forward-compatibility either).
  const input = { ...emptySession(), someFutureField: { nested: 'value' } };
  const { future, state } = migrateSessionData(input);
  assert(future === false, 'version 1 + unknown field: not flagged as future');
  assert(state.someFutureField && state.someFutureField.nested === 'value', 'version 1 + unknown field: unrecognized field preserved, not dropped');
}

{
  // FUTURE version — newer than this build knows about
  const input = { version: SCHEMA_VERSION + 1, current: { goals: [{ text: 'from the future' }] } };
  const { future, state } = migrateSessionData(input);
  assert(future === true, 'future version: flagged as future');
  assert(state.version === SCHEMA_VERSION, 'future version: degraded state stamped at CURRENT schema version, not misread as the future one');
  assert(state.current.goals.length === 0, 'future version: degraded to a fresh, empty session rather than guessing at an unknown shape');
}

// ── 2. readSession() — file-based behavior (one shared scratch HOME) ───
console.log(`\n${BOLD}${CYAN}readSession() — corrupt JSON + future-version quarantine + round-trip${RESET}\n`);

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-schema-test-'));
process.env.HOME = scratch;
process.env.USERPROFILE = scratch; // Windows
const state = await import('./src/session/state.js');
const sessionDir = path.dirname(state.paths.session);
await fs.ensureDir(sessionDir);

// Capture stderr writes without silencing the terminal entirely — used
// below to check the forward-version warning fires exactly once. `fn` may
// be async; the patch must stay installed until it actually resolves (a
// naive sync try/finally restores stderr.write before an awaited async
// write inside `fn` ever happens).
async function captureStderr(fn) {
  const original = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk, ...rest) => { captured += chunk.toString(); return true; };
  try {
    const result = await fn();
    return { result, captured };
  } finally {
    process.stderr.write = original;
  }
}

{
  // Corrupt JSON — existing quarantine pattern must still work.
  await fs.writeFile(state.paths.session, '{ this is not valid json !!');
  const before = await fs.readdir(sessionDir);
  const result = await state.readSession();
  assert(result && result.version === state.SCHEMA_VERSION && Array.isArray(result.current.goals), 'corrupt JSON: readSession returns a safe empty session, does not throw');
  const after = await fs.readdir(sessionDir);
  const newFiles = after.filter(f => !before.includes(f));
  assert(newFiles.some(f => f.includes('.corrupted-')), 'corrupt JSON: original quarantined to a .corrupted-<ts> backup');
}

{
  // Future version — NEW behavior: readSession() itself catches this,
  // backs up the original untouched, warns once, and never throws.
  const futureContent = JSON.stringify({ version: state.SCHEMA_VERSION + 1, current: { goals: [{ text: 'future goal' }] } }, null, 2);
  await fs.writeFile(state.paths.session, futureContent);
  const before = await fs.readdir(sessionDir);

  const { result: r1, captured: captured1 } = await captureStderr(() => state.readSession());
  assert(r1 && r1.version === state.SCHEMA_VERSION && r1.current.goals.length === 0, 'future version: readSession returns a safe degraded session, does not throw');
  assert(/newer version of memoir/i.test(captured1), 'future version: first call prints the upgrade warning to stderr');

  const after = await fs.readdir(sessionDir);
  const newFiles = after.filter(f => !before.includes(f));
  const backupFile = newFiles.find(f => f.includes('.pre-migration-'));
  assert(!!backupFile, 'future version: original backed up to a .pre-migration-<ts> file');
  if (backupFile) {
    const backupContent = await fs.readFile(path.join(sessionDir, backupFile), 'utf8');
    assert(backupContent === futureContent, 'future version: backup content is byte-identical to the original (untouched)');
  }
  const originalStillThere = await fs.readFile(state.paths.session, 'utf8');
  assert(originalStillThere === futureContent, 'future version: the original session.json itself is left untouched by readSession (only a copy is backed up)');

  // Second call: same future-version file still on disk — must NOT warn again.
  const { captured: captured2 } = await captureStderr(() => state.readSession());
  assert(captured2 === '', 'future version: second readSession() call does not re-warn (once per process, not per call)');
}

{
  // Round-trip: read -> mutate -> write -> re-read is byte-stable for
  // unrelated fields.
  const fresh = state.emptySession();
  fresh.current.goals.push({ text: 'Round-trip goal', machine_id: 'm1', set_on: '2026-01-01T00:00:00.000Z' });
  fresh.current.decisions.push({ text: 'Round-trip decision', why: 'testing', machine_id: 'm1', date: '2026-01-01T00:00:00.000Z' });
  await fs.writeFile(state.paths.session, JSON.stringify(fresh, null, 2));

  const read1 = await state.readSession();
  read1.current.next_actions.push({ text: 'Added during round-trip', machine_id: 'm1', added: new Date().toISOString() });
  await state.writeSession(read1);
  const read2 = await state.readSession();

  assert(read2.current.goals[0].text === 'Round-trip goal', 'round-trip: unrelated goal text unchanged');
  assert(read2.current.decisions[0].text === 'Round-trip decision', 'round-trip: unrelated decision text unchanged');
  assert(read2.current.next_actions.some(n => n.text === 'Added during round-trip'), 'round-trip: the mutation actually landed');
  assert(read2.version === state.SCHEMA_VERSION, 'round-trip: version stamped on write');
}

// ── 3. REAL-DATA VERIFICATION ───────────────────────────────────────────
console.log(`\n${BOLD}${CYAN}real-data verification (READ-ONLY copy of Cam's live session.json)${RESET}\n`);

// os.homedir() is shimmed to `scratch` for this process (HOME override), so
// the real path is built explicitly rather than relying on os.homedir() here.
const realPath = '/Users/camarthur/.config/memoir/session.json';

if (await fs.pathExists(realPath)) {
  const realRaw = await fs.readFile(realPath, 'utf8'); // READ-ONLY — never written to
  const realParsed = JSON.parse(realRaw);
  const beforeCounts = {
    goals: realParsed.current?.goals?.length || 0,
    next_actions: realParsed.current?.next_actions?.length || 0,
    open_questions: realParsed.current?.open_questions?.length || 0,
    decisions: realParsed.current?.decisions?.length || 0,
    history: realParsed.history?.length || 0,
  };
  const beforeTexts = {
    goals: (realParsed.current?.goals || []).map(g => g.text).sort(),
    next_actions: (realParsed.current?.next_actions || []).map(n => n.text).sort(),
    decisions: (realParsed.current?.decisions || []).map(d => d.text).sort(),
  };

  // Copy (not move, not modify) into the scratch HOME's session.json.
  await fs.writeFile(state.paths.session, realRaw);

  const read1 = await state.readSession();
  await state.writeSession(read1);
  const read2 = await state.readSession();

  const afterCounts = {
    goals: read2.current.goals.length,
    next_actions: read2.current.next_actions.length,
    open_questions: read2.current.open_questions.length,
    decisions: read2.current.decisions.length,
    history: read2.history.length,
  };
  const afterTexts = {
    goals: read2.current.goals.map(g => g.text).sort(),
    next_actions: read2.current.next_actions.map(n => n.text).sort(),
    decisions: read2.current.decisions.map(d => d.text).sort(),
  };

  for (const key of Object.keys(beforeCounts)) {
    assert(beforeCounts[key] === afterCounts[key], `real data: ${key} count unchanged (${beforeCounts[key]} -> ${afterCounts[key]})`);
  }
  assert(JSON.stringify(beforeTexts.goals) === JSON.stringify(afterTexts.goals), 'real data: goal texts unchanged (content, not just count)');
  assert(JSON.stringify(beforeTexts.next_actions) === JSON.stringify(afterTexts.next_actions), 'real data: next_action texts unchanged (content, not just count)');
  assert(JSON.stringify(beforeTexts.decisions) === JSON.stringify(afterTexts.decisions), 'real data: decision texts unchanged (content, not just count)');

  // Confirm the REAL file itself was never touched by this test.
  const realRawAfter = await fs.readFile(realPath, 'utf8');
  assert(realRawAfter === realRaw, "real data: the ACTUAL /Users/camarthur/.config/memoir/session.json was never modified by this test");
} else {
  console.log(`  ${CYAN}SKIP${RESET} real session.json not found at ${realPath} — skipping (not this machine/environment)`);
}

await fs.remove(scratch);

// ── 4. PUSH-MERGE REGRESSION — two machines, shared bare git remote ────
console.log(`\n${BOLD}${CYAN}push-merge regression (real bug: push used to blind-overwrite the remote)${RESET}\n`);

// cwd MUST be a non-project directory (no .git/package.json/etc.) — push.js
// calls promptActivate() at the end, which opens an interactive inquirer
// prompt if cwd "looks like a project". Against closed/piped stdin that
// crashes with ERR_USE_AFTER_CLOSE instead of just skipping cleanly, so
// spawning with the repo root as cwd (the default) is unsafe here. homeDir
// itself (a fresh mkdtemp scratch dir) has none of those signal files.
function runMemoir(homeDir, args) {
  const r = spawnSync(process.execPath, [MEMOIR_BIN, ...args], {
    env: { PATH: process.env.PATH, HOME: homeDir, USERPROFILE: homeDir, DO_NOT_TRACK: '1' },
    cwd: homeDir,
    input: '',
    encoding: 'utf8',
    timeout: 30000,
  });
  return r;
}

{
  const bareRepoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-bare-remote-'));
  execFileSync('git', ['init', '--bare', '-b', 'main', bareRepoDir], { stdio: 'ignore' });

  const homeA = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-machineA-'));
  const homeB = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-machineB-'));

  for (const h of [homeA, homeB]) {
    await fs.ensureDir(path.join(h, '.config', 'memoir'));
    await fs.writeJson(path.join(h, '.config', 'memoir', 'config.json'), {
      version: 2,
      activeProfile: 'default',
      profiles: { default: { provider: 'git', gitRepo: bareRepoDir, encrypt: false } },
    });
    // Seed a minimal AI tool so push has something to scan (foundAny gate).
    await fs.ensureDir(path.join(h, '.claude'));
    await fs.writeJson(path.join(h, '.claude', 'settings.json'), {});
  }

  // Machine A: record a decision, push. This is the FIRST push — remote
  // starts empty.
  let r = runMemoir(homeA, ['note', 'Use Postgres for the primary datastore', '--why', 'reliability']);
  assert(r.status === 0, `machine A: note recorded (exit ${r.status})${r.status !== 0 ? ` — ${r.stderr}` : ''}`);
  r = runMemoir(homeA, ['push']);
  assert(r.status === 0, `machine A: push succeeded (exit ${r.status})${r.status !== 0 ? ` — ${r.stderr}` : ''}`);

  // Machine B: record a DIFFERENT decision, push — WITHOUT ever restoring
  // machine A's push first. This is exactly the scenario that used to cause
  // silent data loss: B's push would blind-overwrite the remote, destroying
  // A's decision. With the fix, B's push merges against the remote first.
  r = runMemoir(homeB, ['note', 'Use Redis for session cache', '--why', 'low latency']);
  assert(r.status === 0, `machine B: note recorded (exit ${r.status})${r.status !== 0 ? ` — ${r.stderr}` : ''}`);
  r = runMemoir(homeB, ['push']);
  assert(r.status === 0, `machine B: push succeeded (exit ${r.status})${r.status !== 0 ? ` — ${r.stderr}` : ''}`);

  // Verify the final remote state: clone fresh and read session.json.
  const verifyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-verify-remote-'));
  execFileSync('git', ['clone', '--depth', '1', bareRepoDir, '.'], { cwd: verifyDir, stdio: 'ignore' });
  const remoteSessionPath = path.join(verifyDir, 'session.json');
  const remoteExists = await fs.pathExists(remoteSessionPath);
  assert(remoteExists, 'remote: session.json present in the bare repo after both pushes');

  if (remoteExists) {
    const remote = await fs.readJson(remoteSessionPath);
    const texts = (remote.current?.decisions || []).map(d => d.text.toLowerCase());
    assert(texts.some(t => t.includes('postgres')), "remote: machine A's decision (Postgres) survived machine B's push");
    assert(texts.some(t => t.includes('redis')), "remote: machine B's decision (Redis) is present");
  }

  await fs.remove(bareRepoDir);
  await fs.remove(homeA);
  await fs.remove(homeB);
  await fs.remove(verifyDir);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
