// Single source of truth for OS-specific config locations.
//
// Why this exists: before this module, every adapter branched on a single
// `isWin` flag — `isWin ? <windows> : <macOS>`. On Linux, `process.platform`
// is `'linux'`, so those ternaries silently fell through to the *macOS* path
// (`~/Library/Application Support/...`), which doesn't exist on Linux. memoir
// would then detect zero tools, sync nothing, and the user would churn without
// any error — the "silent-zero-memory activation cliff."
//
// Every function is parameterized by { platform, env, home } so the three OS
// branches can be unit-tested from any machine, not just the target OS. Runtime
// callers omit the options and get the live platform.

import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();

// VS Code-family per-user config base: <root>/<App>/User
//   win32  : %APPDATA%/<App>/User
//   darwin : ~/Library/Application Support/<App>/User
//   linux  : $XDG_CONFIG_HOME (or ~/.config)/<App>/User
export function vscodeUserDir(appName, { platform = process.platform, env = process.env, home = HOME } = {}) {
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, appName, 'User');
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', appName, 'User');
  }
  // linux + anything else POSIX-y
  const xdg = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(xdg, appName, 'User');
}

// A VS Code extension's globalStorage dir (e.g. Cline lives under the base
// "Code" install, not its own app dir).
export function vscodeGlobalStorage(extId, opts = {}) {
  return path.join(vscodeUserDir('Code', opts), 'globalStorage', extId);
}

// XDG-aware ~/.config base, for non-VSCode tools that already store there
// (zed, github-copilot). Exposed so callers don't re-hardcode ~/.config and
// drift from XDG_CONFIG_HOME.
export function xdgConfigDir({ env = process.env, home = HOME } = {}) {
  return env.XDG_CONFIG_HOME || path.join(home, '.config');
}
