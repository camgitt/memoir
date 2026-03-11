import fs from 'fs-extra';
import path from 'path';
import os from 'os';

const CONFIG_DIR = process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'memoir')
  : path.join(os.homedir(), '.config', 'memoir');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// Read the raw config file as-is
export async function getRawConfig() {
  if (await fs.pathExists(CONFIG_FILE)) {
    try {
      return await fs.readJson(CONFIG_FILE);
    } catch {
      return null;
    }
  }
  return null;
}

// Get resolved config for a specific profile (or active profile)
// Backwards compatible: v1 flat configs return as-is
export async function getConfig(profileName = null) {
  const raw = await getRawConfig();
  if (!raw) return null;

  // v1 flat config — no profiles, return as-is
  if (!raw.version || raw.version < 2) return raw;

  // v2 — resolve profile
  const name = profileName || raw.activeProfile || 'default';
  const profile = raw.profiles?.[name];
  if (!profile) return null;

  // Merge top-level shared keys into profile
  return { ...profile, geminiApiKey: raw.geminiApiKey };
}

// Save entire raw config
export async function saveConfig(config) {
  await fs.ensureDir(CONFIG_DIR);
  await fs.writeJson(CONFIG_FILE, config, { spaces: 2 });
  if (process.platform !== 'win32') {
    await fs.chmod(CONFIG_FILE, 0o600);
  }
}

// Save config for a specific profile (creates v2 format if needed)
export async function saveProfileConfig(profileName, profileData) {
  let raw = await getRawConfig() || {};
  if (!raw.version || raw.version < 2) {
    raw = migrateConfigToV2(raw);
  }
  raw.profiles[profileName] = profileData;
  await saveConfig(raw);
}

// Migrate v1 flat config to v2 profiles format
export function migrateConfigToV2(flat) {
  const { provider, gitRepo, localPath, geminiApiKey, ...rest } = flat;
  return {
    version: 2,
    activeProfile: 'default',
    geminiApiKey: geminiApiKey || undefined,
    profiles: {
      default: { provider, gitRepo, localPath, ...rest }
    }
  };
}

export async function getActiveProfileName() {
  const raw = await getRawConfig();
  if (!raw || !raw.version || raw.version < 2) return 'default';
  return raw.activeProfile || 'default';
}

export async function listProfiles() {
  const raw = await getRawConfig();
  if (!raw) return [];
  if (!raw.version || raw.version < 2) return ['default'];
  return Object.keys(raw.profiles || {});
}

export async function createProfile(name, profileConfig) {
  let raw = await getRawConfig() || {};
  if (!raw.version || raw.version < 2) {
    raw = migrateConfigToV2(raw);
  }
  raw.profiles[name] = profileConfig;
  await saveConfig(raw);
}

export async function switchProfile(name) {
  let raw = await getRawConfig();
  if (!raw) throw new Error('Not configured. Run memoir init first.');
  if (!raw.version || raw.version < 2) {
    raw = migrateConfigToV2(raw);
  }
  if (!raw.profiles[name]) throw new Error(`Profile "${name}" does not exist.`);
  raw.activeProfile = name;
  await saveConfig(raw);
}

export async function deleteProfile(name) {
  const raw = await getRawConfig();
  if (!raw || !raw.version || raw.version < 2) {
    throw new Error('No profiles configured.');
  }
  if (!raw.profiles[name]) throw new Error(`Profile "${name}" does not exist.`);
  if (raw.activeProfile === name) throw new Error(`Cannot delete the active profile. Switch first with: memoir profile switch <name>`);
  if (Object.keys(raw.profiles).length <= 1) throw new Error('Cannot delete the last profile.');
  delete raw.profiles[name];
  await saveConfig(raw);
}

export async function getGeminiApiKey() {
  const raw = await getRawConfig();
  return raw?.geminiApiKey || process.env.GEMINI_API_KEY || null;
}

export async function saveGeminiApiKey(apiKey) {
  let raw = await getRawConfig() || {};
  raw.geminiApiKey = apiKey;
  await saveConfig(raw);
}
