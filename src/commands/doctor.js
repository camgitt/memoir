import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import boxen from 'boxen';
import ora from 'ora';
import gradient from 'gradient-string';
import os from 'os';
import { execSync } from 'child_process';
import { getConfig } from '../config.js';
import { adapters } from '../adapters/index.js';

const SECRET_PATTERNS = [
  { pattern: /sk-[a-zA-Z0-9]{20,}/, label: 'OpenAI/Stripe secret key' },
  { pattern: /key-[a-zA-Z0-9]{20,}/, label: 'API key' },
  { pattern: /ghp_[a-zA-Z0-9]{36,}/, label: 'GitHub personal access token' },
  { pattern: /gho_[a-zA-Z0-9]{36,}/, label: 'GitHub OAuth token' },
  { pattern: /AKIA[0-9A-Z]{16}/, label: 'AWS access key' },
  { pattern: /Bearer\s+[a-zA-Z0-9._\-]{20,}/, label: 'Bearer token' },
];

const SENSITIVE_FILENAMES = ['.env', 'credentials', 'token.json'];

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}kb`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}mb`;
}

async function collectFiles(dir, filter) {
  const files = [];
  async function walk(d) {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch { return; }
    for (const entry of entries) {
      const fullPath = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (filter && !filter(fullPath)) continue;
        await walk(fullPath);
      } else {
        if (filter && !filter(fullPath)) continue;
        files.push(fullPath);
      }
    }
  }
  await walk(dir);
  return files;
}

async function scanForSecrets(files) {
  const warnings = [];
  for (const filePath of files) {
    const basename = path.basename(filePath);
    if (SENSITIVE_FILENAMES.includes(basename)) {
      warnings.push({ file: filePath, reason: `Sensitive filename: ${basename}` });
      continue;
    }
    try {
      const stat = await fs.stat(filePath);
      // Skip files larger than 1MB
      if (stat.size > 1024 * 1024) continue;
      const content = await fs.readFile(filePath, 'utf-8');
      for (const { pattern, label } of SECRET_PATTERNS) {
        if (pattern.test(content)) {
          warnings.push({ file: filePath, reason: label });
          break;
        }
      }
    } catch {
      // Skip unreadable files
    }
  }
  return warnings;
}

export async function doctorCommand(options = {}) {
  const spinner = ora({ text: 'Running diagnostics...', color: 'cyan' }).start();
  const lines = [];
  let passCount = 0;
  let warnCount = 0;
  let failCount = 0;

  const pass = (msg) => { passCount++; return chalk.green('  ✔ ') + msg; };
  const warn = (msg) => { warnCount++; return chalk.yellow('  ⚠ ') + msg; };
  const fail = (msg) => { failCount++; return chalk.red('  ✖ ') + msg; };

  // 1. Config check
  spinner.text = 'Checking configuration...';
  const config = await getConfig(options.profile);
  if (config) {
    const providerLabel = config.provider === 'git' ? 'git' : 'local';
    const dest = config.provider === 'git' ? config.gitRepo : config.localPath;
    lines.push(pass(`Config: ${chalk.cyan(providerLabel)} → ${chalk.gray(dest)}`));
  } else {
    lines.push(fail(`Config: not initialized — run ${chalk.cyan('memoir init')}`));
  }

  // 2. Git check
  spinner.text = 'Checking git...';
  let gitInstalled = false;
  try {
    execSync('git --version', { stdio: 'pipe' });
    gitInstalled = true;
    lines.push(pass('Git: installed'));
  } catch {
    lines.push(fail('Git: not installed'));
  }

  if (config?.provider === 'git' && gitInstalled && config.gitRepo) {
    spinner.text = 'Testing remote connectivity...';
    try {
      execSync(`git ls-remote ${config.gitRepo} HEAD`, { stdio: 'pipe', timeout: 10000 });
      lines.push(pass(`Remote: ${chalk.gray(config.gitRepo)} reachable`));
    } catch {
      lines.push(fail(`Remote: cannot reach ${chalk.gray(config.gitRepo)}`));
    }
  }

  // 3. AI Tools scan
  spinner.text = 'Scanning AI tools...';
  lines.push('');
  lines.push(chalk.bold.white('  AI Tools'));

  const allSyncFiles = [];
  let totalSize = 0;

  for (const adapter of adapters) {
    let found = false;
    let fileCount = 0;
    let size = 0;
    let adapterFiles = [];

    if (adapter.customExtract) {
      for (const file of adapter.files) {
        const filePath = path.join(adapter.source, file);
        if (await fs.pathExists(filePath)) {
          found = true;
          fileCount++;
          try {
            const stat = await fs.stat(filePath);
            size += stat.size;
            adapterFiles.push(filePath);
          } catch {}
        }
      }
    } else if (await fs.pathExists(adapter.source)) {
      found = true;
      adapterFiles = await collectFiles(adapter.source, adapter.filter);
      fileCount = adapterFiles.length;
      for (const f of adapterFiles) {
        try {
          const stat = await fs.stat(f);
          size += stat.size;
        } catch {}
      }
    }

    if (found) {
      lines.push(pass(`${adapter.name}: ${chalk.gray(`${fileCount} files, ${formatSize(size)}`)}`));
      allSyncFiles.push(...adapterFiles);
      totalSize += size;
    } else {
      lines.push(chalk.gray('  ○ ') + chalk.gray(adapter.name + ': not found'));
    }
  }

  // 4. Secrets scan
  spinner.text = 'Scanning for secrets...';
  lines.push('');
  lines.push(chalk.bold.white('  Security'));

  const secretWarnings = await scanForSecrets(allSyncFiles);
  if (secretWarnings.length === 0) {
    lines.push(pass('No secrets detected in sync files'));
  } else {
    lines.push(warn(`${secretWarnings.length} potential secret${secretWarnings.length !== 1 ? 's' : ''} found:`));
    for (const w of secretWarnings.slice(0, 5)) {
      lines.push(chalk.yellow('      → ') + chalk.gray(path.basename(w.file)) + chalk.yellow(` (${w.reason})`));
    }
    if (secretWarnings.length > 5) {
      lines.push(chalk.gray(`      ...and ${secretWarnings.length - 5} more`));
    }
  }

  // 5. Disk usage
  lines.push('');
  lines.push(chalk.bold.white('  Disk'));
  lines.push(pass(`Total backup size: ${chalk.cyan(formatSize(totalSize))} across ${chalk.cyan(allSyncFiles.length)} files`));

  // 6. Last sync
  if (config?.provider === 'git' && gitInstalled && config.gitRepo) {
    spinner.text = 'Checking last sync...';
    lines.push('');
    lines.push(chalk.bold.white('  Last Sync'));
    try {
      const tmpDir = path.join(os.tmpdir(), 'memoir-doctor-' + Date.now());
      execSync(`git clone --depth 1 ${config.gitRepo} ${tmpDir}`, { stdio: 'pipe', timeout: 15000 });
      const lastCommit = execSync('git log -1 --format=%cr', { cwd: tmpDir, stdio: 'pipe' }).toString().trim();
      const lastMsg = execSync('git log -1 --format=%s', { cwd: tmpDir, stdio: 'pipe' }).toString().trim();
      await fs.remove(tmpDir);
      lines.push(pass(`Last backup: ${chalk.cyan(lastCommit)} — ${chalk.gray(lastMsg)}`));
    } catch {
      lines.push(warn('Could not determine last sync time'));
    }
  }

  spinner.stop();

  // Summary
  const summaryParts = [];
  if (passCount > 0) summaryParts.push(chalk.green(`${passCount} passed`));
  if (warnCount > 0) summaryParts.push(chalk.yellow(`${warnCount} warning${warnCount !== 1 ? 's' : ''}`));
  if (failCount > 0) summaryParts.push(chalk.red(`${failCount} failed`));

  console.log('\n' + boxen(
    gradient.pastel('  memoir doctor  ') + '\n\n' +
    lines.join('\n') + '\n\n' +
    chalk.gray('─'.repeat(36)) + '\n' +
    '  ' + summaryParts.join(chalk.gray(' · ')),
    { padding: 1, borderStyle: 'round', borderColor: failCount > 0 ? 'red' : warnCount > 0 ? 'yellow' : 'green', dimBorder: true }
  ) + '\n');
}
