import fs from 'fs';
import path from 'path';
import os from 'os';

const home = os.homedir();
const cwd = process.cwd();

export default {
  key: 'aider',
  name: 'Aider',
  icon: '🔧',
  format: 'Markdown system prompt in .aider.system-prompt.md. Contains instructions that get injected into Aider\'s system prompt. Supports coding style, conventions, and project context.',

  discover() {
    const files = [];
    const projectFile = path.join(cwd, '.aider.system-prompt.md');
    if (fs.existsSync(projectFile)) {
      files.push({ filePath: projectFile, content: fs.readFileSync(projectFile, 'utf-8'), scope: 'project' });
    }
    const homeFile = path.join(home, '.aider.system-prompt.md');
    const alreadyFound = files.some(f => path.resolve(f.filePath) === path.resolve(homeFile));
    if (fs.existsSync(homeFile) && !alreadyFound) {
      files.push({ filePath: homeFile, content: fs.readFileSync(homeFile, 'utf-8'), scope: 'user' });
    }
    return files;
  },

  targetPath() {
    return path.join(cwd, '.aider.system-prompt.md');
  }
};
