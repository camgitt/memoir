import fs from 'fs';
import path from 'path';
import os from 'os';

const home = os.homedir();
const cwd = process.cwd();

export default {
  key: 'cline',
  name: 'Cline',
  icon: '🤖',
  format: 'Configuration and rules for Cline AI coding assistant. Includes settings for AI behavior and custom rules files for project-specific instructions.',

  discover() {
    const files = [];
    const clineDir = process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev')
      : path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev');

    // Check for .clinerules in project
    const projectFile = path.join(cwd, '.clinerules');
    if (fs.existsSync(projectFile)) {
      files.push({ filePath: projectFile, content: fs.readFileSync(projectFile, 'utf-8'), scope: 'project' });
    }

    // Discover settings and rules from Cline extension storage
    if (fs.existsSync(clineDir)) {
      const scanDir = (dir, scope) => {
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const filePath = path.join(dir, entry.name);
            if (entry.isFile()) {
              files.push({ filePath, content: fs.readFileSync(filePath, 'utf-8'), scope });
            } else if (entry.isDirectory()) {
              scanDir(filePath, scope);
            }
          }
        } catch {}
      };

      const settingsDir = path.join(clineDir, 'settings');
      if (fs.existsSync(settingsDir)) {
        scanDir(settingsDir, 'user');
      }

      const rulesDir = path.join(clineDir, 'rules');
      if (fs.existsSync(rulesDir)) {
        scanDir(rulesDir, 'user');
      }

      // Discover .md files in root
      try {
        const entries = fs.readdirSync(clineDir);
        for (const entry of entries) {
          if (entry.endsWith('.md')) {
            const filePath = path.join(clineDir, entry);
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
    return path.join(cwd, '.clinerules');
  }
};
