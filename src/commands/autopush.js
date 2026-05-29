// Auto-push command — called by the Claude Code Stop hook after every response.
//
// Rules of engagement:
//   - Debounced: won't run more than once per DEBOUNCE_SECONDS.
//   - Non-blocking: detaches a background subprocess and exits immediately
//     so Claude's response pipeline is never held up.
//   - Silent: no stdout unless --verbose is passed.
//
// The actual push work happens in a fully detached child — the hook process
// itself just records a timestamp and returns.

import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';

const home = os.homedir();
const STAMP_FILE = path.join(home, '.config', 'memoir', 'last-autopush.timestamp');
const DEBOUNCE_SECONDS_DEFAULT = 30;

export async function autopushCommand(options = {}) {
  const debounce = parseInt(options.debounce || DEBOUNCE_SECONDS_DEFAULT, 10);
  const verbose = !!options.verbose;

  try {
    await fs.ensureDir(path.dirname(STAMP_FILE));
  } catch {}

  const now = Date.now();
  let last = 0;
  try {
    const raw = await fs.readFile(STAMP_FILE, 'utf8');
    last = parseInt(raw.trim(), 10) || 0;
  } catch {}

  const elapsed = (now - last) / 1000;
  if (last && elapsed < debounce) {
    if (verbose) console.log(`memoir autopush: skipped (${Math.floor(elapsed)}s since last, debounce=${debounce}s)`);
    return;
  }

  // Stamp BEFORE spawning so rapid repeat calls don't all race through.
  try {
    await fs.writeFile(STAMP_FILE, String(now));
  } catch {}

  // Detach a background push. Parent exits immediately so Claude isn't blocked.
  const memoirBin = process.argv[1]; // path to this same memoir CLI
  const child = spawn(process.execPath, [memoirBin, 'push'], {
    detached: true,
    stdio: verbose ? 'inherit' : 'ignore',
    env: { ...process.env, MEMOIR_AUTOPUSH: '1' },
  });
  child.unref();

  if (verbose) console.log('memoir autopush: triggered (background)');
}
