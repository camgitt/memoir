#!/usr/bin/env node
// Project identity for the home directory itself.
//
// projectIdentity() hashes the path RELATIVE to home. For the home directory
// that relative path is '', so every user who ran their agent from ~ was
// assigned the same id: 'local:' + sha256('') — a degenerate bucket that is
// neither unique to them nor meaningful. Home now hashes the explicit key '~'.
//
// Records written under the old scheme are still on disk, so canonicalIdentity()
// maps the legacy empty-string id onto the current home id. Without that alias
// the rename would silently hide every next action, decision and memory that
// was tagged while working from home.

import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

// ⚠️  HOME MUST BE SHIMMED BEFORE THE FIRST ./src IMPORT — DO NOT MOVE THIS.
// src/session/state.js binds paths.session from os.homedir() at module load,
// and ESM caching makes that binding permanent for the process. See the same
// warning in test-decisions-hidden.mjs for the 2026-07-13 incident.
const scratchHome = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-scope-home-test-'));
process.env.HOME = scratchHome;
process.env.USERPROFILE = scratchHome; // Windows

const { projectIdentity, canonicalIdentity, visibleMemory } = await import('./src/memory/scope.js');

const BOLD = '\x1b[1m', GREEN = '\x1b[32m', RED = '\x1b[31m', RESET = '\x1b[0m';
let pass = 0, fail = 0;
const assert = (cond, label) => {
  if (cond) { pass++; console.log(`  ${GREEN}PASS${RESET} ${label}`); }
  else { fail++; console.log(`  ${RED}FAIL${RESET} ${label}`); }
};

console.log(`\n${BOLD}project scope — home directory identity${RESET}\n`);

const LEGACY = 'local:' + crypto.createHash('sha256').update('').digest('hex').slice(0, 32);
const homeId = projectIdentity(scratchHome);

assert(homeId !== LEGACY, 'home no longer hashes the empty string');
assert(/^local:[a-f0-9]{32}$/.test(homeId), 'home id is still a well-formed local identity');
assert(canonicalIdentity(LEGACY) === homeId, 'legacy empty-string id is an alias for home');
assert(canonicalIdentity(homeId) === homeId, 'canonicalIdentity is idempotent for a current id');

// A second, unrelated project must not collide with home.
const sub = path.join(scratchHome, 'gathered');
await fs.ensureDir(sub);
assert(projectIdentity(sub) !== homeId, 'a subdirectory gets its own identity');

// Visibility: the whole point of the alias.
const legacyItem = { project: LEGACY };
assert(visibleMemory(legacyItem, { project: scratchHome }) === true,
  'a legacy home-tagged record is still visible from home');
assert(visibleMemory(legacyItem, { project: sub }) === false,
  'a legacy home-tagged record does not leak into a subproject');

// Untagged records stay global — documented behaviour, asserted so a future
// change to it is a deliberate one.
assert(visibleMemory({}, { project: sub }) === true,
  'an untagged record remains visible in every project');

await fs.remove(scratchHome);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
