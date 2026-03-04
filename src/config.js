import fs from 'fs-extra';
import path from 'path';
import os from 'os';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'ai-sync');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export async function getConfig() {
  if (await fs.pathExists(CONFIG_FILE)) {
    return fs.readJson(CONFIG_FILE);
  }
  return null;
}

export async function saveConfig(config) {
  await fs.ensureDir(CONFIG_DIR);
  await fs.writeJson(CONFIG_FILE, config, { spaces: 2 });
}
