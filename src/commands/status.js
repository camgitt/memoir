import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import { getConfig } from '../config.js';
import { adapters } from '../adapters/index.js';

export async function statusCommand() {
  const config = await getConfig();

  console.log();

  // Config status
  if (config) {
    const provider = config.provider === 'git' ? `Git (${config.gitRepo})` : `Local (${config.localPath})`;
    console.log(chalk.green('✔ Configured') + chalk.gray(` — ${provider}`));
  } else {
    console.log(chalk.red('✖ Not configured') + chalk.gray(' — run memoir init'));
    console.log();
    return;
  }

  console.log();

  // Detected tools
  console.log(chalk.bold('Detected AI tools:\n'));

  let detected = 0;
  for (const adapter of adapters) {
    if (adapter.customExtract) {
      let hasFiles = false;
      for (const file of adapter.files) {
        if (await fs.pathExists(path.join(adapter.source, file))) {
          hasFiles = true;
          break;
        }
      }
      if (hasFiles) {
        console.log(chalk.green('  ✔ ') + adapter.name);
        detected++;
      } else {
        console.log(chalk.gray('  ○ ') + chalk.gray(adapter.name + ' — not found'));
      }
    } else {
      if (await fs.pathExists(adapter.source)) {
        console.log(chalk.green('  ✔ ') + adapter.name);
        detected++;
      } else {
        console.log(chalk.gray('  ○ ') + chalk.gray(adapter.name + ' — not found'));
      }
    }
  }

  console.log();
  console.log(chalk.white(`${detected} tool${detected !== 1 ? 's' : ''} detected on this machine.`));
  console.log();
}
