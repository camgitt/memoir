#!/usr/bin/env node

import { program } from 'commander';
import chalk from 'chalk';
import { initCommand } from '../src/commands/init.js';
import { pushCommand } from '../src/commands/push.js';

// Read version from package.json
// (In an actual package, you might import the package.json directly or parse it)
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
      console.error(chalk.red('Error during initialization:'), err.message);
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
      console.error(chalk.red('Error during sync:'), err.message);
      process.exit(1);
    }
  });

program.parse();
