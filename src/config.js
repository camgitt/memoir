import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

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

// Zero-config auto-setup: detect GitHub user, create repo, save config, return it
export async function autoSetup() {
  // Try gh CLI first, then git config
  let username = '';
  try {
    username = execFileSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    try {
      username = execFileSync('git', ['config', '--global', 'user.name'], { encoding: 'utf8' }).trim();
    } catch {}
  }

  if (!username) return null; // Can't auto-setup without a username

  const repo = 'ai-memory';
  const gitRepo = `https://github.com/${username}/${repo}.git`;

  // Try to create the repo if it doesn't exist (best-effort)
  try {
    execFileSync('gh', ['repo', 'view', `${username}/${repo}`], { stdio: 'ignore', timeout: 5000 });
  } catch {
    try {
      execFileSync('gh', ['repo', 'create', `${username}/${repo}`, '--private', '--description', 'AI memory backup (memoir-cli)'], { stdio: 'ignore', timeout: 10000 });
    } catch {
      // If gh isn't available, user will need to create repo manually — that's fine, syncToGit will handle it
    }
  }

  const config = {
    version: 2,
    activeProfile: 'default',
    profiles: {
      default: {
        provider: 'git',
        gitRepo,
        encrypt: false // Skip encryption for zero-config — user can enable later with `memoir encrypt`
      }
    }
  };

  await saveConfig(config);
  return config.profiles.default;
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
