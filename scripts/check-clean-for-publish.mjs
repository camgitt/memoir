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
