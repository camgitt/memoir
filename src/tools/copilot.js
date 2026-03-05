import fs from 'fs';
import path from 'path';

const cwd = process.cwd();

export default {
  key: 'copilot',
  name: 'GitHub Copilot',
  icon: '🐙',
  format: 'Markdown instructions in .github/copilot-instructions.md. Written as instructions for GitHub Copilot. Supports coding style, project context, and language preferences.',

  discover() {
    const files = [];
    const projectFile = path.join(cwd, '.github', 'copilot-instructions.md');
    if (fs.existsSync(projectFile)) {
      files.push({ filePath: projectFile, content: fs.readFileSync(projectFile, 'utf-8'), scope: 'project' });
    }
    return files;
  },

  targetPath() {
    return path.join(cwd, '.github', 'copilot-instructions.md');
  }
};
