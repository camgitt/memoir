import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import inquirer from 'inquirer';
import { adapters } from '../adapters/index.js';

export async function restoreMemories(sourceDir, spinner) {
  let restoredAny = false;

  for (const adapter of adapters) {
    const backupDir = path.join(sourceDir, adapter.name.toLowerCase().replace(' ', '-'));
    
    if (await fs.pathExists(backupDir)) {
      spinner.stop();
      
      console.log('
' + chalk.yellow(`⚠ Found backup for ${chalk.bold(adapter.name)}.`));
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
        spinner.text = `Restoring ${chalk.cyan(adapter.name)} memory to ${adapter.source}...`;
        await fs.ensureDir(adapter.source);
        // Copy files from backup to the real source directory
        await fs.copy(backupDir, adapter.source, { overwrite: true });
        restoredAny = true;
      } else {
        spinner.info(chalk.gray(`Skipped restoring ${adapter.name}.`));
        spinner.start();
      }
    }
  }

  return restoredAny;
}
