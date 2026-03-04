// Entry point for the recall library, if used programmatically
export { getConfig, saveConfig } from './config.js';
export { extractMemories } from './adapters/index.js';
export { syncToLocal, syncToGit } from './providers/index.js';
