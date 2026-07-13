#!/usr/bin/env node
// Additive, size-bounded, crash-safe JSONL event log (src/events/log.js) —
// append-only invariant, concurrent-writer line integrity, size-bounded
// rotation + backup-file cleanup, wiring at every chokepoint, and the
// never-break-the-caller contract.
//
// Uses a scratch HOME throughout — this file transitively exercises
// session.json mutators, tidyIndex, and syncToGit/syncToLocal, all of which
// now emit events under $HOME/.config/memoir.

import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';

const BOLD = '\x1b[1m', GREEN = '\x1b[32m', RED = '\x1b[31m', CYAN = '\x1b[36m', RESET = '\x1b[0m';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ${GREEN}PASS${RESET} ${msg}`); pass++; }
  else      { console.log(`  ${RED}FAIL${RESET} ${msg}`); fail++; }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Append-only invariant + wiring tests (shared scratch HOME) ─────────
console.log(`\n${BOLD}${CYAN}events/log.js — append-only + wiring${RESET}\n`);

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-event-log-test-'));
process.env.HOME = scratch;
process.env.USERPROFILE = scratch; // Windows

const eventsMod = await import('./src/events/log.js');
const stateMod = await import('./src/session/state.js');
const { tidyIndex } = await import('./src/commands/tidy.js');

async function readEventLines() {
  if (!(await fs.pathExists(eventsMod.paths.events))) return [];
  const raw = await fs.readFile(eventsMod.paths.events, 'utf8');
  return raw.split('\n').filter(Boolean);
}

{
  // Append-only: prior bytes remain an unchanged prefix after a new append.
  await eventsMod.appendEvent('probe_one', { n: 1 });
  const before = await fs.readFile(eventsMod.paths.events);
  await eventsMod.appendEvent('probe_two', { n: 2 });
  const after = await fs.readFile(eventsMod.paths.events);
  assert(after.length > before.length, 'file grew after the second append');
  assert(after.subarray(0, before.length).equals(before), 'prior bytes are an unchanged prefix after a new append');
}

{
  // goal_set
  await stateMod.addGoal('Event-log test goal');
  const lines = await readEventLines();
  assert(lines.some(l => JSON.parse(l).type === 'goal_set'), 'addGoal() emits goal_set');
}

{
  // decision_captured
  await stateMod.addNote('Event-log test decision', { why: 'testing' });
  const lines = await readEventLines();
  const decisionEvents = lines.map(l => JSON.parse(l)).filter(l => l.type === 'decision_captured');
  assert(decisionEvents.length >= 1, 'addNote() emits decision_captured');
  assert(decisionEvents.every(e => !('text' in e) && !JSON.stringify(e).includes('Event-log test decision')), 'decision_captured payload never contains the decision TEXT — counts/booleans only');
}

{
  // next_completed — only on an ACTUAL completion, not a no-match call.
  await stateMod.addNext('Event-log test next action');
  const beforeLines = (await readEventLines()).filter(l => JSON.parse(l).type === 'next_completed').length;

  await stateMod.completeNext('this text matches nothing at all');
  const afterNoMatch = (await readEventLines()).filter(l => JSON.parse(l).type === 'next_completed').length;
  assert(afterNoMatch === beforeLines, 'completeNext() with no match does NOT emit next_completed');

  await stateMod.completeNext('Event-log test next action');
  const afterMatch = (await readEventLines()).filter(l => JSON.parse(l).type === 'next_completed').length;
  assert(afterMatch === beforeLines + 1, 'completeNext() with a real match DOES emit next_completed');
}

{
  // tidy_ran — only on a real rewrite, never a no-op.
  const memDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-event-log-tidy-'));
  const detail = (n) => Array.from({ length: n }, (_, i) => `- detail line ${i + 1}`);
  await fs.writeFile(path.join(memDir, 'MEMORY.md'), [
    '# Project Memory', '',
    '## Fat section', '- **Path:** /p', ...detail(20), '',
  ].join('\n') + '\n');

  const beforeCount = (await readEventLines()).filter(l => JSON.parse(l).type === 'tidy_ran').length;
  const res = await tidyIndex(memDir, { budgetLines: 10, stamp: 'events-test' });
  const afterRealChange = (await readEventLines()).filter(l => JSON.parse(l).type === 'tidy_ran').length;
  assert(res.archived.length > 0, 'sanity: this tidyIndex call actually archived something');
  assert(afterRealChange === beforeCount + 1, 'tidyIndex() with a real rewrite emits tidy_ran');

  // Re-run immediately: now under budget -> no-op -> no new event.
  const noOpRes = await tidyIndex(memDir, { budgetLines: 10, stamp: 'events-test' });
  const afterNoOp = (await readEventLines()).filter(l => JSON.parse(l).type === 'tidy_ran').length;
  assert(noOpRes.overBudget === false, 'sanity: the re-run is a genuine no-op (under budget)');
  assert(afterNoOp === afterRealChange, 'tidyIndex() no-op re-run does NOT emit an additional tidy_ran');

  await fs.remove(memDir);
}

{
  // sync_pushed / sync_failed via syncToGit — a real local bare repo for the
  // success path, an unreachable path for the failure path (no network
  // needed either way).
  const { syncToGit } = await import('./src/providers/index.js');

  const bareRepoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-event-log-bare-'));
  execFileSync('git', ['init', '--bare', '-b', 'main', bareRepoDir], { stdio: 'ignore' });
  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-event-log-staging-'));
  await fs.writeFile(path.join(stagingDir, 'hello.md'), 'hello');

  const fakeSpinner = { text: '', succeed() {}, start() {}, fail() {} };

  const beforePushed = (await readEventLines()).filter(l => JSON.parse(l).type === 'sync_pushed').length;
  await syncToGit({ gitRepo: bareRepoDir }, stagingDir, fakeSpinner);
  const afterPushed = (await readEventLines()).filter(l => JSON.parse(l).type === 'sync_pushed').length;
  assert(afterPushed === beforePushed + 1, 'syncToGit() success emits sync_pushed');

  const beforeFailed = (await readEventLines()).filter(l => JSON.parse(l).type === 'sync_failed').length;
  let threw = false;
  try {
    await syncToGit({ gitRepo: path.join(os.tmpdir(), 'memoir-nonexistent-repo-' + Date.now()) }, stagingDir, fakeSpinner);
  } catch {
    threw = true; // syncToGit still throws to its caller — the event is additive, not a replacement for error handling
  }
  const afterFailed = (await readEventLines()).filter(l => JSON.parse(l).type === 'sync_failed').length;
  assert(threw, 'sanity: an unreachable git remote still throws (unchanged caller-facing behavior)');
  assert(afterFailed === beforeFailed + 1, 'syncToGit() failure emits sync_failed (previously invisible — vanished into ignored autopush stdio)');

  await fs.remove(bareRepoDir);
  await fs.remove(stagingDir);
}

{
  // Never-break-the-caller: force the events write itself to fail (turn the
  // events.jsonl PATH into a directory, so fs.appendFileSync throws EISDIR)
  // without touching session.json's own write path at all. addNote() must
  // still succeed and the decision must still land.
  await fs.remove(eventsMod.paths.events).catch(() => {});
  await fs.ensureDir(eventsMod.paths.events); // events.jsonl is now a DIRECTORY

  let threw = false;
  try {
    await stateMod.addNote('Survives a broken event log', {});
  } catch {
    threw = true;
  }
  assert(threw === false, 'addNote() does not throw even when the event log write is broken');

  const after = await stateMod.readSession();
  assert(
    after.current.decisions.some(d => d.text === 'Survives a broken event log'),
    'the PRIMARY write (session.json) still succeeded despite the event log being unwritable'
  );

  await fs.remove(eventsMod.paths.events); // restore to a plain file for subsequent tests
}

await fs.remove(scratch);

// ── Rotation + backup-file cap (own scratch HOME, isolated SUBPROCESS) ──
// A real fresh Node process, not a re-import-with-cache-buster trick in
// this same process — events/log.js's CONFIG_DIR (and the CONFIG_DIR each
// of its own dependencies like state.js resolve independently) is computed
// from os.homedir() at each module's OWN first import, so reusing this
// process for a second scratch HOME would leave those already-cached
// modules bound to the FIRST home. A subprocess sidesteps that entirely.
console.log(`\n${BOLD}${CYAN}events/log.js — size-bounded rotation + cleanup${RESET}\n`);

{
  const rotScratch = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-event-log-rotation-'));
  const eventsDir = path.join(rotScratch, '.config', 'memoir');
  await fs.ensureDir(eventsDir);
  const eventsPath = path.join(eventsDir, 'events.jsonl');

  const FIVE_MB_PLUS = 'x'.repeat(5 * 1024 * 1024 + 1024);
  await fs.writeFile(eventsPath, `OLD_MAIN:${FIVE_MB_PLUS}`);
  await fs.writeFile(`${eventsPath}.1`, `OLD_GEN1:${FIVE_MB_PLUS}`);
  await fs.writeFile(`${eventsPath}.2`, `OLD_GEN2:${FIVE_MB_PLUS}`);

  const code = `
    import(${JSON.stringify(path.join(__dirname, 'src', 'events', 'log.js'))}).then(async (m) => {
      await m.appendEvent('rotation_probe', {});
      process.exit(0);
    }).catch((e) => { console.error(e); process.exit(1); });
  `;
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', code], {
      env: { PATH: process.env.PATH, HOME: rotScratch, USERPROFILE: rotScratch },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('exit', (code) => resolve({ code, stderr }));
  });
  assert(r.code === 0, `rotation-triggering appendEvent() subprocess exited cleanly${r.code !== 0 ? ` (${r.stderr})` : ''}`);

  const mainContent = await fs.readFile(eventsPath, 'utf8');
  const gen1Content = await fs.readFile(`${eventsPath}.1`, 'utf8');
  const gen2Content = await fs.readFile(`${eventsPath}.2`, 'utf8');
  const gen3Exists = await fs.pathExists(`${eventsPath}.3`);

  assert(mainContent.includes('rotation_probe') && !mainContent.includes('OLD_MAIN'), 'rotation: fresh events.jsonl contains only the new event, old main content rotated out');
  assert(gen1Content.startsWith('OLD_MAIN:'), 'rotation: events.jsonl -> .1 (the just-rotated-out main content)');
  assert(gen2Content.startsWith('OLD_GEN1:'), 'rotation: .1 -> .2 (the previous .1 shifted up)');
  assert(!gen2Content.startsWith('OLD_GEN2'), 'rotation: the old .2 (OLD_GEN2) was dropped, not kept — caps total generations');
  assert(gen3Exists === false, 'rotation: no .3 generation ever created — total on-disk size stays bounded');

  await fs.remove(rotScratch);
}

// ── Concurrent writers — no partial/interleaved lines ───────────────────
console.log(`\n${BOLD}${CYAN}events/log.js — concurrent writers produce only valid, complete lines${RESET}\n`);

{
  const concScratch = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-event-log-concurrent-'));

  function spawnAppends(n) {
    const code = `
      import(${JSON.stringify(path.join(__dirname, 'src', 'events', 'log.js'))}).then(async (m) => {
        for (let i = 0; i < ${n}; i++) {
          await m.appendEvent('concurrent_probe', { i });
        }
        process.exit(0);
      }).catch((e) => { console.error(e); process.exit(1); });
    `;
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', code], {
        env: { PATH: process.env.PATH, HOME: concScratch, USERPROFILE: concScratch },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`exit ${code}: ${stderr}`)));
      child.on('error', reject);
    });
  }

  const PER_CHILD = 15;
  let err = null;
  try {
    await Promise.all([spawnAppends(PER_CHILD), spawnAppends(PER_CHILD)]);
  } catch (e) {
    err = e;
  }
  assert(err === null, `both concurrent-writer child processes exited cleanly${err ? ` (${err.message})` : ''}`);

  const eventsPath = path.join(concScratch, '.config', 'memoir', 'events.jsonl');
  const raw = await fs.readFile(eventsPath, 'utf8');
  const lines = raw.split('\n').filter(Boolean);

  let allValid = true;
  for (const line of lines) {
    try { JSON.parse(line); } catch { allValid = false; break; }
  }
  assert(allValid, `every line is valid, complete JSON (no partial/interleaved lines) — ${lines.length} lines checked`);
  assert(lines.length === PER_CHILD * 2, `no lines lost or merged: expected ${PER_CHILD * 2}, got ${lines.length}`);

  await fs.remove(concScratch);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
