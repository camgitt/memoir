#!/usr/bin/env node
// Telemetry is opt-in: off by default for new and existing installs, no network
// until `memoir telemetry on` (or MEMOIR_TELEMETRY=1/on/true). Opt-out env vars
// still force it off. Scratch HOME; fetch is mocked so nothing leaves the box.
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const BOLD = '\x1b[1m', GREEN = '\x1b[32m', RED = '\x1b[31m', CYAN = '\x1b[36m', RESET = '\x1b[0m';
let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ${GREEN}PASS${RESET} ${msg}`); }
  else { fail++; console.log(`  ${RED}FAIL${RESET} ${msg}`); }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(__dirname, 'bin', 'memoir.js');

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-telemetry-test-'));
process.env.HOME = scratch;
process.env.USERPROFILE = scratch;
process.env.APPDATA = path.join(scratch, 'AppData', 'Roaming');

const saved = {
  CI: process.env.CI,
  DO_NOT_TRACK: process.env.DO_NOT_TRACK,
  MEMOIR_TELEMETRY: process.env.MEMOIR_TELEMETRY,
};
delete process.env.CI;
delete process.env.DO_NOT_TRACK;
delete process.env.MEMOIR_TELEMETRY;

const memoirDir = process.platform === 'win32'
  ? path.join(scratch, 'AppData', 'Roaming', 'memoir')
  : path.join(scratch, '.config', 'memoir');

const { isEnabled, capture, telemetryCommand, POSTHOG_PROJECT_KEY } = await import('./src/telemetry.js');

function envFor(extra = {}) {
  const env = {
    ...process.env,
    HOME: scratch,
    USERPROFILE: scratch,
    APPDATA: path.join(scratch, 'AppData', 'Roaming'),
    PATH: process.env.PATH,
    // CLI postAction would otherwise POST to PostHog once opted in. Point the
    // child at a local blackhole so command tests never leave the machine.
    MEMOIR_POSTHOG_HOST: 'http://127.0.0.1:9',
  };
  delete env.CI;
  delete env.DO_NOT_TRACK;
  delete env.MEMOIR_TELEMETRY;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

function runTelemetry(args, extraEnv = {}) {
  return spawnSync(process.execPath, [bin, 'telemetry', ...args], {
    encoding: 'utf8',
    env: envFor(extraEnv),
    timeout: 20000,
  });
}

async function capturedLogs(fn) {
  const logs = [];
  const orig = console.log;
  console.log = (...a) => { logs.push(a.map(String).join(' ')); };
  try { await fn(); } finally { console.log = orig; }
  return logs.join('\n');
}

async function resetFlags() {
  delete process.env.CI;
  delete process.env.DO_NOT_TRACK;
  delete process.env.MEMOIR_TELEMETRY;
  await fs.remove(path.join(memoirDir, 'telemetry-on'));
  await fs.remove(path.join(memoirDir, 'telemetry-off'));
  await fs.remove(path.join(memoirDir, 'telemetry-id'));
  await fs.remove(path.join(memoirDir, 'telemetry-disclosed'));
}

const fetches = [];
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  fetches.push({ url: String(url), opts });
  return { ok: true, json: async () => ({}) };
};

console.log(`\n${BOLD}${CYAN}telemetry — default off / on / off / status / env${RESET}\n`);

assert(typeof POSTHOG_PROJECT_KEY === 'string' && POSTHOG_PROJECT_KEY.startsWith('phc_'),
  'PostHog project key is a single exported constant (owner rotation is one line)');

await resetFlags();
assert(isEnabled() === false, 'default: isEnabled() is false (no opt-in file)');
fetches.length = 0;
await capture('cli_command', { command: 'status' });
assert(fetches.length === 0, 'default: capture() makes no network calls');
assert(!(await fs.pathExists(path.join(memoirDir, 'telemetry-id'))), 'default: capture() does not write an install id');
assert(!(await fs.pathExists(path.join(memoirDir, 'telemetry-disclosed'))), 'default: capture() does not write a first-run notice');

{
  const out = await capturedLogs(() => telemetryCommand('status'));
  assert(/Telemetry: OFF/.test(out) && /off by default/i.test(out), 'status (default): OFF, off by default');
}

{
  const cli = runTelemetry(['status']);
  assert(cli.status === 0, 'CLI `telemetry status` exits 0 on a fresh install');
  assert(/Telemetry: OFF/.test(cli.stdout) && /off by default/i.test(cli.stdout), 'CLI `telemetry status`: OFF by default');
  assert(!/Telemetry: ON/.test(cli.stdout), 'CLI `telemetry status` does not claim ON by default');
}

{
  const cli = runTelemetry([]);
  assert(cli.status === 0 && /Telemetry: OFF/.test(cli.stdout), 'CLI `telemetry` with no action is status, still OFF');
}

{
  const out = await capturedLogs(() => telemetryCommand('on'));
  assert(isEnabled() === true, '`telemetry on` enables isEnabled()');
  assert(await fs.pathExists(path.join(memoirDir, 'telemetry-on')), '`telemetry on` writes the opt-in file');
  assert(!(await fs.pathExists(path.join(memoirDir, 'telemetry-off'))), '`telemetry on` removes any opt-out file');
  assert(/Telemetry enabled/i.test(out), '`telemetry on` prints that it is enabled');
}

fetches.length = 0;
await capture('cli_command', { command: 'push' });
assert(fetches.length === 1, 'after opt-in, capture() POSTs once');
assert(/\/capture\/?$/.test(new URL(fetches[0].url).pathname) || String(fetches[0].url).includes('/capture/'), 'after opt-in, capture() hits the PostHog capture endpoint');
assert(fetches[0].opts?.method === 'POST', 'after opt-in, capture() uses POST');
assert(await fs.pathExists(path.join(memoirDir, 'telemetry-id')), 'after opt-in, capture() records an anonymous install id');
assert(await fs.pathExists(path.join(memoirDir, 'telemetry-disclosed')), 'after opt-in, first capture writes the disclosure marker');

{
  const out = await capturedLogs(() => telemetryCommand('status'));
  assert(/Telemetry: ON/.test(out), 'status after on: ON');
}

{
  const cli = runTelemetry(['on']);
  assert(cli.status === 0, 'CLI `telemetry on` exits 0');
  const status = runTelemetry(['status']);
  assert(/Telemetry: ON/.test(status.stdout), 'CLI `telemetry status` is ON after `telemetry on`');
}

{
  const out = await capturedLogs(() => telemetryCommand('off'));
  assert(isEnabled() === false, '`telemetry off` disables isEnabled()');
  assert(await fs.pathExists(path.join(memoirDir, 'telemetry-off')), '`telemetry off` writes the opt-out file');
  assert(!(await fs.pathExists(path.join(memoirDir, 'telemetry-on'))), '`telemetry off` removes the opt-in file');
  assert(/Telemetry disabled/i.test(out), '`telemetry off` prints that it is disabled');
}

fetches.length = 0;
await capture('cli_command', { command: 'push' });
assert(fetches.length === 0, 'after opt-out, capture() makes no network calls');

{
  const out = await capturedLogs(() => telemetryCommand('status'));
  assert(/Telemetry: OFF/.test(out) && /opted out/i.test(out), 'status after off: OFF, opted out');
}

{
  const cli = runTelemetry(['off']);
  assert(cli.status === 0, 'CLI `telemetry off` exits 0');
  const status = runTelemetry(['status']);
  assert(/Telemetry: OFF/.test(status.stdout) && /opted out/i.test(status.stdout), 'CLI `telemetry status` is OFF after `telemetry off`');
}

// Existing install that previously sent events (id file present) but never opted in.
await resetFlags();
await fs.ensureDir(memoirDir);
await fs.writeFile(path.join(memoirDir, 'telemetry-id'), 'already-had-an-id');
await fs.writeFile(path.join(memoirDir, 'telemetry-disclosed'), 'old-consent');
assert(isEnabled() === false, 'existing install with only telemetry-id stays OFF');
fetches.length = 0;
await capture('mcp_server_start');
assert(fetches.length === 0, 'existing install: no network on first run after the opt-in change');
assert(!(await fs.pathExists(path.join(memoirDir, 'telemetry-id'))), 'existing install: leftover telemetry-id is deleted while off');
assert(!(await fs.pathExists(path.join(memoirDir, 'telemetry-disclosed'))), 'existing install: leftover telemetry-disclosed is deleted while off');

{
  await resetFlags();
  await fs.ensureDir(memoirDir);
  await fs.writeFile(path.join(memoirDir, 'telemetry-id'), 'already-had-an-id');
  await capturedLogs(() => telemetryCommand('on'));
  const minted = await fs.readFile(path.join(memoirDir, 'telemetry-id'), 'utf8');
  assert(minted.trim() && minted.trim() !== 'already-had-an-id', '`telemetry on` mints a fresh install id');
  assert(!(await fs.pathExists(path.join(memoirDir, 'telemetry-disclosed'))), '`telemetry on` clears the old disclosure marker');
}

// Env opt-in without a file.
await resetFlags();
process.env.MEMOIR_TELEMETRY = '1';
assert(isEnabled() === true, 'MEMOIR_TELEMETRY=1 is an explicit opt-in');
delete process.env.MEMOIR_TELEMETRY;
process.env.MEMOIR_TELEMETRY = 'on';
assert(isEnabled() === true, 'MEMOIR_TELEMETRY=on is an explicit opt-in');
delete process.env.MEMOIR_TELEMETRY;

// Env override still forces off after opt-in.
await resetFlags();
await capturedLogs(() => telemetryCommand('on'));
assert(isEnabled() === true, 'sanity: opted in before env override');
process.env.DO_NOT_TRACK = '1';
assert(isEnabled() === false, 'DO_NOT_TRACK=1 forces off after opt-in');
{
  const out = await capturedLogs(() => telemetryCommand('status'));
  assert(/Telemetry: OFF/.test(out) && /DO_NOT_TRACK/.test(out), 'status with DO_NOT_TRACK: OFF and names the env var');
}
{
  const cli = runTelemetry(['status'], { DO_NOT_TRACK: '1' });
  assert(/Telemetry: OFF/.test(cli.stdout) && /DO_NOT_TRACK/.test(cli.stdout), 'CLI status with DO_NOT_TRACK=1 is OFF');
}
delete process.env.DO_NOT_TRACK;
assert(isEnabled() === true, 'removing DO_NOT_TRACK restores the opt-in');

process.env.MEMOIR_TELEMETRY = '0';
assert(isEnabled() === false, 'MEMOIR_TELEMETRY=0 forces off after opt-in');
{
  const out = await capturedLogs(() => telemetryCommand('status'));
  assert(/Telemetry: OFF/.test(out) && /MEMOIR_TELEMETRY/.test(out), 'status with MEMOIR_TELEMETRY=0: OFF and names the env var');
}
{
  const cli = runTelemetry(['status'], { MEMOIR_TELEMETRY: 'off' });
  assert(/Telemetry: OFF/.test(cli.stdout) && /MEMOIR_TELEMETRY/.test(cli.stdout), 'CLI status with MEMOIR_TELEMETRY=off is OFF');
}
delete process.env.MEMOIR_TELEMETRY;

process.env.CI = 'true';
assert(isEnabled() === false, 'CI=true forces off after opt-in');
delete process.env.CI;

fetches.length = 0;
process.env.DO_NOT_TRACK = '1';
await capture('cli_command', { command: 'push' });
assert(fetches.length === 0, 'DO_NOT_TRACK=1: capture() makes no network calls even when opted in');
delete process.env.DO_NOT_TRACK;

// `telemetry on` while an opt-out env var is set still records the opt-in,
// but status stays OFF until the env var is gone.
await resetFlags();
{
  const out = await capturedLogs(() => {
    process.env.DO_NOT_TRACK = '1';
    return telemetryCommand('on');
  });
  delete process.env.DO_NOT_TRACK;
  assert(await fs.pathExists(path.join(memoirDir, 'telemetry-on')), '`telemetry on` still writes the opt-in file under DO_NOT_TRACK');
  assert(/OFF/.test(out) && /DO_NOT_TRACK/.test(out), '`telemetry on` under DO_NOT_TRACK reports that env still forces it off');
  assert(isEnabled() === true, 'after clearing DO_NOT_TRACK, the recorded opt-in takes effect');
}

{
  const upgradeSrc = await fs.readFile(path.join(__dirname, 'src', 'commands', 'upgrade.js'), 'utf8');
  assert(!/\$29/.test(upgradeSrc), 'CLI upgrade output does not claim a Teams $29 price');
  assert(/Teams \(coming soon\)/.test(upgradeSrc), 'CLI upgrade labels Teams as coming soon');
  const encHits = upgradeSrc.match(/E2E encryption/g) || [];
  assert(encHits.length >= 3, 'upgrade screen lists E2E encryption on Free, Pro, and Teams — not Pro-only');
  assert(!/chalk\.gray\('—'\)\s*,\s*chalk\.white\('E2E encryption'\)/.test(upgradeSrc),
    'upgrade screen does not show a dash in Free against encryption in Pro');
  assert(!/Local only/.test(upgradeSrc), 'upgrade screen does not describe Free as local-only');
  assert(!/Priority support/.test(upgradeSrc), 'upgrade screen does not claim Pro priority support');
  assert(!/Auto snapshots/.test(upgradeSrc), 'upgrade screen does not claim Pro auto snapshots');
  assert(!/Any machine/.test(upgradeSrc), 'upgrade screen does not repeat Any machine on Free and Pro');
  assert(/MAX_BACKUPS_FREE/.test(upgradeSrc) && /MAX_BACKUPS_PRO/.test(upgradeSrc) && /retained backups/.test(upgradeSrc),
    'upgrade screen states retained backups from MAX_BACKUPS_FREE / MAX_BACKUPS_PRO');
  assert(/Sync across machines/.test(upgradeSrc), 'upgrade screen states Pro sync across machines');
}

{
  const mcpSrc = await fs.readFile(path.join(__dirname, 'src', 'mcp.js'), 'utf8');
  const pkg = await fs.readJson(path.join(__dirname, 'package.json'));
  assert(/from '\.\/telemetry\.js'/.test(mcpSrc), 'MCP server uses src/telemetry.js (opt-in, default off)');
  assert(pkg.bin['memoir-mcp'] === 'src/mcp.js', 'published memoir-mcp bin is src/mcp.js');
  assert(Array.isArray(pkg.files) && pkg.files.includes('src/'), 'npm package ships src/ (shared telemetry module)');
  const smithery = path.join(__dirname, '.smithery', 'shttp', 'module.js');
  if (await fs.pathExists(smithery)) {
    const bundled = await fs.readFile(smithery, 'utf8');
    assert(!/posthog|phc_/i.test(bundled), 'smithery bundle does not embed PostHog telemetry');
  }
}

globalThis.fetch = origFetch;
if (saved.CI !== undefined) process.env.CI = saved.CI;
if (saved.DO_NOT_TRACK !== undefined) process.env.DO_NOT_TRACK = saved.DO_NOT_TRACK;
if (saved.MEMOIR_TELEMETRY !== undefined) process.env.MEMOIR_TELEMETRY = saved.MEMOIR_TELEMETRY;
else delete process.env.MEMOIR_TELEMETRY;

await fs.remove(scratch);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
