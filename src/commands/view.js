import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import ora from 'ora';
import boxen from 'boxen';
import inquirer from 'inquirer';
import { execSync } from 'child_process';
import { getConfig } from '../config.js';
import { adapters } from '../adapters/index.js';

async function listFiles(dir, prefix = '') {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...await listFiles(path.join(dir, entry.name), rel));
    } else {
      const stat = await fs.stat(path.join(dir, entry.name));
      files.push({ path: rel, size: stat.size });
    }
  }
  return files;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function isBinaryFile(filePath) {
  const binaryExts = ['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.zip', '.tar', '.gz', '.db', '.sqlite'];
  return binaryExts.includes(path.extname(filePath).toLowerCase());
}

export async function viewCommand() {
  const config = await getConfig();
  if (!config) {
    console.log(chalk.red('\n✖ Not configured yet. Run: memoir init\n'));
    return;
  }

  const spinner = ora('Fetching backup...').start();
  const stagingDir = path.join(os.tmpdir(), `memoir-view-${Date.now()}`);
  await fs.ensureDir(stagingDir);

  try {
    if (config.provider === 'git') {
      execSync(`git clone --depth 1 ${config.gitRepo} .`, { cwd: stagingDir, stdio: 'ignore' });
    } else {
      const resolvedSource = config.localPath.replace(/^~/, os.homedir());
      await fs.copy(resolvedSource, stagingDir);
    }

    spinner.stop();

    console.log('\n' + boxen(
      chalk.cyan.bold('Your Memoir Backup'),
      { padding: { top: 0, bottom: 0, left: 1, right: 1 }, borderStyle: 'round', borderColor: 'cyan' }
    ));

    let totalFiles = 0;
    const viewableFiles = [];

    for (const adapter of adapters) {
      const adapterDir = path.join(stagingDir, adapter.name.toLowerCase().replace(/ /g, '-'));
      if (await fs.pathExists(adapterDir)) {
        const files = await listFiles(adapterDir);
        totalFiles += files.length;

        console.log('\n' + chalk.green.bold(`  ${adapter.name}`) + chalk.gray(` (${files.length} files)`));

        for (const file of files) {
          const localPath = path.join(adapter.source, file.path);
          const backupPath = path.join(adapterDir, file.path);
          const existsLocally = await fs.pathExists(localPath);

          let status;
          let diffType;
          if (!existsLocally) {
            status = chalk.yellow(' (new — not on this machine)');
            diffType = 'new';
          } else if (isBinaryFile(file.path)) {
            status = chalk.gray(' (binary)');
            diffType = 'binary';
          } else {
            // Compare content
            const localContent = await fs.readFile(localPath, 'utf8');
            const backupContent = await fs.readFile(backupPath, 'utf8');
            if (localContent === backupContent) {
              status = chalk.gray(' (identical)');
              diffType = 'same';
            } else {
              status = chalk.cyan(' (different)');
              diffType = 'different';
            }
          }

          console.log(chalk.white(`    ${file.path}`) + chalk.gray(` ${formatSize(file.size)}`) + status);

          if (diffType !== 'binary' && diffType !== 'same') {
            viewableFiles.push({ file, adapter, adapterDir, localPath, diffType });
          }
        }
      }
    }

    if (totalFiles === 0) {
      console.log(chalk.yellow('\n  No backed up files found.\n'));
      return;
    }

    console.log(chalk.gray(`\n  ${totalFiles} total files in backup\n`));

    // Offer to view diffs
    if (viewableFiles.length > 0) {
      const { wantDiff } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'wantDiff',
          message: 'View file contents/diffs?',
          default: true
        }
      ]);

      if (wantDiff) {
        const choices = viewableFiles.map(vf => ({
          name: `${vf.adapter.name}/${vf.file.path}` + (vf.diffType === 'new' ? chalk.yellow(' (new)') : chalk.cyan(' (different)')),
          value: vf
        }));

        const { filesToView } = await inquirer.prompt([
          {
            type: 'checkbox',
            name: 'filesToView',
            message: 'Select files to view:',
            choices
          }
        ]);

        for (const vf of filesToView) {
          const backupPath = path.join(vf.adapterDir, vf.file.path);
          const backupContent = await fs.readFile(backupPath, 'utf8');

          console.log('\n' + boxen(
            chalk.cyan.bold(`${vf.adapter.name}/${vf.file.path}`),
            { padding: { top: 0, bottom: 0, left: 1, right: 1 }, borderStyle: 'single', borderColor: 'cyan' }
          ));

          if (vf.diffType === 'new') {
            console.log(chalk.yellow('\n  This file only exists in backup:\n'));
            console.log(chalk.green(backupContent.split('\n').map(l => '  + ' + l).join('\n')));
          } else {
            // Show side by side: local vs backup
            const localContent = await fs.readFile(vf.localPath, 'utf8');
            const localLines = localContent.split('\n');
            const backupLines = backupContent.split('\n');

            console.log(chalk.gray('\n  ── Local (this machine) ──'));
            console.log(localLines.map(l => '  ' + l).join('\n'));

            console.log(chalk.cyan('\n  ── Backup (remote) ──'));
            console.log(backupLines.map(l => '  ' + l).join('\n'));
          }
          console.log('');
        }
      }
    }

  } finally {
    await fs.remove(stagingDir);
  }
}
