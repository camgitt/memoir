import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import { execSync } from 'child_process';

export async function syncToLocal(config, stagingDir, spinner) {
  const destDir = config.localPath;
  if (!destDir) throw new Error('Local path is not configured.');
  
  // Expand tilde if user used it
  const resolvedDest = destDir.replace(/^~/, os.homedir());
  
  spinner.text = `Syncing files to local directory: ${chalk.cyan(resolvedDest)}`;
  await fs.ensureDir(resolvedDest);
  
  await fs.copy(stagingDir, resolvedDest);
  spinner.succeed(chalk.green('Sync complete! ') + chalk.gray(`(Saved to ${resolvedDest})`));
}

export async function syncToGit(config, stagingDir, spinner) {
  const repoUrl = config.gitRepo;
  if (!repoUrl) throw new Error('Git repository is not configured.');
  
  spinner.text = `Authenticating and syncing with Git remote: ${chalk.cyan(repoUrl)}`;
  
  try {
    execSync('git init', { cwd: stagingDir, stdio: 'ignore' });
    execSync('git branch -m main', { cwd: stagingDir, stdio: 'ignore' });
    execSync('git add .', { cwd: stagingDir, stdio: 'ignore' });
    execSync('git config user.name "recall" && git config user.email "bot@totalrecall.dev"', { cwd: stagingDir, stdio: 'ignore' });
    execSync('git commit -m "chore: recall backup"', { cwd: stagingDir, stdio: 'ignore' });
    
    spinner.text = `Pushing data to ${chalk.cyan(repoUrl)}...`;
    // We ignore stdio to prevent spam, but if it fails it will throw
    execSync(`git push --force ${repoUrl} main`, { cwd: stagingDir, stdio: 'ignore' });
    
    spinner.succeed(chalk.green('Sync complete! ') + chalk.gray('(Uploaded securely to GitHub)'));
  } catch (err) {
    throw new Error('Failed to push to git repository. Ensure your SSH keys are configured and the repository exists.');
  }
}
