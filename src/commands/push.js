import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import ora from 'ora';
import boxen from 'boxen';
import gradient from 'gradient-string';
import { getConfig } from '../config.js';
import { extractMemories, adapters } from '../adapters/index.js';
import { syncToLocal, syncToGit } from '../providers/index.js';

export async function pushCommand(options = {}) {
  const config = await getConfig();

  if (!config) {
    console.log('\n' + boxen(
      chalk.red('✖ Not configured yet\n\n') +
      chalk.white('Run ') + chalk.cyan.bold('memoir init') + chalk.white(' to get started.'),
      { padding: 1, borderStyle: 'round', borderColor: 'red' }
    ) + '\n');
    return;
  }

  console.log();
  const spinner = ora({ text: chalk.gray('Scanning for AI tools...'), spinner: 'dots' }).start();

  const stagingDir = path.join(os.tmpdir(), `memoir-staging-${Date.now()}`);
  await fs.ensureDir(stagingDir);

  try {
    const onlyFilter = options.only ? options.only.split(',').map(t => t.trim().toLowerCase()) : null;
    const foundAny = await extractMemories(stagingDir, spinner, onlyFilter);

    if (!foundAny) {
      spinner.stop();
      console.log('\n' + boxen(
        chalk.yellow('No AI tools detected on this machine.\n\n') +
        chalk.gray('Supported: Claude, Gemini, Codex, Cursor, Copilot, Windsurf, Aider'),
        { padding: 1, borderStyle: 'round', borderColor: 'yellow' }
      ) + '\n');
      return;
    }

    // Count what was found
    const found = [];
    for (const adapter of adapters) {
      if (adapter.customExtract) {
        for (const file of adapter.files) {
          if (await fs.pathExists(path.join(adapter.source, file))) {
            found.push(adapter.name);
            break;
          }
        }
      } else if (await fs.pathExists(adapter.source)) {
        found.push(adapter.name);
      }
    }

    spinner.text = chalk.gray('Uploading to ' + (config.provider === 'git' ? 'GitHub' : 'local storage') + '...');

    if (config.provider === 'local' || config.provider.includes('local')) {
      await syncToLocal(config, stagingDir, spinner);
    } else if (config.provider === 'git' || config.provider.includes('git')) {
      await syncToGit(config, stagingDir, spinner);
    } else {
      spinner.fail(chalk.red(`Unknown provider: ${config.provider}`));
      return;
    }

    spinner.stop();

    // Count total files
    let totalFiles = 0;
    for (const adapter of adapters) {
      const adapterDir = path.join(stagingDir, adapter.name.toLowerCase().replace(/ /g, '-'));
      if (await fs.pathExists(adapterDir)) {
        const countDir = async (dir) => {
          let c = 0;
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const e of entries) {
            if (e.isDirectory()) c += await countDir(path.join(dir, e.name));
            else c++;
          }
          return c;
        };
        totalFiles += await countDir(adapterDir);
      }
    }

    const dest = config.provider === 'git' ? config.gitRepo : config.localPath;

    // Success output
    const toolList = found.map(t => chalk.cyan('  ✔ ' + t)).join('\n');
    console.log('\n' + boxen(
      gradient.pastel('  Backed up!  ') + '\n\n' +
      toolList + '\n\n' +
      chalk.white(`${totalFiles} files from ${found.length} tool${found.length !== 1 ? 's' : ''}`) + '\n' +
      chalk.gray(`→ ${dest}`) + '\n\n' +
      chalk.gray('Restore on another machine with: ') + chalk.cyan('memoir restore'),
      { padding: 1, borderStyle: 'round', borderColor: 'green', dimBorder: true }
    ) + '\n');
  } catch (error) {
    spinner.fail(chalk.red('Sync failed: ') + error.message);
  } finally {
    await fs.remove(stagingDir);
  }
}
