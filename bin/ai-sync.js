#!/usr/bin/env node
import { program } from 'commander';
import chalk from 'chalk';
import boxen from 'boxen';
import gradient from 'gradient-string';
import { initCommand } from '../src/commands/init.js';
import { pushCommand } from '../src/commands/push.js';
import { restoreCommand } from '../src/commands/restore.js';

const VERSION = '1.0.0';

program
  .name('ai-sync')
  .description('Universal AI CLI memory synchronization tool')
  .version(VERSION);

program
  .command('init')
  .description('Initialize and configure ai-sync storage preferences')
  .action(async () => {
    try {
      await initCommand();
    } catch (err) {
      console.error(chalk.red('\\n✖ Error during initialization:'), err.message);
      process.exit(1);
    }
  });

program
  .command('push')
  .alias('remember')
  .description('Sync your AI CLI memory to your configured storage')
  .action(async () => {
    try {
      await pushCommand();
    } catch (err) {
      console.error(chalk.red('\\n✖ Error during sync:'), err.message);
      process.exit(1);
    }
  });

program
  .command('restore')
  .alias('pull')
  .description('Restore your AI CLI memory from your configured storage')
  .action(async () => {
    try {
      await restoreCommand();
    } catch (err) {
      console.error(chalk.red('\\n✖ Error during restore:'), err.message);
      process.exit(1);
    }
  });

program
  .command('migrate')
  .description('Migrate memory/context from one AI bot to another (e.g. Claude to Gemini)')
  .action(() => {
    console.log('\\n' + boxen(
      gradient.pastel('ai-sync migrate (Coming Soon)') + '\\n\\n' +
      chalk.white('We are actively developing the ability to instantly translate') + '\\n' +
      chalk.white('and swap your context/memories between different AI providers.') + '\\n\\n' +
      chalk.cyan('Stay tuned for updates!'),
      { padding: 1, borderStyle: 'round', borderColor: 'yellow', align: 'center' }
    ) + '\\n');
  });

program.parse();
