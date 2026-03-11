import fs from 'fs';
import path from 'path';
import os from 'os';

const home = os.homedir();
const cwd = process.cwd();

export default {
  key: 'continuedev',
  name: 'Continue.dev',
  icon: '🔄',
  format: 'JSON, TypeScript, or YAML configuration for Continue.dev AI assistant. Includes config files for model selection, context providers, and slash commands. Supports .continuerules for project-specific instructions.',

  discover() {
    const files = [];
    const continueDir = process.platform === 'win32'
      ? path.join(process.env.USERPROFILE || home, '.continue')
      : path.join(home, '.continue');

    // Check for .continuerules in project
    const projectFile = path.join(cwd, '.continuerules');
    if (fs.existsSync(projectFile)) {
      files.push({ filePath: projectFile, content: fs.readFileSync(projectFile, 'utf-8'), scope: 'project' });
    }

    if (fs.existsSync(continueDir)) {
      const configFiles = ['config.json', 'config.ts', 'config.yaml', '.continuerules'];
      for (const file of configFiles) {
        const filePath = path.join(continueDir, file);
        if (fs.existsSync(filePath)) {
          files.push({ filePath, content: fs.readFileSync(filePath, 'utf-8'), scope: 'user' });
        }
      }

      // Discover .md files in root
      try {
        const entries = fs.readdirSync(continueDir);
        for (const entry of entries) {
          if (entry.endsWith('.md')) {
            const filePath = path.join(continueDir, entry);
            if (fs.statSync(filePath).isFile()) {
              files.push({ filePath, content: fs.readFileSync(filePath, 'utf-8'), scope: 'user' });
            }
          }
        }
      } catch {}
    }

    return files;
  },

  targetPath() {
    return path.join(cwd, '.continuerules');
  }
};
