# memoir v3: The AI Development Context Portability Layer

## Vision Document — March 2026

**One command to freeze your entire development state. One command to thaw it anywhere.**

---

## Table of Contents

1. [The Problem](#the-problem)
2. [What Exists Today](#what-exists-today)
3. [The memoir v3 Vision](#the-memoir-v3-vision)
4. [Technical Architecture](#technical-architecture)
5. [The AI Context Layer (Killer Differentiator)](#the-ai-context-layer)
6. [Cloud Architecture](#cloud-architecture)
7. [Implementation Roadmap](#implementation-roadmap)
8. [What Makes This Viral/Fundable](#what-makes-this-viralfundable)
9. [Competitive Moat](#competitive-moat)

---

## The Problem

Developers in 2026 don't just switch machines — they switch between AI assistants mid-thought. You're deep in a Claude Code session on your Mac, you close the laptop, open your Windows desktop, fire up Gemini or Cursor, and... the AI has no idea what you were doing. Your files might sync via git, but your **context** — what you were building, why, what decisions you made, what's blocked, what's next — is gone.

This is the "AI context gap." Every tool today solves a piece of it. None solve all of it.

### What gets lost today:
- **AI memory files** (CLAUDE.md, .cursorrules, GEMINI.md) — tool-specific, scattered
- **Session state** — what the AI learned about your codebase during a conversation
- **Decision history** — why you chose React over Svelte, why you avoided that npm package
- **Work-in-progress context** — uncommitted changes, half-written features, debugging state
- **Cross-tool intelligence** — Claude knows your codebase deeply, but Cursor doesn't

---

## What Exists Today

### Cloud Dev Environments (Codespaces, Gitpod, Replit)

**How they work:** Entire VM/container in the cloud. Your "machine" is a URL. Codespaces uses Azure VMs with devcontainer.json; Gitpod runs Docker containers on Kubernetes with gitpod.yml.

**What they solve:** Environment consistency. You get the same Node version, same extensions, same everything.

**What they don't solve:**
- AI context doesn't transfer between environments
- Vendor lock-in (Codespaces is GitHub-only, Gitpod requires its config format)
- Latency — you're coding over a network connection
- Cost — always running, always billing
- No cross-tool portability (can't go from Codespaces to local Cursor)

**Lesson for memoir:** Don't compete with cloud IDEs. Complement them. memoir works whether you're local, in Codespaces, or SSH'd into a server.

### File Sync Tools (Syncthing, rsync, Unison, Rclone)

**How they work:** Continuous or on-demand file mirroring between machines.

**What they solve:** Getting files from A to B.

**What they don't solve:**
- No understanding of *what* the files are — they sync node_modules as happily as CLAUDE.md
- No deduplication intelligence (rsync does binary diffs, but not content-addressable storage)
- No concept of "context" or "sessions"
- Conflict resolution is file-level, not semantic

**Technical lessons:**
- **rsync** — mature, battle-tested binary diff algorithm. Good for incremental sync.
- **Restic/Borg** — content-addressable, deduplicated, encrypted backup. Restic splits files into content-defined chunks, hashes each, only uploads new chunks. Borg does the same with variable-length chunking.
- **Rclone** — "rsync for cloud" — supports 70+ storage backends.

### AI Memory/Context Tools (Direct Competitors)

**OneContext** (newest, most relevant):
- Self-managed persistent context layer for coding agents
- Stores project knowledge across sessions, devices, collaborators
- Supports importing old Codex/Claude sessions
- Can share context via hyperlink
- Context visualization/timeline
- Local-first architecture
- **Gap:** Focused on context only, doesn't sync AI configs/rules. No migration between AI tools.

**Memorix:**
- Persistent memory for AI coding agents via MCP
- Supports Cursor, Windsurf, Claude Code, Codex, Copilot, Gemini CLI
- npm package
- **Gap:** MCP-based (requires MCP support). No session handoff, no cross-device sync.

**Mem0:**
- "Universal memory layer for AI agents"
- Focused on agent memory management, not developer workflow
- More of an API/SDK than a CLI tool
- **Gap:** Enterprise/API-oriented, not developer-facing CLI.

**MemOS:**
- Memory OS for LLMs — persistent skill memory for cross-task reuse
- Academic/research-oriented
- **Gap:** Not a practical developer tool.

### Apple Handoff (Conceptual Inspiration)

**How it works:**
1. Devices signed into the same iCloud account establish BLE 4.2 pairing via APNs
2. AES-256-GCM encrypted BLE advertisements broadcast current activity state
3. Nearby device detects the ad, shows a Handoff icon
4. User taps it — small payloads transfer via BLE, large ones via peer-to-peer Wi-Fi (TLS encrypted, trust derived from iCloud Keychain)

**Key design principles to steal:**
- **Discovery is passive** — you don't "send" to a device, it just appears
- **Minimal payload first** — just enough to show the icon (activity type + app)
- **Full payload on demand** — only transfer everything when user opts in
- **Identity-based trust** — same account = trusted, no manual pairing
- **Encrypted end-to-end** — even Apple can't read the transfer

**This is exactly what `memoir push` / `memoir restore` should feel like.** One identity, encrypted, instant.

---

## The memoir v3 Vision

### The Pitch

**memoir is the portability layer between you, your code, and your AI.**

Today it syncs AI config files. Tomorrow it captures your *entire development state* — project files, AI memory, session context, decisions, blockers, next steps — and recreates it on another machine with one command. Not just the files. The understanding.

### Core Commands (v3)

```bash
# Capture EVERYTHING — AI configs + project state + session context
memoir push

# Recreate everything on another machine
memoir restore

# Snapshot current coding session (already exists, enhanced)
memoir snapshot --smart

# Resume on new machine — AI already knows what you were doing
memoir resume --inject --to claude

# Time travel — restore from any point
memoir restore --version 12
memoir restore --date "2 days ago"

# Share context with a teammate
memoir share --to teammate@email.com
memoir share --link  # generates a shareable URL

# See your development timeline
memoir timeline

# Cross-tool migration (already exists, enhanced)
memoir migrate --from claude --to gemini --include-context
```

### What `memoir push` Captures (v3)

| Layer | What | How |
|-------|------|-----|
| **AI Configs** | CLAUDE.md, .cursorrules, GEMINI.md, etc. | File copy (existing) |
| **AI Memory** | ~/.claude/projects/*/memory/, session JSONL | File copy + parse |
| **Project State** | git status, branch, uncommitted changes, stash | `git diff`, `git stash` |
| **Session Context** | What you were working on, files touched, decisions | JSONL parsing + AI summary |
| **Environment** | Node version, Python version, key deps | Runtime detection |
| **Intent** | What's next, blockers, TODO items | AI-extracted from session |

### What `memoir restore` Recreates (v3)

1. AI config files placed in correct locations for each tool
2. Session handoff injected into target AI tool's context
3. Git state optionally restored (branch checkout, stash pop)
4. AI summary available: "Here's what was happening and what's next"

---

## Technical Architecture

### Content-Addressable Storage (CAS)

Instead of storing full file snapshots every time, use content-addressable storage like git objects or Restic:

```
memoir-store/
├── objects/          # Content-addressed blobs (SHA-256 hash of content)
│   ├── ab/cd1234... # Deduplicated file chunks
│   └── ef/gh5678...
├── snapshots/        # Snapshot manifests (list of object refs)
│   ├── 2026-03-11T14-30-00.json
│   └── 2026-03-10T09-15-00.json
└── index.json        # Local index of all known objects
```

**How it works:**
1. On `memoir push`, walk all tracked files
2. Split each file into chunks (content-defined chunking, like Restic/Borg)
3. Hash each chunk (SHA-256)
4. Check if hash exists in remote store — skip if yes (dedup)
5. Upload only new chunks
6. Create a snapshot manifest (JSON listing all file paths + their chunk hashes)

**Benefits:**
- First push: full upload. Subsequent pushes: only diffs. Massive bandwidth savings.
- Multiple snapshots share chunks — 50 versions might only use 1.2x storage of a single version
- Integrity verification built in (hash = content identity)

**Implementation (Node.js):**
```javascript
import { createHash } from 'crypto';

function hashChunk(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

// Content-defined chunking using rolling hash (Rabin fingerprint)
function chunkFile(buffer, avgSize = 64 * 1024) {
  const chunks = [];
  // Use Rabin fingerprint for content-defined boundaries
  // This ensures similar files produce similar chunks even if bytes shift
  let start = 0;
  // ... rolling hash implementation
  return chunks.map(chunk => ({
    hash: hashChunk(chunk),
    data: chunk,
    size: chunk.length
  }));
}
```

For a solo dev MVP: skip the rolling hash complexity. Use fixed-size chunks (64KB) initially. Content-defined chunking is an optimization for later.

### Incremental Sync Protocol

```
Client                          Server (R2/Supabase)
  │                                │
  │  1. GET /snapshots/latest      │
  │ ─────────────────────────────> │
  │  { manifest: [...hashes] }     │
  │ <───────────────────────────── │
  │                                │
  │  2. Diff local vs remote       │
  │  (compute new/changed chunks)  │
  │                                │
  │  3. PUT /objects/{hash}        │
  │  (upload only new chunks)      │
  │ ─────────────────────────────> │
  │                                │
  │  4. POST /snapshots            │
  │  (create new snapshot manifest)│
  │ ─────────────────────────────> │
  │                                │
  │  Done. Only new data sent.     │
```

### End-to-End Encryption

Project files may contain secrets, proprietary code, API keys. The server should never see plaintext.

**Approach: libsodium (tweetnacl-js for Node)**

```
Key Generation (on first `memoir login`):
  1. Generate X25519 keypair
  2. Derive symmetric key from user password via Argon2id
  3. Encrypt private key with derived key, store encrypted private key on server
  4. Public key stored in plaintext on server

Encryption (on `memoir push`):
  1. Generate ephemeral symmetric key (XChaCha20-Poly1305)
  2. Encrypt each chunk with this key
  3. Encrypt the symmetric key with user's public key (sealed box)
  4. Upload: encrypted chunks + sealed key

Decryption (on `memoir restore`):
  1. Download encrypted chunks + sealed key
  2. Unseal symmetric key with user's private key
  3. Decrypt chunks
```

**Libraries:** `tweetnacl` (1.4KB, zero deps) or `libsodium-wrappers` (more complete). For a CLI tool, `tweetnacl` + `tweetnacl-sealed-box` is sufficient and keeps the install fast.

### Conflict Resolution

When the same file is modified on two machines between syncs:

**Strategy: Last-write-wins with conflict preservation**

```
1. On restore, if local file differs from snapshot AND snapshot differs from what was last restored:
   → CONFLICT DETECTED
2. Save both versions:
   - .cursorrules (remote version applied)
   - .cursorrules.memoir-conflict-2026-03-11 (local version preserved)
3. Show user: "Conflict in .cursorrules — remote version applied, local saved as .memoir-conflict"
4. For AI memory files: MERGE, not overwrite (append new memories, dedup)
```

For AI config files specifically, merging is smarter than overwriting — a CLAUDE.md modified on two machines likely has additive changes, not conflicting ones.

### Compression

**Use zstd (level 3) instead of gzip:**
- 3-5x faster compression than gzip at similar ratios
- Better compression ratio than gzip at same speed
- Streaming support (crypto_secretstream compatible)
- Node.js: `@aspect-build/zstd` or compile via `node-zstd`

Current codebase uses `zlib.createGzip({ level: 9 })` — switching to zstd level 3 would be faster with comparable compression.

---

## The AI Context Layer

**This is the killer differentiator. No tool does this today.**

### The Problem Restated

You have a 2-hour Claude Code session. Claude reads 40 files, writes 12, runs 30 commands, makes architectural decisions, hits 3 bugs and fixes 2. You close the laptop.

On another machine, you open Claude Code. It knows *nothing*. You start from scratch.

`memoir snapshot` already captures the raw session data. The leap is making that data **actionable across any AI tool**.

### Architecture: The Context Bundle

```json
{
  "memoir_version": "3.0",
  "context_format": "ucf-1",  // Universal Context Format
  "captured_at": "2026-03-11T14:30:00Z",
  "source": {
    "tool": "claude-code",
    "machine": "macbook-pro",
    "platform": "darwin",
    "session_id": "abc123"
  },
  "project": {
    "path": "/Users/cam/myproject",
    "git_branch": "feature/auth",
    "git_status": "3 files modified, 1 untracked",
    "git_diff_summary": "Adding JWT auth middleware...",
    "language": "typescript",
    "framework": "next.js",
    "key_dependencies": ["next@14", "prisma@5", "jose@5"]
  },
  "session": {
    "duration_minutes": 127,
    "files_modified": ["src/middleware.ts", "src/lib/auth.ts", "prisma/schema.prisma"],
    "files_read": ["src/app/api/route.ts", "package.json", "..."],
    "decisions": [
      "Chose jose over jsonwebtoken for Edge Runtime compatibility",
      "Using middleware.ts for auth instead of per-route checks",
      "Prisma schema uses @@map for snake_case DB columns"
    ],
    "blockers": [
      "Prisma client not generating types for new User model — need to run prisma generate"
    ],
    "errors_encountered": [
      "Edge Runtime doesn't support Node.js crypto — switched to jose"
    ]
  },
  "intent": {
    "summary": "Building JWT authentication for Next.js API routes",
    "completed": [
      "Auth middleware skeleton",
      "Prisma User model with email/password",
      "Login API route"
    ],
    "in_progress": [
      "Token refresh endpoint"
    ],
    "next_steps": [
      "Finish /api/auth/refresh route",
      "Add protected route wrapper component",
      "Write tests for auth flow"
    ]
  },
  "ai_memory": {
    "tool_configs": {
      "claude": { "path": "~/.claude/projects/-Users-cam-myproject/memory/", "files": ["MEMORY.md"] },
      "cursor": { "path": ".cursorrules", "content": "..." }
    },
    "learned_preferences": [
      "User prefers function components over class components",
      "User wants explicit error handling, not try/catch swallowing",
      "User uses pnpm, not npm or yarn"
    ]
  }
}
```

### Cross-Tool Translation

The existing `memoir migrate` already translates configs between tools. v3 extends this to translate **context**:

```bash
# Push from Claude Code session
memoir push   # captures Claude-format context

# Restore into Cursor on another machine
memoir restore --to cursor
```

What happens on restore to Cursor:
1. AI configs restored (.cursorrules placed)
2. Context bundle translated to Cursor-compatible format
3. A `.cursor/context/memoir-handoff.md` file is generated:

```markdown
# Project Context (from memoir)
You are continuing work on JWT authentication for a Next.js app.

## Key Decisions Already Made
- Using `jose` (not jsonwebtoken) for Edge Runtime compatibility
- Auth via middleware.ts, not per-route
- Prisma with snake_case DB mapping

## Current State
- Auth middleware: DONE
- Login route: DONE
- Token refresh: IN PROGRESS (started, not finished)

## Next Steps
1. Finish /api/auth/refresh route
2. Add protected route wrapper component
3. Write tests for auth flow

## Known Issues
- Run `prisma generate` before starting — types are stale

## Files to Focus On
- src/middleware.ts (auth logic)
- src/lib/auth.ts (token utils)
- src/app/api/auth/refresh/route.ts (in progress)
```

The AI on the new machine reads this and **already knows what you were doing**. No re-explaining. No context rebuilding.

### Smart Summaries (Enhanced)

The existing `--smart` flag uses Gemini to summarize. v3 makes this the default and extracts structured data:

```javascript
// Extract decisions, blockers, next steps from raw session
async function extractContext(sessionData) {
  const prompt = `Analyze this coding session and extract:
  1. KEY DECISIONS: Technical choices made and why
  2. CURRENT STATE: What's done, what's in progress
  3. BLOCKERS: Issues hit, unresolved problems
  4. NEXT STEPS: What should be done next
  5. PREFERENCES: Coding style/tool preferences observed

  Return as JSON matching this schema: { decisions: [], state: {}, blockers: [], next_steps: [], preferences: [] }

  Session data:
  ${JSON.stringify(sessionData)}`;

  // Use whatever LLM is available — Gemini (free), or user's own key
  return callLLM(prompt);
}
```

### Session Continuity: The "Handoff Protocol"

```
Machine A (Mac)                    memoir cloud                    Machine B (Windows)
     │                                  │                                │
     │  memoir push                     │                                │
     │  ─ scan AI configs              │                                │
     │  ─ parse Claude session         │                                │
     │  ─ extract context (AI)         │                                │
     │  ─ bundle + encrypt             │                                │
     │  ─ upload (incremental)         │                                │
     │ ───────────────────────────────>│                                │
     │                                  │                                │
     │                                  │   memoir restore               │
     │                                  │   ─ download + decrypt         │
     │                                  │   ─ detect local AI tools      │
     │                                  │   ─ restore configs            │
     │                                  │   ─ translate context          │
     │                                  │   ─ inject handoff             │
     │                                  │<───────────────────────────────│
     │                                  │                                │
     │                                  │   Open Cursor/Claude/Gemini    │
     │                                  │   → AI reads handoff           │
     │                                  │   → "I see you were building   │
     │                                  │      JWT auth. The refresh     │
     │                                  │      endpoint is next."        │
```

---

## Cloud Architecture

### Storage: Cloudflare R2 (Primary) + Supabase (Metadata/Auth)

The current codebase uses Supabase for everything (auth + storage + metadata). For v3, split concerns:

| Concern | Service | Why |
|---------|---------|-----|
| **Auth** | Supabase Auth | Already built, works well, free tier generous |
| **Metadata** | Supabase Postgres | Backup history, user profiles, sharing permissions |
| **File Storage** | Cloudflare R2 | Zero egress fees, S3-compatible, $0.015/GB/mo |
| **Edge Logic** | Supabase Edge Functions or Cloudflare Workers | Sharing links, webhook handlers |

**Why R2 over Supabase Storage for v3:**
- Zero egress = restores are free no matter how large
- S3-compatible API = can switch backends later
- Better for large bundles (AI session files can be 10-50MB)
- Current Supabase Storage works fine for v2 scale; R2 is the v3 scaling play

**Migration path:** Keep Supabase Storage for now. Add R2 as an option behind a storage abstraction. Switch default when R2 proves stable.

### Storage Layout (R2)

```
memoir-backups/
├── {user_id}/
│   ├── objects/           # Content-addressed chunks
│   │   ├── ab/cd1234...   # Encrypted chunk
│   │   └── ef/gh5678...
│   ├── snapshots/         # Snapshot manifests
│   │   ├── v001.json.enc  # Encrypted manifest
│   │   ├── v002.json.enc
│   │   └── latest.json.enc
│   └── shared/            # Shared context bundles
│       └── {share_id}.json.enc
```

### Cost Projections

For a typical developer (5 AI tools, ~2MB of config/memory, daily pushes):

| Scale | Storage | R2 Cost/mo | Supabase Cost/mo | Total |
|-------|---------|-----------|------------------|-------|
| 100 users | ~500MB | $0.01 | $0 (free tier) | ~$0 |
| 1,000 users | ~5GB | $0.08 | $0 (free tier) | ~$0 |
| 10,000 users | ~50GB | $0.75 | $25 (Pro) | ~$26 |
| 100,000 users | ~500GB | $7.50 | $25 (Pro) | ~$33 |

At $5/mo Pro pricing, 100 paid users = $500 MRR with ~$33 infra cost. The margins are absurd.

### Alternative: Git Bundles as Transport

The current codebase already supports git as a storage backend. Git bundles could be an interesting transport layer:

```bash
# Create a bundle (like a portable git repo)
git bundle create memoir-backup.bundle --all

# Incremental bundle (only new commits since last push)
git bundle create memoir-incremental.bundle main..HEAD
```

**Pros:** Built-in dedup, compression, incremental sync. Git is everywhere.
**Cons:** Overhead of maintaining a git repo per user. Not great for binary files (AI session JSONL can be large). Requires git installed.

**Verdict:** Use CAS for file storage, but keep the existing git provider as an option for users who want self-hosted/private backup.

---

## Implementation Roadmap

### Phase 1: Enhanced Context Capture (v2.6 — 2 weeks)

Enhance what already exists with zero new infrastructure:

- [ ] Make `memoir push` capture git state (branch, status, recent commits) alongside AI configs
- [ ] Make `memoir snapshot --smart` the default (with fallback if no API key)
- [ ] Add structured context extraction (decisions, blockers, next steps) to snapshot
- [ ] Add `memoir push --project` to include git diff/status in the bundle
- [ ] Enhance `memoir resume --inject` to generate richer handoff documents

**Why first:** Immediate value, no backend changes, can ship to existing users today.

### Phase 2: Incremental Sync + Encryption (v2.8 — 3 weeks)

Replace the current "upload full gzip every time" with smart sync:

- [ ] Implement content-addressable chunk storage (fixed-size chunks first)
- [ ] Add hash-based dedup (skip uploading chunks that already exist)
- [ ] Add E2E encryption with tweetnacl (generate keypair on login, encrypt chunks)
- [ ] Add zstd compression (replace gzip)
- [ ] Add conflict detection + resolution for AI config files

**Why second:** Makes push/restore 10x faster for repeat users. Encryption unlocks enterprise.

### Phase 3: Universal Context Format + Cross-Tool Intelligence (v3.0 — 4 weeks)

The big leap — make context portable across AI tools:

- [ ] Define UCF (Universal Context Format) JSON schema
- [ ] Build context extractors for each supported tool (Claude JSONL, Cursor, Gemini, etc.)
- [ ] Build context injectors for each tool (generate tool-specific handoff files)
- [ ] Add `memoir restore --to <tool>` with context translation
- [ ] Add `memoir migrate --include-context` for full context + config migration
- [ ] Add time travel: `memoir restore --version N` or `memoir restore --date "yesterday"`

### Phase 4: Sharing + Teams (v3.2 — 3 weeks)

The viral/fundable features:

- [ ] `memoir share --link` — generate a shareable context URL
- [ ] `memoir share --to email` — invite a collaborator to your context
- [ ] Team workspaces — shared AI configs + context across a team
- [ ] `memoir onboard` — new team member gets full project context in one command
- [ ] Context permissions (read-only share vs. full sync)

### Phase 5: Real-Time + Watch Mode (v3.5 — 4 weeks)

Approach Apple Handoff-level seamlessness:

- [ ] `memoir watch` — background daemon that auto-pushes on file changes
- [ ] WebSocket-based real-time sync (instant push to connected devices)
- [ ] Notification on restore: "Your Mac just pushed new context — restore?"
- [ ] Optional: BLE/mDNS discovery for LAN-based sync (zero cloud, like AirDrop)

---

## What Makes This Viral/Fundable

### Positioning: "GitHub for AI Context"

GitHub stores your code. memoir stores everything your AI knows about your code. Every developer using AI tools (that's everyone in 2026) has this problem. GitHub solved "where is my code?" — memoir solves "where is my AI's understanding of my code?"

### Viral Mechanics

1. **`memoir share --link`** — Every shared context link is a memoir advertisement. Recipient needs memoir to restore. Free viral loop.

2. **Team onboarding** — "We use memoir for context sharing" becomes a team standard. One person adopts, whole team follows.

3. **`memoir snapshot` output is shareable** — The handoff markdown is useful even without memoir. People share it on Twitter/Discord. "Look how clean this session summary is."

4. **Cross-tool migration** — Already a unique feature. "I switched from Cursor to Claude and memoir kept all my context" is a tweet that writes itself.

5. **Time travel** — "I can restore my AI's understanding from 2 weeks ago" is mind-blowing demo material.

### Revenue Model

| Tier | Price | Features |
|------|-------|----------|
| **Free** | $0 | 3 snapshots, 2 devices, local sync, git sync |
| **Pro** | $8/mo | 50 snapshots, unlimited devices, cloud sync, E2E encryption, time travel |
| **Team** | $12/user/mo | Everything in Pro + shared contexts, team onboarding, admin controls |

### Fundable Signals

- **Large TAM:** Every developer using AI coding tools (tens of millions by 2026)
- **Natural network effects:** Sharing and team features create pull
- **Low infrastructure cost:** <$50/mo to serve 10K users
- **Strong retention:** Once your AI context is in memoir, switching is painful (positive lock-in)
- **Clear expansion path:** Enterprise (SOC2, SSO, audit logs), marketplace (share context templates), API (other tools integrate with memoir)

### Competitive Moat

| Feature | memoir | OneContext | Memorix | Codespaces |
|---------|--------|-----------|---------|------------|
| Multi-tool config sync | 11 tools | No | 7 tools (MCP) | No |
| Cross-tool migration | Yes | No | No | No |
| Session handoff | Yes | Yes | No | No |
| Context extraction | AI-powered | Manual | No | No |
| Cross-device sync | Yes | Manual | No | Cloud-only |
| E2E encryption | Planned | No | No | Microsoft-managed |
| Time travel | Planned | Yes | No | No |
| Sharing/Teams | Planned | Link sharing | No | GitHub-native |
| Works offline | Yes | Yes | Yes | No |
| Zero vendor lock-in | Yes (self-host option) | Yes | MCP-dependent | GitHub-locked |

**memoir's unique position:** It's the only tool that combines config sync + context extraction + cross-tool translation + cloud backup. OneContext is the closest competitor but focuses only on context, not configs. Memorix requires MCP. Codespaces is a different category entirely.

### The Magic Moment

A developer works on their Mac all day with Claude Code. At 6 PM:

```bash
$ memoir push
  Backed up!
  ├─ Claude CLI (12 files, 1.2MB)
  ├─ Cursor (3 files, 4.1KB)
  ├─ Projects (5) (8 files, 12KB)
  └─ Session Context (JWT auth feature, 127 min session)

  → memoir cloud (v14, 23KB uploaded, 1.1MB deduped)
```

They go home, open their Windows desktop:

```bash
$ memoir restore
  Restored from cloud (v14, from macbook-pro)
  ├─ Claude CLI configs restored
  ├─ Cursor rules restored
  ├─ Context injected → Claude knows you were building JWT auth

  Ready to continue. Your AI remembers everything.
```

They open Claude Code. It reads the handoff. First message:

> "I see you were building JWT authentication. The middleware and login route are done. The token refresh endpoint at `/api/auth/refresh` is in progress — you need to finish the refresh token rotation logic in `src/lib/auth.ts`. Should I pick up where you left off?"

**That's the magic.**

---

## Technical Decisions Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Language | Node.js (existing) | Already built, npm distribution, cross-platform |
| Storage | R2 (files) + Supabase (auth/meta) | Zero egress + existing auth |
| Encryption | tweetnacl (X25519 + XChaCha20) | Tiny, zero deps, audited |
| Compression | zstd level 3 | 3-5x faster than gzip, better ratio |
| Dedup | SHA-256 content-addressed chunks | Proven approach (Restic/Borg) |
| Sync model | Snapshot-based (not real-time) | Simpler, fewer conflicts, explicit |
| Context format | JSON (UCF schema) | Universal, parseable, translatable |
| Conflict resolution | Last-write-wins + conflict files | Simple, transparent, recoverable |

---

*This document is a living plan. The roadmap is sequenced so each phase delivers standalone value — no phase depends on a future phase to be useful. Phase 1 can ship this week.*
