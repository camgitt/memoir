<div align="center">

# memoir
**Your AI Remembers Everything. Sync It Everywhere.**

[![npm version](https://img.shields.io/npm/v/memoir-cli.svg?style=flat-square)](https://npmjs.org/package/memoir-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)

*Never lose your AI's context again. Sync and translate your AI memory across every device and tool.*

![memoir demo](demo.gif)

</div>

---

## The Problem

You spend weeks teaching your AI tools how you code — your preferred patterns, project context, coding standards.

Then you switch laptops. Or try a new AI tool. Or want your team on the same page.

All that context is trapped in hidden dotfiles on one machine.

## The Solution

`memoir` extracts, backs up, restores, and **translates** your AI memory across any computer and any tool. One command to save. One command to restore. One command to translate between tools.

```bash
npm install -g memoir-cli
```

### Supported Tools (10)
| Tool | Config synced |
|------|--------------|
| **Claude Code** | `~/.claude/` — settings, projects, memory files |
| **Gemini CLI** | `~/.gemini/` — settings, GEMINI.md |
| **OpenAI Codex** | `~/.codex/` — config, instructions |
| **Cursor** | Settings, keybindings, rules |
| **GitHub Copilot** | Config, settings |
| **Windsurf** | Settings, keybindings, rules |
| **Zed** | Settings, keymap, tasks |
| **Cline** | Settings, rules |
| **Continue.dev** | Config, rules |
| **Aider** | `.aider.conf.yml`, system prompt |

Plus **per-project configs**: automatically finds `CLAUDE.md`, `GEMINI.md`, `.cursorrules`, `AGENTS.md` across all your projects.

---

## Quick Start

### 1. Initialize
```bash
memoir init
# Walks you through setup — GitHub repo or local folder
# Auto-creates a private repo if you have gh CLI
```

### 2. Back up your memory
```bash
memoir push
```

### 3. Restore on a new machine
```bash
memoir restore
```

### 4. Translate between tools
```bash
memoir migrate --from claude --to gemini
# AI-powered translation — not copy-paste, real rewriting
```

---

## All Commands

| Command | What it does |
|---------|-------------|
| `memoir init` | Setup wizard — GitHub or local, upload or download |
| `memoir push` | Back up all AI configs |
| `memoir restore` | Restore on a new machine (non-destructive) |
| `memoir status` | Show detected AI tools |
| `memoir doctor` | Diagnose issues, scan for secrets |
| `memoir view` | Preview what's in your backup |
| `memoir diff` | Show changes since last backup |
| `memoir migrate` | Translate memory between tools via AI |
| `memoir snapshot` | Capture current coding session |
| `memoir resume` | Pick up where you left off |
| `memoir profile` | Manage profiles (personal/work) |
| `memoir update` | Self-update to latest version |

---

## Profiles

Separate personal and work configs — different repos, different tools.

```bash
memoir profile create work      # set up work profile with its own repo
memoir profile create personal  # personal side projects

memoir push --profile work      # sync only work configs
memoir restore --profile personal

memoir profile list             # see all profiles
memoir profile switch work      # change default
```

Each profile can filter which tools to sync, so your personal side project memory never mixes with work.

---

## Common Workflows

### New laptop setup
```bash
# Old machine
memoir push

# New machine
memoir init    # → Download → same GitHub repo
memoir restore # All configs restored in seconds
```

### Translate between tools
```bash
memoir migrate --from claude --to gemini
# Your CLAUDE.md becomes a proper GEMINI.md
```

### Fan out to every tool
```bash
memoir migrate --from claude --to all
# One source of truth, every tool gets its own format
```

### Daily sync
```bash
memoir push      # end of day
memoir restore   # next morning, different machine
```

---

## Security

Memoir **only** syncs config files, instructions, and memory markdown. It never touches credentials, API keys, `.env` files, or auth tokens.

Run `memoir doctor` to see exactly what would be synced and scan for accidental secrets before pushing.

---

## Roadmap

- **Universal format** — write one `MEMOIR.md`, generate all tool-specific configs
- **Cloud sync** — no GitHub needed, encrypted backups
- **Teams** — shared coding standards across your whole team
- **Templates** — community-shared AI tool configs

---

## Contributing

Contributions welcome — especially new tool adapters and migration improvements.

1. Fork the repo
2. Create your branch (`git checkout -b feature/my-feature`)
3. Commit and push
4. Open a PR

## License

MIT
