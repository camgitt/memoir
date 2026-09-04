#!/usr/bin/env node
// Concurrency safety for the session.json read-modify-write cycle
// (src/session/lock.js, wrapped around every mutator in src/session/state.js
// and around autopush.js's debounce check-then-act).
//
// REAL BUG this guards against: every mutator (addGoal, addNext,
// completeNext, addNote, addQuestion, recordSessionEnd) did
// readSession() -> mutate in memory -> writeSession(). writeSession's
// tmp-then-rename only prevents a TORN write; it does not stop two
// concurrent processes from both reading the same on-disk snapshot,
// mutating independently, and having whichever writeSession() lands second
// silently and completely overwrite the other's change. Two Claude Code
// sessions running simultaneously against the same $HOME each run their own
// memoir-mcp stdio server, so this is easily triggered, not theoretical.
//
// This test spawns REAL OS-level child processes (not two async functions
// racing in the same process) — that's the only way to actually exercise
// file-level locking across process boundaries.

import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const BOLD = '\x1b[1m', GREEN = '\x1b[32m', RED = '\x1b[31m', CYAN = '\x1b[36m', RESET = '\x1b[0m';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ${GREEN}PASS${RESET} ${msg}`); pass++; }
  else      { console.log(`  ${RED}FAIL${RESET} ${msg}`); fail++; }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Spawns a real `node -e` child, scratch-HOME sandboxed, that dynamically
// imports state.js and calls addNext(text). Resolves once the child exits
// (rejects on non-zero exit).
function spawnAddNext(scratchHome, text) {
  // A file URL, not a path: on Windows `import('D:\\a\\…')` throws
  // ERR_UNSUPPORTED_ESM_URL_SCHEME (the CI red since 2026-08-19).
  const stateJsPath = JSON.stringify(pathToFileURL(path.join(__dirname, 'src', 'session', 'state.js')).href);
  const code = `
    import(${stateJsPath}).then(async (m) => {
      await m.addNext(${JSON.stringify(text)});
      process.exit(0);
    }).catch((e) => { console.error(e); process.exit(1); });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code], {
      env: { PATH: process.env.PATH, HOME: scratchHome, USERPROFILE: scratchHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`child exited ${code}: ${stderr}`));
    });
    child.on('error', reject);
  });
}

console.log(`\n${BOLD}${CYAN}session.json lock — concurrent processes (no lost update)${RESET}\n`);

{
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-lock-test-'));
  const sessionPath = path.join(scratch, '.config', 'memoir', 'session.json');

  // Five real, independent child processes, all racing addNext() against the
  // SAME scratch session.json at as close to the same instant as possible —
  // more concurrent writers than a bare 2 gives the lock's EEXIST retry path
  // a real chance to actually fire, not just get lucky on ordering.
  const N = 5;
  const texts = Array.from({ length: N }, (_, i) => `concurrent-action-${i}`);

  let err = null;
  try {
    await Promise.all(texts.map((t) => spawnAddNext(scratch, t)));
  } catch (e) {
    err = e;
  }

  assert(err === null, `all ${N} concurrent addNext() child processes exited cleanly${err ? ` (${err.message})` : ''}`);

  let finalState = null;
  try {
    finalState = await fs.readJson(sessionPath);
  } catch (e) {
    assert(false, `session.json readable after concurrent writes (${e.message})`);
  }

  if (finalState) {
    const gotTexts = new Set((finalState.current?.next_actions || []).map((a) => a.text));
    for (const t of texts) {
      assert(gotTexts.has(t), `no lost update: "${t}" present in final session.json`);
    }
    assert(gotTexts.size === N, `exactly ${N} next_actions present (got ${gotTexts.size}) — no duplicate/phantom entries either`);
  }

  await fs.remove(scratch);
}

console.log(`\n${BOLD}${CYAN}session.json lock — autopush debounce (no double-fire)${RESET}\n`);

{
  // Same class of race, applied to autopush.js's debounce check-then-act:
  // spawn N concurrent `memoir autopush --verbose` invocations against a
  // shared scratch HOME and assert at most one actually "triggers" (passes
  // the debounce gate) — the lock serializes the check+stamp so a second
  // concurrent invocation always observes the first one's fresh stamp.
  //
  // A "triggered" invocation spawns a REAL (detached) `memoir push` child.
  // With NO config present, push falls into config.js's autoSetup(), which
  // shells out to the REAL `gh` CLI (`gh api user`, `gh repo view/create`) —
  // and gh's auth token lives in the OS keychain, NOT under $HOME, so
  // overriding HOME/USERPROFILE for the child does NOT sandbox it. Pre-seed
  // a local-provider config (matching the exact convention already used by
  // test-cross-machine-e2e.sh / test-session-sync.sh) so getConfig() always
  // resolves and autoSetup() — and therefore any real `gh` call — is never
  // reached from this test.
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-autopush-lock-test-'));
  const memoirConfigDir = path.join(scratch, '.config', 'memoir');
  await fs.ensureDir(memoirConfigDir);
  await fs.writeJson(path.join(memoirConfigDir, 'config.json'), {
    version: 2,
    activeProfile: 'default',
    profiles: {
      default: { provider: 'local', localPath: path.join(scratch, 'memoir-backup'), encrypt: false },
    },
  });
  const memoirBin = path.join(__dirname, 'bin', 'memoir.js');

  function spawnAutopush() {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [memoirBin, 'autopush', '--verbose', '--debounce', '9999'], {
        env: { PATH: process.env.PATH, HOME: scratch, USERPROFILE: scratch, DO_NOT_TRACK: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('exit', (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`autopush exited ${code}: ${stderr}`));
      });
      child.on('error', reject);
    });
  }

  const N = 5;
  let err = null;
  let outputs = [];
  try {
    outputs = await Promise.all(Array.from({ length: N }, () => spawnAutopush()));
  } catch (e) {
    err = e;
  }

  assert(err === null, `all ${N} concurrent autopush invocations exited cleanly${err ? ` (${err.message})` : ''}`);
  if (outputs.length === N) {
    const triggered = outputs.filter((o) => o.includes('triggered')).length;
    assert(triggered === 1, `exactly 1 of ${N} concurrent autopush invocations triggered (debounce gate not double-passed); got ${triggered}`);
  }

  await fs.remove(scratch);
}

console.log(`\n${BOLD}${CYAN}stale lock recovery${RESET}\n`);

{
  const { withSessionLock } = await import('./src/session/lock.js');
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-lock-stale-test-'));
  const lockPath = path.join(scratch, 'test.lock');

  // Simulate a process that crashed while holding the lock: create the lock
  // file directly and backdate its mtime well past the staleness threshold.
  await fs.writeFile(lockPath, 'stale-pid-99999');
  const oldTime = new Date(Date.now() - 60_000); // 60s ago — the threshold is 30s
  fs.utimesSync(lockPath, oldTime, oldTime);

  const start = Date.now();
  let ran = false;
  await withSessionLock(lockPath, async () => { ran = true; });
  const elapsed = Date.now() - start;

  assert(ran === true, 'withSessionLock recovers from a stale lock and runs the critical section');
  assert(elapsed < 2000, `stale-lock recovery is fast, not the full bounded wait (${elapsed}ms)`);
  assert(!(await fs.pathExists(lockPath)), 'lock file cleaned up after use following stale recovery');

  await fs.remove(scratch);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
