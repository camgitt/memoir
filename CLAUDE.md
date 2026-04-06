# memoir — Persistent Memory for AI Coding Tools

## Project
- **Package:** memoir-cli (npm), v3.3.1
- **Website:** memoir.sh (static HTML on Vercel)
- **Repo:** https://github.com/camgitt/memoir
- **License:** MIT
- **Stack:** Node.js CLI + Supabase (auth, storage, PostgreSQL)

## What it does
CLI + MCP server that gives AI tools persistent memory. Your AI can search, read, and save memories across sessions, tools, and machines. Supports 11 tools: Claude Code, Cursor, Windsurf, Gemini, Copilot, Codex, ChatGPT, Aider, Zed, Cline, Continue.dev.

## Architecture
- **CLI commands:** push, restore, snapshot, resume, migrate, diff, profiles, doctor, share, upgrade, login, signup, forgot-password
- **MCP server:** 6 tools (memoir_remember, memoir_recall, memoir_read, memoir_list, memoir_profiles, memoir_status)
- **Cloud sync:** Supabase auth (email/password), gzipped bundles in Storage, PostgreSQL metadata
- **Encryption:** AES-256-GCM, async scrypt, client-side before upload (zero-knowledge)
- **Tiers:** Free (3 cloud backups), Pro (50, $15/mo — not yet purchasable), Teams (planned)

## Key files
- `bin/memoir.js` — CLI entry point
- `src/` — core logic (sync, auth, encryption, mcp server)
- `GAMEPLAN.md` — business plan and roadmap

## Supabase
- **Project:** oqrkxytbahfwjhcbyzrx
- **Tables:** profiles, backups, waitlist, subscriptions
- **Storage:** memoir-backups bucket

## Landing site
- Separate repo: memoir-landing (Vercel)
- Static HTML in public/
- Has pricing page, waitlist (Supabase), SEO, OG image, blog posts

## Current status
- Core product solid, v3.3.1 published
- Pricing page + waitlist live on memoir.sh
- No Stripe integration yet (Pro/Teams can't be purchased)
- Distribution not started (no Reddit/HN posts yet)
