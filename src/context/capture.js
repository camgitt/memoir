import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { scanForSecrets, redactSecrets } from '../security/scanner.js';

const home = os.homedir();

/**
 * Find all Claude session files, sorted newest first
 */
export function findClaudeSessions() {
  const projectsDir = path.join(home, '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) return [];

  const sessions = [];
  const scanDir = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(full);
      } else if (entry.name.endsWith('.jsonl') && !entry.name.includes('subagent')) {
        try {
          const stat = fs.statSync(full);
          // Skip files older than 7 days for performance
          if (Date.now() - stat.mtimeMs < 7 * 24 * 60 * 60 * 1000) {
            sessions.push({ path: full, mtime: stat.mtimeMs, size: stat.size });
          }
        } catch {}
      }
    }
  };
  scanDir(projectsDir);
  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions;
}

/**
 * Parse a Claude session file and extract context (with secret redaction)
 * Streams large files instead of loading entirely into memory
 */
export function parseSession(sessionPath, maxSizeMB = 10) {
  const stat = fs.statSync(sessionPath);
  if (stat.size > maxSizeMB * 1024 * 1024) {
    // For large files, only parse the last portion
    const raw = fs.readFileSync(sessionPath, 'utf8');
    const lines = raw.split('\n');
    const lastLines = lines.slice(-500); // Last 500 lines
    return parseLines(lastLines);
  }

  const raw = fs.readFileSync(sessionPath, 'utf8').trim();
  return parseLines(raw.split('\n'));
}

function parseLines(lines) {
  const result = {
    sessionId: null,
    slug: null,
    gitBranch: null,
    cwd: null,
    firstTimestamp: null,
    lastTimestamp: null,
    userMessages: [],
    filesWritten: new Set(),
    filesRead: new Set(),
    bashCommands: [],
    errors: [],
    decisions: [],
  };

  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    if (!result.sessionId && obj.sessionId) result.sessionId = obj.sessionId;
    if (!result.slug && obj.slug) result.slug = obj.slug;
    if (!result.gitBranch && obj.gitBranch) result.gitBranch = obj.gitBranch;
    if (!result.cwd && obj.cwd) result.cwd = obj.cwd;
    if (!result.firstTimestamp && obj.timestamp) result.firstTimestamp = obj.timestamp;
    if (obj.timestamp) result.lastTimestamp = obj.timestamp;

    // User messages — redact secrets
    if (obj.type === 'user' && obj.message?.content) {
      const content = typeof obj.message.content === 'string' ? obj.message.content : '';
      if (content.length > 3 && !content.startsWith('<task-notification>')) {
        result.userMessages.push(redactSecrets(content));
      }
    }

    // Tool uses from assistant
    if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
      for (const block of obj.message.content) {
        if (block.type !== 'tool_use') continue;
        const name = block.name;
        const input = block.input || {};

        if (name === 'Write' || name === 'Edit') {
          const fp = input.file_path || '';
          if (fp && !fp.startsWith('/tmp/') && !fp.startsWith('/private/tmp/')) {
            result.filesWritten.add(fp);
          }
        } else if (name === 'Read') {
          const fp = input.file_path || '';
          if (fp && !fp.startsWith('/tmp/') && !fp.startsWith('/private/tmp/')) {
            result.filesRead.add(fp);
          }
        } else if (name === 'Bash') {
          const cmd = (input.command || '').trim();
          if (cmd && !cmd.startsWith('sleep') && !cmd.startsWith('cat /private/tmp')) {
            // Redact secrets from commands
            const clean = redactSecrets(cmd.length > 120 ? cmd.slice(0, 120) + '...' : cmd);
            result.bashCommands.push(clean);
          }
        }
      }
    }

    // Errors from tool results
    if (obj.type === 'tool_result' && obj.message?.content) {
      const content = typeof obj.message.content === 'string' ? obj.message.content : '';
      if (content.includes('Error') || content.includes('error') || content.includes('FAIL')) {
        const errorLine = content.split('\n').find(l => /error|fail/i.test(l));
        if (errorLine && errorLine.length < 200) {
          result.errors.push(redactSecrets(errorLine.trim()));
        }
      }
    }
  }

  result.filesWritten = [...result.filesWritten];
  result.filesRead = [...result.filesRead];
  result.errors = [...new Set(result.errors)].slice(0, 10);

  return result;
}

/**
 * Generate a concise handoff markdown from parsed session
 * This is what gets injected into the AI tool on the other machine
 */
export function generateContextHandoff(parsed) {
  const now = new Date();
  const hostname = os.hostname();
  const platform = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux';
  const cwd = parsed.cwd || home;

  // Duration
  let duration = 'unknown';
  if (parsed.firstTimestamp && parsed.lastTimestamp) {
    const ms = new Date(parsed.lastTimestamp) - new Date(parsed.firstTimestamp);
    const mins = Math.floor(ms / 60000);
    duration = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
  }

  // Shorten paths
  const shorten = (fp) => {
    if (fp.startsWith(cwd + '/')) return fp.slice(cwd.length + 1);
    if (fp.startsWith(cwd + '\\')) return fp.slice(cwd.length + 1);
    if (fp.startsWith(home + '/')) return '~/' + fp.slice(home.length + 1);
    if (fp.startsWith(home + '\\')) return '~\\' + fp.slice(home.length + 1);
    return fp;
  };

  // Filter meaningful user messages
  const meaningful = parsed.userMessages
    .filter(m => m.length > 10 && !/^(ok|yes|no|sure|yea|yeah|yep|nah|nope|thanks|ty|thx|good|great|nice|cool|done|hmm)$/i.test(m.trim()))
    .map(m => m.length > 150 ? m.slice(0, 150) + '...' : m);

  // Build a concise, actionable handoff
  let md = `---
name: Session Handoff
description: Coding session context — resume on any machine, any AI tool
type: project
---

# Continue where I left off

> Handed off from **${hostname}** (${platform}) on ${now.toISOString().split('T')[0]} at ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
> Session: ${duration} | Branch: \`${parsed.gitBranch || 'unknown'}\` | Project: \`${cwd}\`

## What I was working on
${meaningful.length > 0 ? meaningful.slice(0, 8).map(m => `- ${m}`).join('\n') : '_No significant messages captured_'}

## Files I changed
${parsed.filesWritten.length > 0
    ? parsed.filesWritten.slice(0, 15).map(f => `- \`${shorten(f)}\``).join('\n')
    : '_None_'}
`;

  // Only show referenced files that weren't also modified
  const readOnly = parsed.filesRead.filter(f => !parsed.filesWritten.includes(f));
  if (readOnly.length > 0) {
    md += `\n## Files I was looking at\n${readOnly.slice(0, 10).map(f => `- \`${shorten(f)}\``).join('\n')}\n`;
  }

  if (parsed.errors.length > 0) {
    md += `\n## Issues I ran into\n${parsed.errors.slice(0, 5).map(e => `- ${e}`).join('\n')}\n`;
  }

  if (parsed.filesWritten.length > 0) {
    md += `\n## Pick up here\nStart by reviewing: ${parsed.filesWritten.slice(0, 3).map(f => '`' + shorten(f) + '`').join(', ')}. ${parsed.filesWritten.length} files were modified in total.\n`;
  }

  return md;
}

/**
 * Check if a project path should be ignored based on .memoirignore
 */
export function shouldIgnoreProject(projectPath) {
  // Check for .memoirignore in home dir
  const ignoreFile = path.join(home, '.memoirignore');
  if (!fs.existsSync(ignoreFile)) return false;

  const patterns = fs.readFileSync(ignoreFile, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));

  const projectName = path.basename(projectPath);
  const projectFull = projectPath.toLowerCase();

  for (const pattern of patterns) {
    const p = pattern.toLowerCase();
    // Exact match on project name
    if (projectName.toLowerCase() === p) return true;
    // Path contains pattern
    if (projectFull.includes(p)) return true;
    // Glob-like: pattern ends with *
    if (p.endsWith('*') && projectFull.startsWith(p.slice(0, -1))) return true;
  }

  return false;
}
