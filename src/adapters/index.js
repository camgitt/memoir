import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import chalk from 'chalk';

const home = os.homedir();

export const adapters = [
  {
    name: 'gemini',
    source: path.join(home, '.gemini'),
    // Only copy safe configuration and memory, ignore tokens/cache
    filter: (src) => {
      const basename = path.basename(src);
      const ignored = ['.git', 'oauth_creds.json', 'google_accounts.json', 'tmp', 'history'];
      return !ignored.includes(basename);
    }
  },
  {
    name: 'claude',
    source: path.join(home, '.claude'),
    filter: (src) => {
      // Just an example, Claude CLI doesn't exist standardly like Gemini yet, 
      // but this shows the structure for any AI bot.
      const basename = path.basename(src);
      return !basename.endsWith('.key') && basename !== '.env';
    }
  }
];

export async function extractMemories(stagingDir) {
  let foundAny = false;
  
  for (const adapter of adapters) {
    if (await fs.pathExists(adapter.source)) {
      console.log(`🔍 Found ${chalk.cyan(adapter.name)} memory...`);
      const dest = path.join(stagingDir, adapter.name);
      await fs.ensureDir(dest);
      await fs.copy(adapter.source, dest, { filter: adapter.filter });
      foundAny = true;
    }
  }
  
  return foundAny;
}
