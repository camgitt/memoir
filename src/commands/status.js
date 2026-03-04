import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import boxen from 'boxen';
import gradient from 'gradient-string';
import { getConfig } from '../config.js';
import { adapters } from '../adapters/index.js';

export async function statusCommand() {
  const config = await getConfig();

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
  const lines = [];
  let detected = 0;

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
      lines.push(chalk.green('  ✔ ') + chalk.white(adapter.name));
      detected++;
    } else {
      lines.push(chalk.gray('  ○ ' + adapter.name));
    }
  }

  const summary = detected > 0
    ? chalk.white(`${detected} tool${detected !== 1 ? 's' : ''} ready to sync`)
    : chalk.yellow('No AI tools detected');

  console.log(boxen(
    gradient.pastel('  memoir status  ') + '\n\n' +
    configLine + '\n\n' +
    chalk.bold.white('AI Tools') + '\n' +
    lines.join('\n') + '\n\n' +
    chalk.gray('─'.repeat(30)) + '\n' +
    summary,
    { padding: 1, borderStyle: 'round', borderColor: 'cyan', dimBorder: true }
  ) + '\n');
}
