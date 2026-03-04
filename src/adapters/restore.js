import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import inquirer from 'inquirer';
import { adapters } from '../adapters/index.js';

export async function restoreMemories(sourceDir, spinner) {
  let restoredAny = false;

  for (const adapter of adapters) {
    const backupDir = path.join(sourceDir, adapter.name.toLowerCase().replace(/ /g, '-'));

    if (await fs.pathExists(backupDir)) {
      spinner.stop();

      console.log('\\n' + chalk.yellow(`⚠ Found backup for ${chalk.bold(adapter.name)}.`));
      const { confirm } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: `Restore ${adapter.name} memory? This will overwrite existing configuration files!`,
          default: false
        }
      ]);

      spinner.start();

      if (confirm) {
        if (adapter.customExtract) {
          // Restore individual files back to their original locations
          const files = await fs.readdir(backupDir);
          for (const file of files) {
            const dest = path.join(adapter.source, file);
            await fs.copy(path.join(backupDir, file), dest, { overwrite: true });
          }
        } else {
          spinner.text = `Restoring ${chalk.cyan(adapter.name)} memory to ${adapter.source}...`;
          await fs.ensureDir(adapter.source);
          await fs.copy(backupDir, adapter.source, { overwrite: true });
        }
        restoredAny = true;
      } else {
        spinner.info(chalk.gray(`Skipped restoring ${adapter.name}.`));
        spinner.start();
      }
    }
  }

  return restoredAny;
}
