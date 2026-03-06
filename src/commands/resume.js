import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import ora from 'ora';
import boxen from 'boxen';
import gradient from 'gradient-string';
import { getConfig } from '../config.js';
import { execFileSync } from 'child_process';

const home = os.homedir();

// Fetch latest handoff from git backup
async function fetchLatestHandoff(config, spinner) {
  const tmpDir = path.join(os.tmpdir(), `memoir-resume-${Date.now()}`);
  await fs.ensureDir(tmpDir);

  try {
    if (config.provider === 'git' || config.provider.includes('git')) {
      spinner.text = chalk.gray('Pulling latest handoff from GitHub...');
      execFileSync('git', ['clone', '--depth', '1', config.gitRepo, '.'], { cwd: tmpDir, stdio: 'ignore' });
    } else if (config.provider === 'local' || config.provider.includes('local')) {
      const resolvedSource = config.localPath.replace(/^~/, home);
      spinner.text = chalk.gray('Fetching handoff from local backup...');
      await fs.copy(resolvedSource, tmpDir);
    }

    const handoffDir = path.join(tmpDir, 'handoffs');
    if (!await fs.pathExists(handoffDir)) {
      return null;
    }

    // Find the newest handoff file
    const files = (await fs.readdir(handoffDir))
      .filter(f => f.endsWith('.md') && f !== 'latest.md')
      .sort()
      .reverse();

    if (files.length === 0) return null;

    const content = await fs.readFile(path.join(handoffDir, files[0]), 'utf8');
    return { filename: files[0], content };
  } finally {
    await fs.remove(tmpDir);
  }
}

// Inject handoff into a tool's context location
async function injectHandoff(content, tool) {
  const targets = {
    claude: () => {
      // Write to Claude's project memory dir so it's auto-loaded
      const cwd = process.cwd();
      const cwdKey = '-' + cwd.replace(/^\//, '').replace(/\\/g, '-').replace(/\//g, '-').replace(/:/g, '');
      const memDir = path.join(home, '.claude', 'projects', cwdKey, 'memory');
      return path.join(memDir, 'handoff.md');
    },
    gemini: () => {
      return path.join(process.cwd(), 'GEMINI.md');
    },
    cursor: () => {
      return path.join(process.cwd(), '.cursor', 'rules', 'handoff.mdc');
    },
    codex: () => {
      return path.join(process.cwd(), 'AGENTS.md');
    }
  };

  const getTarget = targets[tool];
  if (!getTarget) {
    throw new Error(`Unknown tool: ${tool}. Supported: claude, gemini, cursor, codex`);
  }

  const targetPath = getTarget();
  await fs.ensureDir(path.dirname(targetPath));

  if (tool === 'gemini' && await fs.pathExists(targetPath)) {
    // Append to existing GEMINI.md
    const existing = await fs.readFile(targetPath, 'utf8');
    if (!existing.includes('# Session Handoff')) {
      await fs.writeFile(targetPath, existing + '\n\n' + content);
    } else {
      // Replace existing handoff section
      const before = existing.split('# Session Handoff')[0];
      await fs.writeFile(targetPath, before + content);
    }
  } else {
    await fs.writeFile(targetPath, content);
  }

  return targetPath;
}

export async function resumeCommand(options = {}) {
  const config = await getConfig();

  if (!config) {
    console.log('\n' + boxen(
      chalk.red('Not configured yet\n\n') +
      chalk.white('Run ') + chalk.cyan.bold('memoir init') + chalk.white(' to get started.'),
      { padding: 1, borderStyle: 'round', borderColor: 'red' }
    ) + '\n');
    return;
  }

  console.log();
  const spinner = ora({ text: chalk.gray('Fetching latest handoff...'), spinner: 'dots' }).start();

  // First check local cache
  const localLatest = path.join(home, '.config', 'memoir', 'handoffs', 'latest.md');
  let handoff;

  // Try remote first
  try {
    handoff = await fetchLatestHandoff(config, spinner);
  } catch (err) {
    spinner.warn(chalk.yellow(`Remote fetch failed: ${err.message}`));
    spinner.start();
  }

  // Fallback to local cache
  if (!handoff && await fs.pathExists(localLatest)) {
    handoff = { filename: 'latest.md', content: await fs.readFile(localLatest, 'utf8') };
  }

  if (!handoff) {
    spinner.fail(chalk.red('No handoffs found.'));
    console.log(chalk.gray('\n  Run ') + chalk.cyan('memoir snapshot') + chalk.gray(' on another machine first.\n'));
    return;
  }

  // Save locally
  const localHandoffDir = path.join(home, '.config', 'memoir', 'handoffs');
  await fs.ensureDir(localHandoffDir);
  await fs.writeFile(path.join(localHandoffDir, 'latest.md'), handoff.content);

  spinner.stop();

  // Display the handoff
  console.log(boxen(
    gradient.pastel('  Session Handoff  ') + '\n\n' +
    handoff.content
      .replace(/^---[\s\S]*?---\n/, '') // Strip YAML frontmatter for display
      .trim(),
    { padding: 1, borderStyle: 'round', borderColor: 'cyan', dimBorder: true }
  ));

  // Inject if requested
  if (options.inject) {
    const tool = options.to || 'claude';
    spinner.start(chalk.gray(`Injecting handoff for ${tool}...`));
    try {
      const targetPath = await injectHandoff(handoff.content, tool);
      spinner.stop();
      console.log('\n' + chalk.green(`  Injected handoff → ${targetPath}`));
      console.log(chalk.gray(`  ${tool.charAt(0).toUpperCase() + tool.slice(1)} will read this on next session.\n`));
    } catch (err) {
      spinner.fail(chalk.red(`Inject failed: ${err.message}`));
    }
  } else {
    console.log('\n' + chalk.gray('  To inject into your AI tool:'));
    console.log(chalk.cyan('    memoir resume --inject') + chalk.gray(' (Claude)'));
    console.log(chalk.cyan('    memoir resume --inject --to gemini'));
    console.log(chalk.cyan('    memoir resume --inject --to cursor') + '\n');
  }
}
