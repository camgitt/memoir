# memoir — Persistent Memory for AI Coding Tools

## Project
- **Package:** memoir-cli (npm), v3.12.0 (see package.json — this line goes stale)
- **Website:** memoir.sh (static HTML on Vercel)
- **Repo:** https://github.com/camgitt/memoir
- **License:** MIT
- **Stack:** Node.js CLI + Supabase (auth, storage, PostgreSQL)

## What it does
CLI + MCP server for project-scoped memory and coding-session handoffs. It has import/export adapters for 11 tools. The review branch configures Claude Code, Codex, and Cursor with an SDK handshake; actual client acceptance and hosted rollout remain release gates. See README.md and docs/RELIABILITY-ROLLOUT.md for the precise boundaries.

## Architecture
- **CLI commands:** push, restore, snapshot, resume, migrate, diff, profile, doctor, share, upgrade, consolidate, login (--signup), forgot-password, recall, forget, validate, why, note/goal/next/done/ask
- **MCP server:** 15 tools — memory: memoir_remember (aliases/tags → frontmatter), memoir_recall (passages, field-weighted, cached — src/memory/search.js), memoir_read, memoir_list, memoir_profiles, memoir_status, memoir_consolidate; session continuity: memoir_set_goal, memoir_add_next, memoir_complete_next, memoir_note, memoir_ask, memoir_session, memoir_why, memoir_forget (absolute tombstone, --purge redacts)
- **Session continuity:** AI records goals/next-actions/decisions into session.json, auto-rendered into CLAUDE.md so the next session picks up where the last ended
- **Consolidate:** scans all tool memories for duplicates, stale files, and bloat (`--smart` adds a Gemini Flash semantic pass)
- **Cloud sync:** Supabase auth (email/password), gzipped bundles in Storage, PostgreSQL metadata
- **Encryption:** AES-256-GCM, async scrypt, client-side before upload; cloud writes require a user-held passphrase, and legacy cloud backups remain readable with a warning
- **Tiers:** Free (10 cloud backups), Pro ($15/mo, 100 backups + version history — purchasable via `memoir upgrade`, Stripe checkout wired), Teams ($29/seat, planned)

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
- Review candidate: audit reliability fixes plus incremental scoped lexical retrieval. See docs/AUDIT-REMEDIATION.md and docs/RETRIEVAL-INDEX.md; passing regression tests is not a production rollout or a SOTA claim.
- Pricing page + waitlist live on memoir.sh
- Stripe checkout wired — Pro is purchasable via `memoir upgrade` (hits `stripe-checkout` Supabase function, opens browser). Live-mode end-to-end not yet verified.
- Session continuity + consolidate shipped (cross-session goal/decision handoff, memory cleanup)
- Distribution not started (no Reddit/HN posts yet)
