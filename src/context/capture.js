import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { scanForSecrets, redactSecrets } from '../security/scanner.js';

const home = os.homedir();

// Terminal colour codes leak into transcripts through <local-command-stdout>
// blocks (a `/model` switch prints "\x1b[2m…"). Strip before anything is
// persisted — a handoff is read by a human and a model, not a terminal.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
export function stripAnsi(s) {
  return String(s || '').replace(ANSI_RE, '');
}

// Claude Code delivers its own machinery as `user` turns: <command-name> /
// <command-args> / <local-command-stdout> around slash commands, the
// <local-command-caveat> (isMeta) that precedes them, <task-notification>s
// from background agents, hook output. A person's message never starts
// with an XML-ish tag; these always do. Live proof: the author's 2026-09-04
// handoff listed "/model", its caveat and its ANSI-coloured stdout as the
// three things he "was working on".
const MACHINERY_RE = /^\s*<[a-z][\w-]*(?:\s[^>]*)?>/i;
export function isMachineryMessage(s) {
  return MACHINERY_RE.test(String(s || ''));
}

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
        // Skip Claude Code's per-session side directories. `subagents/`
        // holds agent-*.jsonl transcripts whose FIRST user message is the
        // orchestrator's prompt ("You are a software architect. Note that
        // ...") — the filename check below never caught them (the file is
        // agent-<id>.jsonl, not *subagent*), so USER_NOTE_RE minted
        // decisions out of system prompts. Live proof: three of the
        // author's own pinned decisions were subagent-prompt fragments.
        if (entry.name === 'subagents' || entry.name === 'workflows' || entry.name === 'tool-results') continue;
        scanDir(full);
      } else if (entry.name.endsWith('.jsonl') && !entry.name.includes('subagent') && !entry.name.startsWith('agent-')) {
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

    // User messages — redact secrets. Skip the tool's own machinery (see
    // isMachineryMessage) and isMeta turns; strip terminal colour codes.
    if (obj.type === 'user' && obj.message?.content && !obj.isMeta) {
      const content = typeof obj.message.content === 'string' ? stripAnsi(obj.message.content) : '';
      if (content.length > 3 && !isMachineryMessage(content)) {
        result.userMessages.push(redactSecrets(content));
      }
      // Tool results ride inside USER turns as tool_result blocks (there is
      // no top-level type:"tool_result" in a Claude transcript — the old
      // branch that looked for one never matched, so "Issues I ran into"
      // was always empty). Only blocks the tool flagged is_error count,
      // and only when they carry a line that names the failure — a bare
      // "Exit code 1" from a grep with no matches is not an issue.
      if (Array.isArray(obj.message.content)) {
        for (const block of obj.message.content) {
          if (!block || block.type !== 'tool_result' || !block.is_error) continue;
          const text = typeof block.content === 'string'
            ? block.content
            : (Array.isArray(block.content) ? block.content.map((c) => c?.text || '').join('\n') : '');
          const line = stripAnsi(text).split('\n').map((l) => l.trim())
            .find((l) => l && l.length < 200 && /error|fail|exception|cannot|not found|denied|refused|traceback|fatal|unexpected/i.test(l));
          if (line) result.errors.push(redactSecrets(line));
        }
      }
    }

    // Tool uses from assistant turns. Assistant PROSE is deliberately not
    // collected: it used to feed extractDecisions, so the model's own
    // "let's use Redis for caching" minted a decision the user never made
    // (agent-memory-atlas issue #7, and two content-free rows in the
    // author's store on 2026-09-04). Decisions come from the user's words
    // or from explicit memoir_note / `memoir note` — never inferred from
    // what the assistant said.
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

  }

  result.filesWritten = [...result.filesWritten];
  result.filesRead = [...result.filesRead];
  result.errors = [...new Set(result.errors)].slice(0, 10);

  // Extract decisions from the user's messages only (see above).
  result.decisions = extractDecisions(result.userMessages);

  return result;
}

// Reject conversational fragments that loose regexes sometimes capture as
// "decisions" — questions, and clauses starting with a pronoun/filler word
// ("we pick this back up Monday", "it up at...", "some lenders may...").
function looksLikeFragment(v) {
  if (!v) return true;
  if (/\?/.test(v)) return true;
  if (/^(it|this|that|these|those|we|i|they|you|he|she|some|there|here|just|back|now|also)\b/i.test(v)) return true;
  return false;
}

// Quality gate for auto-extracted decisions before they're written to EITHER
// persistence sink (session-decisions.md via persistDecisions, or session.json
// via addNote — see push.js, which now runs this once over parsed.decisions
// before both call sites). Auto-extraction is regex-based and occasionally
// produces prose fragments, markdown-table cells, or truncated pasted-spec
// snippets — this rejects the shapes that look like junk rather than a real
// decision.
//
// 2026-07: two real junk decisions made it into a live session.json because
// the user-note regex (see extractDecisions below) matched mid-paragraph
// inside long pasted spec/prompt text, and one of them was a hard 150-char
// truncation with an unbalanced closing paren. The regex is now anchored to
// message/line start (see below), which independently prevents both from
// matching at all — these two extra checks are defense-in-depth for the
// other, unanchored pattern branches (rename/tech/design/stack) that can
// still match mid-message.
export function isQuality(text) {
  if (!text) return false;
  if (text.length < 15) return false;                // too short to be a real decision
  if (text.length > 200) return false;                // probably a snippet, not a decision
  if (/\|/.test(text)) return false;                  // markdown table fragment
  if (/[_*`]{3,}/.test(text)) return false;           // markdown formatting leaked in
  if (!/[a-zA-Z]/.test(text)) return false;           // no actual words
  if (looksLikeFragment(text)) return false;          // question, or pronoun/filler-start fragment
  const words = text.split(/\s+/).length;
  if (words < 3) return false;                        // less than 3 words isn't a decision

  // Unbalanced parens/brackets — a hallmark of a regex capture that got cut
  // off mid-parenthetical (real junk: "...only gain is Y)" with no opener,
  // because the opening "(" was in the text BEFORE the capture started).
  const opens = (text.match(/[(\[]/g) || []).length;
  const closes = (text.match(/[)\]]/g) || []).length;
  if (opens !== closes) return false;

  // Suspiciously long AND doesn't end in sentence-ending punctuation or a
  // closing quote — another truncation signature (a capture cut off mid-word
  // or mid-sentence by a regex length cap rather than ending naturally).
  if (text.length >= 140 && !/[.!?"')\]]$/.test(text)) return false;

  return true;
}

/**
 * Extract durable decisions from session conversation.
 * These are things like renames, tech choices, preferences — stuff that should persist.
 */
function extractDecisions(userMessages) {
  const decisions = [];
  const allText = userMessages.join('\n');

  // Patterns that indicate a decision was made
  const patterns = [
    // Renames / naming
    { regex: /(?:rename|call|name)\s+(?:it|this|the (?:project|app|tool|product))\s+(?:to\s+)?["']?([A-Z][a-zA-Z0-9_-]+)["']?/gi, type: 'rename' },
    { regex: /(?:the\s+)?(?:new\s+)?name\s+(?:is|will be|should be)\s+["']?([A-Z][a-zA-Z0-9_-]+)["']?/gi, type: 'rename' },
    { regex: /(?:rebrand|rebranding)\s+(?:to|as)\s+["']?([A-Z][a-zA-Z0-9_-]+)["']?/gi, type: 'rename' },
    // Tech choices
    { regex: /(?:let'?s|we(?:'ll| will| should)?|going to|decided to)\s+use\s+([A-Z][a-zA-Z0-9_./-]+)\s+(?:for|instead|as|to)/gi, type: 'tech' },
    { regex: /(?:switch|migrate|move)\s+(?:from\s+\S+\s+)?to\s+([A-Z][a-zA-Z0-9_./-]+)/gi, type: 'tech' },
    // Architecture / design — require an explicit decision verb and a capitalized
    // target. Bare "pick/choose" caught conversational fragments as decisions.
    // 'going' dropped from the bare alternation: "going on Monday to the
    // office" minted a decision (live proof: "going on PostDash" in the real
    // store). "going to go with/use" is still covered by the to-clause.
    { regex: /(?:decided|settled|chose|chosen)\s+(?:to\s+(?:go\s+with|use)|with|on)\s+([A-Z][\w .\/+-]{3,50}?)(?:\.|$|,|\n)/g, type: 'design' },
    { regex: /going\s+to\s+(?:go\s+with|use)\s+([A-Z][\w .\/+-]{3,50}?)(?:\.|$|,|\n)/g, type: 'design' },
    // Stack choices — require a capitalized, tech-looking value, not a prose
    // fragment ("backend is just throwing it away" used to leak through).
    { regex: /(?:stack|framework|database|backend|frontend|hosting|infra)\s+(?:is|will be|should be)\s+([A-Z][\w .\/+-]{2,40}?)(?:\.|$|,|\n)/g, type: 'stack' },
  ];

  for (const { regex, type } of patterns) {
    let match;
    while ((match = regex.exec(allText)) !== null) {
      const value = match[1].trim().replace(/["']+$/, '');
      if (looksLikeFragment(value)) continue;
      // The keyword half of the rename/tech patterns is case-insensitive
      // (`i` flag) but the captured TARGET must be a proper noun — a product,
      // a library, a name. Without this check the flag also lower-cased the
      // [A-Z] anchor: "the name is settled" minted the value "settled" and
      // "rename the app from …" minted "from" (both real rows, 2026-09-04).
      if (!/^[A-Z]/.test(value)) continue;
      if (value.length > 2 && value.length < 80) {
        // Avoid duplicates
        const existing = decisions.find(d => d.value.toLowerCase() === value.toLowerCase());
        if (!existing) {
          decisions.push({ type, value, context: match[0].trim().slice(0, 120) });
        }
      }
    }
  }

  // Look for explicit "remember this" instructions from the user.
  //
  // Anchored to message/line start ((?:^|\n) immediately before optional
  // indentation and an optional "please") — unlike the pattern branches
  // above, this used to match ANYWHERE in the message, which meant a phrase
  // like "note that" or "keep in mind that" appearing mid-sentence inside a
  // long pasted spec/prompt got misread as an explicit remember-instruction.
  // Requiring it to start the message (or a line within it) means only a
  // genuine top-of-message instruction matches, not incidental prose deep in
  // pasted content.
  //
  // Only scanned within the first ~500 chars of the message: a short
  // "Remember that X." followed by a long paste in the SAME turn must still
  // be captured (the instruction is still at message start), but a trigger
  // phrase that only occurs later/mid-document in a long paste is excluded
  // — it was never an instruction to begin with.
  const USER_NOTE_RE = /(?:^|\n)[ \t]*(?:please\s+)?(?:remember (?:that|this)|note that|keep in mind that|from now on)[:\s]+(.{10,150})/i;
  for (const msg of userMessages) {
    const scope = msg.slice(0, 500);
    const rememberMatch = scope.match(USER_NOTE_RE);
    if (rememberMatch) {
      const capturedRaw = rememberMatch[1];
      // The capture group is capped at 150 chars. Hitting that cap exactly is
      // a truncation signature — real junk in the wild was a parenthetical
      // cut off mid-thought with an unbalanced closing paren. Reject rather
      // than keep a truncated tail.
      const hitCap = capturedRaw.length === 150;
      const value = capturedRaw.trim();
      if (!hitCap && !looksLikeFragment(value)) {
        decisions.push({ type: 'user-note', value, context: msg.slice(0, 120) });
      }
    }
  }

  return decisions.slice(0, 20); // Cap at 20 decisions per session
}

/**
 * Resolve the HOME-level memory dir (~/.claude/projects/<home-key>/memory) —
 * the one that matches the user's home path encoding, not a sub-project.
 * Returns null if none exists. Shared by persistDecisions + lean-memory tidy.
 */
export function resolveHomeMemoryDir(claudeSource) {
  const claudeDir = claudeSource || path.join(home, '.claude');
  const projectsDir = path.join(claudeDir, 'projects');
  // Canonical home-key path ONLY. We deliberately do NOT fall back to "shortest
  // dir that has a memory/ subfolder" — on a shared machine that could silently
  // target a different project's (or teammate's) memory. Callers create the dir
  // if needed; tidy safely no-ops when MEMORY.md is absent.
  const homeKey = process.platform === 'win32'
    ? home.replace(/\\/g, '-').replace(/:/g, '-')
    : '-' + home.replace(/^\//, '').replace(/\//g, '-');
  return path.join(projectsDir, homeKey, 'memory');
}

// Atomic write (sync): write to a pid-scoped tmp file, then rename over the
// target. Matches the tmp-then-rename idiom used elsewhere in this codebase
// (state.js's writeSession, inject.js's injectInto) — prevents a torn/partial
// file if the process crashes mid-write. persistDecisions stays synchronous
// (its one caller in push.js doesn't await it), so this uses the sync
// fs-extra APIs rather than switching the whole call chain to async.
function writeFileAtomicSync(targetPath, content) {
  const tmp = `${targetPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.moveSync(tmp, targetPath, { overwrite: true });
}

/**
 * Write extracted decisions to Claude's persistent memory.
 * This ensures decisions survive across sessions and machines.
 */
export function persistDecisions(decisions, claudeSource) {
  if (!decisions || decisions.length === 0) return 0;

  const memDir = resolveHomeMemoryDir(claudeSource);
  if (!memDir) return 0;
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
    writeFileAtomicSync(decisionsFile, content);
  } else {
    // Append to existing
    writeFileAtomicSync(decisionsFile, existing.trimEnd() + '\n' + section);
  }

  // Ensure MEMORY.md references the decisions file
  if (fs.existsSync(memoryMdPath)) {
    const memoryMd = fs.readFileSync(memoryMdPath, 'utf8');
    if (!memoryMd.includes('session-decisions.md')) {
      const addition = `\n- [Session Decisions](session-decisions.md) — project renames, tech choices, architecture decisions from coding sessions\n`;
      writeFileAtomicSync(memoryMdPath, memoryMd.trimEnd() + addition);
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
 * Files changed in the session's repository according to git: every file in
 * a commit made since the session started, plus the current uncommitted
 * changes. The transcript only knows about Edit/Write tool calls — a session
 * that shipped through Bash heredocs, subagents or `git commit` reports
 * "Files I changed: None" (27 of the author's last 40 handoffs, including a
 * 15-hour session that shipped a product rename). Git is the honest source.
 * Best effort: no repo, no git binary, or a slow repo → [].
 */
export function gitChangedFiles(cwd, sinceIso, { timeoutMs = 4000, cap = 200 } = {}) {
  if (!cwd) return [];
  const run = (args) => execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: timeoutMs,
  });
  let root;
  try { root = run(['rev-parse', '--show-toplevel']).trim(); } catch { return []; }
  if (!root) return [];

  const files = new Set();
  try {
    const args = ['log', '--name-only', '--format=', '--no-merges', '-n', '200'];
    if (sinceIso) args.push(`--since=${sinceIso}`);
    for (const line of run(args).split('\n')) {
      const f = line.trim();
      if (f) files.add(f);
    }
  } catch {}
  try {
    for (const line of run(['status', '--porcelain', '--untracked-files=normal']).split('\n')) {
      if (line.length < 4) continue;
      let f = line.slice(3).trim();
      const arrow = f.indexOf(' -> ');
      if (arrow >= 0) f = f.slice(arrow + 4);
      f = f.replace(/^"|"$/g, '');
      if (f && !f.endsWith('/')) files.add(f);
    }
  } catch {}
  return [...files].slice(0, cap).map((f) => path.join(root, f));
}

/**
 * Merge git's view of what changed into parsed.filesWritten (in place).
 * Called by push/snapshot after parseSession; kept separate so parseSession
 * stays a pure function of the transcript (and stays testable without git).
 */
export function enrichWithGit(parsed) {
  try {
    const fromGit = gitChangedFiles(parsed.cwd, parsed.firstTimestamp);
    if (fromGit.length) {
      parsed.filesWritten = [...new Set([...(parsed.filesWritten || []), ...fromGit])];
      parsed.gitFiles = fromGit.length;
    }
  } catch {}
  return parsed;
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

  // Filter meaningful user messages. The LAST few are what "continue where
  // I left off" needs — the first eight of a fifteen-hour session are stale.
  const meaningful = parsed.userMessages
    .filter(m => m.length > 10 && !isMachineryMessage(m) && !/^(ok|yes|no|sure|yea|yeah|yep|nah|nope|thanks|ty|thx|good|great|nice|cool|done|hmm)$/i.test(m.trim()))
    .map(m => stripAnsi(m).replace(/\s+/g, ' ').trim())
    .map(m => m.length > 150 ? m.slice(0, 150) + '...' : m)
    .slice(-8);

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
${meaningful.length > 0 ? meaningful.map(m => `- ${m}`).join('\n') : '_No significant messages captured_'}

## Files I changed
${parsed.filesWritten.length > 0
    ? parsed.filesWritten.slice(0, 15).map(f => `- \`${shorten(f)}\``).join('\n')
      + (parsed.filesWritten.length > 15 ? `\n- …and ${parsed.filesWritten.length - 15} more` : '')
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
