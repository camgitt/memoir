import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import boxen from 'boxen';
import gradient from 'gradient-string';
import { getProfile, getProfileKeys, getProfileChoices } from '../tools/index.js';
import { resolveApiKey, translateMemory } from '../migrate/translator.js';

const TOOL_ICONS = {
  claude: '🟣', gemini: '🔵', codex: '🟢', cursor: '⚡',
  copilot: '🐙', windsurf: '🏄', aider: '🔧'
};

function toolLabel(key) {
  return `${TOOL_ICONS[key] || '●'} ${getProfile(key)?.name || key}`;
}

async function translateToTarget(targetKey, sourceFiles, sourceProfile, apiKey, dryRun) {
  const targetProfile = getProfile(targetKey);
  const spinner = ora();
  const translated = [];
  const failed = [];

  for (const file of sourceFiles) {
    const basename = path.basename(file.filePath);
    spinner.start(chalk.cyan(`  ${TOOL_ICONS[targetKey] || '●'} Translating ${basename} → ${targetProfile.name}...`));

    try {
      const result = await translateMemory(file.content, sourceProfile, targetProfile, apiKey);
      translated.push({ source: file, result });
      spinner.succeed(chalk.green(`  ${TOOL_ICONS[targetKey] || '✔'} ${basename} → ${targetProfile.name}`));
    } catch (err) {
      failed.push({ source: file, error: err.message });
      spinner.fail(chalk.red(`  ✖ ${basename} → ${targetProfile.name}: ${err.message}`));
    }
  }

  if (translated.length === 0) {
    return { targetKey, translated: 0, failed: failed.length, written: false };
  }

  // Combine content
  let finalContent;
  if (translated.length === 1) {
    finalContent = translated[0].result;
  } else {
    finalContent = translated.map((t, i) => {
      const header = `# From ${path.basename(t.source.filePath)}`;
      return i === 0 ? `${header}\n\n${t.result}` : `\n\n${header}\n\n${t.result}`;
    }).join('');
  }

  if (dryRun) {
    return { targetKey, translated: translated.length, failed: failed.length, written: false, content: finalContent };
  }

  // Write output
  const targetPath = targetProfile.targetPath();
  let writeMode = 'write';

  if (await fs.pathExists(targetPath)) {
    const { action } = await inquirer.prompt([{
      type: 'list',
      name: 'action',
      message: `${TOOL_ICONS[targetKey]} ${path.basename(targetPath)} already exists.`,
      choices: [
        { name: 'Overwrite', value: 'overwrite' },
        { name: 'Append', value: 'append' },
        { name: 'Skip', value: 'skip' }
      ]
    }]);
    writeMode = action;
  }

  if (writeMode === 'skip') {
    return { targetKey, translated: translated.length, failed: failed.length, written: false };
  }

  await fs.ensureDir(path.dirname(targetPath));

  if (writeMode === 'append') {
    const existing = await fs.readFile(targetPath, 'utf-8');
    const separator = `\n\n---\n<!-- Translated from ${sourceProfile.name} by memoir on ${new Date().toISOString().split('T')[0]} -->\n\n`;
    await fs.writeFile(targetPath, existing + separator + finalContent);
  } else {
    await fs.writeFile(targetPath, finalContent);
  }

  return { targetKey, translated: translated.length, failed: failed.length, written: true, path: targetPath };
}

export async function migrateCommand(options = {}) {
  let { from, to, dryRun } = options;

  // 1. Pick source tool
  if (!from) {
    const answer = await inquirer.prompt([{
      type: 'list',
      name: 'from',
      message: 'Translate from:',
      choices: getProfileChoices().map(c => ({ ...c, name: `${TOOL_ICONS[c.value] || '●'} ${c.name}` }))
    }]);
    from = answer.from;
  }

  // 2. Pick target tool(s)
  let targets = [];
  if (to === 'all') {
    targets = getProfileKeys().filter(k => k !== from);
  } else if (to) {
    targets = [to];
  } else {
    const choices = [
      { name: '🌐 All tools', value: '_all' },
      ...getProfileChoices()
        .filter(c => c.value !== from)
        .map(c => ({ ...c, name: `${TOOL_ICONS[c.value] || '●'} ${c.name}` }))
    ];
    const answer = await inquirer.prompt([{
      type: 'list',
      name: 'to',
      message: 'Translate to:',
      choices
    }]);
    targets = answer.to === '_all'
      ? getProfileKeys().filter(k => k !== from)
      : [answer.to];
  }

  // Validate
  const sourceProfile = getProfile(from);
  if (!sourceProfile) {
    console.log(chalk.red(`\nUnknown source tool: ${from}`));
    console.log(chalk.gray(`Available: ${getProfileKeys().join(', ')}`));
    return;
  }
  for (const t of targets) {
    if (!getProfile(t)) {
      console.log(chalk.red(`\nUnknown target tool: ${t}`));
      console.log(chalk.gray(`Available: ${getProfileKeys().join(', ')}`));
      return;
    }
  }
  if (targets.includes(from)) {
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

  // 5. Show source files
  console.log('');
  console.log(boxen(
    `${TOOL_ICONS[from]} ${chalk.bold(sourceProfile.name)} ${chalk.gray('→')} ${targets.map(t => TOOL_ICONS[t]).join(' ')}\n\n` +
    sourceFiles.map(f => {
      const display = f.filePath.replace(os.homedir(), '~');
      const size = chalk.gray(`(${(f.content.length / 1024).toFixed(1)}kb)`);
      return `  ${chalk.cyan('◆')} ${display} ${size}`;
    }).join('\n'),
    { padding: { top: 0, bottom: 0, left: 1, right: 1 }, borderStyle: 'round', borderColor: 'cyan', dimBorder: true }
  ));

  const { proceed } = await inquirer.prompt([{
    type: 'confirm',
    name: 'proceed',
    message: `Translate ${sourceFiles.length} file${sourceFiles.length > 1 ? 's' : ''} to ${targets.length} tool${targets.length > 1 ? 's' : ''}?`,
    default: true
  }]);

  if (!proceed) {
    console.log(chalk.gray('\nCancelled.'));
    return;
  }

  console.log('');

  // 6. Translate to each target
  const results = [];
  for (const targetKey of targets) {
    const result = await translateToTarget(targetKey, sourceFiles, sourceProfile, apiKey, dryRun);
    results.push(result);
  }

  // 7. Summary
  const succeeded = results.filter(r => r.translated > 0);
  const written = results.filter(r => r.written);
  const totalFailed = results.reduce((sum, r) => sum + r.failed, 0);

  console.log('');

  if (dryRun) {
    // Show preview for dry run
    for (const r of succeeded) {
      if (r.content) {
        const preview = r.content.split('\n').slice(0, 10).join('\n');
        console.log(chalk.cyan(`--- ${getProfile(r.targetKey).name} preview ---`));
        console.log(chalk.gray(preview));
        const totalLines = r.content.split('\n').length;
        if (totalLines > 10) console.log(chalk.gray(`  ... (${totalLines - 10} more lines)`));
        console.log('');
      }
    }
    console.log(chalk.yellow('Dry run — no files written.\n'));
    return;
  }

  // Build summary box
  const summaryLines = results.map(r => {
    const profile = getProfile(r.targetKey);
    const icon = TOOL_ICONS[r.targetKey] || '●';
    if (r.written) {
      const display = r.path.replace(os.homedir(), '~');
      return `  ${icon} ${chalk.green('✔')} ${profile.name} ${chalk.gray('→ ' + display)}`;
    } else if (r.translated > 0) {
      return `  ${icon} ${chalk.gray('⏭')} ${profile.name} ${chalk.gray('(skipped)')}`;
    } else {
      return `  ${icon} ${chalk.red('✖')} ${profile.name} ${chalk.gray('(failed)')}`;
    }
  }).join('\n');

  console.log(boxen(
    gradient.pastel('  Translated!  ') + '\n\n' +
    summaryLines + '\n\n' +
    chalk.gray(`${written.length} written, ${succeeded.length - written.length} skipped${totalFailed > 0 ? `, ${totalFailed} failed` : ''}`),
    { padding: { top: 0, bottom: 0, left: 1, right: 1 }, borderStyle: 'round', borderColor: 'green', dimBorder: true }
  ));
  console.log('');
}
