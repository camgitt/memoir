import fs from 'fs';
import path from 'path';
import os from 'os';

const home = os.homedir();
const cwd = process.cwd();

export default {
  key: 'zed',
  name: 'Zed',
  icon: '🔶',
  format: 'JSON or markdown configuration files for Zed editor. Includes settings.json for editor preferences, keymap.json for keybindings, and tasks.json for task runner configs.',

  discover() {
    const files = [];
    const zedDir = process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Zed')
      : path.join(home, '.config', 'zed');

    if (fs.existsSync(zedDir)) {
      const configFiles = ['settings.json', 'keymap.json', 'tasks.json'];
      for (const file of configFiles) {
        const filePath = path.join(zedDir, file);
        if (fs.existsSync(filePath)) {
          files.push({ filePath, content: fs.readFileSync(filePath, 'utf-8'), scope: 'user' });
        }
      }
      // Also discover .md files in root
      try {
        const entries = fs.readdirSync(zedDir);
        for (const entry of entries) {
          if (entry.endsWith('.md')) {
            const filePath = path.join(zedDir, entry);
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
    const zedDir = process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Zed')
      : path.join(home, '.config', 'zed');
    return path.join(zedDir, 'settings.json');
  }
};
