# Ready-to-Post Social Media — Copy & Paste Now

Updated for v3.5.0 (zero-config). Post these THIS WEEK.

---

## 1. Reddit r/ClaudeAI — POST FIRST (biggest audience for this)

**URL:** https://www.reddit.com/r/ClaudeAI/submit

**Title:** I built a CLI that syncs your Claude Code memory across machines — one command, zero setup

**Body:**

For those using Claude Code on multiple machines — how do you keep your CLAUDE.md files and ~/.claude/ settings in sync?

I built **memoir** to solve this. It backs up and restores your Claude Code memory across any machine. Zero config:

```
npx memoir-cli
```

That's it. Auto-detects your GitHub, creates a private repo, backs up everything. No setup wizard, no account creation.

On your other machine:

```
npx memoir-cli restore
```

Done. All your CLAUDE.md files, project memory, ~/.claude/ settings — restored.

**The part I find most useful: session handoff.** Memoir captures what you were working on — files changed, decisions made, errors hit — and injects that context on restore. Claude literally picks up where you left off on a different machine.

It also ships an MCP server with 6 tools so Claude can search and save memories mid-conversation automatically. Your AI calls `memoir_recall` when it needs context from past sessions — you don't do anything manually.

Works with 13 tools total (Cursor, Gemini, Codex, Copilot, Windsurf, etc.) and translates between them:

```
memoir migrate --from claude --to cursor
# Rewrites CLAUDE.md into proper .cursorrules
```

E2E encryption available, secret scanning built in, MIT licensed.

GitHub: https://github.com/camgitt/memoir
Website: https://memoir.sh

Would love feedback from the Claude community. What would make this more useful for your workflow?

---

## 2. Reddit r/cursor — POST SAME DAY OR NEXT

**URL:** https://www.reddit.com/r/cursor/submit

**Title:** Sync your .cursorrules and AI context across machines — zero setup, one command

**Body:**

Quick question for multi-machine Cursor users — how are you keeping your `.cursorrules` in sync across devices?

I built **memoir** because I kept losing my AI context switching between machines. One command, zero config:

```
npx memoir-cli
```

Auto-detects your GitHub, creates a private repo, backs up your .cursorrules alongside 12 other AI tools — Claude Code, Gemini CLI, ChatGPT, Codex, Copilot, Windsurf, Zed, Cline, Continue.dev, and Aider.

The part that's been most useful for me:

```
memoir migrate --from claude --to cursor
```

This uses AI to actually *translate* your Claude CLAUDE.md into a proper `.cursorrules` that follows Cursor's conventions. Not a file copy — a real rewrite.

It also captures your current coding session and lets you resume on another machine. Your AI picks up mid-conversation.

```
npx memoir-cli            # backs up everything
npx memoir-cli restore    # restores on another machine
```

E2E encryption available, MIT licensed, free.

GitHub: https://github.com/camgitt/memoir

What other Cursor-specific workflows would be useful?

---

## 3. Reddit r/ChatGPTCoding — POST DAY 2

**URL:** https://www.reddit.com/r/ChatGPTCoding/submit

**Title:** Your AI forgets you every session. I built a fix — one command, syncs memory across 13 tools

**Body:**

Every AI coding tool stores context in its own hidden files. Claude has CLAUDE.md. Cursor has .cursorrules. Gemini has GEMINI.md. None of them talk to each other, and none sync between machines.

I built **memoir** — a CLI that backs up, restores, and translates your AI memory across devices and tools. Zero config:

```
npx memoir-cli
```

That's the whole setup. It auto-detects your GitHub, creates a private backup repo, and syncs everything.

**What it does:**

- `memoir push` — backs up AI configs, project knowledge, and your current coding session
- `memoir restore` — restores everything on any machine (Mac, Windows, Linux)
- `memoir migrate --from claude --to cursor` — AI-powered translation between tools
- `memoir mcp` — MCP server so your editor can search/save memories in-conversation

**What makes it different from just copying dotfiles:**

It captures *session state* — what files you changed, what decisions you made, what you were debugging — and injects that context when you restore. Your AI literally picks up where you left off.

E2E encrypted, secret scanning built in, MIT licensed.

GitHub: https://github.com/camgitt/memoir
Website: https://memoir.sh

What workflows would you find useful? Currently thinking about shareable context links for team onboarding.

---

## 4. Reddit r/programming — POST DAY 2-3

**URL:** https://www.reddit.com/r/programming/submit

**Title:** I built a CLI that syncs your AI coding memory across 13 tools and every device — zero config

**Body:**

Every AI coding tool stores your preferences in its own hidden config files. Claude has `~/.claude/` and `CLAUDE.md`. Cursor has `.cursorrules`. Gemini has `GEMINI.md`. None of them talk to each other, and none of them sync between machines.

I got tired of re-teaching my AI tools every time I switched from my Mac to my PC, so I built **memoir** — a CLI that backs up, restores, and translates your AI memory across devices and tools.

Zero config — one command:

```
npx memoir-cli
```

Auto-detects your GitHub username, creates a private `ai-memory` repo, scans for installed AI tools, and backs up everything. No wizard, no account, no setup.

**What it does:**

- `memoir push` — backs up AI configs, project knowledge, and your current coding session
- `memoir restore` — restores everything on any machine (Mac, Windows, Linux)
- `memoir migrate --from claude --to cursor` — AI-powered translation between tools (rewrites conventions, doesn't just copy files)
- `memoir mcp` — MCP server so your editor can search/save memories in-conversation

**What makes it interesting:**

It doesn't just sync config files. It captures *session state* — what files you changed, what decisions you made, what you were debugging — and injects that context when you restore. Your AI literally picks up where you left off.

It also syncs your workspace: git repos are auto-cloned, non-git projects are bundled, uncommitted changes saved as patches.

E2E encrypted (AES-256-GCM), secret scanning built in, MIT licensed.

GitHub: https://github.com/camgitt/memoir
Website: https://memoir.sh

Would love to hear what workflows people would find useful.

---

## 5. X/Twitter Thread — POST SAME DAY AS FIRST REDDIT

**Tweet 1:**
AI tools forget you every time you switch machines.

I built memoir — a CLI that syncs your AI memory across 13 tools and every device.

One command. Zero config. Your AI picks up mid-conversation.

npx memoir-cli

Here's what it does 🧵

**Tweet 2:**
The problem: Claude has CLAUDE.md. Cursor has .cursorrules. Gemini has GEMINI.md.

None of them sync. None of them talk to each other.

Switch machines? Start from zero. Switch tools? Re-teach everything.

memoir fixes this with one command.

**Tweet 3:**
npx memoir-cli          # save everything
npx memoir-cli restore  # restore anywhere

Zero config. Auto-detects your GitHub, creates a private repo, backs up.

It syncs three layers:
→ AI memory (configs across 13 tools)
→ Session state (what you were doing)
→ Workspace (your actual projects)

**Tweet 4:**
The killer feature: AI-powered translation between tools.

memoir migrate --from claude --to cursor

This doesn't just copy files. It rewrites your Claude instructions into proper .cursorrules following Cursor's conventions.

Works between all 13 tools.

**Tweet 5:**
Session handoff is the other thing nothing else does.

memoir captures what files you changed, what decisions you made, what you were debugging.

On restore, it injects that context. Your AI literally picks up where you left off.

**Tweet 6:**
npx memoir-cli

Free & open source. MIT licensed.

MCP server included so your editor can search memories in-conversation automatically.

GitHub: github.com/camgitt/memoir
Website: memoir.sh

Try it and let me know what you think 🙏

---

## Posting Schedule

| Day | Platform | Post |
|-----|----------|------|
| Today | r/ClaudeAI | Post #1 — biggest Claude community |
| Today | r/cursor | Post #2 — .cursorrules pain point |
| Today | X/Twitter | Thread (Post #5) |
| Tomorrow | r/ChatGPTCoding | Post #3 |
| Tomorrow | r/programming | Post #4 |

## Rules
1. Reply to EVERY comment within 2 hours
2. Don't be defensive about "it's just dotfiles" — explain session handoff and translation
3. Ask questions back: "What tools are you using?" "How do you sync between machines?"
4. Lead with `npx memoir-cli` in early replies — zero friction
5. Ask 2-3 friends to upvote within first 30 min
