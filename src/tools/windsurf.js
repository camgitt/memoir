import fs from 'fs';
import path from 'path';

const cwd = process.cwd();

export default {
  key: 'windsurf',
  name: 'Windsurf',
  icon: '🏄',
  format: 'Plain text or markdown rules in .windsurfrules. Contains coding conventions, style preferences, and project-specific instructions for Windsurf AI.',

  discover() {
    const files = [];
    const projectFile = path.join(cwd, '.windsurfrules');
    if (fs.existsSync(projectFile)) {
      files.push({ filePath: projectFile, content: fs.readFileSync(projectFile, 'utf-8'), scope: 'project' });
    }
    return files;
  },

  targetPath() {
    return path.join(cwd, '.windsurfrules');
  }
};
