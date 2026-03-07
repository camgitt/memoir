import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import ora from 'ora';
import boxen from 'boxen';
import gradient from 'gradient-string';
import { getConfig } from '../config.js';
import { fetchFromLocal, fetchFromGit } from '../providers/restore.js';

export async function restoreCommand(options = {}) {
  const config = await getConfig();

  if (!config) {
    console.log('\n' + boxen(
      chalk.red('✖ Not configured yet\n\n') +
      chalk.white('Run ') + chalk.cyan.bold('memoir init') + chalk.white(' to get started.'),
      { padding: 1, borderStyle: 'round', borderColor: 'red' }
    ) + '\n');
    return;
  }

  console.log();
  const spinner = ora({ text: chalk.gray('Fetching memories from ' + (config.provider === 'git' ? 'GitHub' : 'local storage') + '...'), spinner: 'dots' }).start();

  const stagingDir = path.join(os.tmpdir(), `memoir-restore-${Date.now()}`);
  await fs.ensureDir(stagingDir);

  try {
    let restored = false;

    const onlyFilter = options.only ? options.only.split(',').map(t => t.trim().toLowerCase()) : null;

    const autoYes = options.yes || false;

    if (config.provider === 'local' || config.provider.includes('local')) {
      restored = await fetchFromLocal(config, stagingDir, spinner, onlyFilter, autoYes);
    } else if (config.provider === 'git' || config.provider.includes('git')) {
      restored = await fetchFromGit(config, stagingDir, spinner, onlyFilter, autoYes);
    } else {
      spinner.fail(chalk.red(`Unknown provider: ${config.provider}`));
      return;
    }

    spinner.stop();

    if (restored) {
      console.log(boxen(
        gradient.pastel('  Done!  ') + '\n\n' +
        chalk.white('Your AI tools have their memories back.') + '\n' +
        chalk.gray('Restart your AI tools to pick up the changes.'),
        { padding: 1, borderStyle: 'round', borderColor: 'green', dimBorder: true }
      ) + '\n');
    } else {
      console.log('\n' + boxen(
        chalk.yellow('Nothing was restored.\n\n') +
        chalk.white('This can happen if:\n') +
        chalk.gray('  1. You haven\'t run ') + chalk.cyan('memoir push') + chalk.gray(' on another machine yet\n') +
        chalk.gray('  2. You skipped all the restore prompts\n') +
        chalk.gray('  3. The backup repo is empty\n\n') +
        chalk.gray('Try: ') + chalk.cyan('memoir view') + chalk.gray(' to see what\'s in your backup'),
        { padding: 1, borderStyle: 'round', borderColor: 'yellow' }
      ) + '\n');
    }

  } catch (error) {
    spinner.fail(chalk.red('Restore failed: ') + error.message);
  } finally {
    await fs.remove(stagingDir);
  }
}
