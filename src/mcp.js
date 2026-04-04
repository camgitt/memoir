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
import { loadIdentity } from './commands/identity.js';
import { rateSignal, logFailure, logSuccess, getLearnings } from './commands/signal.js';
import { runCouncil } from './commands/council.js';
import { listSkills, getSkill, runSkill, createSkill } from './commands/skill.js';

const home = os.homedir();

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Read all memory files from a tool adapter's source directory
 */
async function readMemoryFiles(adapter) {
  const files = [];

  if (adapter.customExtract) {
    for (const file of adapter.files) {
      const filePath = path.join(adapter.source, file);
      if (await fs.pathExists(filePath)) {
        try {
          const content = await fs.readFile(filePath, 'utf8');
          files.push({ path: file, content, tool: adapter.name });
        } catch {}
      }
    }
    return files;
  }

  if (!(await fs.pathExists(adapter.source))) return files;

  const walk = async (dir, prefix = '') => {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (adapter.filter(fullPath)) {
          await walk(fullPath, relPath);
        }
      } else if (entry.name.endsWith('.md') || entry.name.endsWith('.json') || entry.name.endsWith('.yml') || entry.name.endsWith('.yaml')) {
        if (adapter.filter(fullPath)) {
          try {
            const content = await fs.readFile(fullPath, 'utf8');
            files.push({ path: relPath, content, tool: adapter.name });
          } catch {}
        }
      }
    }
  };

  await walk(adapter.source);
  return files;
}

/**
 * Search across all memory files for a query (case-insensitive keyword match)
 */
async function searchMemories(query) {
  const results = [];
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

  for (const adapter of adapters) {
    const files = await readMemoryFiles(adapter);
    for (const file of files) {
      const lower = file.content.toLowerCase();
      const score = terms.reduce((s, t) => s + (lower.includes(t) ? 1 : 0), 0);
      if (score > 0) {
        results.push({ ...file, score, relevance: score / terms.length });
      }
    }
  }

  // Also search per-project AI config files
  const projectFiles = ['CLAUDE.md', 'GEMINI.md', 'CHATGPT.md', '.cursorrules', '.windsurfrules', '.clinerules'];
  const skipDirs = new Set(['node_modules', '.git', '.next', '.vercel', 'dist', 'build', '__pycache__', '.venv', 'venv', '.cache', 'Library', '.Trash', 'Applications', 'Downloads']);

  const scanProjects = async (dir, depth = 0) => {
    if (depth > 3) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }

    for (const file of projectFiles) {
      const filePath = path.join(dir, file);
      if (await fs.pathExists(filePath)) {
        try {
          const content = await fs.readFile(filePath, 'utf8');
          const lower = content.toLowerCase();
          const score = terms.reduce((s, t) => s + (lower.includes(t) ? 1 : 0), 0);
          if (score > 0) {
            results.push({
              path: `${path.basename(dir)}/${file}`,
              content,
              tool: `Project: ${path.basename(dir)}`,
              score,
              relevance: score / terms.length
            });
          }
        } catch {}
      }
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      if (skipDirs.has(entry.name)) continue;
      await scanProjects(path.join(dir, entry.name), depth + 1);
    }
  };

  await scanProjects(home);

  return results.sort((a, b) => b.score - a.score);
}

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
  version: '4.0.0',
}, {
  capabilities: {
    tools: {},
    resources: {},
  }
});

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
  'Search across all AI tool memories, project configs, and session context for relevant information. Use this to find what you know about a topic, project, or tool.',
  { query: z.string().describe('Search query — keywords or topic to find in memories') },
  async ({ query }) => {
    const results = await searchMemories(query);

    if (results.length === 0) {
      return {
        content: [{ type: 'text', text: `No memories found matching "${query}".` }]
      };
    }

    // Return top 10 results with content
    const top = results.slice(0, 10);
    const output = top.map((r, i) => {
      const preview = r.content.length > 500 ? r.content.slice(0, 500) + '...' : r.content;
      return [
        `── ${i + 1}. ${r.tool} / ${r.path} (relevance: ${Math.round(r.relevance * 100)}%) ──`,
        preview,
      ].join('\n');
    }).join('\n\n');

    return {
      content: [{
        type: 'text',
        text: `Found ${results.length} memories matching "${query}":\n\n${output}`
      }]
    };
  }
);

server.tool(
  'memoir_remember',
  'Save a memory to a specific AI tool\'s memory files. Use this to persist important context, decisions, or facts for future sessions.',
  {
    content: z.string().describe('The memory content to save (markdown format)'),
    filename: z.string().describe('Filename for the memory (e.g. "auth-setup.md", "project-goals.md")'),
    tool: z.string().optional().describe('Which AI tool to save to: "claude", "gemini", "cursor", etc. Defaults to claude.'),
    project: z.string().optional().describe('Project directory path to save a project-level memory (e.g. CLAUDE.md). If provided, saves to that project directory instead of global tool config.'),
  },
  async ({ content, filename, tool, project }) => {
    // Project-level memory
    if (project) {
      const projectDir = project.startsWith('/') ? project : path.join(home, project);
      if (!(await fs.pathExists(projectDir))) {
        return { content: [{ type: 'text', text: `Project directory not found: ${projectDir}` }] };
      }

      // Default to CLAUDE.md for project-level memories
      const targetFile = filename || 'CLAUDE.md';
      const targetPath = path.join(projectDir, targetFile);

      // Append to existing file or create new
      if (await fs.pathExists(targetPath)) {
        const existing = await fs.readFile(targetPath, 'utf8');
        await fs.writeFile(targetPath, existing + '\n\n' + content);
      } else {
        await fs.writeFile(targetPath, content);
      }

      return {
        content: [{ type: 'text', text: `Saved to ${targetPath}` }]
      };
    }

    // Global tool memory
    const toolKey = (tool || 'claude').toLowerCase();

    // Find the right directory for the tool
    let targetDir;
    if (toolKey === 'claude') {
      // Save to Claude's memory system
      const claudeMemDir = path.join(home, '.claude', 'projects', '-Users-' + path.basename(home), 'memory');
      await fs.ensureDir(claudeMemDir);
      targetDir = claudeMemDir;
    } else if (toolKey === 'gemini') {
      targetDir = path.join(home, '.gemini');
    } else if (toolKey === 'cursor') {
      const cursorDir = process.platform === 'win32'
        ? path.join(process.env.APPDATA || '', 'Cursor', 'User', 'rules')
        : path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'rules');
      await fs.ensureDir(cursorDir);
      targetDir = cursorDir;
    } else {
      return { content: [{ type: 'text', text: `Unsupported tool for writing: ${toolKey}. Supported: claude, gemini, cursor` }] };
    }

    if (!filename.endsWith('.md')) filename += '.md';
    const targetPath = path.join(targetDir, filename);
    await fs.writeFile(targetPath, content);

    return {
      content: [{ type: 'text', text: `Memory saved to ${targetPath}` }]
    };
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

    for (const adapter of adapters) {
      if (tool) {
        const key = tool.toLowerCase();
        if (!adapter.name.toLowerCase().includes(key)) continue;
      }

      const files = await readMemoryFiles(adapter);
      for (const f of files) {
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
  },
  async ({ tool, filepath }) => {
    const toolKey = tool.toLowerCase();
    const adapter = adapters.find(a => a.name.toLowerCase().includes(toolKey));

    if (!adapter) {
      return { content: [{ type: 'text', text: `Unknown tool: ${tool}. Available: ${adapters.map(a => a.name).join(', ')}` }] };
    }

    const fullPath = path.join(adapter.source, filepath);

    if (!(await fs.pathExists(fullPath))) {
      return { content: [{ type: 'text', text: `File not found: ${filepath} in ${adapter.name}` }] };
    }

    try {
      const content = await fs.readFile(fullPath, 'utf8');
      return {
        content: [{ type: 'text', text: `── ${adapter.name} / ${filepath} ──\n\n${content}` }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error reading file: ${err.message}` }] };
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

// ── Identity Tool ───────────────────────────────────────────────────────────

server.tool(
  'memoir_identity',
  'Load user\'s identity, goals, projects, and preferences. This tells you who the user is, what they\'re building, their tech stack, current priorities, and how they work. Call this at the start of any session to personalize your assistance.',
  {
    section: z.enum(['mission', 'goals', 'projects', 'preferences', 'challenges', 'ideas', 'all'])
      .optional()
      .default('all')
      .describe('Which identity section to load. Use "all" for complete context.'),
  },
  async ({ section }) => {
    const identity = await loadIdentity(section || 'all');

    if (identity.error) {
      return { content: [{ type: 'text', text: identity.error }] };
    }

    if (section && section !== 'all') {
      return {
        content: [{
          type: 'text',
          text: `── Identity: ${section} ──\n\n${JSON.stringify(identity, null, 2)}`
        }]
      };
    }

    // Format all sections
    const parts = ['── Your Identity ──\n'];
    for (const [key, value] of Object.entries(identity)) {
      if (!value) continue;
      parts.push(`## ${key.charAt(0).toUpperCase() + key.slice(1)}\n${JSON.stringify(value, null, 2)}\n`);
    }

    return {
      content: [{ type: 'text', text: parts.join('\n') }]
    };
  }
);

// ── Council Tool ────────────────────────────────────────────────────────────

server.tool(
  'memoir_council',
  'Run a multi-perspective debate on a decision or question. Returns structured agent perspectives (bull/bear/pragmatist, advocate/critic/auditor, or first-principles) for you to analyze from each viewpoint and synthesize into a recommendation.',
  {
    question: z.string().describe('The question or decision to debate'),
    mode: z.enum(['debate', 'red_team', 'first_principles', 'product'])
      .optional()
      .default('debate')
      .describe('Type of analysis: debate (bull/bear/pragmatist), red_team (advocate/critic/auditor), first_principles (physicist/economist/builder), product (user/builder/investor)'),
    agents: z.array(z.string())
      .optional()
      .describe('Optional: specific agent perspectives to use (e.g., ["bull", "bear", "risk"])'),
  },
  async ({ question, mode, agents }) => {
    const debate = await runCouncil(question, { mode, agents });

    const parts = [
      `── Council ${mode || 'debate'} ──`,
      `Question: ${question}\n`,
    ];

    for (const agent of debate.agents) {
      parts.push(`### ${agent.icon} ${agent.name}`);
      parts.push(`System: ${agent.prompt}\n`);
    }

    parts.push(`## Instructions\n${debate.instructions}`);
    parts.push(`\nAnalyze the question from each agent perspective above. Provide 2-3 paragraphs per agent, then synthesize into a clear recommendation.`);

    return {
      content: [{ type: 'text', text: parts.join('\n') }]
    };
  }
);

// ── Skills Tool ─────────────────────────────────────────────────────────────

server.tool(
  'memoir_skills',
  'Manage and execute reusable workflows (skills). List available skills, run a named skill, or create a new one from a workflow pattern.',
  {
    action: z.enum(['list', 'run', 'create']).describe('What to do: list available skills, run a skill, or create a new one'),
    name: z.string().optional().describe('Skill name (required for run/create)'),
    input: z.string().optional().describe('Input data for running a skill'),
    description: z.string().optional().describe('Description when creating a skill'),
    steps: z.string().optional().describe('Semicolon-separated steps when creating a skill'),
    triggers: z.string().optional().describe('Comma-separated trigger phrases when creating a skill'),
  },
  async ({ action, name, input, description, steps, triggers }) => {
    if (action === 'list') {
      const skills = await listSkills();
      if (skills.length === 0) {
        return { content: [{ type: 'text', text: 'No skills created yet. Use action="create" to create one.' }] };
      }
      const output = skills.map(s => {
        const parts = [`● ${s.name}`];
        if (s.description) parts[0] += ` — ${s.description}`;
        if (s.triggers?.length) parts.push(`  Triggers: ${s.triggers.join(', ')}`);
        if (s.steps?.length) parts.push(`  Steps: ${s.steps.length}`);
        return parts.join('\n');
      }).join('\n\n');
      return { content: [{ type: 'text', text: `── Skills (${skills.length}) ──\n\n${output}` }] };
    }

    if (action === 'run') {
      if (!name) return { content: [{ type: 'text', text: 'Error: "name" is required to run a skill.' }] };
      const result = await runSkill(name, input || '');
      if (result.error) return { content: [{ type: 'text', text: result.error }] };

      const parts = [`── Running Skill: ${result.skill.name} ──\n`];
      if (result.skill.description) parts.push(result.skill.description);
      if (result.input) parts.push(`Input: ${result.input}`);
      if (result.skill.workflow) {
        parts.push('\n## Workflow\n' + result.skill.workflow);
      } else if (result.skill.steps?.length) {
        parts.push('\n## Steps');
        result.skill.steps.forEach((s, i) => parts.push(`${i + 1}. ${s}`));
      }
      parts.push(`\n${result.instructions}`);
      return { content: [{ type: 'text', text: parts.join('\n') }] };
    }

    if (action === 'create') {
      if (!name) return { content: [{ type: 'text', text: 'Error: "name" is required to create a skill.' }] };
      const skill = await createSkill(name, { description, steps, triggers });
      return { content: [{ type: 'text', text: `Skill "${skill.name}" created successfully.\n\n${JSON.stringify(skill, null, 2)}` }] };
    }
  }
);

// ── Signal Tool ─────────────────────────────────────────────────────────────

server.tool(
  'memoir_signal',
  'Rate AI outputs and capture learnings for self-improvement. Rate responses (1-5), log failures or successes, and surface patterns from past signals.',
  {
    action: z.enum(['rate', 'log_failure', 'log_success', 'get_learnings']).describe('What to do'),
    rating: z.number().min(1).max(5).optional().describe('Rating from 1-5 (required for "rate" action)'),
    context: z.string().optional().describe('Context about what was rated or what happened'),
    tags: z.array(z.string()).optional().describe('Tags for categorization (e.g., ["code-review", "security"])'),
  },
  async ({ action, rating, context, tags }) => {
    if (action === 'rate') {
      if (rating == null) return { content: [{ type: 'text', text: 'Error: "rating" (1-5) is required for rate action.' }] };
      const entry = await rateSignal(rating, context || '', tags || []);
      const stars = '★'.repeat(entry.rating) + '☆'.repeat(5 - entry.rating);
      return { content: [{ type: 'text', text: `Rated: ${stars}${context ? `\nContext: ${context}` : ''}` }] };
    }

    if (action === 'log_failure') {
      if (!context) return { content: [{ type: 'text', text: 'Error: "context" is required for log_failure.' }] };
      await logFailure(context, tags || []);
      return { content: [{ type: 'text', text: `Failure logged: ${context}` }] };
    }

    if (action === 'log_success') {
      if (!context) return { content: [{ type: 'text', text: 'Error: "context" is required for log_success.' }] };
      await logSuccess(context, tags || []);
      return { content: [{ type: 'text', text: `Success logged: ${context}` }] };
    }

    if (action === 'get_learnings') {
      const learnings = await getLearnings();
      if (learnings.totalSignals === 0) {
        return { content: [{ type: 'text', text: 'No signals recorded yet. Use rate/log_failure/log_success to start capturing feedback.' }] };
      }

      const parts = [
        `── Signal Learnings ──`,
        `Total signals: ${learnings.totalSignals}`,
        `Average rating: ${learnings.averageRating}/5`,
      ];

      if (learnings.patterns.length > 0) {
        parts.push('\nPatterns by tag:');
        for (const p of learnings.patterns) {
          parts.push(`  ${p.avgRating} avg (${p.count}x) — ${p.tag}`);
        }
      }

      if (learnings.recentFailures.length > 0) {
        parts.push('\nRecent failures:');
        for (const f of learnings.recentFailures) {
          parts.push(`  ✖ ${f.context}`);
        }
      }

      if (learnings.recentSuccesses.length > 0) {
        parts.push('\nRecent successes:');
        for (const s of learnings.recentSuccesses) {
          parts.push(`  ✔ ${s.context}`);
        }
      }

      return { content: [{ type: 'text', text: parts.join('\n') }] };
    }
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
