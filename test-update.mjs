// memoir update — resolves and upgrades the RUNNING install, not whichever
// copy `npm -g` happens to own. Scratch HOME; no network (MEMOIR_UPDATE_LATEST).
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const BOLD = '\x1b[1m', GREEN = '\x1b[32m', RED = '\x1b[31m', RESET = '\x1b[0m';
let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ${GREEN}PASS${RESET} ${msg}`); }
  else { fail++; console.log(`  ${RED}FAIL${RESET} ${msg}`); }
}

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-update-test-'));
process.env.HOME = scratch;
process.env.USERPROFILE = scratch;
process.env.XDG_CONFIG_HOME = path.join(scratch, '.config');

const { isNewer, findPackageRoot, classifyInstall, planUpdate, listPathInstalls, shadowWarnings, readInstalledVersion, updateCommand } = await import('./src/commands/update.js');

// ── Fixture: three installs and a source checkout ─────────────────
async function fakeInstall(root, version) {
  await fs.outputJson(path.join(root, 'package.json'), { name: 'memoir-cli', version, bin: { memoir: 'bin/memoir.js' } });
  await fs.outputFile(path.join(root, 'bin', 'memoir.js'), '#!/usr/bin/env node\n');
  return root;
}
const home = path.join(scratch, 'home');
const npmGlobalRoot = path.join(scratch, 'npm', 'lib', 'node_modules');
const bunGlobalRoot = path.join(home, '.bun', 'install', 'global', 'node_modules');
const localRoot = await fakeInstall(path.join(home, 'node_modules', 'memoir-cli'), '3.12.0');
const globalRoot = await fakeInstall(path.join(npmGlobalRoot, 'memoir-cli'), '3.16.0');
const bunRoot = await fakeInstall(path.join(bunGlobalRoot, 'memoir-cli'), '3.6.1');
const sourceRoot = await fakeInstall(path.join(scratch, 'checkout'), '3.16.1');
await fs.ensureDir(path.join(sourceRoot, '.git'));
await fs.outputJson(path.join(home, 'package.json'), { name: 'home', dependencies: { 'memoir-cli': '^3.6.1' } });
const orphanRoot = await fakeInstall(path.join(scratch, 'somewhere', 'memoir-cli'), '3.0.0');

// PATH shims: bun's shim points at the project-local copy (the real-world
// layout that caused the bug), npm's bin at the global copy.
const bunBin = path.join(home, '.bun', 'bin');
const npmBin = path.join(scratch, 'npm', 'bin');
await fs.ensureDir(bunBin); await fs.ensureDir(npmBin);
await fs.symlink(path.join(localRoot, 'bin', 'memoir.js'), path.join(bunBin, 'memoir'));
await fs.symlink(path.join(globalRoot, 'bin', 'memoir.js'), path.join(npmBin, 'memoir'));
const PATH = [bunBin, npmBin, path.join(scratch, 'empty')].join(path.delimiter);

// 1. version compare
assert(isNewer('3.16.1', '3.16.0') && isNewer('4.0.0', '3.99.99') && !isNewer('3.16.0', '3.16.0') && !isNewer('3.9.9', '3.16.0'), 'isNewer compares numerically');
assert(!isNewer('', '3.16.0') && !isNewer('latest', '3.16.0'), 'garbage never reads as newer');

// 2. package root resolution through symlinks
assert(findPackageRoot(path.join(bunBin, 'memoir')) === await fs.realpath(localRoot), 'bun shim resolves to the project-local package');
assert(findPackageRoot(path.join(npmBin, 'memoir')) === await fs.realpath(globalRoot), 'npm bin resolves to the global package');
assert(findPackageRoot(path.join(scratch, 'nope', 'memoir')) === null, 'missing path resolves to null');
assert(readInstalledVersion(localRoot) === '3.12.0' && readInstalledVersion(path.join(scratch, 'empty')) === null, 'readInstalledVersion reads the package on disk');

// 3. classification
const opts = { npmGlobalRoot, bunGlobalRoot };
assert(classifyInstall(localRoot, opts).kind === 'local' && classifyInstall(localRoot, opts).project === home && classifyInstall(localRoot, opts).hasManifest === true, 'project-local install is classified with its project');
assert(classifyInstall(globalRoot, opts).kind === 'npm-global', 'npm global install is classified');
assert(classifyInstall(bunRoot, opts).kind === 'bun-global', 'bun global install is classified');
assert(classifyInstall(sourceRoot, opts).kind === 'source', 'git checkout is classified as source');
assert(classifyInstall(orphanRoot, opts).kind === 'unknown' && classifyInstall(null, opts).kind === 'unknown', 'unrecognised layouts fall to unknown');

// 4. plans
const local = planUpdate(classifyInstall(localRoot, opts), '9.9.9');
assert(local.command === 'npm' && local.cwd === home && local.args.includes('memoir-cli@9.9.9') && !local.args.includes('-g') && !local.args.includes('--no-save'), 'local plan installs in the project, recorded in its manifest');
await fs.remove(path.join(home, 'package.json'));
assert(planUpdate(classifyInstall(localRoot, opts), '9.9.9').args.includes('--no-save'), 'local plan without a manifest does not create one');
await fs.outputJson(path.join(home, 'package.json'), { name: 'home', dependencies: { 'memoir-cli': '^3.6.1' } });
const glob = planUpdate(classifyInstall(globalRoot, opts), '9.9.9');
assert(glob.command === 'npm' && glob.args.join(' ') === 'install -g memoir-cli@9.9.9' && glob.cwd === undefined, 'npm-global plan pins the version');
assert(planUpdate(classifyInstall(bunRoot, opts), '9.9.9').command === 'bun', 'bun-global plan uses bun');
assert(planUpdate(classifyInstall(sourceRoot, opts), '9.9.9').command === null, 'source plan never runs a package manager');
assert(planUpdate(classifyInstall(orphanRoot, opts), '9.9.9').args.includes('-g'), 'unknown plan falls back to npm -g');

// 5. PATH listing + shadow warnings
const installs = listPathInstalls({ PATH });
assert(installs.length === 2 && installs[0].version === '3.12.0' && installs[1].version === '3.16.0', 'PATH installs listed in shell order with versions');
const warnGlobal = shadowWarnings(globalRoot, installs);
assert(warnGlobal.length === 1 && /Your shell runs/.test(warnGlobal[0]) && warnGlobal[0].includes('3.12.0'), 'updating the global copy warns that the shell runs the local one');
assert(shadowWarnings(localRoot, installs).length === 1 && /not updated/.test(shadowWarnings(localRoot, installs)[0]), 'updating the running copy still names the other copy on PATH');
assert(shadowWarnings(localRoot, installs.slice(0, 1)).length === 0, 'single install → no warnings');

// 6. updateCommand end to end with an injected runner: it updates the RUNNING
//    install (the local one the bun shim points at), verifies from disk, and
//    reports the shadow.
const logs = [];
const ran = [];
const result = await updateCommand({}, {
  currentVersion: '3.12.0', scriptPath: path.join(bunBin, 'memoir'), PATH, npmGlobalRoot, bunGlobalRoot,
  fetchLatest: async () => '9.9.9',
  run: async (cmd, args, cwd) => { ran.push({ cmd, args, cwd }); await fs.outputJson(path.join(localRoot, 'package.json'), { name: 'memoir-cli', version: '9.9.9' }); },
  log: m => logs.push(String(m)),
});
assert(ran.length === 1 && ran[0].cwd === await fs.realpath(home) && ran[0].args.includes('memoir-cli@9.9.9'), 'runs the plan for the running (local) install, in its project');
assert(result.updated === true && logs.some(l => l.includes('3.12.0') && l.includes('9.9.9')), 'reports the real before/after from disk');
assert(logs.some(l => /not updated/.test(l) && l.includes('3.16.0')), 'names the global copy that stays behind');

// 7. verification failure: runner does nothing → error, not "Updated!"
let threw = null;
try {
  await updateCommand({}, { currentVersion: '3.12.0', scriptPath: path.join(npmBin, 'memoir'), PATH, npmGlobalRoot, bunGlobalRoot, fetchLatest: async () => '9.9.9', run: () => {}, log: () => {} });
} catch (err) { threw = err; }
assert(threw && threw.exitCode === 1 && /still reports v3\.16\.0/.test(threw.message), 'a no-op install is reported as a failure with the version still on disk');

// 8. up to date → no run, but a shadow is still reported
const upLogs = [];
const up = await updateCommand({}, { currentVersion: '3.16.0', scriptPath: path.join(npmBin, 'memoir'), PATH, npmGlobalRoot, bunGlobalRoot, fetchLatest: async () => '3.16.0', run: () => { throw new Error('must not run'); }, log: m => upLogs.push(String(m)) });
assert(up.updated === false && upLogs.some(l => /Already up to date/.test(l)) && upLogs.some(l => /Your shell runs/.test(l)), 'up to date still warns that the shell runs a different copy');

// 9. --dry-run through the real CLI from this checkout: classified as source, nothing runs
const bin = fileURLToPath(new URL('./bin/memoir.js', import.meta.url));
const cli = spawnSync(process.execPath, [bin, 'update', '--dry-run'], { encoding: 'utf8', env: { ...process.env, MEMOIR_UPDATE_LATEST: '99.0.0', DO_NOT_TRACK: '1', PATH }, timeout: 30000 });
assert(cli.status === 0 && /source checkout/.test(cli.stdout) && !/Updated!/.test(cli.stdout), 'CLI --dry-run from a checkout says git pull and exits 0');

await fs.remove(scratch);
console.log(`\n${BOLD}═══════════════════════════════════${RESET}`);
if (fail === 0) console.log(`${BOLD}${GREEN}  ALL ${pass} TESTS PASSED${RESET}`);
else console.log(`${BOLD}${RED}  ${fail} FAILED${RESET}, ${GREEN}${pass} passed${RESET}`);
console.log(`${BOLD}═══════════════════════════════════${RESET}\n`);
process.exit(fail);
