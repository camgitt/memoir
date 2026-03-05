import fs from 'fs';
import path from 'path';
import os from 'os';

const home = os.homedir();
const cwd = process.cwd();

export default {
  key: 'claude',
  name: 'Claude',
  icon: '🟣',
  format: 'Markdown instructions in CLAUDE.md. Supports sections for project context, coding conventions, tool preferences, and workflow rules. Written as direct instructions to Claude.',

  discover() {
    const files = [];

    const projectFile = path.join(cwd, 'CLAUDE.md');
    if (fs.existsSync(projectFile)) {
      files.push({ filePath: projectFile, content: fs.readFileSync(projectFile, 'utf-8'), scope: 'project' });
    }

    const memoryBase = path.join(home, '.claude', 'projects');
    if (fs.existsSync(memoryBase)) {
      const cwdEncoded = cwd.replace(/\//g, '-');
      const projectDirs = fs.readdirSync(memoryBase).filter(d => {
        if (!fs.statSync(path.join(memoryBase, d)).isDirectory()) return false;
        return d === cwdEncoded || cwdEncoded.startsWith(d) || d.startsWith(cwdEncoded);
      });
      for (const dir of projectDirs) {
        const memoryDir = path.join(memoryBase, dir, 'memory');
        if (fs.existsSync(memoryDir)) {
          const mdFiles = fs.readdirSync(memoryDir).filter(f => f.endsWith('.md'));
          for (const f of mdFiles) {
            const filePath = path.join(memoryDir, f);
            files.push({ filePath, content: fs.readFileSync(filePath, 'utf-8'), scope: 'user' });
          }
        }
        const claudeMd = path.join(memoryBase, dir, 'CLAUDE.md');
        if (fs.existsSync(claudeMd)) {
          files.push({ filePath: claudeMd, content: fs.readFileSync(claudeMd, 'utf-8'), scope: 'user' });
        }
      }
    }

    return files;
  },

  targetPath() {
    return path.join(cwd, 'CLAUDE.md');
  }
};
