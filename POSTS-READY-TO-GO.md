# Ready-to-Post Social Media — Copy & Paste Now

Post these THIS WEEK. Don't wait for perfection.

---

## 1. Reddit r/programming — POST TODAY

**URL:** https://www.reddit.com/r/programming/submit

**Title:** I built a CLI that syncs your AI coding memory across 11 tools and every device

**Body:**

Every AI coding tool stores your preferences in its own hidden config files. Claude has `~/.claude/` and `CLAUDE.md`. Cursor has `.cursorrules`. Gemini has `GEMINI.md`. None of them talk to each other, and none of them sync between machines.

I got tired of re-teaching my AI tools every time I switched from my Mac to my PC, so I built **memoir** — a CLI that backs up, restores, and translates your AI memory across devices and tools.

**What it does:**

- `memoir push` — backs up AI configs, project knowledge, and your current coding session
- `memoir restore` — restores everything on any machine (Mac, Windows, Linux)
- `memoir migrate --from claude --to cursor` — AI-powered translation between tools (rewrites conventions, doesn't just copy files)
- `memoir mcp` — MCP server so your editor can search/save memories in-conversation

**What makes it interesting:**

It doesn't just sync config files. It captures *session state* — what files you changed, what decisions you made, what you were debugging — and injects that context when you restore. Your AI literally picks up where you left off.

It also syncs your actual workspace: git repos are auto-cloned, non-git projects are bundled and unpacked, uncommitted changes are saved as patches.

E2E encrypted (AES-256-GCM), secret scanning built in, MIT licensed.

```
npm install -g memoir-cli
```

GitHub: https://github.com/camgitt/memoir
Website: https://memoir.sh

Would love to hear what workflows people would find useful. Currently thinking about shareable context links for team onboarding.

---

## 2. Reddit r/cursor — POST TOMORROW

**URL:** https://www.reddit.com/r/cursor/submit

**Title:** Sync your .cursorrules and AI context across machines (and 10 other AI tools)

**Body:**

Quick question for multi-machine Cursor users — how are you keeping your `.cursorrules` and settings in sync across devices?

I built **memoir** because I kept losing my AI context switching between machines. It's a CLI that syncs Cursor configs alongside 10 other AI tools — Claude Code, Gemini CLI, ChatGPT, Codex, Copilot, Windsurf, Zed, Cline, Continue.dev, and Aider. 11 tools total.

The part that's been most useful for me:

```
memoir migrate --from claude --to cursor
```

This uses AI to actually *translate* your Claude CLAUDE.md into a proper `.cursorrules` that follows Cursor's conventions. Not a file copy — a real rewrite.

It also captures your current coding session and lets you resume on another machine. Your AI picks up mid-conversation.

```
npm install -g memoir-cli
memoir init
memoir push     # backs up .cursorrules + settings + projects
memoir restore  # restores everything on another machine
```

E2E encrypted, MIT licensed, free tier available.

GitHub: https://github.com/camgitt/memoir

What other Cursor-specific workflows would be useful? Happy to add things.

---

## 3. Reddit r/ClaudeAI — POST DAY AFTER

**URL:** https://www.reddit.com/r/ClaudeAI/submit

**Title:** Built a CLI to sync your CLAUDE.md and Claude Code memory across machines

**Body:**

For those of you using Claude Code on multiple machines — how are you keeping your CLAUDE.md files and ~/.claude/ settings in sync?

I built **memoir** to solve this. It's a CLI that backs up and restores your Claude Code memory (plus 10 other AI tools) across any machine.

```
memoir push      # backs up ~/.claude/, CLAUDE.md files, session state, projects
memoir restore   # restores everything on another machine
```

The part I find most useful: **session handoff**. memoir captures what you were working on — files changed, errors hit, decisions made — and injects that context when you restore. Claude literally picks up where you left off on a different machine.

It also does AI-powered translation if you use multiple tools:

```
memoir migrate --from claude --to cursor
# Rewrites your CLAUDE.md into proper .cursorrules
```

And it ships an MCP server (`memoir mcp`) with 6 tools your editor can use to search and save memories in-conversation.

E2E encrypted, secret scanning built in, MIT licensed, ~100kb installed.

```
npm install -g memoir-cli
```

GitHub: https://github.com/camgitt/memoir
Website: https://memoir.sh

Would love feedback from the Claude community. What would make this more useful for your workflow?

---

## 4. X/Twitter Thread — POST SAME DAY AS REDDIT

Copy each tweet as a separate post in a thread:

**Tweet 1:**
AI tools forget you every time you switch machines.

I built memoir — a CLI that syncs your AI memory across 11 tools and every device.

One command to save. One command to restore. Your AI picks up mid-conversation.

Here's what it does:

**Tweet 2:**
The problem: Claude has CLAUDE.md. Cursor has .cursorrules. Gemini has GEMINI.md.

None of them sync. None of them talk to each other.

Switch machines? Start from zero. Switch tools? Re-teach everything.

memoir fixes this.

**Tweet 3:**
memoir push      # save everything
memoir restore   # restore anywhere

It syncs three layers:
- AI memory (configs across 11 tools)
- Session state (what you were doing)
- Workspace (your actual projects)

**Tweet 4:**
The killer feature: AI-powered translation between tools.

memoir migrate --from claude --to cursor

This doesn't just copy files. It rewrites your Claude instructions into proper .cursorrules following Cursor's conventions.

Works between all 11 tools.

**Tweet 5:**
Session handoff is the other thing nothing else does.

memoir captures what files you changed, what decisions you made, what you were debugging.

On restore, it injects that context. Your AI literally picks up where you left off.

**Tweet 6:**
npm install -g memoir-cli

Free & open source. MIT licensed. ~100kb.

Cloud sync available. MCP server included so your editor can search memories in-conversation.

GitHub: github.com/camgitt/memoir
Website: memoir.sh

Try it and let me know what you think

---

## 5. Cold DM Template (for devs tweeting about AI context loss)

**Search Twitter for:** "lost my cursorrules" OR "claude forgot" OR "new machine setup" OR "re-teaching AI" OR "CLAUDE.md sync"

**DM template:**

Hey! Saw your tweet about [specific pain point]. I built an open-source CLI called memoir that solves exactly this — it syncs your AI memory (CLAUDE.md, .cursorrules, etc.) across machines and tools.

One command to back up, one to restore. Your AI picks up mid-conversation.

github.com/camgitt/memoir

Would love your feedback if you try it!

---

## Posting Schedule

| Day | Platform | Post |
|-----|----------|------|
| Today (Thu) | r/programming | Post #1 |
| Today (Thu) | X/Twitter | Thread (Post #4) |
| Friday | r/cursor | Post #2 |
| Friday | r/ClaudeAI | Post #3 |
| Sat-Sun | X/Twitter | Cold DMs to 10-20 devs |

## Rules
1. Reply to EVERY comment within 2 hours
2. Don't be defensive about "it's just dotfiles" — explain session handoff
3. Ask questions back: "What tools are you using?"
4. Link the demo SVG/GIF in early replies
5. Ask 2-3 friends to upvote within first 30 min
