import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import fs from 'fs-extra';
import path from 'path';
import { getProfile, getProfileKeys, getProfileChoices } from '../migrate/profiles.js';
import { resolveApiKey, translateMemory } from '../migrate/translator.js';

export async function migrateCommand(options = {}) {
  let { from, to } = options;

  // 1. Pick source tool
  if (!from) {
    const answer = await inquirer.prompt([{
      type: 'list',
      name: 'from',
      message: 'Translate from:',
      choices: getProfileChoices()
    }]);
    from = answer.from;
  }

  // 2. Pick target tool
  if (!to) {
    const choices = getProfileChoices().filter(c => c.value !== from);
    const answer = await inquirer.prompt([{
      type: 'list',
      name: 'to',
      message: 'Translate to:',
      choices
    }]);
    to = answer.to;
  }

  // Validate
  const sourceProfile = getProfile(from);
  const targetProfile = getProfile(to);

  if (!sourceProfile) {
    console.log(chalk.red(`\nUnknown source tool: ${from}`));
    console.log(chalk.gray(`Available: ${getProfileKeys().join(', ')}`));
    return;
  }
  if (!targetProfile) {
    console.log(chalk.red(`\nUnknown target tool: ${to}`));
    console.log(chalk.gray(`Available: ${getProfileKeys().join(', ')}`));
    return;
  }
  if (from === to) {
    console.log(chalk.yellow('\nSource and target are the same tool.'));
    return;
  }

  // 3. Resolve API key
  const apiKey = await resolveApiKey(inquirer);

  // 4. Discover source files
  const sourceFiles = sourceProfile.discover();

  if (sourceFiles.length === 0) {
    console.log(chalk.yellow(`\nNo ${sourceProfile.name} memory files found.`));
    console.log(chalk.gray('Make sure you\'re in the right directory or that the tool has been configured.'));
    return;
  }

  // 5. Preview
  console.log(chalk.cyan(`\nFound ${sourceFiles.length} file${sourceFiles.length > 1 ? 's' : ''} from ${sourceProfile.name}:`));
  for (const f of sourceFiles) {
    const display = f.filePath.replace(process.env.HOME, '~');
    console.log(chalk.gray(`  ${display}`));
  }

  const { proceed } = await inquirer.prompt([{
    type: 'confirm',
    name: 'proceed',
    message: `Translate these to ${targetProfile.name} format?`,
    default: true
  }]);

  if (!proceed) {
    console.log(chalk.gray('\nCancelled.'));
    return;
  }

  // 6. Translate each file
  const spinner = ora();
  const translated = [];

  for (const file of sourceFiles) {
    const basename = path.basename(file.filePath);
    spinner.start(chalk.cyan(`Translating ${basename} for ${targetProfile.name}...`));

    try {
      const result = await translateMemory(file.content, sourceProfile, targetProfile, apiKey);
      translated.push({ source: file, result });
      spinner.succeed(chalk.green(`Translated ${basename}`));
    } catch (err) {
      spinner.fail(chalk.red(`Failed to translate ${basename}: ${err.message}`));
      return;
    }
  }

  // 7. Combine translated content
  let finalContent;
  if (translated.length === 1) {
    finalContent = translated[0].result;
  } else {
    finalContent = translated.map((t, i) => {
      const header = `# From ${path.basename(t.source.filePath)}`;
      return i === 0 ? `${header}\n\n${t.result}` : `\n\n${header}\n\n${t.result}`;
    }).join('');
  }

  // 8. Preview output
  console.log(chalk.cyan('\n--- Preview ---'));
  const preview = finalContent.split('\n').slice(0, 15).join('\n');
  console.log(chalk.gray(preview));
  if (finalContent.split('\n').length > 15) {
    console.log(chalk.gray(`  ... (${finalContent.split('\n').length - 15} more lines)`));
  }
  console.log(chalk.cyan('--- End preview ---\n'));

  // 9. Handle existing target file
  const targetPath = targetProfile.targetPath();
  let writeMode = 'write';

  if (await fs.pathExists(targetPath)) {
    const { action } = await inquirer.prompt([{
      type: 'list',
      name: 'action',
      message: `${path.basename(targetPath)} already exists.`,
      choices: [
        { name: 'Overwrite', value: 'overwrite' },
        { name: 'Append', value: 'append' },
        { name: 'Skip', value: 'skip' }
      ]
    }]);
    writeMode = action;
  }

  if (writeMode === 'skip') {
    console.log(chalk.gray('\nSkipped writing output.'));
    return;
  }

  // 10. Write output
  await fs.ensureDir(path.dirname(targetPath));

  if (writeMode === 'append') {
    const existing = await fs.readFile(targetPath, 'utf-8');
    await fs.writeFile(targetPath, existing + '\n\n' + finalContent);
  } else {
    await fs.writeFile(targetPath, finalContent);
  }

  const displayTarget = targetPath.replace(process.env.HOME, '~');
  console.log(chalk.green(`\n✔ Translated ${sourceFiles.length} file${sourceFiles.length > 1 ? 's' : ''} from ${sourceProfile.name} → ${targetProfile.name}`));
  console.log(chalk.gray(`  Written to ${displayTarget}\n`));
}
