// memoir update — upgrade the copy of memoir that is actually running.
//
// Before this module, `memoir update` ran `npm install -g memoir-cli`
// unconditionally and printed "Updated!" from the registry version. On a
// machine with more than one install (a project-local copy first on PATH, a
// Homebrew/npm global second, a bun global) that upgraded a copy the shell
// never runs, the running copy kept showing the update banner, and the
// Claude Code hooks kept executing the old version.
//
// Now: resolve the running install from the executing script, classify it,
// upgrade that install with the matching package manager, verify the version
// on disk afterwards, and say plainly when another copy on PATH shadows it.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import chalk from 'chalk';
import boxen from 'boxen';

export const PACKAGE_NAME = 'memoir-cli';

// Numeric semver compare. Non-numeric parts (tags, garbage) compare as 0 so a
// malformed registry answer never triggers an "update".
export function isNewer(candidate, current) {
  const parse = v => String(v || '').split('.').slice(0, 3).map(n => { const x = parseInt(n, 10); return Number.isFinite(x) ? x : 0; });
  const [a1, a2, a3] = parse(candidate);
  const [b1, b2, b3] = parse(current);
  return a1 > b1 || (a1 === b1 && a2 > b2) || (a1 === b1 && a2 === b2 && a3 > b3);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export function readInstalledVersion(root) {
  const pkg = root ? readJson(path.join(root, 'package.json')) : null;
  return pkg && pkg.name === PACKAGE_NAME ? String(pkg.version || '') : null;
}

// Walk up from a script (bin/memoir.js, src/mcp.js …) to the memoir-cli
// package directory. Follows symlinks first so `~/.bun/bin/memoir` resolves
// to the package it points at, not the shim directory.
export function findPackageRoot(startPath) {
  let real;
  try { real = fs.realpathSync(startPath); } catch { return null; }
  let dir = fs.existsSync(real) && fs.statSync(real).isDirectory() ? real : path.dirname(real);
  for (;;) {
    const pkg = readJson(path.join(dir, 'package.json'));
    if (pkg && pkg.name === PACKAGE_NAME) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function samePath(a, b) {
  const norm = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  return norm(a) === norm(b);
}

// Where is this install, and who owns it?
//   source      — a git checkout (`.git` present): upgrading means `git pull`
//   npm-global  — `<npm root -g>/memoir-cli`
//   bun-global  — under bun's global node_modules
//   local       — `<project>/node_modules/memoir-cli` (a dependency of <project>)
//   unknown     — anything else; fall back to npm -g with a warning
export function classifyInstall(root, { npmGlobalRoot = null, bunGlobalRoot = null } = {}) {
  if (!root) return { kind: 'unknown', root: null };
  root = path.resolve(root);
  if (fs.existsSync(path.join(root, '.git'))) return { kind: 'source', root };
  if (npmGlobalRoot && samePath(root, path.join(npmGlobalRoot, PACKAGE_NAME))) return { kind: 'npm-global', root };
  if (bunGlobalRoot && (samePath(root, path.join(bunGlobalRoot, PACKAGE_NAME)) || root.startsWith(path.resolve(bunGlobalRoot) + path.sep))) return { kind: 'bun-global', root };
  const parent = path.dirname(root);
  if (path.basename(parent) === 'node_modules') {
    const project = path.dirname(parent);
    return { kind: 'local', root, project, hasManifest: fs.existsSync(path.join(project, 'package.json')) };
  }
  return { kind: 'unknown', root };
}

// The exact command that upgrades *this* install. `source` has no command:
// the right move is a git pull in the checkout, which we never run for the user.
export function planUpdate(install, latest) {
  const spec = `${PACKAGE_NAME}@${latest}`;
  switch (install.kind) {
    case 'source':
      return { kind: install.kind, command: null, args: [], cwd: install.root, description: `running from a source checkout at ${install.root}; run \`git pull\` there` };
    case 'npm-global':
      return { kind: install.kind, command: 'npm', args: ['install', '-g', spec], cwd: undefined, description: `npm global install at ${install.root}` };
    case 'bun-global':
      return { kind: install.kind, command: 'bun', args: ['add', '-g', spec], cwd: undefined, description: `bun global install at ${install.root}` };
    case 'local': {
      // A dependency of <project>/package.json: update it there so the
      // manifest, the lockfile and the copy on disk agree. Without a manifest
      // there is nothing to record, so do not create one.
      const args = ['install', spec, '--no-audit', '--no-fund'];
      if (!install.hasManifest) args.push('--no-save');
      return { kind: install.kind, command: 'npm', args, cwd: install.project, description: `project-local install at ${install.root} (dependency of ${install.project})` };
    }
    default:
      return { kind: 'unknown', command: 'npm', args: ['install', '-g', spec], cwd: undefined, description: install.root ? `unrecognised install layout at ${install.root}; trying npm -g` : 'could not locate the running install; trying npm -g' };
  }
}

// Every `memoir` executable on PATH, in shell resolution order, mapped to the
// package it runs. The first entry is what the shell executes for `memoir`.
export function listPathInstalls({ PATH = process.env.PATH || '', bin = 'memoir' } = {}) {
  const out = [];
  const seen = new Set();
  for (const dir of PATH.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, bin);
    let stat;
    try { stat = fs.statSync(candidate); } catch { continue; }
    if (!stat.isFile()) continue;
    const root = findPackageRoot(candidate);
    const key = root || candidate;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ bin: candidate, root, version: readInstalledVersion(root) });
  }
  return out;
}

// Plain-language warnings when the shell would run a different copy than the
// one we just updated (or when other copies exist and will drift).
export function shadowWarnings(runningRoot, installs) {
  const warnings = [];
  if (!installs.length) return warnings;
  const first = installs[0];
  const same = (a, b) => a && b && samePath(a, b);
  if (first.root && !same(first.root, runningRoot)) {
    warnings.push(`Your shell runs \`memoir\` from ${first.bin} (v${first.version || '?'}), not the copy just updated. Remove that one or update it too, or the old version keeps running.`);
  }
  const others = installs.filter(i => i.root && !same(i.root, runningRoot) && i !== first);
  for (const other of others) warnings.push(`Another copy is on PATH at ${other.bin} (v${other.version || '?'}); it was not updated.`);
  return warnings;
}

function probeNpmGlobalRoot() {
  try { return execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; }
  catch { return null; }
}

function defaultBunGlobalRoot() {
  const bunHome = process.env.BUN_INSTALL || path.join(os.homedir(), '.bun');
  return path.join(bunHome, 'install', 'global', 'node_modules');
}

async function fetchLatestFromRegistry() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, { signal: controller.signal });
    const data = await res.json();
    return String(data.version || '');
  } finally { clearTimeout(timeout); }
}

// Resolve the running install once; exported so `doctor`/tests can reuse it.
export function resolveRunningInstall({ scriptPath = process.argv[1], npmGlobalRoot, bunGlobalRoot } = {}) {
  const root = findPackageRoot(scriptPath);
  return classifyInstall(root, {
    npmGlobalRoot: npmGlobalRoot === undefined ? probeNpmGlobalRoot() : npmGlobalRoot,
    bunGlobalRoot: bunGlobalRoot === undefined ? defaultBunGlobalRoot() : bunGlobalRoot,
  });
}

export async function updateCommand(options = {}, deps = {}) {
  const { dryRun = false } = options;
  const {
    currentVersion,
    scriptPath = process.argv[1],
    fetchLatest = fetchLatestFromRegistry,
    run = (cmd, args, cwd) => execFileSync(cmd, args, { stdio: 'inherit', cwd }),
    PATH = process.env.PATH,
    log = console.log,
  } = deps;

  const latest = process.env.MEMOIR_UPDATE_LATEST || await fetchLatest();
  if (!latest) throw new Error('could not read the latest version from the npm registry');

  const install = resolveRunningInstall({ scriptPath, npmGlobalRoot: deps.npmGlobalRoot, bunGlobalRoot: deps.bunGlobalRoot });
  const installs = listPathInstalls({ PATH });
  const warnings = shadowWarnings(install.root, installs);

  if (!isNewer(latest, currentVersion)) {
    log('\n' + boxen(chalk.green('✔ Already up to date!') + '\n' + chalk.gray(`v${currentVersion} · ${install.root || 'install location unknown'}`),
      { padding: { top: 0, bottom: 0, left: 1, right: 1 }, borderStyle: 'round', borderColor: 'green', dimBorder: true }) + '\n');
    for (const w of warnings) log(chalk.yellow('⚠ ') + w);
    return { updated: false, install, latest, warnings };
  }

  const plan = planUpdate(install, latest);
  log('\n' + chalk.cyan(`Updating memoir ${currentVersion} → ${chalk.green.bold(latest)}`) + chalk.gray(` — ${plan.description}`) + '\n');

  if (plan.kind === 'source') {
    log(chalk.yellow('This copy is a git checkout; memoir will not pull it for you.') + '\n' + chalk.gray('Run: ') + chalk.cyan(`git -C ${plan.cwd} pull`) + '\n');
    for (const w of warnings) log(chalk.yellow('⚠ ') + w);
    return { updated: false, install, latest, plan, warnings };
  }

  const commandLine = [plan.command, ...plan.args].join(' ') + (plan.cwd ? chalk.gray(`   (in ${plan.cwd})`) : '');
  if (dryRun) {
    log(chalk.gray('Would run: ') + chalk.cyan(commandLine) + '\n');
    for (const w of warnings) log(chalk.yellow('⚠ ') + w);
    return { updated: false, dryRun: true, install, latest, plan, warnings };
  }
  if (plan.kind === 'unknown') log(chalk.yellow('⚠ ') + plan.description);

  await run(plan.command, plan.args, plan.cwd);

  const now = install.root ? readInstalledVersion(install.root) : null;
  const ok = now === latest || (install.root == null && plan.kind === 'unknown');
  if (!ok) {
    log('\n' + chalk.red('✖ The install did not change: ') + chalk.white(`${install.root} still reports v${now || '?'}`) + '\n' +
      chalk.gray('Try manually: ') + chalk.cyan(commandLine) + '\n');
    for (const w of warnings) log(chalk.yellow('⚠ ') + w);
    const err = new Error(`update ran but ${install.root} still reports v${now || '?'}`);
    err.exitCode = 1;
    throw err;
  }

  log('\n' + boxen(chalk.white(`memoir ${currentVersion} → ${chalk.green.bold(latest)}`) + '\n' + chalk.gray(install.root || ''),
    { padding: 1, borderStyle: 'round', borderColor: 'green', dimBorder: true }) + '\n');
  for (const w of warnings) log(chalk.yellow('⚠ ') + w);
  return { updated: true, install, latest, plan, warnings };
}
