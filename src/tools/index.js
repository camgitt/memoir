import claude from './claude.js';
import gemini from './gemini.js';
import codex from './codex.js';
import cursor from './cursor.js';
import copilot from './copilot.js';
import windsurf from './windsurf.js';
import zed from './zed.js';
import cline from './cline.js';
import continuedev from './continuedev.js';
import aider from './aider.js';

const registry = {};
for (const tool of [claude, gemini, codex, cursor, copilot, windsurf, zed, cline, continuedev, aider]) {
  registry[tool.key] = tool;
}

export function getProfile(key) {
  return registry[key] || null;
}

export function getProfileKeys() {
  return Object.keys(registry);
}

export function getProfileChoices() {
  return Object.values(registry).map(t => ({ name: t.name, value: t.key }));
}

export { registry as profiles };
