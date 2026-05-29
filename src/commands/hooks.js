// Install / uninstall / status for Claude Code hooks.
//
// Hooks are configured in ~/.claude/settings.json under the `hooks` object:
//   {
//     "hooks": {
//       "Stop":         [{ "matcher": "", "hooks": [{ "type": "command", "command": "..." }] }],
//       "SessionStart": [{ "matcher": "", "hooks": [{ "type": "command", "command": "..." }] }]
//     }
//   }
//
// We merge into any existing hooks the user has — never clobber. Our entries
// are identified by a marker in the command string so we can find and remove
// them on uninstall.

import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import boxen from 'boxen';
import inquirer from 'inquirer';

const home = os.homedir();
const CLAUDE_SETTINGS = path.join(home, '.claude', 'settings.json');
const MARKER = 'memoir'; // any command containing this is ours

const OUR_HOOKS = {
  Stop: {
    type: 'command',
    command: 'memoir autopush --debounce 30',
  },
  SessionStart: {
    type: 'command',
    command: 'memoir auto-refresh',
  },
};

async function readSettings() {
  if (!await fs.pathExists(CLAUDE_SETTINGS)) return {};
  try {
    return JSON.parse(await fs.readFile(CLAUDE_SETTINGS, 'utf8'));
  } catch {
    return {};
  }
}

async function writeSettings(settings) {
  await fs.ensureDir(path.dirname(CLAUDE_SETTINGS));
  const tmp = `${CLAUDE_SETTINGS}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(settings, null, 2));
  await fs.move(tmp, CLAUDE_SETTINGS, { overwrite: true });
}

function findOurEntry(hookList) {
  // hookList is array of { matcher, hooks: [{type, command}] }
  return (hookList || []).findIndex(entry =>
    (entry.hooks || []).some(h => h.type === 'command' && (h.command || '').includes(MARKER))
  );
}

function ensureOurHook(settings, eventName, hook) {
  settings.hooks = settings.hooks || {};
  settings.hooks[eventName] = settings.hooks[eventName] || [];
  const list = settings.hooks[eventName];

  const existing = findOurEntry(list);
  if (existing >= 0) {
    // Replace (idempotent — same shape every time)
    list[existing] = { matcher: '', hooks: [hook] };
  } else {
    list.push({ matcher: '', hooks: [hook] });
  }
}

function removeOurHook(settings, eventName) {
  if (!settings?.hooks?.[eventName]) return false;
  const list = settings.hooks[eventName];
  const idx = findOurEntry(list);
  if (idx < 0) return false;
  list.splice(idx, 1);
  if (list.length === 0) delete settings.hooks[eventName];
  return true;
}

export async function hooksInstallCommand(options = {}) {
  const settings = await readSettings();
  const fresh = JSON.parse(JSON.stringify(settings)); // snapshot for diff

  ensureOurHook(fresh, 'Stop', OUR_HOOKS.Stop);
  ensureOurHook(fresh, 'SessionStart', OUR_HOOKS.SessionStart);

  const isNoop = JSON.stringify(settings) === JSON.stringify(fresh);
  if (isNoop) {
    console.log('\n' + chalk.green('  ✓ Hooks already installed — nothing to do.\n'));
    return;
  }

  // Show what will change
  console.log('\n' + boxen(
    chalk.cyan('memoir will add these hooks to ') + chalk.white.bold('~/.claude/settings.json') + chalk.cyan(':') + '\n\n' +
    chalk.gray('  Stop:         ') + chalk.white(OUR_HOOKS.Stop.command) + '\n' +
    chalk.gray('                fires after every response; auto-pushes (debounced 30s)') + '\n\n' +
    chalk.gray('  SessionStart: ') + chalk.white(OUR_HOOKS.SessionStart.command) + '\n' +
    chalk.gray('                fires at session open; refreshes pinned block from session.json') + '\n\n' +
    chalk.gray('  Your existing settings (including other hooks) will be preserved.'),
    { padding: 1, borderStyle: 'round', borderColor: 'cyan', dimBorder: true }
  ) + '\n');

  if (!options.yes) {
    const { confirm } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirm',
      message: 'Install hooks?',
      default: true,
    }]);
    if (!confirm) {
      console.log(chalk.yellow('\n  Cancelled.\n'));
      return;
    }
  }

  await writeSettings(fresh);
  console.log('\n' + chalk.green('  ✓ Hooks installed. Restart Claude Code to activate.\n'));
}

export async function hooksUninstallCommand(options = {}) {
  const settings = await readSettings();
  const fresh = JSON.parse(JSON.stringify(settings));
  const removedStop = removeOurHook(fresh, 'Stop');
  const removedStart = removeOurHook(fresh, 'SessionStart');

  if (!removedStop && !removedStart) {
    console.log('\n' + chalk.gray('  No memoir hooks installed.\n'));
    return;
  }

  if (!options.yes) {
    const { confirm } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirm',
      message: 'Remove memoir hooks from ~/.claude/settings.json?',
      default: true,
    }]);
    if (!confirm) {
      console.log(chalk.yellow('\n  Cancelled.\n'));
      return;
    }
  }

  await writeSettings(fresh);
  console.log('\n' + chalk.green('  ✓ memoir hooks removed.\n'));
}

export async function hooksStatusCommand() {
  const settings = await readSettings();
  const hasStop = (settings.hooks?.Stop || []).some(entry =>
    (entry.hooks || []).some(h => (h.command || '').includes(MARKER))
  );
  const hasStart = (settings.hooks?.SessionStart || []).some(entry =>
    (entry.hooks || []).some(h => (h.command || '').includes(MARKER))
  );

  const mark = (b) => b ? chalk.green('  ✓ ') : chalk.gray('  ✗ ');
  console.log('\n' + boxen(
    chalk.cyan.bold('memoir hooks status') + '\n\n' +
    mark(hasStop) + chalk.white('Stop hook') + chalk.gray(' (auto-push)') + '\n' +
    mark(hasStart) + chalk.white('SessionStart hook') + chalk.gray(' (auto-refresh)') + '\n\n' +
    chalk.gray('  Settings: ') + chalk.white(CLAUDE_SETTINGS) + '\n' +
    chalk.gray('  Run ') + chalk.cyan('memoir hooks install') + chalk.gray(' to add missing hooks.'),
    { padding: 1, borderStyle: 'round', borderColor: 'cyan', dimBorder: true }
  ) + '\n');
}
