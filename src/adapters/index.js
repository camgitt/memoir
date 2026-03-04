import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import chalk from 'chalk';

const home = os.homedir();

export const adapters = [
  {
    name: 'Gemini CLI',
    source: path.join(home, '.gemini'),
    filter: (src) => {
      const basename = path.basename(src);
      const ignored = ['.git', 'oauth_creds.json', 'google_accounts.json', 'tmp', 'history'];
      return !ignored.includes(basename);
    }
  },
  {
    name: 'Claude CLI',
    source: path.join(home, '.claude'),
    filter: (src) => {
      const basename = path.basename(src);
      return !basename.endsWith('.key') && basename !== '.env';
    }
  }
];

export async function extractMemories(stagingDir, spinner) {
  let foundAny = false;
  
  for (const adapter of adapters) {
    if (await fs.pathExists(adapter.source)) {
      spinner.text = `Found ${chalk.cyan(adapter.name)} memory... copying to staging`;
      const dest = path.join(stagingDir, adapter.name.toLowerCase().replace(' ', '-'));
      await fs.ensureDir(dest);
      await fs.copy(adapter.source, dest, { filter: adapter.filter });
      foundAny = true;
    }
  }
  
  return foundAny;
}
