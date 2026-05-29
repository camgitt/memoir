# memoir — Persistent Memory for AI Coding Tools

## Project
- **Package:** memoir-cli (npm), v3.7.1
- **Website:** memoir.sh (static HTML on Vercel)
- **Repo:** https://github.com/camgitt/memoir
- **License:** MIT
- **Stack:** Node.js CLI + Supabase (auth, storage, PostgreSQL)

## What it does
CLI + MCP server that gives AI tools persistent memory. Your AI can search, read, and save memories across sessions, tools, and machines. Supports 11 tools: Claude Code, Cursor, Windsurf, Gemini, Copilot, Codex, ChatGPT, Aider, Zed, Cline, Continue.dev.

## Architecture
- **CLI commands:** push, restore, snapshot, resume, migrate, diff, profile, doctor, share, upgrade, consolidate, login (--signup), forgot-password
- **MCP server:** 14 tools — memory: memoir_remember, memoir_recall, memoir_read, memoir_list, memoir_profiles, memoir_status, memoir_consolidate; session continuity: memoir_set_goal, memoir_add_next, memoir_complete_next, memoir_note, memoir_ask, memoir_session, memoir_why
- **Session continuity:** AI records goals/next-actions/decisions into session.json, auto-rendered into CLAUDE.md so the next session picks up where the last ended
- **Consolidate:** scans all tool memories for duplicates, stale files, and bloat (`--smart` adds a Gemini Flash semantic pass)
- **Cloud sync:** Supabase auth (email/password), gzipped bundles in Storage, PostgreSQL metadata
- **Encryption:** AES-256-GCM, async scrypt, client-side before upload (zero-knowledge)
- **Tiers:** Free (100 cloud backups), Pro ($15/mo — purchasable via `memoir upgrade`, Stripe checkout wired), Teams ($29/seat, planned)

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
- Core product solid, v3.7.1 published
- Pricing page + waitlist live on memoir.sh
- Stripe checkout wired — Pro is purchasable via `memoir upgrade` (hits `stripe-checkout` Supabase function, opens browser). Live-mode end-to-end not yet verified.
- Session continuity + consolidate shipped (cross-session goal/decision handoff, memory cleanup)
- Distribution not started (no Reddit/HN posts yet)
