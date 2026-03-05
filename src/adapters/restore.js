import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import inquirer from 'inquirer';
import { adapters } from '../adapters/index.js';

async function copyMissing(src, dest, changes) {
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await fs.ensureDir(destPath);
      await copyMissing(srcPath, destPath, changes);
    } else {
      if (await fs.pathExists(destPath)) {
        changes.skipped.push(destPath);
      } else {
        await fs.copy(srcPath, destPath);
        changes.added.push(destPath);
      }
    }
  }
}

export async function restoreMemories(sourceDir, spinner) {
  let restoredAny = false;

  for (const adapter of adapters) {
    const backupDir = path.join(sourceDir, adapter.name.toLowerCase().replace(/ /g, '-'));

    if (await fs.pathExists(backupDir)) {
      spinner.stop();

      console.log('\n' + chalk.yellow(`⚠ Found backup for ${chalk.bold(adapter.name)}.`));
      const { confirm } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: `Restore ${adapter.name} memory? (only adds missing files, won't overwrite)`,
          default: false
        }
      ]);

      spinner.start();

      if (confirm) {
        const changes = { added: [], skipped: [] };

        if (adapter.customExtract) {
          const files = await fs.readdir(backupDir);
          for (const file of files) {
            const dest = path.join(adapter.source, file);
            if (await fs.pathExists(dest)) {
              changes.skipped.push(dest);
            } else {
              await fs.copy(path.join(backupDir, file), dest);
              changes.added.push(dest);
            }
          }
        } else {
          spinner.text = `Restoring ${chalk.cyan(adapter.name)} memory to ${adapter.source}...`;
          await fs.ensureDir(adapter.source);
          await copyMissing(backupDir, adapter.source, changes);
        }

        // Show summary of changes
        spinner.stop();
        if (changes.added.length > 0) {
          console.log(chalk.green.bold(`\n  ✔ ${adapter.name} — ${changes.added.length} file(s) added:`));
          for (const f of changes.added) {
            console.log(chalk.green(`    + ${f}`));
          }
        }
        if (changes.skipped.length > 0) {
          console.log(chalk.gray(`  ⏭ ${changes.skipped.length} file(s) already existed (kept yours)`));
        }
        if (changes.added.length === 0 && changes.skipped.length > 0) {
          console.log(chalk.gray(`  Nothing new to add — you're already up to date.`));
        }
        spinner.start();

        restoredAny = true;
      } else {
        spinner.info(chalk.gray(`Skipped restoring ${adapter.name}.`));
        spinner.start();
      }
    }
  }

  return restoredAny;
}
