# Memoir Business Game Plan
**Date:** March 25, 2026 | **Status:** Pre-revenue | **Author:** Boardroom consensus + CEO directive

---

## Current State

| Metric | Value |
|--------|-------|
| Version | 3.1.2 (npm) |
| Revenue | $0 |
| Users | ~50 npm downloads |
| AI Tools Supported | 11 (Claude, Gemini, Cursor, Copilot, Windsurf, Zed, Cline, Continue, Aider, Codex, ChatGPT) |
| Cloud Backend | Supabase (auth + storage + PostgreSQL) |
| Landing Page | memoir.sh (Vercel, 13 blog posts, no email capture) |
| Blog Posts | 13 SEO-targeted articles |
| Analytics | None (CLI or website) |
| Payment Processing | None |
| Team Features | None |
| Shareable Links | None |

---

## What's Already Built (Don't Rebuild)

- **CLI core** — push, restore, snapshot, resume, migrate, diff, profiles, doctor
- **Cloud sync** — Supabase auth (email/password), gzipped bundles in Storage, PostgreSQL metadata
- **Free/Pro tiers** — enforced in code (Free: 3 backups, Pro: 50) — but no way to pay for Pro
- **Version history** — cloud backups versioned, restore from any version
- **E2E encryption** — AES-256-GCM, async scrypt (just fixed), client-side before upload
- **Workspace sync** — clones git repos, bundles non-git projects, applies uncommitted patches
- **Session handoff** — snapshot current session, resume on another machine
- **Landing page** — memoir.sh with animated terminal demo, tool marquee, FAQ, competitor comparison
- **13 SEO blog posts** — sync guides for each tool, comparisons, setup guides

---

## The Plan: 4 Phases

### Phase 1: Monetization Foundation (Week 1-2)
> **Goal:** Accept money. Capture emails. Track usage.

| Task | Priority | Effort | Details |
|------|----------|--------|---------|
| Add Stripe integration | P0 | 1 day | Connect to Pro tier ($15/mo individual, already priced in competitor comparison) |
| `memoir upgrade` command | P0 | 0.5 day | Opens Stripe checkout from CLI, activates Pro |
| Add pricing page to memoir.sh | P0 | 0.5 day | Free vs Pro vs Teams (coming soon) |
| Add email capture / waitlist | P0 | 0.5 day | "Get notified for Teams" — collect emails on memoir.sh |
| Add PostHog analytics to CLI | P1 | 0.5 day | Anonymous: commands used, tool count, machine OS, cloud vs local |
| Add PostHog to memoir.sh | P1 | 0.5 day | Page views, blog reads, install clicks |
| `memoir doctor` completion | P2 | 0.5 day | Finish the stubbed diagnostics command |

**Phase 1 deliverable:** People can pay. We know who's using what.

---

### Phase 2: Viral Loop + Shareability (Week 3-4)
> **Goal:** Every user brings one more user.

| Task | Priority | Effort | Details |
|------|----------|--------|---------|
| Shareable context links | P0 | 2 days | `memoir share` → generates encrypted link (Supabase signed URL, 24hr expiry). Recipient runs `memoir restore --from <link>` |
| Share landing page | P0 | 0.5 day | When link is opened in browser (not CLI), show "Install memoir to restore this context" with one-click copy |
| Team invite flow | P1 | 1 day | `memoir team create`, `memoir team invite <email>` — shared backup namespace in Supabase |
| Onboarding context | P1 | 0.5 day | `memoir push --share` generates a restore link printed to terminal. Copy-paste to Slack |
| "Synced with memoir" badge | P2 | 0.5 day | Auto-append to CLAUDE.md / .cursorrules when synced — passive discovery |

**Phase 2 deliverable:** Sharing is the viral loop. Every shared link = a new install prompt.

---

### Phase 3: Teams Tier (Week 5-8)
> **Goal:** $29/seat/month revenue from dev teams.

| Task | Priority | Effort | Details |
|------|----------|--------|---------|
| Organizations in Supabase | P0 | 2 days | `organizations` table, `org_members` table, role-based (admin/member) |
| Shared team backups | P0 | 2 days | `memoir push --team` syncs to org namespace. All members can restore team context |
| Team dashboard (web) | P1 | 3 days | memoir.sh/dashboard — see team members, backup history, storage usage |
| Seat-based billing | P0 | 1 day | Stripe per-seat subscription, enforce in CLI |
| Context inheritance | P1 | 1 day | `memoir restore --from <teammate>` — pull specific teammate's context with permission |
| Audit log | P2 | 1 day | Who pushed, who restored, when — enterprise compliance checkbox |
| SSO (Google/GitHub) | P2 | 1 day | Enterprise teams expect OAuth, not email/password |

**Phase 3 deliverable:** Teams can buy seats, share context, see a dashboard.

---

### Phase 4: Enterprise + Moat (Week 9-12)
> **Goal:** First $5k MRR. Lock-in through history depth.

| Task | Priority | Effort | Details |
|------|----------|--------|---------|
| Context time-travel | P1 | 3 days | `memoir restore --version 5 --tool claude` — restore any tool to any point in history |
| Diff between versions | P1 | 1 day | `memoir diff v3 v7` — show what changed in AI context between versions |
| Context quality scoring | P2 | 2 days | Auto-tag backups: files changed, decisions made, session length. Surface "important" snapshots |
| Enterprise pricing page | P1 | 0.5 day | $99/seat/month with SLA, priority support, SSO, audit logs |
| SOC2 narrative | P2 | 1 day | Document E2E encryption, zero-knowledge architecture, audit trail for compliance conversations |
| API for integrations | P2 | 3 days | REST API: programmatic backup/restore for CI/CD pipelines, onboarding scripts |

**Phase 4 deliverable:** Enterprise-ready product with deep history moat.

---

## Pricing Structure

| Tier | Price | Limits | Target |
|------|-------|--------|--------|
| **Free** | $0/forever | 3 cloud backups, local unlimited, 1 machine | Solo devs trying it out |
| **Pro** | $15/month | 50 cloud backups, unlimited machines, version history | Power users, multi-machine devs |
| **Teams** | $29/seat/month | Shared team context, dashboard, audit log, 200 backups/team | Dev teams (5-20 people) |
| **Enterprise** | $99/seat/month | SSO, SLA, API access, compliance docs, unlimited backups | Companies (20+) |

---

## Positioning

| Audience | Message |
|----------|---------|
| Individual dev | "Never lose your AI context again" |
| Dev team lead | "Onboard devs in 60 seconds with full AI context" |
| Enterprise buyer | "SOC2-ready AI workflow continuity" |
| SEO / content | "Git for your AI setup" |

**One-liner:** memoir syncs your AI memory across every machine and every teammate.

**Anti-positioning (what we're NOT):** Not a dotfiles manager. Not VS Code Sync. Not a cloud IDE. We sync the AI layer — the conversations, decisions, and context that make your tools smart.

---

## First 100 Users Plan

| Week | Action | Target |
|------|--------|--------|
| 1 | Ship Stripe + pricing page | Accept payments |
| 2 | Post on r/programming, r/neovim, r/cursor, Hacker News | 500 page views |
| 3 | Cold DM 50 developers who tweet about Claude/Cursor context loss | 10 installs |
| 4 | Ship shareable links, post demo video on X/Twitter | 20 shares |
| 5-6 | Reach out to 10 companies using Cursor (check their GitHub for .cursorrules) | 3 team pilots |
| 7-8 | Ship Teams tier, convert pilots to paid | First $290 MRR |
| 9-12 | Content marketing: "How Company X onboards devs in 60s" case study | 100 users, $1k+ MRR |

---

## Supabase Schema Changes Needed

```sql
-- Organizations
CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  owner_id UUID REFERENCES auth.users(id),
  plan TEXT DEFAULT 'teams',
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Org members
CREATE TABLE org_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id),
  role TEXT DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  invited_by UUID REFERENCES auth.users(id),
  joined_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(org_id, user_id)
);

-- Shared links
CREATE TABLE shared_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  backup_id UUID REFERENCES backups(id),
  created_by UUID REFERENCES auth.users(id),
  token TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  max_uses INT DEFAULT 1,
  use_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Add org_id to backups for team backups
ALTER TABLE backups ADD COLUMN org_id UUID REFERENCES organizations(id);

-- Add stripe fields to subscriptions
ALTER TABLE subscriptions ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE subscriptions ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE subscriptions ADD COLUMN seats INT DEFAULT 1;
```

---

## New CLI Commands Summary

```
memoir upgrade          # Open Stripe checkout, activate Pro
memoir share            # Generate encrypted shareable link
memoir team create      # Create a team organization
memoir team invite      # Invite teammate by email
memoir team list        # List team members
memoir push --team      # Push to team namespace
memoir restore --from   # Restore from shared link or teammate
memoir history --diff   # Diff between backup versions
memoir analytics        # Show your usage stats (local)
```

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| AI tools change config paths | High | Medium | Version-gated path detection, community PRs for new tools |
| Supabase costs spike with users | Medium | Medium | Gzip compression (already done), enforce tier limits, monitor |
| Nobody pays for Pro | High | High | Validate with shareable links first (free viral), watch conversion |
| Enterprise competitor (JetBrains, GitHub) builds this | Medium | High | Move fast, own the CLI mindshare, community moat |
| ToS violations syncing AI configs | Low | High | Only sync user-owned files (configs, not conversations). Document clearly |
| Data breach of cloud backups | Low | Critical | E2E encryption means we literally can't read user data. Zero-knowledge by design |

---

## This Week's Checklist

- [ ] Stripe account setup + integration in CLI
- [ ] `memoir upgrade` command
- [ ] Pricing page on memoir.sh
- [ ] Email capture for Teams waitlist on memoir.sh
- [ ] PostHog analytics on CLI (anonymous, opt-out available)
- [ ] PostHog analytics on memoir.sh
- [ ] Post in 3 subreddits about memoir

---

*"The CLI is the funnel. Cloud is the product. Teams is the business."*
