<div align="center">

# memoir

**Portable memory for every AI coding tool.**

[![npm version](https://img.shields.io/npm/v/memoir-cli.svg?style=flat-square&color=7c6ef0)](https://npmjs.org/package/memoir-cli)
[![npm downloads](https://img.shields.io/npm/dm/memoir-cli.svg?style=flat-square&color=7c6ef0)](https://npmjs.org/package/memoir-cli)
[![GitHub stars](https://img.shields.io/github/stars/camgitt/memoir?style=flat-square&color=7c6ef0)](https://github.com/camgitt/memoir/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)

</div>

```bash
npm install -g memoir-cli
memoir activate
```

Your AI now remembers across sessions, tools, and machines. Works with Claude Code, Cursor, Windsurf, Gemini, Copilot, and 6 more tools.

---

## What it does

memoir is an [MCP server](https://modelcontextprotocol.io) that gives your AI tools persistent memory. Your AI can search, save, and recall context automatically.

```
you: how does auth work in this project?

  memoir_recall("auth setup architecture")
  Found 3 memories matching "auth"

claude: Based on your previous sessions: this project uses JWT auth
  with refresh tokens, the middleware is in src/middleware/auth.ts,
  and you chose Zustand over Redux for auth state (decided March 12).
```

No re-explaining. memoir remembered.

## Setup

### 1. Install

```bash
npm install -g memoir-cli
```

### 2. Add MCP to your AI tool

**Claude Code** — add to `~/.mcp.json`:
```json
{
  "mcpServers": {
    "memoir": { "command": "memoir-mcp" }
  }
}
```

**Cursor** — add to `.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "memoir": { "command": "memoir-mcp" }
  }
}
```

### 3. Activate in your project

```bash
memoir activate
```

That's it. Your AI now has 6 memory tools:

| MCP Tool | What it does |
|----------|-------------|
| `memoir_recall` | Search across all your AI memories |
| `memoir_remember` | Save context for future sessions |
| `memoir_list` | Browse all memory files by tool |
| `memoir_read` | Read a specific memory in full |
| `memoir_status` | See which AI tools are detected |
| `memoir_profiles` | Switch between work/personal |

## Why memoir

Your AI forgets everything between sessions. You re-explain your codebase, your conventions, your decisions — every time.

memoir fixes this by giving your AI a shared memory layer that works across **every tool you use**. Tell Claude something once. Cursor knows it too.

**11 tools supported:** Claude Code, Cursor, Windsurf, Gemini CLI, GitHub Copilot, OpenAI Codex, ChatGPT, Aider, Zed, Cline, Continue.dev

## Sync across machines

```bash
# Back up
memoir push

# Restore on any machine
memoir restore -y
```

Push syncs AI memory, session context, workspace (git repos + uncommitted work), and project configs. E2E encrypted with AES-256-GCM.

## Translate between AI tools

```bash
memoir migrate --from chatgpt --to claude
# AI-powered — rewrites conventions, not copy-paste

memoir migrate --from chatgpt --to all
# Translate to every tool at once
```

## Cloud sync

```bash
memoir login
memoir cloud push      # encrypted cloud backup
memoir cloud restore   # restore from any version
memoir history         # view backup versions
memoir share           # create encrypted shareable link
```

## All Commands

| Command | What it does |
|---------|-------------|
| `memoir activate` | Enable auto-recall in this project |
| `memoir deactivate` | Remove memoir from this project |
| `memoir push` | Back up AI memory + workspace + session |
| `memoir restore` | Restore everything on a new machine |
| `memoir status` | Show detected AI tools |
| `memoir migrate` | Translate memory between tools via AI |
| `memoir snapshot` | Capture current coding session |
| `memoir resume` | Pick up where you left off |
| `memoir encrypt` | Toggle E2E encryption |
| `memoir profile` | Manage profiles (personal/work) |
| `memoir cloud push` | Back up to memoir cloud |
| `memoir cloud restore` | Restore from memoir cloud |
| `memoir share` | Create encrypted shareable link |
| `memoir doctor` | Diagnose issues |
| `memoir diff` | Show changes since last backup |
| `memoir view` | Preview what's in your backup |
| `memoir update` | Self-update to latest version |

## Security

- **E2E encryption** — AES-256-GCM with scrypt key derivation
- **Secret scanning** — API keys, tokens, passwords auto-redacted before sync
- **Local MCP server** — runs on your machine, no data sent externally
- **Zero-knowledge cloud** — encrypted before upload

## Links

- **Website:** [memoir.sh](https://memoir.sh)
- **npm:** [memoir-cli](https://npmjs.org/package/memoir-cli)
- **Issues:** [GitHub Issues](https://github.com/camgitt/memoir/issues)
- **Contributing:** [CONTRIBUTING.md](CONTRIBUTING.md)

MIT Licensed
