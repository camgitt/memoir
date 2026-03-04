import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { getConfig } from '../config.js';
import { extractMemories } from '../adapters/index.js';
import { syncToLocal, syncToGit } from '../providers/index.js';

export async function pushCommand() {
  const config = await getConfig();
  
  if (!config) {
    console.log(chalk.red('Error: ai-sync is not configured.'));
    console.log(`Run ${chalk.cyan('ai-sync init')} to set up your storage provider.`);
    return;
  }

  console.log(chalk.blue('Starting AI memory sync...'));

  // Create a temporary staging directory
  const stagingDir = path.join(os.tmpdir(), `ai-sync-staging-${Date.now()}`);
  await fs.ensureDir(stagingDir);

  try {
    const foundAny = await extractMemories(stagingDir);
    
    if (!foundAny) {
      console.log(chalk.yellow('No supported AI memory folders found on this system.'));
      return;
    }

    if (config.provider === 'local') {
      await syncToLocal(config, stagingDir);
    } else if (config.provider === 'git') {
      await syncToGit(config, stagingDir);
    } else {
      console.log(chalk.red(`Unknown provider: ${config.provider}`));
    }
  } finally {
    // Clean up staging directory
    await fs.remove(stagingDir);
  }
}
