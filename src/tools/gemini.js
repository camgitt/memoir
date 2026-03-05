import fs from 'fs';
import path from 'path';
import os from 'os';

const home = os.homedir();
const cwd = process.cwd();

export default {
  key: 'gemini',
  name: 'Gemini',
  icon: '🔵',
  format: 'Markdown instructions in GEMINI.md. Written as direct instructions to Gemini. Supports project context, coding style, preferences, and behavioral rules.',

  discover() {
    const files = [];
    const projectFile = path.join(cwd, 'GEMINI.md');
    if (fs.existsSync(projectFile)) {
      files.push({ filePath: projectFile, content: fs.readFileSync(projectFile, 'utf-8'), scope: 'project' });
    }
    const homeFile = path.join(home, 'GEMINI.md');
    const alreadyFound = files.some(f => path.resolve(f.filePath) === path.resolve(homeFile));
    if (fs.existsSync(homeFile) && !alreadyFound) {
      files.push({ filePath: homeFile, content: fs.readFileSync(homeFile, 'utf-8'), scope: 'user' });
    }
    return files;
  },

  targetPath() {
    return path.join(cwd, 'GEMINI.md');
  }
};
