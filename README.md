<div align="center">

# memoir

**Sync AI memory across every tool and every machine — end-to-end encrypted. Free.**

[![npm version](https://img.shields.io/npm/v/memoir-cli.svg?style=flat-square&color=7c6ef0)](https://npmjs.org/package/memoir-cli)
[![npm downloads](https://img.shields.io/npm/dm/memoir-cli.svg?style=flat-square&color=7c6ef0)](https://npmjs.org/package/memoir-cli)
[![GitHub stars](https://img.shields.io/github/stars/camgitt/memoir?style=flat-square&color=7c6ef0)](https://github.com/camgitt/memoir/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)

</div>

```bash
npx memoir-cli
```

One command. No install, no config, no API keys. Claude Code on your Mac, Cursor on your laptop, Copilot at the office — **one memory follows you** across every tool and every machine. Cloud sync is end-to-end encrypted with a key only you hold — memoir's servers can't read what you sync.

---

## What it does

Your coding tools are starting to remember you — Claude Code, Cursor, and Copilot all ship built-in memory now. But that memory is **trapped: one tool, one machine, one vendor's format.** Switch from Cursor to Claude Code, or open a different laptop, and your AI is a stranger again.

memoir is the [MCP memory server](https://modelcontextprotocol.io) that breaks it out. **One memory, shared across every tool and synced to every machine — E2E-encrypted in the cloud, plain readable markdown on your disk.** Your AI searches, saves, and recalls context automatically, everywhere you work.

It's built on an **open, published format** — [the memoir format, v0.1](docs/SPEC.md) — so your AI's accumulated context is never trapped in this tool either. Six entry types, normative merge semantics, JSON Schemas, and a validator (`npx memoir-cli validate`). Any tool can implement it; [critique welcome](https://github.com/camgitt/memoir/issues).

```
you: how does auth work in this project?

  memoir_recall("auth setup architecture")
  Found 3 memories matching "auth"

claude: Based on your previous sessions: this project uses JWT auth
  with refresh tokens, the middleware is in src/middleware/auth.ts,
  and you chose Zustand over Redux for auth state (decided March 12).
```

No re-explaining. memoir remembered.

## How it's different

Native memory and the other memory tools each give you *part* of this. memoir is the only one that gives you all of it:

| | Cross-tool | Cross-machine sync | Zero-knowledge encrypted |
|---|:---:|:---:|:---:|
| **memoir** | ✅ | ✅ **free** | ✅ |
| Claude Code / Cursor native | ❌ one tool | ❌ one machine | ❌ |
| claude-mem | ✅ | ❌ local only | ❌ |
| basic-memory | ✅ | 💲 paid cloud | ❌ |
| mem0 / OpenMemory | ✅ | 💲 paid cloud | ❌ |

Native memory is locked to one tool on one machine. The others keep your memory in plaintext, or put cross-machine sync behind a paywall. memoir is the only one that does all three — every tool, every machine, encrypted under a key only you hold — for free. <sub>(Based on public docs, June 2026.)</sub>

## Quick start

```bash
npx memoir-cli
```

That's it. memoir detects your AI tools, configures MCP, and activates memory. No global install needed.

Your AI gets 14 memory tools:

| MCP Tool | What it does |
|----------|-------------|
| `memoir_recall` | Search across all your AI memories |
| `memoir_remember` | Save context for future sessions |
| `memoir_list` | Browse all memory files by tool |
| `memoir_read` | Read a specific memory in full |
| `memoir_consolidate` | Analyze memories for duplicates, staleness, and bloat |
| `memoir_status` | See which AI tools are detected |
| `memoir_profiles` | Switch between work/personal |
| `memoir_set_goal` | Set the current session goal (pinned into CLAUDE.md) |
| `memoir_add_next` | Add a next action to the current session |
| `memoir_complete_next` | Mark a next action as done |
| `memoir_note` | Record a decision with its rationale |
| `memoir_ask` | Capture an open question for later |
| `memoir_session` | Show goals, next actions, decisions, and recent sessions |
| `memoir_why` | Look up why a past decision was made |

## Why memoir

Your AI forgets everything between sessions. You re-explain your codebase, your conventions, your decisions — every time.

memoir fixes that. Tell Claude something once and Cursor knows it too — your memory syncs between tools, backs up to the cloud, and restores on any machine. When it piles up, `memoir consolidate` cleans house: finds duplicates, flags stale context, and can use AI to merge and prune.

**11 tools supported:** Claude Code, Cursor, Windsurf, Gemini CLI, GitHub Copilot, OpenAI Codex, ChatGPT, Aider, Zed, Cline, Continue.dev.

## Sync across machines

```bash
memoir push       # back up AI memory + workspace + session
memoir restore -y # restore on any machine
```

Push syncs AI memory, cursorrules, session context, workspace (git repos + uncommitted work), and project configs. E2E encrypted with AES-256-GCM.

## Translate between AI tools

```bash
memoir migrate --from chatgpt --to claude
# AI-powered — rewrites conventions, not copy-paste

memoir migrate --from chatgpt --to all
# Translate to every tool at once
```

## Consolidate memories

```bash
memoir consolidate          # scan for duplicates, stale files, bloat
memoir consolidate --smart  # AI-powered analysis (finds contradictions + merge candidates)
memoir consolidate --apply  # interactively clean up
```

Over time, memories pile up across tools. Consolidate finds exact and near-duplicates, flags files untouched for 60+ days, and catches contradictions where you told Claude one thing and Cursor another. With `--smart`, Gemini Flash does a semantic pass and suggests intelligent merges.

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
| `memoir consolidate` | Find duplicates, stale memories, and bloat |
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
