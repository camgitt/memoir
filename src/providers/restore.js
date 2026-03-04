import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { restoreMemories } from '../adapters/restore.js';

export async function fetchFromLocal(config, stagingDir, spinner) {
  const sourceDir = config.localPath;
  if (!sourceDir) throw new Error('Local path is not configured.');
  
  const resolvedSource = sourceDir.replace(/^~/, os.homedir());
  
  if (!(await fs.pathExists(resolvedSource))) {
    throw new Error(`The backup directory does not exist: ${resolvedSource}`);
  }

  spinner.text = `Fetching data from local directory: ${chalk.cyan(resolvedSource)}`;
  await fs.copy(resolvedSource, stagingDir);
  
  return await restoreMemories(stagingDir, spinner);
}

export async function fetchFromGit(config, stagingDir, spinner) {
  const repoUrl = config.gitRepo;
  if (!repoUrl) throw new Error('Git repository is not configured.');
  
  spinner.text = `Cloning memory from Git remote: ${chalk.cyan(repoUrl)}`;
  
  try {
    // Clone depth 1 to make it fast
    execSync(`git clone --depth 1 ${repoUrl} .`, { cwd: stagingDir, stdio: 'ignore' });
  } catch (err) {
    throw new Error('Failed to pull from git repository. Ensure your SSH keys are configured and the repository is accessible.');
  }

  return await restoreMemories(stagingDir, spinner);
}
