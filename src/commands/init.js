import inquirer from 'inquirer';
import chalk from 'chalk';
import open from 'open';
import boxen from 'boxen';
import gradient from 'gradient-string';
import { saveConfig } from '../config.js';

export async function initCommand() {
  const title = gradient.pastel.multiline('ai-sync \\nUniversal AI Memory Manager');
  console.log('\\n' + boxen(title, { 
    padding: 1, 
    margin: 1, 
    borderStyle: 'round', 
    borderColor: 'cyan',
    align: 'center'
  }));

  console.log(chalk.gray("Let's configure where your AI knowledge will be safely stored.\\n"));

  const answers = await inquirer.prompt([
    {
      type: 'list',
      name: 'provider',
      message: 'Choose your storage provider:',
      choices: [
        { name: '☁️  Git Repository ' + chalk.gray('(GitHub, GitLab - Best for syncing across computers)'), value: 'git' },
        { name: '📂 Local Directory ' + chalk.gray('(Dropbox, iCloud - Best for local backups)'), value: 'local' }
      ]
    },
    {
      type: 'input',
      name: 'localPath',
      message: 'Enter the full path to your sync directory ' + chalk.gray('(e.g., ~/Dropbox/ai-sync):'),
      when: (answers) => answers.provider === 'local',
      validate: (input) => input.trim() !== '' ? true : chalk.red('✖ Path is required')
    },
    {
      type: 'confirm',
      name: 'openBrowser',
      message: 'Need to create an empty GitHub repository right now?',
      when: (answers) => answers.provider === 'git',
      default: false
    }
  ]);

  if (answers.openBrowser) {
    console.log(chalk.cyan('\\n↗ Opening GitHub... Create an empty private repository, then return here.\\n'));
    await open('https://github.com/new');
  }

  const finalAnswers = await inquirer.prompt([
    {
      type: 'input',
      name: 'gitRepo',
      message: 'Repository URL ' + chalk.gray('(e.g., git@github.com:username/ai-memory.git):'),
      when: () => answers.provider === 'git',
      validate: (input) => {
        if (input.trim() === '') return chalk.red('✖ Repo URL is required');
        if (!input.includes('github.com') && !input.includes('gitlab.com')) {
          return chalk.yellow('⚠ Warning: This does not look like a standard GitHub/GitLab URL. Please verify.');
        }
        return true;
      }
    }
  ]);

  const config = {
    provider: answers.provider,
    localPath: answers.localPath,
    gitRepo: finalAnswers.gitRepo
  };

  await saveConfig(config);

  console.log('\\n' + boxen(
    chalk.green('✔ Configuration saved successfully!') + '\\n\\n' +
    chalk.white('To backup your memory, run:') + '\\n' +
    chalk.cyan.bold('ai-sync push'),
    { padding: 1, borderStyle: 'single', borderColor: 'green' }
  ) + '\\n');
}
