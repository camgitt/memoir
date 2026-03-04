import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import ora from 'ora';
import { getConfig } from '../config.js';
import { extractMemories } from '../adapters/index.js';
import { syncToLocal, syncToGit } from '../providers/index.js';

export async function pushCommand() {
  const config = await getConfig();
  
  if (!config) {
    console.log('\\n' + chalk.red('✖ ai-sync is not configured.'));
    console.log(`Run ${chalk.cyan('ai-sync init')} to set up your storage provider.\\n`);
    return;
  }

  console.log();
  const spinner = ora('Initializing AI memory sync...').start();

  // Create a temporary staging directory
  const stagingDir = path.join(os.tmpdir(), `ai-sync-staging-${Date.now()}`);
  await fs.ensureDir(stagingDir);

  try {
    spinner.text = 'Scanning system for AI configurations...';
    
    // Pass spinner so adapter can update it
    const foundAny = await extractMemories(stagingDir, spinner);
    
    if (!foundAny) {
      spinner.warn(chalk.yellow('No supported AI memory folders found on this system.'));
      return;
    }

    if (config.provider === 'local' || config.provider.includes('local')) {
      await syncToLocal(config, stagingDir, spinner);
    } else if (config.provider === 'git' || config.provider.includes('git')) {
      await syncToGit(config, stagingDir, spinner);
    } else {
      spinner.fail(chalk.red(`Unknown provider: ${config.provider}`));
    }
  } catch (error) {
    spinner.fail(chalk.red('Sync failed: ') + error.message);
  } finally {
    // Clean up staging directory
    await fs.remove(stagingDir);
  }
}
