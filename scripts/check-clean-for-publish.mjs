#!/usr/bin/env node
// prepublishOnly guard: npm packs whatever's on disk under package.json's
// "files" paths — it does NOT check git tracking status. An uncommitted or
// modified file sitting in one of those paths (new WIP, an in-progress
// edit) would silently ship in the published tarball with no warning.
//
// This nearly happened on 2026-07-13: an untracked src/utils/platform.js
// (unreviewed WIP) showed up in the `npm publish` tarball listing.
//
// If run from a plain `git archive` export (no .git present — the safe way
// to publish while unrelated WIP sits in the working tree), there is
// nothing to check and this is a no-op.

import { execSync } from 'child_process';
import fs from 'fs';

// Auth check FIRST, before the full test suite runs. An expired npm session
// (it silently expires between releases — 3.10.1, 3.11.0 and 3.12.0 all hit
// it) makes `npm publish` run every test and then fail with a misleading
// "404 Not Found - PUT .../memoir-cli ... could not be found or you do not
// have permission" — which reads as a package problem, not a login problem,
// and cost three weeks once. Fail fast with the actual fix instead.
// Skip when the registry is unreachable (offline dry-runs) or when explicitly
// disabled (CI with a granular token that can publish but not whoami).
if (!process.env.MEMOIR_SKIP_NPM_AUTH_CHECK) {
  try {
    execSync('npm whoami', { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 15000 });
  } catch (err) {
    const msg = String(err?.stderr || err?.message || '');
    if (/E401|401|ENEEDAUTH|Unauthorized/i.test(msg)) {
      console.error(
        '\npublish blocked: not logged in to npm (the token in ~/.npmrc has expired).\n' +
          'Run:  npm login   (opens a browser; then re-run npm publish — it will ask for your OTP)\n' +
          'Note: with a dead token npm publish itself would have failed AFTER the whole test suite\n' +
          'with a misleading "404 Not Found - PUT" — that 404 is really this 401.\n'
      );
      process.exit(1);
    }
    // Network error / registry hiccup: don't block on it, publish will surface it.
  }
}

if (!fs.existsSync('.git')) {
  process.exit(0);
}

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const paths = pkg.files || [];
if (paths.length === 0) process.exit(0);

const out = execSync(`git status --porcelain -- ${paths.map((p) => JSON.stringify(p)).join(' ')}`, {
  encoding: 'utf8',
});

if (out.trim()) {
  console.error(
    `\npublish blocked: uncommitted changes under published paths (${paths.join(', ')}):\n\n${out}\n` +
      'Commit or revert these first, or publish from a clean snapshot:\n' +
      '  git archive HEAD | tar -x -C <tmpdir> && cd <tmpdir> && npm ci && npm publish\n'
  );
  process.exit(1);
}
