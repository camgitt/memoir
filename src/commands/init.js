import inquirer from 'inquirer';
import chalk from 'chalk';
import open from 'open';
import { saveConfig } from '../config.js';

export async function initCommand() {
  console.log(chalk.blue('Welcome to ai-sync! 🚀'));
  console.log("Let's set up where you want to store your AI memory.\\n");

  const answers = await inquirer.prompt([
    {
      type: 'list',
      name: 'provider',
      message: 'Choose your storage provider:',
      choices: [
        { name: '📂 Local Directory (e.g. Dropbox, iCloud Drive)', value: 'local' },
        { name: '☁️  Git Repository (e.g. private GitHub repo)', value: 'git' }
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
      type: 'confirm',
      name: 'openBrowser',
      message: 'Do you need to create a new private GitHub repository right now?',
      when: (answers) => answers.provider === 'git',
      default: false
    }
  ]);

  if (answers.openBrowser) {
    console.log(chalk.yellow('Opening GitHub in your browser... Create an empty private repository, then come back here!'));
    await open('https://github.com/new');
  }

  const finalAnswers = await inquirer.prompt([
    {
      type: 'input',
      name: 'gitRepo',
      message: 'Enter your private git repository URL (e.g., git@github.com:username/ai-memory.git):',
      when: () => answers.provider === 'git',
      validate: (input) => {
        if (input.trim() === '') return 'Repo URL is required';
        if (!input.includes('github.com') && !input.includes('gitlab.com')) return 'Please enter a valid Git URL';
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

  console.log(chalk.green('\\n✅ Configuration saved!'));
  console.log(`You can now run ${chalk.cyan('ai-sync push')} or ${chalk.cyan('ai-sync remember')} to back up your CLI memories.`);
}
