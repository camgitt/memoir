#!/usr/bin/env node
// Regression guard for the 2026-09-04 audit fixes:
//   • next-actions PARK on overflow instead of vanishing (3 live items were
//     silently dropped in one week while the store sat at exactly MAX_NEXT)
//   • goals retire with a tombstone (a plain removal came back on merge)
//   • merge re-splits live/parked instead of capping (same silent eviction)
//   • history dedupes by session_id and hides content-free summaries
//   • handoff dir is pruned to a window
//   • git sync: one blob-less clone, `additive` mode keeps the remote tree,
//     `preserve` survives, sync_failed carries a reason enum
//
// Shims $HOME BEFORE importing any ./src module — state.js binds its paths
// at import time (see run-tests.mjs for the incident that rule comes from).
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

const BOLD = '\x1b[1m', GREEN = '\x1b[32m', RED = '\x1b[31m', CYAN = '\x1b[36m', RESET = '\x1b[0m';
let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ${GREEN}PASS${RESET} ${msg}`); pass++; }
  else      { console.log(`  ${RED}FAIL${RESET} ${msg}`); fail++; }
}

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-parking-test-'));
process.env.HOME = scratch;
process.env.USERPROFILE = scratch;
process.env.APPDATA = path.join(scratch, 'AppData', 'Roaming');

const state = await import('./src/session/state.js');
const { renderSession, isContentFreeSummary } = await import('./src/session/render.js');
const { saveHandoff, pruneHandoffs, localHandoffDir } = await import('./src/context/handoffs.js');
const { syncToGit, cloneForSync, classifyGitError } = await import('./src/providers/index.js');

// events/log.js keeps its log under %APPDATA%\memoir on Windows and
// ~/.config/memoir elsewhere — mirror that so the assertions read the file
// the code actually writes.
const eventsPath = process.platform === 'win32'
  ? path.join(process.env.APPDATA, 'memoir', 'events.jsonl')
  : path.join(scratch, '.config', 'memoir', 'events.jsonl');
async function events(type) {
  try {
    return (await fs.readFile(eventsPath, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === type);
  } catch { return []; }
}
const texts = (list) => (list || []).map((a) => a.text);

// ── 1. Parking on overflow ──────────────────────────────────────────
console.log(`\n${BOLD}${CYAN}next-actions park on overflow${RESET}\n`);
{
  let reported = null;
  for (let i = 1; i <= 10; i++) {
    const st = await state.addNext(`parking-item-${i}`);
    if (i === 9) reported = st.justParked;
  }
  const s = await state.readSession();
  assert(s.current.next_actions.length === 8, 'live list holds exactly MAX_NEXT (8)');
  assert(s.current.parked_actions.length === 2, 'the two oldest were parked, not dropped');
  assert(texts(s.current.parked_actions).join(',') === 'parking-item-2,parking-item-1', 'parked list is newest-parked first');
  assert(texts(s.current.next_actions)[0] === 'parking-item-3', 'oldest live item is the 3rd added');
  assert(reported && reported.length === 1 && reported[0].text === 'parking-item-1', 'addNext reports what it parked (justParked)');
  assert(reported && !JSON.stringify(s).includes('justParked'), 'justParked is not serialised into session.json');
  assert((await events('next_parked')).length === 2, 'each parking emits a next_parked event');
}

// ── 2. Re-adding a parked item brings it back ───────────────────────
{
  await state.addNext('parking-item-1');
  const s = await state.readSession();
  assert(texts(s.current.next_actions).includes('parking-item-1'), 're-adding a parked item un-parks it');
  assert(!texts(s.current.parked_actions).includes('parking-item-1'), 'un-parked item left the parked list');
  assert(texts(s.current.parked_actions).includes('parking-item-3'), 'the then-oldest live item was parked to make room');
}

// ── 3. Completing a parked item works and tombstones it ─────────────
{
  await state.completeNext('parking-item-2');
  const s = await state.readSession();
  assert(!texts(s.current.parked_actions).includes('parking-item-2'), 'completeNext finds parked items');
  assert(s.current.completed_actions.some((c) => c.text === 'parking-item-2'), 'completing a parked item records the tombstone');
  assert((await events('next_completed')).length === 1, 'completing a parked item emits next_completed');
}

// ── 4. Merge re-splits instead of capping ───────────────────────────
console.log(`\n${BOLD}${CYAN}merge keeps every next-action (live or parked)${RESET}\n`);
{
  const mk = (n, day) => ({ text: n, machine_id: 'm', added: `2026-09-${String(day).padStart(2, '0')}T00:00:00Z` });
  const local = {
    ...state.emptySession(),
    current: { ...state.emptySession().current,
      next_actions: [1, 2, 3, 4, 5, 6, 7, 8].map((d) => mk(`L${d}`, d)),
      parked_actions: [mk('Lp', 0)] },
  };
  const remote = {
    ...state.emptySession(),
    current: { ...state.emptySession().current,
      next_actions: [mk('R9', 9), mk('R10', 10), mk('R11', 11)],
      completed_actions: [{ text: 'L2', done_at: '2026-09-12T00:00:00Z' }] },
  };
  const merged = state.mergeSessions(local, remote);
  const live = texts(merged.current.next_actions);
  const parked = texts(merged.current.parked_actions);
  assert(live.length === 8, 'merged live list is capped at 8');
  assert(live[live.length - 1] === 'R11' && live[0] === 'L4', 'live = the 8 newest by `added`, oldest-first order');
  assert(parked.includes('L1') && parked.includes('L3') && parked.includes('Lp'), 'older items are parked, not lost');
  assert(!live.includes('L2') && !parked.includes('L2'), 'a completed-action tombstone still removes the item from both lists');
  assert(live.length + parked.length === 8 + 3 + 1 - 1, 'nothing else was dropped');
}

// ── 4b. Unknown `current` fields survive a merge ─────────────────────
{
  const base = state.emptySession();
  const local = { ...base, current: { ...base.current, future_field: [{ text: 'from a newer build' }] } };
  const remote = { ...base, current: { ...base.current, other_future: 'remote-only', future_field: [{ text: 'stale' }] } };
  const merged = state.mergeSessions(local, remote);
  assert(Array.isArray(merged.current.future_field) && merged.current.future_field[0].text === 'from a newer build', 'unknown current.* keys pass through, local copy wins');
  assert(merged.current.other_future === 'remote-only', 'unknown keys only the remote has are kept too');
}

// ── 5. Goals: cap reports, --done tombstones and survives merge ─────
console.log(`\n${BOLD}${CYAN}goals${RESET}\n`);
{
  await state.addGoal('goal-A');
  await state.addGoal('goal-B');
  await state.addGoal('goal-C');
  const st = await state.addGoal('goal-D');
  assert(st.replacedGoals.length === 1 && st.replacedGoals[0].text === 'goal-A', 'a 4th goal reports which one it replaced');
  const gs = await events('goal_set');
  assert(gs[gs.length - 1].replaced === 1, 'goal_set event carries replaced count');

  const before = await state.readSession();
  const done = await state.completeGoal('goal-b');
  assert(done.completed === true, 'completeGoal matches case-insensitively by substring');
  const after = await state.readSession();
  assert(!texts(after.current.goals).includes('goal-B'), 'retired goal is gone from goals');
  assert(after.current.completed_goals[0].text === 'goal-B', 'retired goal has a tombstone');
  const merged = state.mergeSessions(after, before);
  assert(!texts(merged.current.goals).includes('goal-B'), 'a stale copy cannot resurrect a retired goal on merge');
  // The temporal rule compares set_on > done_at at millisecond resolution;
  // retiring and re-setting inside the same millisecond (seen once in five
  // runs) reads as a stale copy. Give the clock a tick — the rule under test
  // is "later re-set survives", not sub-millisecond ordering.
  await new Promise((r) => setTimeout(r, 5));
  await state.addGoal('goal-B');
  const revived = state.mergeSessions(await state.readSession(), before);
  assert(texts(revived.current.goals).includes('goal-B'), 'a goal re-set AFTER retirement survives the merge (temporal tombstone)');
  assert((await events('goal_completed')).length === 1, 'completeGoal emits goal_completed');
  const miss = await state.completeGoal('no such goal');
  assert(miss.completed === false, 'completeGoal reports no match honestly');
}

// ── 6. Render ───────────────────────────────────────────────────────
console.log(`\n${BOLD}${CYAN}render${RESET}\n`);
{
  const s = await state.readSession();
  const md = renderSession(s);
  // State here: live = items 4..10 + item-1 (8), parked = item-3 (item-2 was completed).
  const itemLines = md.split('\n').filter((l) => l.startsWith('- [ ] parking-item-'));
  assert(itemLines.length === 9 && md.includes('**Parked ('), 'block renders all 8 live items plus the parked one under a Parked section');
  assert(md.indexOf('**Parked (') < md.indexOf('- [ ] parking-item-3'), 'the parked item is rendered (full text) under the Parked heading');
  assert(isContentFreeSummary('Worked on calm-bubbling-liskov') && isContentFreeSummary('3 file(s) touched') && isContentFreeSummary('—'), 'content-free summaries are recognised');
  assert(!isContentFreeSummary('gymlogger (main): ok lets look at domain names now'), 'a real summary is not');
  await state.recordSessionEnd({ summary: 'Worked on calm-bubbling-liskov', durationMin: 5, sessionId: 'sid-1' });
  await state.recordSessionEnd({ summary: 'memoir (main): fix list', durationMin: 6, sessionId: 'sid-2' });
  await state.recordSessionEnd({ summary: 'memoir (main): fix list, tests', durationMin: 30, sessionId: 'sid-2' });
  const s2 = await state.readSession();
  const md2 = renderSession(s2);
  assert(!md2.includes('calm-bubbling-liskov'), 'content-free history rows are not rendered');
  assert(s2.history.filter((h) => h.session_id === 'sid-2').length === 1, 'same session_id updates its history row in place');
  assert(s2.history.find((h) => h.session_id === 'sid-2').duration_min === 30, 'the in-place update carries the newer duration');
  assert(md2.includes('memoir (main): fix list, tests'), 'the updated summary is what renders');
}

// ── 7. Handoff pruning ──────────────────────────────────────────────
console.log(`\n${BOLD}${CYAN}handoffs${RESET}\n`);
{
  const dir = localHandoffDir();
  assert(dir.startsWith(scratch), 'handoff dir resolves under the shimmed HOME');
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  await fs.ensureDir(dir);
  for (let i = 0; i < 6; i++) {
    const f = path.join(dir, `2026-08-0${i + 1}T00-00-00-claude.md`);
    await fs.writeFile(f, `old ${i}`);
    const t = new Date(now - (30 - i) * day); // 30..25 days old
    await fs.utimes(f, t, t);
  }
  const fresh = await saveHandoff('fresh handoff', { filename: 'fresh-claude.md' });
  assert(fresh === 'fresh-claude.md', 'saveHandoff returns the filename used');
  assert(await fs.pathExists(path.join(dir, 'latest.md')), 'latest.md written');
  const left = (await fs.readdir(dir)).sort();
  assert(!left.some((n) => n.startsWith('2026-08-0')), 'files older than the window are pruned on save');
  assert(left.includes('fresh-claude.md') && left.includes('latest.md'), 'the new file and latest.md survive');
  for (let i = 0; i < 5; i++) await fs.writeFile(path.join(dir, `k${i}.md`), 'x');
  const removed = await pruneHandoffs(dir, { keepMax: 3, keepDays: 365 });
  const after = (await fs.readdir(dir)).filter((n) => n !== 'latest.md');
  assert(after.length === 3 && removed === 3, `keepMax trims to the newest N (kept ${after.length}, removed ${removed})`);
}

// ── 8. Git sync ─────────────────────────────────────────────────────
console.log(`\n${BOLD}${CYAN}git sync${RESET}\n`);
{
  const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-parking-bare-'));
  execFileSync('git', ['init', '--bare', '-b', 'main', bare], { stdio: 'ignore' });
  const spinner = { text: '', succeed() {}, start() {}, fail() {}, warn() {} };
  const tree = () => execFileSync('git', ['-C', bare, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' }).split('\n').filter(Boolean).sort();
  const staging = async (files) => {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-parking-staging-'));
    for (const [rel, content] of Object.entries(files)) { await fs.ensureDir(path.dirname(path.join(d, rel))); await fs.writeFile(path.join(d, rel), content); }
    return d;
  };

  await syncToGit({ gitRepo: bare }, await staging({ 'a.txt': 'a', 'session.json': '{"v":1}' }), spinner);
  assert(tree().join(',') === 'a.txt,session.json', 'first push into an empty remote creates the tree');

  await syncToGit({ gitRepo: bare }, await staging({ 'handoffs/x.md': 'x' }), spinner, { additive: true });
  assert(tree().join(',') === 'a.txt,handoffs/x.md,session.json', 'additive push (snapshot) keeps every remote file and adds its own');

  await syncToGit({ gitRepo: bare }, await staging({ 'b.txt': 'b' }), spinner, { preserve: ['session.json'] });
  assert(tree().join(',') === 'b.txt,session.json', 'mirror push replaces the tree but keeps preserved files');

  const peek = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-parking-peek-'));
  cloneForSync(bare, peek);
  assert(!(await fs.pathExists(path.join(peek, 'b.txt'))), 'cloneForSync checks nothing out');
  const pushedBefore = (await events('sync_pushed')).length;
  await syncToGit({ gitRepo: bare }, await staging({ 'c.txt': 'c' }), spinner, { cloneDir: peek });
  const pushed = await events('sync_pushed');
  assert(pushed.length === pushedBefore + 1 && pushed[pushed.length - 1].reused_clone === true, 'a caller-supplied clone is reused (reused_clone:true in sync_pushed)');
  assert(typeof pushed[pushed.length - 1].ms === 'number', 'sync_pushed carries a duration');
  assert(!(await fs.pathExists(peek)), 'the reused clone dir is removed afterwards');
  assert(tree().join(',') === 'c.txt', 'the reused-clone push mirrored correctly');

  let threw = false;
  try { await syncToGit({ gitRepo: path.join(os.tmpdir(), 'memoir-parking-nonexistent-' + Date.now()) }, await staging({ 'z.txt': 'z' }), spinner); }
  catch (e) { threw = /not_found|unknown/.test(e.message); }
  const failed = await events('sync_failed');
  assert(threw, 'an unreachable remote still throws, and the message names the reason');
  assert(failed.length >= 1 && typeof failed[failed.length - 1].reason === 'string' && failed[failed.length - 1].reason.length > 0, 'sync_failed carries a reason enum');
  assert(!JSON.stringify(failed).includes(os.tmpdir()), 'sync_failed never contains the repo path');

  assert(classifyGitError({ code: 'ETIMEDOUT' }) === 'timeout', 'classify: ETIMEDOUT → timeout');
  assert(classifyGitError({ message: 'x', stderr: '! [rejected] HEAD -> main (fetch first)' }) === 'non_fast_forward', 'classify: rejected → non_fast_forward');
  assert(classifyGitError({ message: 'x', stderr: 'fatal: Authentication failed for https://…' }) === 'auth', 'classify: auth');
  assert(classifyGitError({ message: 'x', stderr: 'fatal: unable to access …: Could not resolve host: github.com' }) === 'network', 'classify: network');
  assert(classifyGitError({ message: 'x', stderr: 'fatal: repository not found' }) === 'not_found', 'classify: not_found');

  await fs.remove(bare);
}

await fs.remove(scratch).catch(() => {});
console.log(`\n${BOLD}${pass} passed, ${fail} failed${RESET}\n`);
process.exit(fail ? 1 : 0);
