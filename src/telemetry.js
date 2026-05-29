// Anonymous, opt-out usage telemetry.
//
// Fire-and-forget POST to PostHog's capture endpoint — no SDK, no batching/flush
// problem for a short-lived CLI, and a HARD NO-OP unless a project key is set.
// Honors DO_NOT_TRACK, CI, and `memoir telemetry off`. We NEVER send PII or any
// memory contents — only an anonymous install UUID, the event name, the OS, and
// the CLI version. All output goes to stderr so it can never corrupt the MCP
// stdio protocol (which speaks JSON-RPC over stdout).
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const VERSION = (() => {
  try { return require('../package.json').version; } catch { return 'unknown'; }
})();

// PostHog PROJECT API key (phc_…). This is a PUBLIC client key — safe to ship in
// the package, same model as posthog-js in a web app. Set MEMOIR_POSTHOG_KEY or
// paste the project key here. Empty → telemetry is a silent no-op.
const POSTHOG_KEY = process.env.MEMOIR_POSTHOG_KEY || '';
const POSTHOG_HOST = process.env.MEMOIR_POSTHOG_HOST || 'https://us.i.posthog.com';

const CONFIG_DIR = process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'memoir')
  : path.join(os.homedir(), '.config', 'memoir');
const ID_FILE = path.join(CONFIG_DIR, 'telemetry-id');
const OPTOUT_FILE = path.join(CONFIG_DIR, 'telemetry-off');
const DISCLOSED_FILE = path.join(CONFIG_DIR, 'telemetry-disclosed');

export function isEnabled() {
  if (!POSTHOG_KEY) return false;                                   // no key → no-op
  if (['1', 'true'].includes(process.env.DO_NOT_TRACK)) return false;
  if (process.env.CI) return false;                                 // never track CI
  if (['0', 'off', 'false'].includes(process.env.MEMOIR_TELEMETRY)) return false;
  try { if (fs.existsSync(OPTOUT_FILE)) return false; } catch {}
  return true;
}

function getInstallId() {
  try {
    if (fs.existsSync(ID_FILE)) return fs.readFileSync(ID_FILE, 'utf8').trim();
  } catch {}
  const id = randomUUID();
  try { fs.ensureDirSync(CONFIG_DIR); fs.writeFileSync(ID_FILE, id); } catch {}
  return id;
}

function discloseOnce() {
  try {
    if (fs.existsSync(DISCLOSED_FILE)) return;
    fs.ensureDirSync(CONFIG_DIR);
    fs.writeFileSync(DISCLOSED_FILE, new Date().toISOString());
    process.stderr.write(
      '\n  memoir collects anonymous, no-PII usage stats to improve the tool.\n' +
      '  Opt out anytime: `memoir telemetry off` (or set DO_NOT_TRACK=1).\n\n'
    );
  } catch {}
}

// Fire-and-forget. Never throws, never blocks beyond a short timeout, never
// touches stdout. Callers may await (CLI) or not (MCP) — both are safe.
export async function capture(event, properties = {}) {
  try {
    if (!isEnabled()) return;
    discloseOnce();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    await fetch(`${POSTHOG_HOST}/capture/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: POSTHOG_KEY,
        event,
        distinct_id: getInstallId(),
        properties: { ...properties, os: process.platform, node: process.version, version: VERSION, $lib: 'memoir-cli' },
        timestamp: new Date().toISOString(),
      }),
      signal: ctrl.signal,
    }).catch(() => {});
    clearTimeout(timer);
  } catch {
    // Telemetry must never break a command or a tool call.
  }
}

// `memoir telemetry on|off|status`
export async function telemetryCommand(action = 'status') {
  const a = String(action).toLowerCase();
  if (a === 'off') {
    try { await fs.ensureDir(CONFIG_DIR); await fs.writeFile(OPTOUT_FILE, '1'); } catch {}
    console.log('  Telemetry disabled. memoir will not send any usage events.');
    return;
  }
  if (a === 'on') {
    try { await fs.remove(OPTOUT_FILE); } catch {}
    console.log('  Telemetry enabled (anonymous, no PII).');
    return;
  }
  // status
  const reason = !POSTHOG_KEY ? 'no project key configured'
    : ['1', 'true'].includes(process.env.DO_NOT_TRACK) ? 'DO_NOT_TRACK is set'
    : process.env.CI ? 'running in CI'
    : (() => { try { return fs.existsSync(OPTOUT_FILE) ? 'opted out (`memoir telemetry off`)' : null; } catch { return null; } })();
  console.log(reason ? `  Telemetry: OFF — ${reason}.` : '  Telemetry: ON — anonymous usage events (no PII). Disable with `memoir telemetry off`.');
}
