#!/usr/bin/env node
/**
 * Memoir MCP Server
 *
 * Exposes memoir's memory management as MCP tools for Claude Code, Cursor, VS Code, etc.
 * Run via: memoir mcp (or directly: node src/mcp.js)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { z } from 'zod';
import { getConfig, listProfiles, getActiveProfileName } from './config.js';
import { adapters } from './adapters/index.js';
import {
  readSession,
  writeSession,
  addGoal,
  addNext,
  completeNext,
  addNote,
  addQuestion,
  getMachineId,
} from './session/state.js';
import { appendEvent } from './events/log.js';
import { renderSession } from './session/render.js';
import { injectInto, detectAvailableTargets } from './session/inject.js';
import { findDecisions } from './commands/why.js';
import { matchDecisions, hideDecision } from './session/state.js';
import { readMemoryFiles, searchMemories, formatRecallResults, withFrontmatterLists } from './memory/search.js';
import { buildResumeBrief, formatResumeBrief } from './session/brief.js';
import { rememberMemory, memoryRoot, forgetStoredMemory, readStoredMemories } from './memory/store.js';
import { memoryFilename, relativeFile, readSafeFile } from './security/files.js';
import { visibleMemory, sessionView } from './memory/scope.js';
import { parseFrontmatter } from './commands/validate.js';
import { capture as track } from './telemetry.js';
import { createRequire } from 'module';

const home = os.homedir();
const { version: VERSION } = createRequire(import.meta.url)('../package.json');

// ── Helpers ──────────────────────────────────────────────────────────────────
// readMemoryFiles / searchMemories live in ./memory/search.js (cached,
// field-weighted, passage-returning) so the CLI's `memoir recall` and tests
// share one implementation with this server.

/**
 * Get list of detected tools with status
 */
async function getDetectedTools() {
  const detected = [];
  for (const adapter of adapters) {
    let found = false;
    if (adapter.customExtract) {
      for (const file of adapter.files) {
        if (await fs.pathExists(path.join(adapter.source, file))) { found = true; break; }
      }
    } else {
      found = await fs.pathExists(adapter.source);
    }
    detected.push({ name: adapter.name, icon: adapter.icon, installed: found });
  }
  return detected;
}

// ── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'memoir',
  version: VERSION,
}, {
  capabilities: {
    tools: {},
    resources: {},
  }
});

// ── Anonymous telemetry (activation signal) ───────────────────────────────────
// Wrap server.tool ONCE so every registered handler emits an anonymous, no-PII
// "mcp_tool_used" event on call — the only place that proves memory was actually
// used (the North Star's activation event). Fire-and-forget; can't block or
// break a tool response. No-op unless a telemetry key is configured.
track('mcp_server_start');
const _registerTool = server.tool.bind(server);
server.tool = (name, ...rest) => {
  const handler = rest[rest.length - 1];
  if (typeof handler === 'function') {
    rest[rest.length - 1] = async (...args) => {
      const started = Date.now();
      let success = false;
      try {
        const result = await handler(...args);
        success = result?.isError !== true;
        return result;
      } finally {
        try { track('mcp_tool_used', { tool: name, success }); } catch {}
        appendEvent('mcp_tool_used', { tool: name, success, ms: Date.now() - started }).catch(() => {});
      }
    };
  }
  return _registerTool(name, ...rest);
};

// ── Tools ────────────────────────────────────────────────────────────────────

server.tool(
  'memoir_status',
  'Show which AI tools are detected on this machine and memoir configuration status',
  {},
  async () => {
    const config = await getConfig();
    const tools = await getDetectedTools();
    const profile = await getActiveProfileName();
    const profiles = await listProfiles();

    const installed = tools.filter(t => t.installed);
    const toolList = installed.map(t => `  ${t.icon} ${t.name}`).join('\n');
    const notInstalled = tools.filter(t => !t.installed).map(t => t.name).join(', ');

    let configStatus;
    if (config) {
      const dest = config.provider === 'git' ? config.gitRepo : config.localPath;
      configStatus = `Connected → ${dest}`;
    } else {
      configStatus = 'Not configured (run: memoir init)';
    }

    return {
      content: [{
        type: 'text',
        text: [
          `Memoir Status`,
          `─────────────`,
          `Config: ${configStatus}`,
          `Profile: ${profile} (${profiles.length} total)`,
          `Encryption: ${config?.encrypt ? 'enabled' : 'disabled'}`,
          ``,
          `Detected AI Tools (${installed.length}):`,
          toolList,
          ``,
          notInstalled.length > 0 ? `Also supports: ${notInstalled}` : '',
        ].filter(Boolean).join('\n')
      }]
    };
  }
);

server.tool(
  'memoir_recall',
  'Search memories and decisions for the current or selected project, including shared memories. Hidden, deleted, superseded, and unrelated project records are excluded. Returns the matched passages (not file headers) from the best files, ranked by how well each file covers all your terms — aliases, names, and descriptions weigh more than body prose. Use this before answering questions about a project, a past decision, or a tool. Use memoir_read to see a whole file.',
  {
    query: z.string().describe('Search query — keywords or topic to find in memories. Multi-word queries rank files that match every word highest.'),
    limit: z.number().int().min(1).max(30).optional().describe('Max results to return (default 10)'),
    project: z.string().optional().describe('Project directory or identity. Defaults to the current working project; shared memories are also included.'),
    budget: z.number().int().min(256).max(16000).optional().describe('Total character budget for returned evidence (default 6000).'),
  },
  async ({ query, limit, project, budget }) => {
    const res = await searchMemories(query, { limit: limit || 10, project, budget });
    return { content: [{ type: 'text', text: formatRecallResults(query, res) }] };
  }
);

server.tool(
  'memoir_remember',
  'Save a durable, project-scoped memory in Memoir. Returns a stable ID and revision. Use this to persist important context, decisions, or facts for future sessions. Give the file frontmatter (type, name, description) and ALWAYS pass aliases — the other names, nicknames, or phrasings someone might search for this under (e.g. a "vertical swipe feed" surface should carry aliases like "tiktok", "reels", "/tape"). Recall weights aliases heaviest; a memory without them can only be found by the exact words it happens to use.',
  {
    content: z.string().describe('The memory content to save (markdown, ideally with --- frontmatter: type, name, description)'),
    filename: z.string().describe('Filename for the memory (e.g. "auth-setup.md", "project-goals.md")'),
    aliases: z.array(z.string()).optional().describe('Other names/phrasings this memory should be findable under. Written into frontmatter `aliases:`. Strongly recommended.'),
    tags: z.array(z.string()).optional().describe('Topic tags. Written into frontmatter `tags:`.'),
    tool: z.string().optional().describe('Originating tool, recorded as provenance. Memory is stored in Memoir and is readable across clients.'),
    scope: z.enum(['project', 'shared']).optional().describe('Default project scope; shared is for deliberately reusable preferences across projects.'),
    project: z.string().optional().describe('Project directory or identity for this memory. Defaults to the working project; does not modify project files.'),
  },
  async ({ content, filename, aliases, tags, tool, project, scope }) => {
    try {
      memoryFilename(filename);
      const saved = await rememberMemory({ content, filename, aliases, tags, tool, project, scope });
      return { content: [{ type: 'text', text: 'Memory saved: ' + saved.id + ' (revision ' + saved.revision + ', project ' + saved.project + '). Read with tool "memoir" and filepath "' + saved.path + '".' }] };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err.message }] };
    }
  }
);

server.tool(
  'memoir_list',
  'List all memory files across all detected AI tools and projects',
  {
    tool: z.string().optional().describe('Filter to a specific tool: "claude", "gemini", "cursor", etc. Leave empty for all.'),
  },
  async ({ tool }) => {
    const allFiles = [];
    if (!tool || tool.toLowerCase() === 'memoir') {
      for (const file of await readStoredMemories()) {
        if (visibleMemory(parseFrontmatter(file.content).fields)) allFiles.push({ tool: 'Memoir', icon: '🧠', path: file.path, size: file.content.length });
      }
    }

    for (const adapter of adapters) {
      if (tool) {
        const key = tool.toLowerCase();
        if (!adapter.name.toLowerCase().includes(key)) continue;
      }

      const files = await readMemoryFiles(adapter);
      for (const f of files) {
        if (!visibleMemory(f)) continue;
        allFiles.push({ tool: adapter.name, icon: adapter.icon, path: f.path, size: f.content.length });
      }
    }

    if (allFiles.length === 0) {
      return { content: [{ type: 'text', text: tool ? `No memory files found for ${tool}.` : 'No memory files found.' }] };
    }

    // Group by tool
    const grouped = {};
    for (const f of allFiles) {
      if (!grouped[f.tool]) grouped[f.tool] = [];
      grouped[f.tool].push(f);
    }

    const output = Object.entries(grouped).map(([toolName, files]) => {
      const icon = files[0]?.icon || '';
      const fileList = files.map(f => {
        const sizeStr = f.size < 1024 ? `${f.size}B` : `${(f.size / 1024).toFixed(1)}KB`;
        return `  ${f.path} (${sizeStr})`;
      }).join('\n');
      return `${icon} ${toolName} (${files.length} files)\n${fileList}`;
    }).join('\n\n');

    return {
      content: [{ type: 'text', text: `Memory files (${allFiles.length} total):\n\n${output}` }]
    };
  }
);

server.tool(
  'memoir_read',
  'Read the full content of a specific memory file',
  {
    tool: z.string().describe('Tool name: "claude", "gemini", "cursor", etc.'),
    filepath: z.string().describe('Relative file path within the tool\'s memory directory'),
    project: z.string().optional().describe('Project directory or identity; defaults to the working project.'),
  },
  async ({ tool, filepath, project }) => {
    try {
      const rel = relativeFile(filepath);
      const toolKey = tool.toLowerCase();
      let root, name;
      if (toolKey === 'memoir') {
        if (!/^[a-f0-9]{64}\.md$/.test(rel)) throw new Error('Use the memory ID returned by remember or recall.');
        root = memoryRoot;
        name = 'Memoir';
      } else {
        const adapter = adapters.find(a => a.name.toLowerCase().includes(toolKey));
        if (!adapter) throw new Error('Unknown memory tool');
        const permitted = adapter.customExtract ? adapter.files.includes(rel) : adapter.filter(path.join(adapter.source, rel));
        if (!permitted) throw new Error('This file is excluded from the memory adapter');
        root = adapter.source;
        name = adapter.name;
      }
      let content = (await readSafeFile(root, rel)).toString('utf8');
      const { fields } = parseFrontmatter(content);
      if (toolKey.includes('claude')) fields.claudeProjectKey = rel.match(/^projects\/([^/]+)\//)?.[1];
      if (!visibleMemory(fields, { project })) throw new Error('This memory is hidden, expired, superseded, or belongs to another project.');
      // Generated session blocks are projections; authoritative decisions are
      // retrieved from state so old projections cannot bypass a deletion.
      content = content.replace(/<!--\s*memoir:session-block[^>]*-->[\s\S]*?<!--\s*\/memoir:session-block\s*-->/g, '');
      return { content: [{ type: 'text', text: '── ' + name + ' / ' + rel + ' ──\n\n' + content }] };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err.message }] };
    }
  }
);

server.tool(
  'memoir_profiles',
  'List and manage memoir profiles (personal, work, etc.)',
  {},
  async () => {
    const profiles = await listProfiles();
    const active = await getActiveProfileName();

    if (profiles.length === 0) {
      return { content: [{ type: 'text', text: 'No profiles configured. Run: memoir init' }] };
    }

    const list = profiles.map(p => `  ${p === active ? '● ' : '  '}${p}${p === active ? ' (active)' : ''}`).join('\n');

    return {
      content: [{
        type: 'text',
        text: `Memoir Profiles:\n\n${list}\n\nSwitch with: memoir profile switch <name>`
      }]
    };
  }
);

server.tool(
  'memoir_consolidate',
  'Analyze all AI tool memories for duplicates, stale files, contradictions, and bloat. Returns a consolidation report with actionable suggestions. Use this to help users keep their AI memory clean.',
  {
    smart: z.boolean().optional().describe('Compatibility option. This MCP tool performs local analysis only; use memoir consolidate --smart in the CLI for external model analysis.'),
  },
  async ({ smart }) => {
    const allFiles = [];
    for (const file of await readStoredMemories()) {
      if (visibleMemory(parseFrontmatter(file.content).fields)) allFiles.push({
        ...file, size: file.content.length, mtime: Date.parse(parseFrontmatter(file.content).fields.updated) || 0,
      });
    }
    for (const adapter of adapters) {
      for (const doc of await readMemoryFiles(adapter)) {
        if (visibleMemory(doc)) allFiles.push({ ...doc, size: doc.content.length, mtime: doc.mtimeMs });
      }
    }

    if (allFiles.length === 0) {
      return { content: [{ type: 'text', text: 'No memory files found across any AI tools.' }] };
    }

    // Heuristic analysis
    const daysAgo = (ms) => Math.floor((Date.now() - ms) / (1000 * 60 * 60 * 24));
    const fingerprint = (c) => c.toLowerCase().replace(/\s+/g, ' ').trim();
    const wordSim = (a, b) => {
      const wA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 3));
      const wB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 3));
      if (!wA.size || !wB.size) return 0;
      let n = 0; for (const w of wA) { if (wB.has(w)) n++; }
      return n / (wA.size + wB.size - n);
    };

    const duplicates = [];
    const stale = [];
    const bloated = [];
    const empty = [];
    const fps = new Map();

    for (const f of allFiles) {
      const fp = fingerprint(f.content);
      if (fp.length < 10) { empty.push(f); continue; }
      if (!fps.has(fp)) fps.set(fp, []);
      fps.get(fp).push(f);
    }
    for (const [, group] of fps) {
      if (group.length > 1) duplicates.push(group.map(f => `${f.tool}/${f.path}`));
    }
    for (const f of allFiles) {
      if (daysAgo(f.mtime) > 60) stale.push({ file: `${f.tool}/${f.path}`, age: daysAgo(f.mtime) });
      if (f.size > 10240) bloated.push({ file: `${f.tool}/${f.path}`, size: f.size });
    }

    let report = `Memoir Consolidation Report\n${'─'.repeat(30)}\nScanned: ${allFiles.length} files\n\n`;

    if (duplicates.length) {
      report += `Duplicates (${duplicates.length}):\n`;
      for (const group of duplicates) report += `  ${group.join(' = ')}\n`;
      report += '\n';
    }
    if (stale.length) {
      report += `Stale — 60+ days (${stale.length}):\n`;
      for (const s of stale.sort((a, b) => b.age - a.age).slice(0, 15)) report += `  ${s.file} (${s.age}d)\n`;
      if (stale.length > 15) report += `  ...and ${stale.length - 15} more\n`;
      report += '\n';
    }
    if (bloated.length) {
      report += `Bloated — over 10KB (${bloated.length}):\n`;
      for (const b of bloated) report += `  ${b.file} (${(b.size / 1024).toFixed(1)}KB)\n`;
      report += '\n';
    }
    if (empty.length) {
      report += `Empty / near-empty (${empty.length}):\n`;
      for (const e of empty) report += `  ${e.tool}/${e.path}\n`;
      report += '\n';
    }
    if (!duplicates.length && !stale.length && !bloated.length && !empty.length) {
      report += 'No issues found. Your memories look clean!\n';
    }

    report += '\nRun `memoir consolidate --apply` in terminal to interactively clean up.';
    if (!smart) report += '\nRun `memoir consolidate --smart` for AI-powered semantic analysis.';

    return { content: [{ type: 'text', text: report }] };
  }
);

// ── Session continuity tools ─────────────────────────────────────────────────
// These let the AI record its own goals, decisions, and next-actions into
// session.json — which is auto-rendered into ~/.claude/CLAUDE.md (and other
// tools in the future) so the next session picks up where this one ended.

async function refreshPinnedBlock() {
  try {
    const state = await readSession();
    const rendered = renderSession(state);
    for (const target of Object.values(detectAvailableTargets())) {
      try { await injectInto(target, rendered); } catch {}
    }
  } catch {
    // Best-effort; don't fail the MCP call
  }
}

server.tool(
  'memoir_set_goal',
  'Set the current goal for this session. Use when the user states what they want to work on, or when a clear focus emerges. Available through the scoped session and resume tools.',
  { text: z.string().describe('The goal, one short sentence') },
  async ({ text }) => {
    const state = await addGoal(text);
    await refreshPinnedBlock();
    const replaced = (state.replacedGoals || []).map((g) => `"${g.text}"`);
    return { content: [{ type: 'text', text: `Goal set: ${text}${replaced.length ? `\nGoals list is full (3) — replaced: ${replaced.join('; ')}. Re-set it with memoir_set_goal if that was wrong.` : ''}` }] };
  }
);

server.tool(
  'memoir_add_next',
  'Add a next action to the current session. Use when the user decides on a concrete next step, or when you finish something and the logical next move is clear. The list holds 8; when it is full the oldest item is PARKED (still shown in the pinned block, still completable), never dropped — the response names anything parked.',
  { text: z.string().describe('The action, one short imperative sentence') },
  async ({ text }) => {
    const state = await addNext(text);
    await refreshPinnedBlock();
    const parked = (state.justParked || []).map((p) => `"${p.text}"`);
    return { content: [{ type: 'text', text: `Next: ${text}${parked.length ? `\nList was full — parked (still open, still in the block): ${parked.join('; ')}` : ''}` }] };
  }
);

server.tool(
  'memoir_complete_next',
  'Mark a next action as complete (removes it from the pinned list, parked items included). Match by substring — pass the relevant keywords, not the whole text.',
  { match: z.string().describe('Substring to match against existing next actions') },
  async ({ match }) => {
    const count = (st) => st.current.next_actions.length + (st.current.parked_actions || []).length;
    const before = await readSession();
    const beforeCount = count(before);
    await completeNext(match);
    const after = await readSession();
    const removed = beforeCount - count(after);
    await refreshPinnedBlock();
    return {
      content: [{
        type: 'text',
        text: removed > 0 ? `Completed ${removed} action(s) matching "${match}"` : `No action matched "${match}"`,
      }],
    };
  }
);

server.tool(
  'memoir_note',
  'Record a decision with optional rationale and rejected alternative. Use when a non-obvious technical or product choice is made — the kind of thing a future session would want to know "why did we do this."',
  {
    text: z.string().describe('The decision, one short sentence (what was decided)'),
    why: z.string().optional().describe('Rationale — why this choice over others'),
    rejected: z.string().optional().describe('The alternative that was considered and rejected'),
  },
  async ({ text, why, rejected }) => {
    await addNote(text, { why, rejected });
    await refreshPinnedBlock();
    const extras = [];
    if (why) extras.push(`why: ${why}`);
    if (rejected) extras.push(`rejected: ${rejected}`);
    return {
      content: [{ type: 'text', text: `Decision recorded: ${text}${extras.length ? ` (${extras.join('; ')})` : ''}` }],
    };
  }
);

server.tool(
  'memoir_ask',
  'Capture an open question for later. Use when the user poses a question you cannot fully answer now, or when an ambiguity surfaces that needs resolution in a future session.',
  { text: z.string().describe('The open question') },
  async ({ text }) => {
    await addQuestion(text);
    await refreshPinnedBlock();
    return { content: [{ type: 'text', text: `Question captured: ${text}` }] };
  }
);

server.tool(
  'memoir_session',
  'Show the current session state — goals, next actions, open questions, recent decisions, recent sessions across machines. Use this to catch up at the start of a session, or when you need to orient yourself on what was decided.',
  {},
  async () => {
    const state = sessionView(await readSession());
    const machine = await getMachineId();
    const goals = state.current.goals.map(g => `- ${g.text}`).join('\n') || '(none)';
    const nexts = state.current.next_actions.map(n => `- [ ] ${n.text}`).join('\n') || '(none)';
    const questions = state.current.open_questions.map(q => `- ${q.text}`).join('\n') || '(none)';
    const decisions = state.current.decisions.filter(d => visibleMemory(d)).slice(0, 5).map(d => {
      let line = `- ${d.text}`;
      if (d.why) line += ` — *${d.why}*`;
      return line;
    }).join('\n') || '(none)';
    const history = state.history.slice(0, 5).map(h => {
      const date = (h.date || '').slice(0, 10);
      const label = state.machines?.[h.machine_id]?.label || '?';
      return `- ${date} ${label}: ${h.summary || '—'}`;
    }).join('\n') || '(none)';
    const machineList = Object.entries(state.machines || {})
      .map(([id, m]) => `- ${m.label} (last seen: ${(m.last_seen || '').slice(0, 10)})`)
      .join('\n') || '(just this one)';

    const text = [
      `# Memoir session`,
      `This machine: ${machine.label}`,
      '',
      '## Current goal',
      goals,
      '',
      '## Next',
      nexts,
      '',
      '## Open questions',
      questions,
      '',
      '## Recent decisions',
      decisions,
      '',
      '## Recent sessions',
      history,
      '',
      '## Machines syncing this session',
      machineList,
    ].join('\n');

    return { content: [{ type: 'text', text }] };
  }
);

server.tool(
  'memoir_why',
  'Look up past decisions by keyword. Returns the decision text, why it was made, and what alternative was rejected. Use when the user asks "why did we do X" or when you need to avoid re-opening a settled question.',
  { query: z.string().describe('Keyword or phrase to search in decision text, rationale, or rejected alternative') },
  async ({ query }) => {
    const state = await readSession();
    // findDecisions() already filters hidden:true (tombstoned) decisions —
    // this second filter is deliberate belt-and-suspenders so this tool
    // handler stays correct even if findDecisions' internals change without
    // that coupling being obvious. Same tombstone semantics as render.js's
    // pinned block and why.js's CLI display: distinct from the live
    // `rejected` field.
    const matches = findDecisions(state, query).filter(d => !d?.hidden);
    if (matches.length === 0) {
      return { content: [{ type: 'text', text: `No decisions match "${query}".` }] };
    }
    const out = matches.map(d => {
      const parts = [`● ${d.text}`];
      if (d.why) parts.push(`  why: ${d.why}`);
      if (d.rejected) parts.push(`  rejected: ${d.rejected}`);
      if (d.date) parts.push(`  (${d.date.slice(0, 10)})`);
      return parts.join('\n');
    }).join('\n\n');
    return { content: [{ type: 'text', text: `${matches.length} decision(s) matching "${query}":\n\n${out}` }] };
  }
);

server.tool(
  'memoir_forget',
  'Forget a recorded decision — permanently hides it from the pinned block, memoir_why, and every synced machine (an absolute tombstone; there is no un-forget). Use when the user says a decision is wrong, obsolete, or was captured by mistake, or when a secret leaked into a decision. Refuses to act if the text matches more than one decision — call again with a more specific string. Pass purge=true to also redact the text in place (for secrets).',
  {
    text: z.string().describe('A canonical memory ID, or decision text/substr uniquely identifying a decision'),
    purge: z.boolean().optional().describe('Also redact the text/why/rejected in place, keeping only a hash. For leaked secrets. Default false.'),
  },
  async ({ text, purge }) => {
    if (/^[a-f0-9]{64}$/.test(text)) {
      try {
        const result = await forgetStoredMemory(text, { purge: !!purge });
        return { content: [{ type: 'text', text: 'Forgotten memory ' + result.id + '. The deletion will sync on push. ' + (purge ? 'Local record and revision history purged; older remote backups and Git history are not erased.' : '') }] };
      } catch (err) { return { isError: true, content: [{ type: 'text', text: err.message }] }; }
    }
    const state = await readSession();
    const matches = matchDecisions(state, text);
    if (matches.length === 0) {
      return { content: [{ type: 'text', text: `No visible decision matches "${text}". Nothing forgotten.` }] };
    }
    if (matches.length > 1) {
      const list = matches.map(d => `● ${d.text}`).join('\n');
      return { content: [{ type: 'text', text: `"${text}" matches ${matches.length} decisions — forgetting is permanent, so nothing was changed. Call again with a string unique to one of:\n\n${list}` }] };
    }
    const res = await hideDecision(matches[0].text, { purge: !!purge });
    if (!res.hidden) {
      return { content: [{ type: 'text', text: `Nothing changed — the decision may already have been forgotten.` }] };
    }
    // Re-render the pinned block so the next session no longer loads it.
    try {
      const rendered = renderSession(res.state);
      for (const target of Object.values(detectAvailableTargets())) {
        try { await injectInto(target, rendered); } catch {}
      }
    } catch {}
    return { content: [{ type: 'text', text: res.purged ? 'Forgotten and purged locally. The tombstone propagates on the next push; historical backups still require removal.' : 'Forgotten. The tombstone propagates on the next push.' }] };
  }
);

server.tool(
  'memoir_resume',
  'Build an actionable handoff for the current project: goal, next actions, decisions with sources, open questions, and checkout drift. Saved observations never imply that current tests pass.',
  { project: z.string().optional().describe('Project directory; defaults to the configured working project.') },
  async ({ project }) => {
    const brief = await buildResumeBrief(project);
    return { content: [{ type: 'text', text: formatResumeBrief(brief) }] };
  }
);

// ── Resources ────────────────────────────────────────────────────────────────

// Expose detected tools as browsable resources
server.resource(
  'detected-tools',
  'memoir://tools',
  { description: 'List of AI tools detected on this machine', mimeType: 'text/plain' },
  async () => {
    const tools = await getDetectedTools();
    const text = tools.map(t => `${t.icon} ${t.name}: ${t.installed ? 'installed' : 'not found'}`).join('\n');
    return { contents: [{ uri: 'memoir://tools', text, mimeType: 'text/plain' }] };
  }
);

// ── Start ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Memoir MCP server error: ${err.message}\n`);
  process.exit(1);
});
