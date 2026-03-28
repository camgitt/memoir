# Memoir Launch Posts — Ready to Copy & Paste

---

## 1. Hacker News — Show HN

**Title:** Show HN: Memoir – Sync your AI coding memory across 11 tools and every device

**Text:**

I switch between a Mac and a PC daily. Every time, my Claude Code rules, Gemini instructions, Cursor settings — gone. Trapped in hidden dotfiles on whichever machine I used last.

I built memoir to fix this. It's a CLI that backs up, restores, and syncs your AI memory across devices and tools. It supports 11 tools: Claude Code, Gemini CLI, ChatGPT, OpenAI Codex, Cursor, GitHub Copilot, Windsurf, Zed, Cline, Continue.dev, and Aider.

```
memoir push      # back up everything — AI configs, projects, session state
memoir restore   # restore on any machine — AI picks up mid-conversation
```

What makes it different from dotfile managers:

1. **AI-aware translation.** `memoir migrate --from claude --to cursor` uses AI to rewrite your instructions following each tool's conventions — not just file copy.

2. **Session handoff.** memoir captures what you were doing (files changed, errors hit, decisions made) and injects it on restore so your AI picks up mid-conversation.

3. **Workspace sync.** Git repos are auto-cloned, non-git projects are bundled, and uncommitted changes are saved as patches and reapplied.

4. **MCP server.** `memoir mcp` gives your editor 6 tools to search, read, and save memories without leaving the conversation.

5. **E2E encrypted.** AES-256-GCM. Secret scanning auto-redacts API keys and tokens before sync. Zero-knowledge — we can't read your data.

It syncs three layers no other tool connects: AI memory (configs + instructions), session state (what you were doing), and workspace (your actual projects).

```
npm install -g memoir-cli
```

~100kb installed. MIT licensed. Cloud sync available (free tier: 3 backups). Would love feedback — especially on what workflows you'd want next. Thinking about shareable context links so you can onboard a teammate with one URL.

https://github.com/camgitt/memoir

---

## 2. Reddit — r/programming

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

## 3. Reddit — r/cursor

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

## 4. Reddit — r/neovim

**Title:** memoir — sync your AI coding context (Aider, Cline, Continue.dev) across machines from the terminal

**Body:**

For terminal-first devs using AI tools alongside Neovim — I built a CLI that syncs your AI memory across machines and tools.

If you're using Aider, Cline, or Continue.dev, you've probably got config files and project instructions scattered across `~/.aider.conf.yml`, `.clinerules`, `.continuerules`, etc. memoir backs all of that up and restores it on any machine.

```
memoir push      # backs up AI configs + projects + session state
memoir restore   # restores on any machine
memoir migrate --from aider --to cline  # AI-powered translation
```

It also ships an MCP server (`memoir mcp`) that gives your tools 6 commands to search, read, and save memories without leaving your workflow.

The workspace sync is nice too — git repos auto-clone, non-git projects get bundled, uncommitted changes are saved as patches and reapplied.

Everything's E2E encrypted (AES-256-GCM) with secret scanning. MIT licensed.

```
npm install -g memoir-cli
```

https://github.com/camgitt/memoir

Would love feedback from the terminal crowd. What AI tool integrations would you want to see next?

---

## 5. X/Twitter Launch Thread

**Tweet 1 (hook):**
AI tools forget you every time you switch machines.

I built memoir — a CLI that syncs your AI memory across 11 tools and every device.

One command to save. One command to restore. Your AI picks up mid-conversation.

Here's what it does 🧵

**Tweet 2:**
The problem: Claude has CLAUDE.md. Cursor has .cursorrules. Gemini has GEMINI.md.

None of them sync. None of them talk to each other.

Switch machines? Start from zero. Switch tools? Re-teach everything.

memoir fixes this.

**Tweet 3:**
```
memoir push      # save everything
memoir restore   # restore anywhere
```

It syncs three layers:
→ AI memory (configs across 11 tools)
→ Session state (what you were doing)
→ Workspace (your actual projects)

**Tweet 4:**
The killer feature: AI-powered translation between tools.

```
memoir migrate --from claude --to cursor
```

This doesn't just copy files. It rewrites your Claude instructions into proper .cursorrules following Cursor's conventions.

Works between all 11 tools.

**Tweet 5:**
Session handoff is the other thing nothing else does.

memoir captures what files you changed, what decisions you made, what you were debugging.

On restore, it injects that context. Your AI literally picks up where you left off.

**Tweet 6:**
Security:
→ E2E encrypted (AES-256-GCM)
→ Secret scanning catches API keys, tokens, passwords
→ Auto-redacted before sync
→ Zero-knowledge — we can't read your data

**Tweet 7:**
```
npm install -g memoir-cli
```

Free & open source. MIT licensed. ~100kb.

Cloud sync available. MCP server included so your editor can search memories in-conversation.

GitHub: github.com/camgitt/memoir
Website: memoir.sh

Try it and let me know what you think ↓

---

## Posting Strategy

### Timing
- **Hacker News:** Tuesday or Wednesday, 8-9am ET (peak HN traffic)
- **Reddit r/programming:** Same day as HN, 2-3 hours after
- **Reddit r/cursor:** Day after HN post
- **Reddit r/neovim:** Day after HN post (different audience, won't cannibalize)
- **X/Twitter thread:** Same day as HN, post in the morning, then reply-thread throughout the day

### Engagement Rules
1. **Reply to every comment** within the first 2 hours — HN and Reddit rank by early engagement
2. **Don't be defensive** — if someone says "this is just dotfiles," acknowledge it and explain the session handoff + translation layer
3. **Ask questions back** — "What tools are you using?" and "What would you want synced?" drives comments
4. **Have a demo GIF ready** — link to your demo.gif in early replies
5. **Upvote timing** — ask 2-3 friends to upvote within the first 30 minutes (critical for HN front page)

### Expected Objections & Responses

**"This is just a dotfiles manager"**
→ "Dotfiles managers sync files. memoir syncs AI context — it captures your session state (what you were debugging, what decisions you made) and injects it on restore. It also translates between tools using AI, not file copy. The workspace sync with uncommitted patches is a layer above dotfiles too."

**"Why not just use git?"**
→ "Git syncs code. memoir syncs the AI layer on top of it — your CLAUDE.md, .cursorrules, session context, and tool configs. Plus it handles non-git projects (bundles them), and saves uncommitted work as patches. It's the layer between your code and your AI."

**"I don't use multiple machines"**
→ "Fair — but do you use multiple AI tools? `memoir migrate` translates your context between them. And the MCP server is useful on a single machine for searching across all your AI memories."

**"Security concerns with syncing AI configs"**
→ "E2E encrypted before it leaves your machine (AES-256-GCM). Built-in secret scanner catches API keys, tokens, passwords — auto-redacted. Zero-knowledge architecture. Run `memoir doctor` to see exactly what gets synced."
