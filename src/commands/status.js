import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import boxen from 'boxen';
import gradient from 'gradient-string';
import { getConfig } from '../config.js';
import { adapters } from '../adapters/index.js';

export async function statusCommand(options = {}) {
  const config = await getConfig(options.profile);

  console.log();

  // Config status
  let configLine;
  if (config) {
    const provider = config.provider === 'git'
      ? chalk.cyan(config.gitRepo)
      : chalk.cyan(config.localPath);
    configLine = chalk.green('✔ Connected') + chalk.gray(' → ') + provider;
  } else {
    configLine = chalk.red('✖ Not configured') + chalk.gray(' → run ') + chalk.cyan('memoir init');
  }

  // Detected tools
  const foundTools = [];
  const notFound = [];

  for (const adapter of adapters) {
    let found = false;
    if (adapter.customExtract) {
      for (const file of adapter.files) {
        if (await fs.pathExists(path.join(adapter.source, file))) {
          found = true;
          break;
        }
      }
    } else {
      found = await fs.pathExists(adapter.source);
    }

    if (found) {
      foundTools.push(chalk.green('  ✔ ') + chalk.white(adapter.name));
    } else {
      notFound.push(adapter.name);
    }
  }

  const lines = foundTools.length > 0
    ? foundTools
    : [chalk.yellow('  No AI tools detected')];

  const summary = foundTools.length > 0
    ? chalk.white(`${foundTools.length} tool${foundTools.length !== 1 ? 's' : ''} ready to sync`)
    : chalk.gray(`Supports: ${adapters.map(a => a.name).join(', ')}`);

  // Show not-found tools as a compact line if there are found tools
  const notFoundLine = foundTools.length > 0 && notFound.length > 0
    ? '\n' + chalk.gray(`  Also supports: ${notFound.join(', ')}`)
    : '';

  console.log(boxen(
    gradient.pastel('  memoir status  ') + '\n\n' +
    configLine + '\n\n' +
    chalk.bold.white('AI Tools') + '\n' +
    lines.join('\n') + notFoundLine + '\n\n' +
    chalk.gray('─'.repeat(30)) + '\n' +
    summary,
    { padding: 1, borderStyle: 'round', borderColor: 'cyan', dimBorder: true }
  ) + '\n');
}
