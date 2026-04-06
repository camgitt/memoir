import inquirer from 'inquirer';
import chalk from 'chalk';
import boxen from 'boxen';
import gradient from 'gradient-string';
import { execFileSync } from 'child_process';
import { saveConfig } from '../config.js';
import { pushCommand } from './push.js';
import { restoreCommand } from './restore.js';

function getGitUsername() {
  try {
    return execFileSync('git', ['config', '--global', 'user.name'], { encoding: 'utf8' }).trim();
  } catch { return ''; }
}

function getGitHubUsername() {
  try {
    // Try gh CLI first
    return execFileSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8' }).trim();
  } catch {
    // Fall back to git config
    return getGitUsername();
  }
}

export async function initCommand(options = {}) {
  console.log('');
  console.log(boxen(
    gradient.pastel('memoir') + '\n' +
    chalk.gray('Your AI remembers everything.'),
    { padding: 1, margin: 0, borderStyle: 'round', borderColor: 'cyan', align: 'center' }
  ));
  console.log('');

  const detectedUser = getGitHubUsername();

  let direction, provider;

  if (options.provider) {
    // Non-interactive: use flags directly
    provider = options.provider;
    direction = options.direction || 'upload';
  } else {
    // Interactive: prompt the user
    const answers = await inquirer.prompt([
      {
        type: 'list',
        name: 'direction',
        message: 'Upload or download?',
        choices: [
          { name: 'Upload — back up this machine', value: 'upload' },
          { name: 'Download — restore from backup', value: 'download' }
        ]
      },
      {
        type: 'list',
        name: 'provider',
        message: (a) => a.direction === 'upload' ? 'Back up to?' : 'Restore from?',
        choices: [
          { name: 'GitHub', value: 'git' },
          { name: 'Local folder', value: 'local' }
        ]
      }
    ]);
    direction = answers.direction;
    provider = answers.provider;
  }

  let config = { provider };

  if (provider === 'local') {
    let localPath;
    if (options.localPath) {
      localPath = options.localPath;
    } else {
      const msg = direction === 'upload' ? 'Save to:' : 'Backup folder:';
      const answers = await inquirer.prompt([{
        type: 'input',
        name: 'localPath',
        message: msg,
        validate: (input) => input.trim() ? true : 'Required'
      }]);
      localPath = answers.localPath;
    }
    config.localPath = localPath;
  } else {
    let username, repo;
    if (options.username) {
      username = options.username.trim();
      repo = (options.repo || 'ai-memory').trim();
    } else {
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'username',
          message: 'GitHub username:',
          default: detectedUser || undefined,
          validate: (input) => input.trim() ? true : 'Required'
        },
        {
          type: 'input',
          name: 'repo',
          message: 'Repo name:',
          default: 'ai-memory',
          validate: (input) => input.trim() ? true : 'Required'
        }
      ]);
      username = answers.username.trim();
      repo = answers.repo.trim();
    }

    config.gitRepo = `https://github.com/${username}/${repo}.git`;
    console.log(chalk.gray(`  → ${config.gitRepo}`));

    // Auto-create the repo if gh CLI is available and repo doesn't exist
    if (direction === 'upload') {
      try {
        execFileSync('gh', ['repo', 'view', `${username}/${repo}`], { stdio: 'ignore' });
        console.log(chalk.gray('  ✔ Repo exists\n'));
      } catch {
        // Repo doesn't exist — try to create it
        try {
          execFileSync('gh', ['repo', 'create', `${username}/${repo}`, '--private', '--description', 'AI memory backup (memoir-cli)'], { stdio: 'ignore' });
          console.log(chalk.green('  ✔ Created private repo\n'));
        } catch {
          console.log(chalk.yellow('  ⚠ Could not auto-create repo. Create it manually on GitHub.\n'));
        }
      }
    } else {
      console.log('');
    }
  }

  // Ask about encryption
  let encrypt;
  if (options.encrypt !== undefined) {
    encrypt = options.encrypt;
  } else {
    const answers = await inquirer.prompt([{
      type: 'confirm',
      name: 'encrypt',
      message: 'Enable E2E encryption? (protects your data even if backup is compromised)',
      default: true
    }]);
    encrypt = answers.encrypt;
  }
  config.encrypt = encrypt;

  if (encrypt) {
    console.log(chalk.gray('  You\'ll set a passphrase on first push. Same passphrase on all machines.'));
  }

  await saveConfig(config);
  console.log(chalk.green('✔ Saved!\n'));

  if (direction === 'upload') {
    await pushCommand();
  } else {
    await restoreCommand();
  }
}
