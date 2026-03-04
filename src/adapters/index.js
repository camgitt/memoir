import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import chalk from 'chalk';

const home = os.homedir();

const isWin = process.platform === 'win32';
const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');

export const adapters = [
  {
    name: 'Gemini CLI',
    source: path.join(home, '.gemini'),
    filter: (src) => {
      const basename = path.basename(src);
      const ignored = ['.git', 'oauth_creds.json', 'google_accounts.json', 'tmp', 'history'];
      return !ignored.includes(basename);
    }
  },
  {
    name: 'Claude CLI',
    source: path.join(home, '.claude'),
    filter: (src) => {
      const basename = path.basename(src);
      return !basename.endsWith('.key') && basename !== '.env';
    }
  },
  {
    name: 'OpenAI Codex',
    source: path.join(home, '.codex'),
    filter: (src) => {
      const basename = path.basename(src);
      const ignored = ['.git', 'sessions', 'cache'];
      return !ignored.includes(basename) && !basename.endsWith('.key') && basename !== '.env';
    }
  },
  {
    name: 'Cursor',
    source: isWin
      ? path.join(appData, 'Cursor', 'User')
      : path.join(home, 'Library', 'Application Support', 'Cursor', 'User'),
    filter: (src) => {
      const basename = path.basename(src);
      const ignored = ['globalStorage', 'workspaceStorage', 'CachedData', 'Cache', 'GPUCache', 'logs', 'History', 'Backups', 'snippets'];
      return !ignored.includes(basename);
    }
  },
  {
    name: 'GitHub Copilot',
    source: isWin
      ? path.join(appData, 'GitHub Copilot')
      : path.join(home, '.config', 'github-copilot'),
    filter: (src) => {
      const basename = path.basename(src);
      const ignored = ['hosts.json', 'apps.json', 'versions.json'];
      return !ignored.includes(basename);
    }
  },
  {
    name: 'Windsurf',
    source: isWin
      ? path.join(appData, 'Windsurf', 'User')
      : path.join(home, 'Library', 'Application Support', 'Windsurf', 'User'),
    filter: (src) => {
      const basename = path.basename(src);
      const ignored = ['workspaceStorage', 'CachedData', 'Cache', 'GPUCache', 'logs', 'History', 'Backups', 'memories', 'snippets'];
      return !ignored.includes(basename);
    }
  },
  {
    name: 'Aider',
    source: home,
    customExtract: true,
    files: ['.aider.conf.yml', '.aider.system-prompt.md'],
    filter: () => true
  }
];

export async function extractMemories(stagingDir, spinner) {
  let foundAny = false;

  for (const adapter of adapters) {
    if (adapter.customExtract) {
      // Handle tools with individual files (e.g. Aider)
      const dest = path.join(stagingDir, adapter.name.toLowerCase().replace(/ /g, '-'));
      let foundFile = false;
      for (const file of adapter.files) {
        const filePath = path.join(adapter.source, file);
        if (await fs.pathExists(filePath)) {
          if (!foundFile) {
            spinner.text = `Found ${chalk.cyan(adapter.name)} config... copying to staging`;
            await fs.ensureDir(dest);
            foundFile = true;
          }
          await fs.copy(filePath, path.join(dest, file));
        }
      }
      if (foundFile) foundAny = true;
    } else if (await fs.pathExists(adapter.source)) {
      spinner.text = `Found ${chalk.cyan(adapter.name)} memory... copying to staging`;
      const dest = path.join(stagingDir, adapter.name.toLowerCase().replace(/ /g, '-'));
      await fs.ensureDir(dest);
      await fs.copy(adapter.source, dest, { filter: adapter.filter });
      foundAny = true;
    }
  }

  return foundAny;
}
