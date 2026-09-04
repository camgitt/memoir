import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import { execFileSync } from 'child_process';
import { appendEvent } from '../events/log.js';

function sanitizeUrl(url) {
  // Reject URLs with shell metacharacters
  if (/[`$;|&()<>!]/.test(url)) {
    throw new Error('Repository URL contains invalid characters.');
  }
  return url;
}

export async function syncToLocal(config, stagingDir, spinner) {
  const destDir = config.localPath;
  if (!destDir) throw new Error('Local path is not configured.');

  const resolvedDest = destDir.replace(/^~/, os.homedir());

  spinner.text = `Syncing files to local directory: ${chalk.cyan(resolvedDest)}`;
  await fs.ensureDir(resolvedDest);

  await fs.copy(stagingDir, resolvedDest);

  // Prune orphaned encrypted blobs. Each encrypted push derives a fresh salt
  // and therefore fresh HMAC filenames, so without this every push leaves the
  // previous push's data/*.enc behind forever and localPath grows without
  // bound. Only runs for a full encrypted sync (manifest.enc present in what
  // we just wrote) — `memoir snapshot` also calls syncToLocal with a staging
  // dir of a single handoff file, and blanket-emptying the destination there
  // would delete the user's backup.
  try {
    const stagedManifest = path.join(stagingDir, 'manifest.enc');
    const destData = path.join(resolvedDest, 'data');
    if (await fs.pathExists(stagedManifest) && await fs.pathExists(destData)) {
      const keep = new Set(await fs.readdir(path.join(stagingDir, 'data')).catch(() => []));
      for (const f of await fs.readdir(destData)) {
        if (!keep.has(f)) await fs.remove(path.join(destData, f)).catch(() => {});
      }
    }
  } catch {
    // Pruning is housekeeping — never fail a completed backup over it.
  }

  spinner.succeed(chalk.green('Sync complete! ') + chalk.gray(`(Saved to ${resolvedDest})`));
  await appendEvent('sync_pushed', { provider: 'local' });
}

// ── Git sync ─────────────────────────────────────────────────────
//
// One cheap clone per push. `--depth 1 --filter=blob:none --no-checkout`
// fetches commits and trees only — no file contents, no working tree. The
// remote of the author's own store is 720MB with ~40MB of workspace bundles
// at HEAD; the old full shallow clone, done TWICE per push (the merge peek in
// push.js and then this function), pulled all of it through on every Stop
// hook and a quarter of pushes died on the 60s timeout (183 sync_failed in
// 15 days, none with a reason). Blobs are now fetched on demand only for the
// files a caller actually reads (`git checkout HEAD -- session.json`).
// Remotes that don't support filters (plain file:// paths, old hosts) print
// a warning and fall back to a normal shallow clone — never worse than before.
//
// Mirror semantics are unchanged and come for free: after a --no-checkout
// clone the index is empty and every remote file is a staged deletion until
// something re-adds it, so `copy staging → git add -A` yields exactly
// "staging + the files the caller asked to preserve".

export const CLONE_TIMEOUT_MS = 60000;
const GIT_QUIET = ['ignore', 'ignore', 'pipe']; // stderr kept for classifyGitError

export function cloneForSync(repoUrl, dir, { timeout = CLONE_TIMEOUT_MS } = {}) {
  execFileSync('git', ['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', repoUrl, '.'], {
    cwd: dir, stdio: GIT_QUIET, timeout,
  });
}

// Does the remote HEAD carry `file`? Reads the tree only — no blob fetch.
export function remoteHasFile(dir, file) {
  try {
    const out = execFileSync('git', ['ls-tree', '--name-only', 'HEAD', '--', file], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000,
    });
    return out.trim().length > 0;
  } catch {
    return false; // unborn HEAD (empty remote) or not a repo
  }
}

// Materialise one remote file into the working tree (fetches its blob).
export function checkoutFromRemote(dir, file) {
  try {
    execFileSync('git', ['checkout', 'HEAD', '--', file], { cwd: dir, stdio: 'ignore', timeout: 30000 });
    return true;
  } catch {
    return false;
  }
}

// A short enum for the event log — never the raw stderr (it can carry the
// repo URL, a username, a local path). Enough to tell "the network is down"
// from "two pushes raced" from "the token expired" when reading events.jsonl.
export function classifyGitError(err) {
  const text = `${err?.message || ''}\n${err?.stderr || ''}`.toLowerCase();
  if (err?.code === 'ETIMEDOUT' || err?.signal === 'SIGTERM' || /timed? ?out/.test(text)) return 'timeout';
  if (/non-fast-forward|fetch first|\[rejected\]/.test(text)) return 'non_fast_forward';
  if (/authentication failed|could not read username|could not read password|permission denied|terminal prompts disabled|invalid credentials|403/.test(text)) return 'auth';
  if (/could not resolve host|unable to access|connection (?:refused|reset|timed)|network is unreachable|early eof|remote end hung up/.test(text)) return 'network';
  if (/repository not found|does not appear to be a git repository|does not exist|no such file/.test(text)) return 'not_found';
  if (/invalid characters/.test(text)) return 'bad_url';
  return 'unknown';
}

/**
 * Push `stagingDir` to the git remote as the new HEAD:main.
 *
 * options:
 *   cloneDir  — a directory already prepared by cloneForSync (push.js's merge
 *               peek). Reused instead of cloning again; removed when done.
 *   preserve  — remote files to keep even though staging lacks them
 *               (an unreadable session.json the caller declined to overwrite).
 *   additive  — overlay staging onto the remote tree instead of mirroring it
 *               (`memoir snapshot` uploads ONE handoff file; mirroring would
 *               have wiped every other file in the backup).
 */
export async function syncToGit(config, stagingDir, spinner, options = {}) {
  const repoUrl = sanitizeUrl(config.gitRepo);
  if (!repoUrl) throw new Error('Git repository is not configured.');

  spinner.text = `Authenticating and syncing with Git remote: ${chalk.cyan(repoUrl)}`;

  const reuse = Boolean(options.cloneDir) && await fs.pathExists(path.join(options.cloneDir, '.git'));
  const gitDir = reuse ? options.cloneDir : path.join(os.tmpdir(), `memoir-git-${Date.now()}`);
  await fs.ensureDir(gitDir);
  const started = Date.now();

  try {
    if (!reuse) {
      try {
        cloneForSync(repoUrl, gitDir);
      } catch (err) {
        // Cloning an EMPTY remote succeeds (git warns and continues), so a
        // failure here is a real one. Unreachable / unauthorised / timed out
        // must surface as such — the old unconditional `git init` fallback
        // turned every one of them into a later, misleading
        // "non-fast-forward" or "credentials" failure. Only a not_found /
        // unknown failure (a host that refuses to clone an empty repo) still
        // falls back to init so a first push can create the history.
        const reason = classifyGitError(err);
        if (reason === 'timeout' || reason === 'auth' || reason === 'network') throw err;
        execFileSync('git', ['init'], { cwd: gitDir, stdio: 'ignore' });
        execFileSync('git', ['branch', '-m', 'main'], { cwd: gitDir, stdio: 'ignore' });
      }
    }

    // Files the caller wants kept although staging lacks them: check them
    // out (one blob each) so `git add -A` below sees them in the tree.
    for (const p of options.preserve || []) checkoutFromRemote(gitDir, p);

    if (options.additive) {
      // Populate the index from HEAD (trees only, no blobs) so everything
      // the remote already has stays in the commit; then add ONLY what
      // staging brought. `git add -A` over an empty working tree would
      // stage every other remote file as deleted.
      try { execFileSync('git', ['read-tree', 'HEAD'], { cwd: gitDir, stdio: 'ignore', timeout: 30000 }); } catch {}
    }

    await fs.copy(stagingDir, gitDir);

    if (options.additive) {
      const tops = (await fs.readdir(stagingDir)).filter((n) => n !== '.git');
      if (tops.length) execFileSync('git', ['add', '-A', '--', ...tops], { cwd: gitDir, stdio: 'ignore', timeout: 30000 });
    } else {
      execFileSync('git', ['add', '-A'], { cwd: gitDir, stdio: 'ignore', timeout: 30000 });
    }
    execFileSync('git', ['config', 'user.name', 'memoir'], { cwd: gitDir, stdio: 'ignore', timeout: 5000 });
    execFileSync('git', ['config', 'user.email', 'bot@memoir.dev'], { cwd: gitDir, stdio: 'ignore', timeout: 5000 });

    const timestamp = new Date().toISOString().split('T')[0];
    try {
      execFileSync('git', ['commit', '-q', '-m', `memoir backup ${timestamp}`], { cwd: gitDir, stdio: 'ignore', timeout: 30000 });
    } catch {
      spinner.succeed(chalk.green('Already up to date! ') + chalk.gray('No changes to push.'));
      return;
    }

    spinner.text = `Pushing data to ${chalk.cyan(repoUrl)}...`;
    // HEAD:main pushes whatever branch the clone checked out (a master-
    // default remote used to make `push main` fail silently under autopush
    // with a misleading credentials error, while doctor reported green).
    execFileSync('git', ['push', '-q', repoUrl, 'HEAD:main'], { cwd: gitDir, stdio: GIT_QUIET, timeout: 120000 });

    spinner.succeed(chalk.green('Sync complete! ') + chalk.gray('(Uploaded securely to GitHub)'));
    await appendEvent('sync_pushed', { provider: 'git', ms: Date.now() - started, reused_clone: reuse });
  } catch (err) {
    // Makes a silently-swallowed push failure (a non-fast-forward rejection
    // from two racing pushes, a network error, bad credentials, etc.)
    // visible in the event log instead of vanishing into the detached
    // autopush child's ignored stdio. `reason` is a short enum, never the
    // raw error text/repo URL — those can contain usernames/paths.
    const reason = classifyGitError(err);
    await appendEvent('sync_failed', { provider: 'git', reason, ms: Date.now() - started });
    if (err.message.includes('invalid characters')) throw err;
    throw new Error(`Failed to push to git repository (${reason}). Ensure your credentials are configured and the repository exists.`);
  } finally {
    await fs.remove(gitDir).catch(() => {});
  }
}
