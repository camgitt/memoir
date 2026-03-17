import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import { execFileSync } from 'child_process';

function sanitizeUrl(url) {
  // Reject URLs with shell metacharacters
  if (/[`$;|&()<>!]/.test(url)) {
    throw new Error('Repository URL contains invalid characters.');
  }
  return url;
}

export async function syncToLocal(config, stagingDir, spinner) {
  const destDir = config.localPath;
  if (!destDir) throw new Error('Local path is not configured.');

  const resolvedDest = destDir.replace(/^~/, os.homedir());

  spinner.text = `Syncing files to local directory: ${chalk.cyan(resolvedDest)}`;
  await fs.ensureDir(resolvedDest);

  await fs.copy(stagingDir, resolvedDest);
  spinner.succeed(chalk.green('Sync complete! ') + chalk.gray(`(Saved to ${resolvedDest})`));
}

export async function syncToGit(config, stagingDir, spinner) {
  const repoUrl = sanitizeUrl(config.gitRepo);
  if (!repoUrl) throw new Error('Git repository is not configured.');

  spinner.text = `Authenticating and syncing with Git remote: ${chalk.cyan(repoUrl)}`;

  const gitDir = path.join(os.tmpdir(), `memoir-git-${Date.now()}`);
  await fs.ensureDir(gitDir);

  try {
    try {
      execFileSync('git', ['clone', '--depth', '1', repoUrl, '.'], { cwd: gitDir, stdio: 'ignore', timeout: 60000 });
      const files = await fs.readdir(gitDir);
      for (const f of files) {
        if (f !== '.git') await fs.remove(path.join(gitDir, f));
      }
    } catch {
      execFileSync('git', ['init'], { cwd: gitDir, stdio: 'ignore' });
      execFileSync('git', ['branch', '-m', 'main'], { cwd: gitDir, stdio: 'ignore' });
    }

    await fs.copy(stagingDir, gitDir);

    execFileSync('git', ['add', '-A'], { cwd: gitDir, stdio: 'ignore', timeout: 30000 });
    execFileSync('git', ['config', 'user.name', 'memoir'], { cwd: gitDir, stdio: 'ignore', timeout: 5000 });
    execFileSync('git', ['config', 'user.email', 'bot@memoir.dev'], { cwd: gitDir, stdio: 'ignore', timeout: 5000 });

    const timestamp = new Date().toISOString().split('T')[0];
    try {
      execFileSync('git', ['commit', '-m', `memoir backup ${timestamp}`], { cwd: gitDir, stdio: 'ignore', timeout: 30000 });
    } catch {
      spinner.succeed(chalk.green('Already up to date! ') + chalk.gray('No changes to push.'));
      return;
    }

    spinner.text = `Pushing data to ${chalk.cyan(repoUrl)}...`;
    execFileSync('git', ['push', repoUrl, 'main'], { cwd: gitDir, stdio: 'ignore', timeout: 120000 });

    spinner.succeed(chalk.green('Sync complete! ') + chalk.gray('(Uploaded securely to GitHub)'));
  } catch (err) {
    if (err.message.includes('invalid characters')) throw err;
    throw new Error('Failed to push to git repository. Ensure your credentials are configured and the repository exists.');
  } finally {
    await fs.remove(gitDir);
  }
}
