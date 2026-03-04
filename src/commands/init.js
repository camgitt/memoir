import inquirer from 'inquirer';
import chalk from 'chalk';
import { saveConfig } from '../config.js';

export async function initCommand() {
  console.log(chalk.blue('Welcome to ai-sync! 🚀'));
  console.log('Let's set up where you want to store your AI memory.
');

  const answers = await inquirer.prompt([
    {
      type: 'list',
      name: 'provider',
      message: 'Choose your storage provider:',
      choices: [
        { name: 'Local Directory (e.g. Dropbox, iCloud Drive)', value: 'local' },
        { name: 'Git Repository (e.g. private GitHub repo)', value: 'git' }
      ]
    },
    {
      type: 'input',
      name: 'localPath',
      message: 'Enter the full path to your sync directory (e.g., /Users/name/Dropbox/ai-sync):',
      when: (answers) => answers.provider === 'local',
      validate: (input) => input.trim() !== '' ? true : 'Path is required'
    },
    {
      type: 'input',
      name: 'gitRepo',
      message: 'Enter your private git repository URL (e.g., git@github.com:user/ai-memory.git):',
      when: (answers) => answers.provider === 'git',
      validate: (input) => input.trim() !== '' ? true : 'Repo URL is required'
    }
  ]);

  const config = {
    provider: answers.provider,
    localPath: answers.localPath,
    gitRepo: answers.gitRepo
  };

  await saveConfig(config);

  console.log(chalk.green('
✅ Configuration saved!'));
  console.log(`You can now run ${chalk.cyan('ai-sync push')} or ${chalk.cyan('ai-sync remember')} to back up your CLI memories.`);
}
