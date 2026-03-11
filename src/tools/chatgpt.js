import fs from 'fs';
import path from 'path';

const cwd = process.cwd();

export default {
  key: 'chatgpt',
  name: 'ChatGPT',
  icon: '💬',
  format: 'Markdown custom instructions in CHATGPT.md. Written as instructions for ChatGPT — your preferences, coding style, response format, and project context. Paste into ChatGPT\'s Custom Instructions or Memory settings.',

  discover() {
    const files = [];
    const projectFile = path.join(cwd, 'CHATGPT.md');
    if (fs.existsSync(projectFile)) {
      files.push({ filePath: projectFile, content: fs.readFileSync(projectFile, 'utf-8'), scope: 'project' });
    }
    return files;
  },

  targetPath() {
    return path.join(cwd, 'CHATGPT.md');
  }
};
