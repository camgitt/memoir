import fs from 'fs-extra';
import path from 'path';
import os from 'os';

const CONFIG_DIR = process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'memoir')
  : path.join(os.homedir(), '.config', 'memoir');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export async function getConfig() {
  if (await fs.pathExists(CONFIG_FILE)) {
    try {
      return await fs.readJson(CONFIG_FILE);
    } catch {
      return null;
    }
  }
  return null;
}

export async function saveConfig(config) {
  await fs.ensureDir(CONFIG_DIR);
  await fs.writeJson(CONFIG_FILE, config, { spaces: 2 });
  // Restrict permissions — config may contain API keys
  if (process.platform !== 'win32') {
    await fs.chmod(CONFIG_FILE, 0o600);
  }
}

export async function getGeminiApiKey() {
  const config = await getConfig();
  return config?.geminiApiKey || process.env.GEMINI_API_KEY || null;
}

export async function saveGeminiApiKey(apiKey) {
  const config = await getConfig() || {};
  config.geminiApiKey = apiKey;
  await saveConfig(config);
}
