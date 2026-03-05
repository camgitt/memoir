import fs from 'fs';
import path from 'path';

const cwd = process.cwd();

export default {
  key: 'codex',
  name: 'Codex',
  icon: '🟢',
  format: 'Markdown instructions in AGENTS.md. Written as instructions for OpenAI Codex agent. Supports project context, coding conventions, and task guidance.',

  discover() {
    const files = [];
    const projectFile = path.join(cwd, 'AGENTS.md');
    if (fs.existsSync(projectFile)) {
      files.push({ filePath: projectFile, content: fs.readFileSync(projectFile, 'utf-8'), scope: 'project' });
    }
    return files;
  },

  targetPath() {
    return path.join(cwd, 'AGENTS.md');
  }
};
