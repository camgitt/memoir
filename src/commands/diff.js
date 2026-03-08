import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import ora from 'ora';
import boxen from 'boxen';
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
      files.push({ path: rel });
    }
  }
  return files;
}

function isBinaryFile(filePath) {
  const binaryExts = ['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.zip', '.tar', '.gz', '.db', '.sqlite'];
  return binaryExts.includes(path.extname(filePath).toLowerCase());
}

function simpleDiff(oldText, newText) {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const output = [];

  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);

  for (const line of oldLines) {
    if (!newSet.has(line) && line.trim()) {
      output.push(chalk.red(`  - ${line}`));
    }
  }
  for (const line of newLines) {
    if (!oldSet.has(line) && line.trim()) {
      output.push(chalk.green(`  + ${line}`));
    }
  }

  return output;
}

export async function diffCommand() {
  const config = await getConfig();
  if (!config) {
    console.log(chalk.red('\n✖ Not configured yet. Run: memoir init\n'));
    return;
  }

  const spinner = ora('Comparing local files against last backup...').start();
  const stagingDir = path.join(os.tmpdir(), `memoir-diff-${Date.now()}`);
  await fs.ensureDir(stagingDir);

  try {
    if (config.provider === 'git') {
      execSync(`git clone --depth 1 ${config.gitRepo} .`, { cwd: stagingDir, stdio: 'ignore' });
    } else {
      const resolvedSource = config.localPath.replace(/^~/, os.homedir());
      if (!(await fs.pathExists(resolvedSource))) {
        spinner.fail('No backup found. Run: memoir push');
        return;
      }
      await fs.copy(resolvedSource, stagingDir);
    }

    spinner.stop();

    const summary = { added: [], modified: [], deleted: [], unchanged: 0 };
    const details = [];

    for (const adapter of adapters) {
      const backupDir = path.join(stagingDir, adapter.name.toLowerCase().replace(/ /g, '-'));
      const backupExists = await fs.pathExists(backupDir);

      // Get local files for this adapter
      const localFiles = new Set();
      if (adapter.customExtract) {
        for (const file of adapter.files) {
          if (await fs.pathExists(path.join(adapter.source, file))) {
            localFiles.add(file);
          }
        }
      } else if (await fs.pathExists(adapter.source)) {
        // Walk local source with the adapter's filter
        const walk = async (dir, prefix = '') => {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (adapter.filter && !adapter.filter(fullPath)) continue;
            if (entry.isDirectory()) {
              await walk(fullPath, rel);
            } else {
              localFiles.add(rel);
            }
          }
        };
        await walk(adapter.source);
      }

      // Get backup files
      const backupFiles = new Set();
      if (backupExists) {
        const files = await listFiles(backupDir);
        files.forEach(f => backupFiles.add(f.path));
      }

      // New files (local but not in backup)
      for (const file of localFiles) {
        if (!backupFiles.has(file)) {
          if (!isBinaryFile(file)) {
            summary.added.push({ tool: adapter.name, icon: adapter.icon, file });
          }
        }
      }

      // Deleted files (in backup but not local)
      for (const file of backupFiles) {
        if (!localFiles.has(file)) {
          summary.deleted.push({ tool: adapter.name, icon: adapter.icon, file });
        }
      }

      // Modified files (in both, content differs)
      for (const file of localFiles) {
        if (backupFiles.has(file) && !isBinaryFile(file)) {
          const localPath = adapter.customExtract
            ? path.join(adapter.source, file)
            : path.join(adapter.source, file);
          const backupPath = path.join(backupDir, file);

          try {
            const localContent = await fs.readFile(localPath, 'utf8');
            const backupContent = await fs.readFile(backupPath, 'utf8');

            if (localContent !== backupContent) {
              const diffLines = simpleDiff(backupContent, localContent);
              summary.modified.push({ tool: adapter.name, icon: adapter.icon, file });
              details.push({ tool: adapter.name, icon: adapter.icon, file, lines: diffLines });
            } else {
              summary.unchanged++;
            }
          } catch {
            summary.unchanged++;
          }
        }
      }
    }

    // Print summary
    const totalChanges = summary.added.length + summary.modified.length + summary.deleted.length;

    if (totalChanges === 0) {
      console.log('\n' + boxen(
        chalk.green('Everything is in sync.') + '\n' +
        chalk.gray(`${summary.unchanged} files unchanged since last backup.`),
        { padding: 1, borderStyle: 'round', borderColor: 'green', dimBorder: true }
      ) + '\n');
      return;
    }

    console.log('\n' + boxen(
      chalk.cyan.bold('Changes since last backup'),
      { padding: { top: 0, bottom: 0, left: 1, right: 1 }, borderStyle: 'round', borderColor: 'cyan' }
    ));

    if (summary.added.length > 0) {
      console.log(chalk.green.bold(`\n  + ${summary.added.length} new file(s)`));
      for (const f of summary.added) {
        console.log(chalk.green(`    ${f.icon} ${f.tool}/${f.file}`));
      }
    }

    if (summary.modified.length > 0) {
      console.log(chalk.yellow.bold(`\n  ~ ${summary.modified.length} modified file(s)`));
      for (const f of summary.modified) {
        console.log(chalk.yellow(`    ${f.icon} ${f.tool}/${f.file}`));
      }
    }

    if (summary.deleted.length > 0) {
      console.log(chalk.red.bold(`\n  - ${summary.deleted.length} removed file(s)`));
      for (const f of summary.deleted) {
        console.log(chalk.red(`    ${f.icon} ${f.tool}/${f.file}`));
      }
    }

    if (summary.unchanged > 0) {
      console.log(chalk.gray(`\n  ${summary.unchanged} file(s) unchanged`));
    }

    // Show diffs for modified files
    if (details.length > 0) {
      console.log(chalk.gray('\n' + '─'.repeat(40)));
      console.log(chalk.bold.white('\n  Changes:\n'));

      for (const d of details) {
        console.log(`  ${d.icon} ${chalk.cyan(d.tool + '/' + d.file)}`);
        for (const line of d.lines) {
          console.log(line);
        }
        console.log('');
      }
    }

    console.log(chalk.gray('  Run ') + chalk.cyan('memoir push') + chalk.gray(' to back up these changes.\n'));

  } finally {
    await fs.remove(stagingDir);
  }
}
