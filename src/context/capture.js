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
  const TAIL_BYTES = 2 * 1024 * 1024; // Read last 2MB max

  if (stat.size > TAIL_BYTES) {
    // For large files, only read the tail to avoid loading 20MB+ into memory
    const fd = fs.openSync(sessionPath, 'r');
    const buf = Buffer.alloc(TAIL_BYTES);
    fs.readSync(fd, buf, 0, TAIL_BYTES, stat.size - TAIL_BYTES);
    fs.closeSync(fd);
    const raw = buf.toString('utf8');
    // Skip the first (partial) line since we likely cut mid-line
    const lines = raw.split('\n').slice(1);
    return parseLines(lines);
  }

  const raw = fs.readFileSync(sessionPath, 'utf8').trim();
  return parseLines(raw.split('\n'));
}

function parseLines(lines) {
  const assistantTexts = [];
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

    // Tool uses and text from assistant
    if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
      for (const block of obj.message.content) {
        if (block.type === 'text' && block.text) {
          // Capture assistant text for decision extraction (limit size)
          if (block.text.length < 2000) assistantTexts.push(block.text);
          continue;
        }
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

  // Extract decisions from user + assistant messages
  result.decisions = extractDecisions(result.userMessages, assistantTexts);

  return result;
}

/**
 * Extract durable decisions from session conversation.
 * These are things like renames, tech choices, preferences — stuff that should persist.
 */
function extractDecisions(userMessages, assistantTexts) {
  const decisions = [];
  const allText = [...userMessages, ...assistantTexts].join('\n');

  // Patterns that indicate a decision was made
  const patterns = [
    // Renames / naming
    { regex: /(?:rename|call|name)\s+(?:it|this|the (?:project|app|tool|product))\s+(?:to\s+)?["']?([A-Z][a-zA-Z0-9_-]+)["']?/gi, type: 'rename' },
    { regex: /(?:the\s+)?(?:new\s+)?name\s+(?:is|will be|should be)\s+["']?([A-Z][a-zA-Z0-9_-]+)["']?/gi, type: 'rename' },
    { regex: /(?:rebrand|rebranding)\s+(?:to|as)\s+["']?([A-Z][a-zA-Z0-9_-]+)["']?/gi, type: 'rename' },
    // Tech choices
    { regex: /(?:let'?s|we(?:'ll| will| should)?|going to|decided to)\s+use\s+([A-Z][a-zA-Z0-9_./-]+)\s+(?:for|instead|as|to)/gi, type: 'tech' },
    { regex: /(?:switch|migrate|move)\s+(?:from\s+\S+\s+)?to\s+([A-Z][a-zA-Z0-9_./-]+)/gi, type: 'tech' },
    // Architecture / design
    { regex: /(?:let'?s|we(?:'ll| will| should)?)\s+(?:go with|pick|choose)\s+(.{5,60}?)(?:\.|$|,|\n)/gi, type: 'design' },
    // Stack choices
    { regex: /(?:stack|framework|database|backend|frontend)\s+(?:is|will be|should be)\s+(.{5,60}?)(?:\.|$|,|\n)/gi, type: 'stack' },
  ];

  for (const { regex, type } of patterns) {
    let match;
    while ((match = regex.exec(allText)) !== null) {
      const value = match[1].trim().replace(/["']+$/, '');
      if (value.length > 2 && value.length < 80) {
        // Avoid duplicates
        const existing = decisions.find(d => d.value.toLowerCase() === value.toLowerCase());
        if (!existing) {
          decisions.push({ type, value, context: match[0].trim().slice(0, 120) });
        }
      }
    }
  }

  // Look for explicit "remember this" instructions from the user
  for (const msg of userMessages) {
    // Only match when user is clearly asking to remember something
    const rememberMatch = msg.match(/(?:remember (?:that|this)|note that|keep in mind that|from now on)[:\s]+(.{10,150})/i);
    if (rememberMatch) {
      decisions.push({ type: 'user-note', value: rememberMatch[1].trim(), context: msg.slice(0, 120) });
    }
  }

  return decisions.slice(0, 20); // Cap at 20 decisions per session
}

/**
 * Write extracted decisions to Claude's persistent memory.
 * This ensures decisions survive across sessions and machines.
 */
export function persistDecisions(decisions, claudeSource) {
  if (!decisions || decisions.length === 0) return 0;

  const claudeDir = claudeSource || path.join(home, '.claude');
  const projectsDir = path.join(claudeDir, 'projects');
  if (!fs.existsSync(projectsDir)) return 0;

  // Find the HOME-level memory dir (not project-specific)
  // This is the dir that matches the user's home path encoding
  let homeKey;
  if (process.platform === 'win32') {
    homeKey = home.replace(/\\/g, '-').replace(/:/g, '-');
  } else {
    homeKey = '-' + home.replace(/^\//, '').replace(/\//g, '-');
  }

  // Try exact match first, then detect from existing dirs
  let memDir = path.join(projectsDir, homeKey, 'memory');
  if (!fs.existsSync(memDir)) {
    // Fallback: find dirs with memory/ subfolder, pick shortest name (likely home-level)
    const entries = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && fs.existsSync(path.join(projectsDir, e.name, 'memory')));
    if (entries.length === 0) return 0;
    // Shortest dir name is most likely the home key (not a sub-project)
    const homeEntry = entries.sort((a, b) => a.name.length - b.name.length)[0];
    memDir = path.join(projectsDir, homeEntry.name, 'memory');
  }

  fs.mkdirSync(memDir, { recursive: true });
  const decisionsFile = path.join(memDir, 'session-decisions.md');
  const memoryMdPath = path.join(memDir, 'MEMORY.md');

  // Read existing decisions file or create new
  let existing = '';
  if (fs.existsSync(decisionsFile)) {
    existing = fs.readFileSync(decisionsFile, 'utf8');
  }

  // Format new decisions
  const date = new Date().toISOString().split('T')[0];
  const newEntries = decisions.map(d => {
    if (d.type === 'rename') return `- **Renamed:** ${d.context}`;
    if (d.type === 'tech') return `- **Tech choice:** ${d.context}`;
    if (d.type === 'design') return `- **Decision:** ${d.context}`;
    if (d.type === 'stack') return `- **Stack:** ${d.context}`;
    if (d.type === 'user-note') return `- **Note:** ${d.value}`;
    return `- ${d.context}`;
  });

  // Check for duplicates against existing content
  const fresh = newEntries.filter(entry => !existing.includes(entry));
  if (fresh.length === 0) return 0;

  const section = `\n### ${date}\n${fresh.join('\n')}\n`;

  if (!existing) {
    // Create new file with frontmatter
    const content = `---
name: Session Decisions
description: Project decisions extracted from coding sessions — renames, tech choices, architecture
type: project
---

# Decisions from coding sessions
${section}`;
    fs.writeFileSync(decisionsFile, content);
  } else {
    // Append to existing
    fs.writeFileSync(decisionsFile, existing.trimEnd() + '\n' + section);
  }

  // Ensure MEMORY.md references the decisions file
  if (fs.existsSync(memoryMdPath)) {
    const memoryMd = fs.readFileSync(memoryMdPath, 'utf8');
    if (!memoryMd.includes('session-decisions.md')) {
      const addition = `\n- [Session Decisions](session-decisions.md) — project renames, tech choices, architecture decisions from coding sessions\n`;
      fs.writeFileSync(memoryMdPath, memoryMd.trimEnd() + addition);
    }
  }

  return fresh.length;
}

/**
 * Promote memories from project-scoped dirs to the home-level scope.
 * Claude scopes memory per working directory — memories saved in ~/memoir
 * are invisible from ~/btc-trader. This copies important .md files to the
 * home-level scope so they're accessible from ANY directory.
 *
 * Only promotes files with frontmatter type: user or type: project (not ephemeral ones).
 */
export function promoteMemoriesToGlobal() {
  const claudeDir = path.join(home, '.claude');
  const projectsDir = path.join(claudeDir, 'projects');
  if (!fs.existsSync(projectsDir)) return 0;

  // Find the home-level key
  let homeKey;
  if (process.platform === 'win32') {
    homeKey = home.replace(/\\/g, '-').replace(/:/g, '-');
  } else {
    homeKey = '-' + home.replace(/^\//, '').replace(/\//g, '-');
  }

  const homeMemDir = path.join(projectsDir, homeKey, 'memory');
  fs.mkdirSync(homeMemDir, { recursive: true });

  const homeMemoryMdPath = path.join(homeMemDir, 'MEMORY.md');
  let homeMemoryMd = '';
  if (fs.existsSync(homeMemoryMdPath)) {
    homeMemoryMd = fs.readFileSync(homeMemoryMdPath, 'utf8');
  } else {
    homeMemoryMd = '# Project Memory\n';
  }

  let promoted = 0;
  const entries = fs.readdirSync(projectsDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name !== homeKey);

  for (const entry of entries) {
    const memDir = path.join(projectsDir, entry.name, 'memory');
    if (!fs.existsSync(memDir)) continue;

    const files = fs.readdirSync(memDir)
      .filter(f => f.endsWith('.md') && f !== 'MEMORY.md' && f !== 'handoff.md');

    for (const file of files) {
      const destPath = path.join(homeMemDir, file);
      // Skip if already exists in home scope
      if (fs.existsSync(destPath)) continue;

      const content = fs.readFileSync(path.join(memDir, file), 'utf8');

      // Only promote files with type: user or type: project
      const typeMatch = content.match(/^type:\s*(user|project)/m);
      if (!typeMatch) continue;

      // Copy to home scope
      fs.writeFileSync(destPath, content);

      // Add to MEMORY.md if not already referenced
      if (!homeMemoryMd.includes(file)) {
        const nameMatch = content.match(/^name:\s*(.+)/m);
        const descMatch = content.match(/^description:\s*(.+)/m);
        const name = nameMatch ? nameMatch[1].trim() : file.replace('.md', '').replace(/-/g, ' ');
        const desc = descMatch ? descMatch[1].trim() : '';
        homeMemoryMd += `- [${name}](${file})${desc ? ' — ' + desc : ''}\n`;
      }

      promoted++;
    }
  }

  if (promoted > 0) {
    fs.writeFileSync(homeMemoryMdPath, homeMemoryMd);
  }

  return promoted;
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
