import inquirer from 'inquirer';
import chalk from 'chalk';
import { saveConfig } from '../config.js';

export async function initCommand() {
  console.log(chalk.blue('Welcome to ai-sync! 🚀'));
  console.log("Let's set up where you want to store your AI memory.\\n");

  const initialAnswers = await inquirer.prompt([
    {
      type: 'list',
      name: 'provider',
      message: 'Choose your storage provider:',
      choices: [
        { name: 'Local Directory (e.g. Dropbox, iCloud Drive)', value: 'local' },
        { name: 'Git Repository (e.g. private GitHub repo)', value: 'git' }
      ]
    }
  ]);

  // Normalize provider in case terminal fallback allowed typing
  let selectedProvider = initialAnswers.provider;
  if (typeof selectedProvider === 'string') {
    selectedProvider = selectedProvider.toLowerCase();
    if (selectedProvider.includes('local')) selectedProvider = 'local';
    else if (selectedProvider.includes('git')) selectedProvider = 'git';
  }

  const detailedAnswers = await inquirer.prompt([
    {
      type: 'input',
      name: 'localPath',
      message: 'Enter the full path to your sync directory (e.g., /Users/name/Dropbox/ai-sync):',
      when: () => selectedProvider === 'local',
      validate: (input) => input.trim() !== '' ? true : 'Path is required'
    },
    {
      type: 'input',
      name: 'gitRepo',
      message: 'Enter your private git repository URL (e.g., git@github.com:user/ai-memory.git):',
      when: () => selectedProvider === 'git',
      validate: (input) => input.trim() !== '' ? true : 'Repo URL is required'
    }
  ]);

  const config = {
    provider: selectedProvider,
    localPath: detailedAnswers.localPath,
    gitRepo: detailedAnswers.gitRepo
  };

  await saveConfig(config);

  console.log(chalk.green('\\n✅ Configuration saved!'));
  console.log(`You can now run ${chalk.cyan('ai-sync push')} or ${chalk.cyan('ai-sync remember')} to back up your CLI memories.`);
}
