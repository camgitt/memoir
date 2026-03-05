import inquirer from 'inquirer';
import chalk from 'chalk';
import boxen from 'boxen';
import gradient from 'gradient-string';
import { execSync } from 'child_process';
import { saveConfig } from '../config.js';
import { pushCommand } from './push.js';
import { restoreCommand } from './restore.js';

function getGitUsername() {
  try {
    return execSync('git config --global user.name', { encoding: 'utf8' }).trim();
  } catch { return ''; }
}

export async function initCommand() {
  console.log('');
  console.log(boxen(
    gradient.pastel('memoir') + '\n' +
    chalk.gray('Your AI remembers everything.'),
    { padding: 1, margin: 0, borderStyle: 'round', borderColor: 'cyan', align: 'center' }
  ));
  console.log('');

  const gitUser = getGitUsername();

  const { direction, provider } = await inquirer.prompt([
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
      message: (answers) => answers.direction === 'upload' ? 'Back up to?' : 'Restore from?',
      choices: [
        { name: 'GitHub', value: 'git' },
        { name: 'Local folder', value: 'local' }
      ]
    }
  ]);

  let config = { provider };

  if (provider === 'local') {
    const msg = direction === 'upload' ? 'Save to:' : 'Backup folder:';
    const { localPath } = await inquirer.prompt([{
      type: 'input',
      name: 'localPath',
      message: msg,
      validate: (input) => input.trim() ? true : 'Required'
    }]);
    config.localPath = localPath;
  } else {
    const { username, repo } = await inquirer.prompt([
      {
        type: 'input',
        name: 'username',
        message: 'GitHub username:',
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

    config.gitRepo = `https://github.com/${username.trim()}/${repo.trim()}.git`;
  }

  await saveConfig(config);
  console.log(chalk.green('Saved!\n'));

  if (direction === 'upload') {
    await pushCommand();
  } else {
    await restoreCommand();
  }
}
