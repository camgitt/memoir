import fs from 'fs-extra';
import nodeFs from 'node:fs';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import { shouldIgnoreProject } from '../context/capture.js';

const home = os.homedir();

const isWin = process.platform === 'win32';
const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');

export const adapters = [
  {
    name: 'Gemini CLI',
    icon: '🔵',
    source: path.join(home, '.gemini'),
    filter: (src) => {
      const geminiDir = path.join(home, '.gemini');
      const rel = path.relative(geminiDir, src);
      if (src === geminiDir) return true;
      // Only sync config/settings files — skip caches, history, auth, sandbox, etc.
      const allowed = ['settings.json', 'projects.json', 'state.json', 'installation_id', 'trustedFolders.json', '.gitignore', 'GEMINI.md'];
      const basename = path.basename(src);
      return allowed.includes(basename) && !rel.includes(path.sep);
    }
  },
  {
    name: 'Claude CLI',
    icon: '🟣',
    source: path.join(home, '.claude'),
    filter: (src, dest) => {
      const basename = path.basename(src);
      const claudeDir = path.join(home, '.claude');
      const rel = path.relative(claudeDir, src);
      // Root dir itself
      if (src === claudeDir) return true;
      // Only allow these top-level dirs
      const topDir = rel.split(path.sep)[0];
      const allowedFiles = ['settings.json', 'settings.local.json'];
      // Allow specific top-level config files
      if (!rel.includes(path.sep) && allowedFiles.includes(basename)) return true;
      // Allow projects dir (contains memory .md files)
      if (topDir === 'projects') {
        // Allow directory traversal but skip dirs that only contain session data
        try {
          if (nodeFs.statSync(src).isDirectory()) {
            // Skip subagents and UUID-named session dirs (contain large .jsonl files, no .md)
            if (basename === 'subagents') return false;
            // UUID pattern: 8-4-4-4-12 hex chars
            if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(basename)) return false;
            return true;
          }
        } catch {}
        // Only sync memory markdown files — skip .jsonl session files
        return basename.endsWith('.md');
      }
      // Allow settings dir
      if (topDir === 'settings') return true;
      // Block everything else
      return false;
    }
  },
  {
    name: 'OpenAI Codex',
    icon: '🟢',
    source: path.join(home, '.codex'),
    filter: (src) => {
      const codexDir = path.join(home, '.codex');
      const rel = path.relative(codexDir, src);
      if (src === codexDir) return true;
      const basename = path.basename(src);
      // Only sync config files
      const allowed = ['config.json', 'settings.json', 'instructions.md'];
      return allowed.includes(basename) && !rel.includes(path.sep);
    }
  },
  {
    name: 'Cursor',
    icon: '⚡',
    source: isWin
      ? path.join(appData, 'Cursor', 'User')
      : path.join(home, 'Library', 'Application Support', 'Cursor', 'User'),
    filter: (src) => {
      const cursorDir = isWin
        ? path.join(appData, 'Cursor', 'User')
        : path.join(home, 'Library', 'Application Support', 'Cursor', 'User');
      const rel = path.relative(cursorDir, src);
      if (src === cursorDir) return true;
      const basename = path.basename(src);
      // Only sync settings and keybindings — not extensions, cache, storage
      const allowed = ['settings.json', 'keybindings.json', 'rules'];
      const topDir = rel.split(path.sep)[0];
      if (allowed.includes(basename) && !rel.includes(path.sep)) return true;
      // Allow rules directory (cursor rules)
      if (topDir === 'rules') return true;
      return false;
    }
  },
  {
    name: 'GitHub Copilot',
    icon: '🐙',
    source: isWin
      ? path.join(appData, 'GitHub Copilot')
      : path.join(home, '.config', 'github-copilot'),
    filter: (src) => {
      const copilotDir = isWin
        ? path.join(appData, 'GitHub Copilot')
        : path.join(home, '.config', 'github-copilot');
      if (src === copilotDir) return true;
      const basename = path.basename(src);
      // Only sync config — skip auth tokens and version files
      const allowed = ['settings.json', 'config.json'];
      return allowed.includes(basename);
    }
  },
  {
    name: 'Windsurf',
    icon: '🏄',
    source: isWin
      ? path.join(appData, 'Windsurf', 'User')
      : path.join(home, 'Library', 'Application Support', 'Windsurf', 'User'),
    filter: (src) => {
      const windsurfDir = isWin
        ? path.join(appData, 'Windsurf', 'User')
        : path.join(home, 'Library', 'Application Support', 'Windsurf', 'User');
      const rel = path.relative(windsurfDir, src);
      if (src === windsurfDir) return true;
      const basename = path.basename(src);
      // Only sync settings and keybindings
      const allowed = ['settings.json', 'keybindings.json', 'rules'];
      const topDir = rel.split(path.sep)[0];
      if (allowed.includes(basename) && !rel.includes(path.sep)) return true;
      if (topDir === 'rules') return true;
      return false;
    }
  },
  {
    name: 'Zed',
    icon: '🔶',
    source: isWin
      ? path.join(appData, 'Zed')
      : path.join(home, '.config', 'zed'),
    filter: (src) => {
      const zedDir = isWin
        ? path.join(appData, 'Zed')
        : path.join(home, '.config', 'zed');
      const rel = path.relative(zedDir, src);
      if (src === zedDir) return true;
      const basename = path.basename(src);
      // Skip known heavy/non-config directories
      const skipDirs = ['extensions', 'themes', 'logs', 'db', 'copilot', 'node', 'languages'];
      const topDir = rel.split(path.sep)[0];
      if (skipDirs.includes(topDir)) return false;
      // Only sync specific config files in root
      const allowed = ['settings.json', 'keymap.json', 'tasks.json'];
      if (allowed.includes(basename) && !rel.includes(path.sep)) return true;
      // Allow .md files in root
      if (basename.endsWith('.md') && !rel.includes(path.sep)) return true;
      return false;
    }
  },
  {
    name: 'Cline',
    icon: '🤖',
    source: isWin
      ? path.join(appData, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev')
      : path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev'),
    filter: (src) => {
      const clineDir = isWin
        ? path.join(appData, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev')
        : path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev');
      const rel = path.relative(clineDir, src);
      if (src === clineDir) return true;
      const basename = path.basename(src);
      const topDir = rel.split(path.sep)[0];
      // Skip known heavy/non-config directories
      const skipDirs = ['tasks', 'checkpoints', '.cache', 'images'];
      if (skipDirs.includes(topDir)) return false;
      // Allow settings/ and rules/ directories
      if (topDir === 'settings' || topDir === 'rules') return true;
      // Allow .md files in root
      if (basename.endsWith('.md') && !rel.includes(path.sep)) return true;
      return false;
    }
  },
  {
    name: 'Continue.dev',
    icon: '🔄',
    source: isWin
      ? path.join(process.env.USERPROFILE || home, '.continue')
      : path.join(home, '.continue'),
    filter: (src) => {
      const continueDir = isWin
        ? path.join(process.env.USERPROFILE || home, '.continue')
        : path.join(home, '.continue');
      const rel = path.relative(continueDir, src);
      if (src === continueDir) return true;
      const basename = path.basename(src);
      // Skip known heavy/non-config directories
      const skipDirs = ['sessions', 'dev_data', 'logs', 'index', 'cache', 'types'];
      const topDir = rel.split(path.sep)[0];
      if (skipDirs.includes(topDir)) return false;
      // Only sync specific config files in root
      const allowed = ['config.json', 'config.ts', 'config.yaml', '.continuerules'];
      if (allowed.includes(basename) && !rel.includes(path.sep)) return true;
      // Allow .md files in root
      if (basename.endsWith('.md') && !rel.includes(path.sep)) return true;
      return false;
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

export async function extractMemories(stagingDir, spinner, onlyFilter = null) {
  let foundAny = false;
  const results = [];

  for (const adapter of adapters) {
    // Skip if --only filter is set and this adapter doesn't match
    if (onlyFilter) {
      const adapterKey = adapter.name.toLowerCase().replace(/ /g, '-').replace('cli', '').replace('openai-', '').trim().replace(/-$/, '');
      const matches = onlyFilter.some(f => adapter.name.toLowerCase().includes(f) || adapterKey.includes(f));
      if (!matches) continue;
    }
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

  // Scan for per-project AI config files
  if (!onlyFilter || onlyFilter.some(f => 'projects'.includes(f))) {
    spinner.text = `📁 Scanning for project-level AI configs...`;

    const projectFiles = [
      'CLAUDE.md', 'GEMINI.md', 'CHATGPT.md', 'AGENTS.md', '.cursorrules',
      '.github/copilot-instructions.md', '.windsurfrules',
      '.aider.conf.yml', '.clinerules'
    ];

    const skipDirs = new Set([
      'node_modules', '.git', '.next', '.vercel', 'dist', 'build',
      '__pycache__', '.venv', 'venv', '.cache', '.npm', '.bun',
      'Library', '.Trash', 'Applications', 'Pictures', 'Music',
      'Movies', 'Public', 'Downloads', '.local', '.cargo', '.rustup'
    ]);

    const projectsDest = path.join(stagingDir, 'projects');
    let projectCount = 0;
    let projectFileCount = 0;
    const projectNames = [];

    // Walk home dir up to 3 levels deep looking for project markers
    const scanDir = async (dir, depth = 0) => {
      if (depth > 3) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch { return; }

      // Check if this dir has any AI config files
      const foundFiles = [];
      for (const file of projectFiles) {
        const filePath = path.join(dir, file);
        if (await fs.pathExists(filePath)) {
          foundFiles.push(file);
        }
      }

      if (foundFiles.length > 0 && dir !== home && !shouldIgnoreProject(dir)) {
        // This is a project with AI configs
        const projectName = path.basename(dir);
        const projectDestDir = path.join(projectsDest, projectName);
        await fs.ensureDir(projectDestDir);

        for (const file of foundFiles) {
          const src = path.join(dir, file);
          const dest = path.join(projectDestDir, file);
          await fs.ensureDir(path.dirname(dest));
          await fs.copy(src, dest);
          projectFileCount++;
        }

        projectCount++;
        projectNames.push(projectName);
      }

      // Recurse into subdirectories
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.') && entry.name !== '.github') continue;
        if (skipDirs.has(entry.name)) continue;
        await scanDir(path.join(dir, entry.name), depth + 1);
      }
    };

    await scanDir(home);

    if (projectCount > 0) {
      const size = await dirSize(projectsDest);
      foundAny = true;
      results.push({
        adapter: { name: `Projects (${projectCount})`, icon: '📁' },
        fileCount: projectFileCount,
        size
      });
      spinner.text = `📁 ${chalk.green(`${projectCount} projects`)} ${chalk.gray(`(${projectFileCount} files, ${formatSize(size)})`)}`;
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
