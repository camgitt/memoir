import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import boxen from 'boxen';
import { execFileSync } from 'child_process';

const home = os.homedir();
const TODOS_PATH = path.join(home, '.config', 'memoir', 'project-todos.json');

// ─── Helpers ───

async function loadTodos() {
  try {
    return await fs.readJson(TODOS_PATH);
  } catch {
    return {};
  }
}

async function saveTodos(todos) {
  await fs.ensureDir(path.dirname(TODOS_PATH));
  await fs.writeJson(TODOS_PATH, todos, { spaces: 2 });
}

function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 5000,
    }).toString().trim();
  } catch {
    return null;
  }
}

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

// ─── Scan ───

async function discoverProjects() {
  const maxDepth = 3;
  const skipDirs = new Set([
    'node_modules', '.git', '.next', '.vercel', 'dist', 'build',
    '__pycache__', '.venv', 'venv', '.cache', '.npm', '.bun',
    'Library', '.Trash', 'Applications', 'Pictures', 'Music',
    'Movies', 'Public', 'Downloads', '.local', '.cargo', '.rustup',
    '.docker', '.ssh', '.config', '.claude', '.gemini',
  ]);

  const projectMarkers = [
    'package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml',
    'requirements.txt', 'Gemfile', 'pom.xml', 'build.gradle',
    'Makefile', 'CMakeLists.txt', '.project', 'CLAUDE.md',
    'GEMINI.md', 'AGENTS.md',
    '.gitignore', 'index.html', 'main.py', 'app.py', 'index.js',
  ];

  const projects = [];

  const scanDir = async (dir, depth = 0) => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }

    const hasMarker = entries.some(e => !e.isDirectory() && projectMarkers.includes(e.name));
    if (hasMarker && dir !== home) {
      projects.push(dir);
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      if (skipDirs.has(entry.name)) continue;
      await scanDir(path.join(dir, entry.name), depth + 1);
    }
  };

  await scanDir(home);
  return projects;
}

function getProjectStatus(dir) {
  const name = path.basename(dir);
  const hasGit = fs.pathExistsSync(path.join(dir, '.git'));

  const info = { name, path: dir, hasGit, branch: null, dirty: false, logs: [] };

  if (!hasGit) return info;

  info.branch = git(['branch', '--show-current'], dir) || 'unknown';

  const status = git(['status', '--porcelain'], dir);
  info.dirty = status ? status.length > 0 : false;

  const logRaw = git(['log', '-5', '--format=%ad|%s', '--date=format:%b %d, %H:%M'], dir);
  if (logRaw) {
    info.logs = logRaw.split('\n').filter(Boolean).map(line => {
      const sep = line.indexOf('|');
      return { date: line.slice(0, sep), msg: line.slice(sep + 1) };
    });
  }

  const lastDate = git(['log', '-1', '--format=%aI'], dir);
  if (lastDate) info.lastActivity = lastDate;

  return info;
}

// ─── Commands ───

export async function projectsListCommand(options) {
  const dirs = await discoverProjects();
  const todos = await loadTodos();

  // Gather status for all projects
  const projects = dirs.map(d => {
    const s = getProjectStatus(d);
    s.todos = todos[s.name] || [];
    return s;
  });

  // Sort by last activity (most recent first)
  projects.sort((a, b) => {
    if (!a.lastActivity && !b.lastActivity) return 0;
    if (!a.lastActivity) return 1;
    if (!b.lastActivity) return -1;
    return new Date(b.lastActivity) - new Date(a.lastActivity);
  });

  if (options.json) {
    console.log(JSON.stringify(projects, null, 2));
    return;
  }

  console.log('\n' + boxen(
    chalk.white.bold('  projects  ') + chalk.gray(`  ${projects.length} found`),
    { padding: { top: 0, bottom: 0, left: 1, right: 1 }, borderStyle: 'round', borderColor: 'cyan', dimBorder: true }
  ));

  const limit = options.all ? projects.length : Math.min(projects.length, 15);

  for (let i = 0; i < limit; i++) {
    const p = projects[i];
    const dot = p.hasGit
      ? (p.dirty ? chalk.yellow('●') : chalk.green('●'))
      : chalk.gray('●');

    const age = p.lastActivity ? chalk.gray(` ${timeAgo(p.lastActivity)}`) : '';
    const branchTag = p.branch && p.branch !== 'main' && p.branch !== 'master'
      ? chalk.magenta(` [${p.branch}]`)
      : '';
    const dirtyTag = p.dirty ? chalk.yellow(' *') : '';
    const todoTag = p.todos.length > 0
      ? chalk.yellow(` (${p.todos.length} todo${p.todos.length > 1 ? 's' : ''})`)
      : '';

    console.log(`\n  ${dot} ${chalk.white.bold(p.name)}${branchTag}${dirtyTag}${todoTag}${age}`);

    // Show last few commits
    const logCount = options.verbose ? 5 : 2;
    for (let j = 0; j < Math.min(p.logs.length, logCount); j++) {
      const log = p.logs[j];
      console.log(`    ${chalk.gray(log.date)} ${chalk.dim(log.msg)}`);
    }

    // Show todos inline
    if (p.todos.length > 0 && options.verbose) {
      for (const t of p.todos) {
        console.log(`    ${chalk.yellow('□')} ${chalk.yellow(t)}`);
      }
    }
  }

  if (!options.all && projects.length > 15) {
    console.log(chalk.gray(`\n  ... and ${projects.length - 15} more (use --all to show all)`));
  }

  console.log(chalk.gray(`\n  ${chalk.green('●')} clean  ${chalk.yellow('●')} dirty  ${chalk.gray('●')} no git\n`));
}

export async function projectsTodoCommand(projectName, text, options) {
  const todos = await loadTodos();

  // List todos for a project
  if (!text && !options.done && !options.clear) {
    const items = todos[projectName] || [];
    if (items.length === 0) {
      console.log(chalk.gray(`\n  No todos for ${projectName}\n`));
      return;
    }
    console.log(chalk.white.bold(`\n  ${projectName} todos:\n`));
    items.forEach((t, i) => {
      console.log(`  ${chalk.gray(`${i + 1}.`)} ${chalk.yellow('□')} ${t}`);
    });
    console.log('');
    return;
  }

  // Mark done
  if (options.done !== undefined) {
    const idx = parseInt(options.done, 10) - 1;
    const items = todos[projectName] || [];
    if (idx < 0 || idx >= items.length) {
      console.error(chalk.red(`\n  ✖ Invalid index. ${projectName} has ${items.length} todo(s).\n`));
      return;
    }
    const removed = items.splice(idx, 1)[0];
    todos[projectName] = items;
    if (items.length === 0) delete todos[projectName];
    await saveTodos(todos);
    console.log(chalk.green(`\n  ✔ Done: ${removed}\n`));
    return;
  }

  // Clear all
  if (options.clear) {
    delete todos[projectName];
    await saveTodos(todos);
    console.log(chalk.green(`\n  ✔ Cleared all todos for ${projectName}\n`));
    return;
  }

  // Add todo
  if (!todos[projectName]) todos[projectName] = [];
  todos[projectName].push(text);
  await saveTodos(todos);
  console.log(chalk.green(`\n  ✔ Added to ${projectName}: ${text}\n`));
}
