import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import ora from 'ora';
import boxen from 'boxen';
import gradient from 'gradient-string';
import { getConfig, getGeminiApiKey } from '../config.js';
import { syncToLocal, syncToGit } from '../providers/index.js';

const home = os.homedir();

// Find all Claude session files, sorted newest first
function findClaudeSessions() {
  const projectsDir = path.join(home, '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) return [];

  const sessions = [];
  const scanDir = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(full);
      } else if (entry.name.endsWith('.jsonl') && !entry.name.includes('subagent')) {
        const stat = fs.statSync(full);
        sessions.push({ path: full, mtime: stat.mtimeMs, size: stat.size });
      }
    }
  };
  scanDir(projectsDir);
  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions;
}

// Parse a Claude .jsonl session file
function parseClaudeSession(sessionPath) {
  const raw = fs.readFileSync(sessionPath, 'utf8').trim();
  const lines = raw.split('\n');

  const result = {
    sessionId: null,
    slug: null,
    gitBranch: null,
    cwd: null,
    firstTimestamp: null,
    lastTimestamp: null,
    model: null,
    userMessages: [],
    filesWritten: new Set(),
    filesRead: new Set(),
    bashCommands: [],
    errors: [],
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

    // User messages (skip system/task notifications)
    if (obj.type === 'user' && obj.message?.content) {
      const content = typeof obj.message.content === 'string' ? obj.message.content : '';
      if (content.length > 3 && !content.startsWith('<task-notification>')) {
        result.userMessages.push(content);
      }
    }

    // Tool uses from assistant messages
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
            result.bashCommands.push(cmd.length > 120 ? cmd.slice(0, 120) + '...' : cmd);
          }
        }
      }
    }

    // Capture errors from tool results
    if (obj.type === 'tool_result' && obj.message?.content) {
      const content = typeof obj.message.content === 'string' ? obj.message.content : '';
      if (content.includes('Error') || content.includes('error') || content.includes('FAIL')) {
        const errorLine = content.split('\n').find(l => /error|fail/i.test(l));
        if (errorLine && errorLine.length < 200) {
          result.errors.push(errorLine.trim());
        }
      }
    }
  }

  // Convert sets to arrays
  result.filesWritten = [...result.filesWritten];
  result.filesRead = [...result.filesRead];
  // Deduplicate errors
  result.errors = [...new Set(result.errors)].slice(0, 10);

  return result;
}

// Shorten file paths relative to cwd for readability
function shortenPath(filePath, cwd) {
  if (filePath.startsWith(cwd + '/')) {
    return filePath.slice(cwd.length + 1);
  }
  if (filePath.startsWith(home + '/')) {
    return '~/' + filePath.slice(home.length + 1);
  }
  return filePath;
}

// Format duration between two ISO timestamps
function formatDuration(start, end) {
  const ms = new Date(end) - new Date(start);
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remaining = mins % 60;
  return `${hours}h ${remaining}m`;
}

// Generate handoff markdown from parsed session
function generateHandoff(parsed, options = {}) {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const hostname = os.hostname();
  const platform = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux';
  const duration = formatDuration(parsed.firstTimestamp, parsed.lastTimestamp);
  const cwd = parsed.cwd || home;

  // Build user message summary (filter noise, keep substance)
  const meaningfulMessages = parsed.userMessages
    .filter(m => m.length > 10 && !m.startsWith('ok') && !m.startsWith('yes'))
    .map(m => m.length > 200 ? m.slice(0, 200) + '...' : m);

  // YAML frontmatter
  let md = `---
memoir_version: "2.0"
source_tool: claude
session_id: ${parsed.sessionId || 'unknown'}
session_name: ${parsed.slug || 'unknown'}
timestamp: ${now.toISOString()}
machine: ${hostname} (${platform})
project: ${cwd}
branch: ${parsed.gitBranch || 'unknown'}
duration: ${duration}
files_modified: ${parsed.filesWritten.length}
files_read: ${parsed.filesRead.length}
---

# Session Handoff

**From:** ${hostname} (${platform})
**When:** ${dateStr} ${timeStr}
**Tool:** Claude Code
**Branch:** ${parsed.gitBranch || 'unknown'}
**Duration:** ${duration}
**Project:** ${cwd}

## What was discussed
${meaningfulMessages.map(m => `- ${m}`).join('\n')}

## Files modified
${parsed.filesWritten.length > 0
    ? parsed.filesWritten.map(f => `- \`${shortenPath(f, cwd)}\``).join('\n')
    : '_None_'}

## Files referenced
${parsed.filesRead.length > 0
    ? parsed.filesRead.map(f => `- \`${shortenPath(f, cwd)}\``).join('\n')
    : '_None_'}

## Commands run
${parsed.bashCommands.length > 0
    ? parsed.bashCommands.slice(0, 20).map(c => `- \`${c}\``).join('\n')
    : '_None_'}
`;

  if (parsed.errors.length > 0) {
    md += `\n## Errors encountered\n${parsed.errors.map(e => `- ${e}`).join('\n')}\n`;
  }

  if (options.goal) {
    md += `\n## Goal for next session\n${options.goal}\n`;
  }

  md += `\n## Context for next session\nThis handoff was captured from a Claude Code session on ${platform}. `;
  md += `The session touched ${parsed.filesWritten.length} files and ran ${parsed.bashCommands.length} commands. `;
  if (parsed.filesWritten.length > 0) {
    md += `Key files to review: ${parsed.filesWritten.slice(0, 5).map(f => '`' + shortenPath(f, cwd) + '`').join(', ')}.`;
  }
  md += '\n';

  return md;
}

// Use Gemini API to create a smart summary
async function smartSummarize(parsed, apiKey) {
  const prompt = `You are summarizing a coding session for handoff to another machine. Be concise and actionable.

Session info:
- Duration: ${formatDuration(parsed.firstTimestamp, parsed.lastTimestamp)}
- Branch: ${parsed.gitBranch || 'unknown'}
- Project dir: ${parsed.cwd || 'unknown'}

User messages (what they asked for):
${parsed.userMessages.filter(m => m.length > 10).map(m => `- ${m.slice(0, 200)}`).join('\n')}

Files modified:
${parsed.filesWritten.map(f => `- ${f}`).join('\n')}

Write a structured summary with these exact sections:
## Summary
(2-3 sentences of what was accomplished)

## Key decisions
(Bullet list of important decisions made)

## Current state
(What's done, what's in progress, what's left)

## Next steps
(What should be done next to continue this work)

Keep it under 300 words total. Be specific about file names and features.`;

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 1000, temperature: 0.3 }
    })
  });

  if (!response.ok) {
    throw new Error(`Gemini API error: ${response.status}`);
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
}

export async function snapshotCommand(options = {}) {
  const config = await getConfig();

  console.log();
  const spinner = ora({ text: chalk.gray('Finding latest session...'), spinner: 'dots' }).start();

  // Find sessions
  const sessions = findClaudeSessions();
  if (sessions.length === 0) {
    spinner.fail(chalk.red('No Claude Code sessions found.'));
    return;
  }

  const latest = sessions[0];
  spinner.text = chalk.gray('Parsing session...');

  // Parse the session
  const parsed = parseClaudeSession(latest.path);

  if (parsed.userMessages.length === 0) {
    spinner.fail(chalk.red('Session has no user messages.'));
    return;
  }

  spinner.text = chalk.gray('Generating handoff...');

  // Generate handoff markdown
  let handoff;

  if (options.smart) {
    const apiKey = await getGeminiApiKey();
    if (!apiKey) {
      spinner.warn(chalk.yellow('No Gemini API key found. Using local extraction.'));
      spinner.start();
      handoff = generateHandoff(parsed, options);
    } else {
      spinner.text = chalk.gray('Generating AI-powered summary...');
      try {
        const smartSummary = await smartSummarize(parsed, apiKey);
        // Generate base handoff then inject smart summary
        handoff = generateHandoff(parsed, options);
        if (smartSummary) {
          // Insert smart summary after the frontmatter header
          const insertPoint = handoff.indexOf('## What was discussed');
          handoff = handoff.slice(0, insertPoint) +
            '## AI Summary\n' + smartSummary + '\n\n' +
            handoff.slice(insertPoint);
        }
      } catch (err) {
        spinner.warn(chalk.yellow(`AI summary failed: ${err.message}. Using local extraction.`));
        spinner.start();
        handoff = generateHandoff(parsed, options);
      }
    }
  } else {
    handoff = generateHandoff(parsed, options);
  }

  // Save handoff
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `${timestamp}-claude.md`;

  // If config exists, push to backup
  if (config) {
    const stagingDir = path.join(os.tmpdir(), `memoir-handoff-${Date.now()}`);
    await fs.ensureDir(path.join(stagingDir, 'handoffs'));
    await fs.writeFile(path.join(stagingDir, 'handoffs', filename), handoff);

    spinner.text = chalk.gray('Pushing handoff to backup...');

    try {
      if (config.provider === 'local' || config.provider.includes('local')) {
        await syncToLocal(config, stagingDir, spinner);
      } else if (config.provider === 'git' || config.provider.includes('git')) {
        await syncToGit(config, stagingDir, spinner);
      }
    } catch (err) {
      spinner.warn(chalk.yellow(`Push failed: ${err.message}. Saved locally.`));
    }

    await fs.remove(stagingDir);
  }

  // Also save locally for immediate access
  const localHandoffDir = path.join(home, '.config', 'memoir', 'handoffs');
  await fs.ensureDir(localHandoffDir);
  await fs.writeFile(path.join(localHandoffDir, filename), handoff);

  // Also save as "latest" for easy access
  await fs.writeFile(path.join(localHandoffDir, 'latest.md'), handoff);

  spinner.stop();

  // Display summary
  const duration = formatDuration(parsed.firstTimestamp, parsed.lastTimestamp);
  console.log('\n' + boxen(
    gradient.pastel('  Snapshot captured  ') + '\n\n' +
    chalk.white(`Session: ${parsed.slug || 'unnamed'}`) + '\n' +
    chalk.gray(`Duration: ${duration} | Branch: ${parsed.gitBranch || '?'} | ${parsed.filesWritten.length} files changed`) + '\n\n' +
    chalk.white.bold('Files modified:') + '\n' +
    (parsed.filesWritten.length > 0
      ? parsed.filesWritten.slice(0, 8).map(f => chalk.cyan(`  ${shortenPath(f, parsed.cwd || home)}`)).join('\n')
      : chalk.gray('  None')) +
    (parsed.filesWritten.length > 8 ? chalk.gray(`\n  ...and ${parsed.filesWritten.length - 8} more`) : '') + '\n\n' +
    chalk.white.bold('User requests:') + '\n' +
    parsed.userMessages
      .filter(m => m.length > 10 && !m.startsWith('ok') && !m.startsWith('yes'))
      .slice(0, 5)
      .map(m => chalk.gray(`  "${m.slice(0, 80)}${m.length > 80 ? '...' : ''}"`))
      .join('\n') + '\n\n' +
    chalk.gray(`Saved to: ${localHandoffDir}/${filename}`) +
    (config ? '\n' + chalk.gray(`Pushed to: ${config.provider === 'git' ? config.gitRepo : config.localPath}`) : ''),
    { padding: 1, borderStyle: 'round', borderColor: 'green', dimBorder: true }
  ) + '\n');

  console.log(chalk.gray('  Restore on another machine with: ') + chalk.cyan('memoir resume') + '\n');
}
