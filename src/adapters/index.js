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
    icon: '🔵',
    source: path.join(home, '.gemini'),
    filter: (src) => {
      const basename = path.basename(src);
      const ignored = ['.git', 'oauth_creds.json', 'google_accounts.json', 'tmp', 'history'];
      return !ignored.includes(basename);
    }
  },
  {
    name: 'Claude CLI',
    icon: '🟣',
    source: path.join(home, '.claude'),
    filter: (src) => {
      const basename = path.basename(src);
      return !basename.endsWith('.key') && basename !== '.env';
    }
  },
  {
    name: 'OpenAI Codex',
    icon: '🟢',
    source: path.join(home, '.codex'),
    filter: (src) => {
      const basename = path.basename(src);
      const ignored = ['.git', 'sessions', 'cache'];
      return !ignored.includes(basename) && !basename.endsWith('.key') && basename !== '.env';
    }
  },
  {
    name: 'Cursor',
    icon: '⚡',
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
    icon: '🐙',
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
    icon: '🏄',
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
    icon: '🔧',
    source: home,
    customExtract: true,
    files: ['.aider.conf.yml', '.aider.system-prompt.md'],
    filter: () => true
  }
];

async function countFiles(dir) {
  let count = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      count += await countFiles(path.join(dir, entry.name));
    } else {
      count++;
    }
  }
  return count;
}

async function dirSize(dir) {
  let size = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      size += await dirSize(fullPath);
    } else {
      const stat = await fs.stat(fullPath);
      size += stat.size;
    }
  }
  return size;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}kb`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}mb`;
}

export async function extractMemories(stagingDir, spinner) {
  let foundAny = false;
  const results = [];

  for (const adapter of adapters) {
    if (adapter.customExtract) {
      const dest = path.join(stagingDir, adapter.name.toLowerCase().replace(/ /g, '-'));
      let foundFile = false;
      let fileCount = 0;

      for (const file of adapter.files) {
        const filePath = path.join(adapter.source, file);
        if (await fs.pathExists(filePath)) {
          if (!foundFile) {
            spinner.text = `${adapter.icon} Scanning ${chalk.cyan(adapter.name)}...`;
            await fs.ensureDir(dest);
            foundFile = true;
          }
          await fs.copy(filePath, path.join(dest, file));
          fileCount++;
        }
      }

      if (foundFile) {
        foundAny = true;
        results.push({ adapter, fileCount, size: await dirSize(dest) });
        spinner.text = `${adapter.icon} ${chalk.green(adapter.name)} ${chalk.gray(`(${fileCount} files)`)}`;
      }
    } else if (await fs.pathExists(adapter.source)) {
      spinner.text = `${adapter.icon} Scanning ${chalk.cyan(adapter.name)}...`;
      const dest = path.join(stagingDir, adapter.name.toLowerCase().replace(/ /g, '-'));
      await fs.ensureDir(dest);
      await fs.copy(adapter.source, dest, { filter: adapter.filter });

      const fileCount = await countFiles(dest);
      const size = await dirSize(dest);
      foundAny = true;
      results.push({ adapter, fileCount, size });
      spinner.text = `${adapter.icon} ${chalk.green(adapter.name)} ${chalk.gray(`(${fileCount} files, ${formatSize(size)})`)}`;
    }
  }

  // Print tree after scanning
  if (results.length > 0) {
    spinner.stop();
    console.log('');
    console.log(chalk.white.bold('  Detected AI tools:\n'));
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const isLast = i === results.length - 1;
      const branch = isLast ? '  └─' : '  ├─';
      const detail = chalk.gray(` ${r.fileCount} files, ${formatSize(r.size)}`);
      console.log(`${branch} ${r.adapter.icon} ${chalk.cyan(r.adapter.name)}${detail}`);
    }
    console.log('');
    spinner.start(chalk.gray('Uploading...'));
  }

  return foundAny;
}
