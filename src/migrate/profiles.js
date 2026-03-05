import fs from 'fs-extra';
import path from 'path';
import os from 'os';

const home = os.homedir();
const cwd = process.cwd();

const profiles = {
  claude: {
    name: 'Claude',
    format: 'Markdown instructions in CLAUDE.md. Supports sections for project context, coding conventions, tool preferences, and workflow rules. Written as direct instructions to Claude.',
    discover() {
      const files = [];

      // Project-level CLAUDE.md
      const projectFile = path.join(cwd, 'CLAUDE.md');
      if (fs.existsSync(projectFile)) {
        files.push({ filePath: projectFile, content: fs.readFileSync(projectFile, 'utf-8'), scope: 'project' });
      }

      // User-level auto-memory files (scoped to current project)
      const memoryBase = path.join(home, '.claude', 'projects');
      if (fs.existsSync(memoryBase)) {
        // Claude encodes project paths: /Users/foo/bar → -Users-foo-bar
        const cwdEncoded = cwd.replace(/\//g, '-');
        const projectDirs = fs.readdirSync(memoryBase).filter(d => {
          if (!fs.statSync(path.join(memoryBase, d)).isDirectory()) return false;
          // Match exact cwd or cwd is a parent (e.g. -Users-camarthur matches when cwd is /Users/camarthur)
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
          // Also check for CLAUDE.md directly in the project dir
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
  },

  gemini: {
    name: 'Gemini',
    format: 'Markdown instructions in GEMINI.md. Written as direct instructions to Gemini. Supports project context, coding style, preferences, and behavioral rules.',
    discover() {
      const files = [];
      const projectFile = path.join(cwd, 'GEMINI.md');
      if (fs.existsSync(projectFile)) {
        files.push({ filePath: projectFile, content: fs.readFileSync(projectFile, 'utf-8'), scope: 'project' });
      }
      // Check home-level (skip if already found as project file)
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
  },

  codex: {
    name: 'Codex',
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
  },

  cursor: {
    name: 'Cursor',
    format: 'Plain text or markdown rules in .cursorrules. Contains coding conventions, style preferences, and project-specific instructions for Cursor AI.',
    discover() {
      const files = [];
      const projectFile = path.join(cwd, '.cursorrules');
      if (fs.existsSync(projectFile)) {
        files.push({ filePath: projectFile, content: fs.readFileSync(projectFile, 'utf-8'), scope: 'project' });
      }
      return files;
    },
    targetPath() {
      return path.join(cwd, '.cursorrules');
    }
  },

  copilot: {
    name: 'GitHub Copilot',
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
  },

  windsurf: {
    name: 'Windsurf',
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
  },

  aider: {
    name: 'Aider',
    format: 'Markdown system prompt in .aider.system-prompt.md. Contains instructions that get injected into Aider\'s system prompt. Supports coding style, conventions, and project context.',
    discover() {
      const files = [];
      const projectFile = path.join(cwd, '.aider.system-prompt.md');
      if (fs.existsSync(projectFile)) {
        files.push({ filePath: projectFile, content: fs.readFileSync(projectFile, 'utf-8'), scope: 'project' });
      }
      // Also check home dir (skip if already found as project file)
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
  }
};

export function getProfile(key) {
  return profiles[key] || null;
}

export function getProfileKeys() {
  return Object.keys(profiles);
}

export function getProfileChoices() {
  return Object.entries(profiles).map(([key, p]) => ({ name: p.name, value: key }));
}

export { profiles };
