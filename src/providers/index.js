import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { extractMemories } from '../adapters/index.js';
import chalk from 'chalk';
import { execSync } from 'child_process';

export async function syncToLocal(config, stagingDir) {
  const destDir = config.localPath;
  if (!destDir) throw new Error('Local path is not configured.');
  
  // Expand tilde if user used it
  const resolvedDest = destDir.replace(/^~/, os.homedir());
  
  await fs.ensureDir(resolvedDest);
  console.log(`📦 Copying files to ${chalk.cyan(resolvedDest)}...`);
  
  await fs.copy(stagingDir, resolvedDest);
  console.log(chalk.green('✅ Sync complete (Local Provider)!'));
}

export async function syncToGit(config, stagingDir) {
  const repoUrl = config.gitRepo;
  if (!repoUrl) throw new Error('Git repository is not configured.');
  
  // For MVP, we will initialize a temp git repo in staging, add, commit, and push force
  console.log(`📦 Syncing with Git remote: ${chalk.cyan(repoUrl)}...`);
  
  try {
    execSync('git init', { cwd: stagingDir, stdio: 'ignore' });
    execSync('git branch -m main', { cwd: stagingDir, stdio: 'ignore' });
    execSync('git add .', { cwd: stagingDir, stdio: 'ignore' });
    execSync('git config user.name "ai-sync" && git config user.email "bot@ai-sync.cli"', { cwd: stagingDir, stdio: 'ignore' });
    execSync('git commit -m "chore: ai-sync backup"', { cwd: stagingDir, stdio: 'ignore' });
    execSync(`git push --force ${repoUrl} main`, { cwd: stagingDir, stdio: 'inherit' });
    console.log(chalk.green('✅ Sync complete (Git Provider)!'));
  } catch (err) {
    throw new Error('Failed to push to git repository. Ensure you have ssh access configured.');
  }
}
