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
  
  // Clone existing repo to preserve history, then replace contents
  const gitDir = path.join(os.tmpdir(), `memoir-git-${Date.now()}`);
  await fs.ensureDir(gitDir);

  try {
    try {
      execSync(`git clone --depth 10 ${repoUrl} .`, { cwd: gitDir, stdio: 'ignore' });
      // Remove old files so deleted configs don't persist
      const files = await fs.readdir(gitDir);
      for (const f of files) {
        if (f !== '.git') await fs.remove(path.join(gitDir, f));
      }
    } catch {
      // Repo is empty or doesn't exist yet — init fresh
      execSync('git init', { cwd: gitDir, stdio: 'ignore' });
      execSync('git branch -m main', { cwd: gitDir, stdio: 'ignore' });
    }

    // Copy staged memories into the git dir
    await fs.copy(stagingDir, gitDir);

    execSync('git add -A', { cwd: gitDir, stdio: 'ignore' });
    execSync('git config user.name "memoir"', { cwd: gitDir, stdio: 'ignore' });
    execSync('git config user.email "bot@memoir.dev"', { cwd: gitDir, stdio: 'ignore' });

    const timestamp = new Date().toISOString().split('T')[0];
    try {
      execSync(`git commit -m "memoir backup ${timestamp}"`, { cwd: gitDir, stdio: 'ignore' });
    } catch {
      spinner.succeed(chalk.green('Already up to date! ') + chalk.gray('No changes to push.'));
      return;
    }

    spinner.text = `Pushing data to ${chalk.cyan(repoUrl)}...`;
    execSync(`git push ${repoUrl} main`, { cwd: gitDir, stdio: 'ignore' });

    spinner.succeed(chalk.green('Sync complete! ') + chalk.gray('(Uploaded securely to GitHub)'));
  } catch (err) {
    throw new Error('Failed to push to git repository. Ensure your credentials are configured and the repository exists.');
  } finally {
    await fs.remove(gitDir);
  }
}
