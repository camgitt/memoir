import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import ora from 'ora';
import { getConfig } from '../config.js';
import { fetchFromLocal, fetchFromGit } from '../providers/restore.js';

export async function restoreCommand() {
  const config = await getConfig();
  
  if (!config) {
    console.log('\\n' + chalk.red('✖ memoir is not configured.'));
    console.log(`Run ${chalk.cyan('memoir init')} to set up your storage provider and fetch your files.\\n`);
    return;
  }

  console.log();
  const spinner = ora('Initializing AI memory restore...').start();

  // Create a temporary staging directory to hold the downloaded files
  const stagingDir = path.join(os.tmpdir(), `memoir-restore-${Date.now()}`);
  await fs.ensureDir(stagingDir);

  try {
    let restored = false;

    if (config.provider === 'local' || config.provider.includes('local')) {
      restored = await fetchFromLocal(config, stagingDir, spinner);
    } else if (config.provider === 'git' || config.provider.includes('git')) {
      restored = await fetchFromGit(config, stagingDir, spinner);
    } else {
      spinner.fail(chalk.red(`Unknown provider: ${config.provider}`));
      return;
    }

    if (restored) {
      spinner.succeed(chalk.green('Restore complete! Your AI bots have their memories back.'));
    } else {
      spinner.info(chalk.yellow('No memories were restored.'));
    }

  } catch (error) {
    spinner.fail(chalk.red('Restore failed: ') + error.message);
  } finally {
    // Clean up staging directory
    await fs.remove(stagingDir);
  }
}
