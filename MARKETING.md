# memoir Marketing Plan

## Key Metric
Weekly active `memoir_recall` calls. Not installs, not stars, not waitlist. If AI tools are calling memoir_recall regularly, the product is working.

---

## Phase 1: Directory Listings (Week 1)

### 1. awesome-mcp-servers PR
**Repo:** https://github.com/punkpeye/awesome-mcp-servers (or appcypher)
**PR title:** Add Memoir to Development Tools
**Line to add** (alphabetical, between Mastra and Maven):
```
- [Memoir](https://github.com/camgitt/memoir) - Persistent memory for AI coding tools via MCP. Your AI remembers across sessions, tools, and machines
```

### 2. mcp.so Submission
**Submit:** https://github.com/chatmcp/mcpso/issues/new
**Title:** Add Memoir — persistent memory MCP server for AI coding tools
**Body:**

```
## Server Info
- **Name:** memoir-cli
- **Repository:** https://github.com/camgitt/memoir
- **npm:** https://www.npmjs.com/package/memoir-cli
- **Website:** https://memoir.sh
- **Author:** camgitt
- **License:** MIT
- **Language:** JavaScript (ESM)
- **Transport:** stdio

## Description
MCP server that gives AI coding tools persistent memory across sessions. Your AI can search, read, and save memories automatically. Works with Claude Code, Cursor, Windsurf, and any MCP-compatible client.

## MCP Tools
| Tool | Description |
|------|-------------|
| `memoir_recall` | Search across all AI memories |
| `memoir_remember` | Save context for future sessions |
| `memoir_read` | Read a specific memory file |
| `memoir_list` | List all memory files by tool |
| `memoir_status` | Show detected AI tools |
| `memoir_profiles` | Switch work/personal profiles |

## Installation
npm install -g memoir-cli

## Client Setup
Add to ~/.mcp.json:
{ "mcpServers": { "memoir": { "command": "memoir-mcp" } } }

## Tags
memory, mcp, ai-tools, developer-tools, persistent-context, cli, claude, cursor
```

### 3. PulseMCP
**Submit:** https://www.pulsemcp.com/submit
Fill in: name, GitHub URL, npm URL, description.

### 4. Smithery.ai
```bash
npx smithery auth login
npx smithery mcp publish "https://github.com/camgitt/memoir" -n @camgitt/memoir
```

### 5. Official MCP Registry
Requires adding `mcpName` to package.json and using mcp-publisher CLI.
```bash
npx @anthropic/mcp-publisher init
npx @anthropic/mcp-publisher publish
```

---

## Phase 2: Launch Posts (Week 1-2)

### Show HN
See SHOW_HN.md. Post Tuesday or Wednesday 8-10am ET.

### Reddit Posts (1 per sub, spread across 3 days)

**r/ClaudeAI:**
Title: I built an MCP server that gives Claude long-term memory across sessions
Body: "Got tired of re-explaining my project to Claude every conversation. Built an MCP server called memoir that lets Claude search and save memories automatically. Tell it your auth setup once — it remembers next week. Free, open source, MIT licensed. Works with Cursor and 9 other tools too. https://github.com/camgitt/memoir Would love feedback."

**r/cursor:**
Title: MCP server that syncs your project context between Cursor, Claude Code, and other tools
Body: "Built memoir — an MCP server that gives your AI tools shared memory. You explain something in Cursor, and Claude Code knows it too. Also handles migrating your .cursorrules to other tools. Free CLI, MIT licensed. https://github.com/camgitt/memoir"

**r/ChatGPTCoding:**
Title: Open source tool that gives AI coding tools persistent memory (works with 11 tools)
Body: "memoir is an MCP server + CLI that syncs your AI memory across Claude, Cursor, ChatGPT, Gemini, and 7 more tools. Your AI remembers your codebase across sessions. Also backs up all your AI configs and restores them on a new machine in 60 seconds. https://memoir.sh"

---

## Phase 3: Social + Content (Week 2-3)

### X/Twitter Clips
- 15-sec screen recording: memoir_recall in Claude Code
- 15-sec screen recording: memoir migrate from Cursor to Claude
- 15-sec screen recording: memoir restore on a fresh machine
- Post across AlgoThesis + personal accounts

### Blog Post
Title: "How MCP Gives Your AI Tools Persistent Memory"
Target keywords: "MCP memory server", "Claude Code memory", "AI coding context"
Publish on memoir.sh/blog, cross-post to dev.to

---

## Phase 4: First 10 Users (Week 2-3)

### Discord Communities
- Claude Code official Discord
- Cursor community Discord
- AI/ML Discord servers
- Don't promote — ask for feedback: "Building an MCP memory layer, would love testers"

### Direct Outreach
- Find people complaining about AI context loss on Twitter/Reddit
- Reply with genuine help, mention memoir if relevant
- Not spammy — just useful

---

## NOT Doing Yet
- Stripe/payments (need users first)
- Product Hunt (low conversion for CLI tools)
- Teams tier (need solo users first)
- Paid ads (premature)
- Conference talks (too early)

---

## Timeline
| Week | Focus | Goal |
|------|-------|------|
| 1 | Directory listings + Show HN | Listed in 5+ directories, 50+ stars |
| 2 | Reddit + Discord + X clips | 10 active users |
| 3 | Blog post + iterate on feedback | 25 active users, first feature from user feedback |
| 4 | Repeat what worked, double down | 50+ weekly memoir_recall calls |
