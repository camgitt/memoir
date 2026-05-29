# MEMORY.md Truncation / Index Bloat

**Problem:** MEMORY.md grows past the loader cap (200 lines) and the bottom gets truncated at load time. Claude then can't see index entries that live near the end — recently experienced when searching for a project ("accelerometer" / vibration-MPU6050 file) that was indexed past line 195. Had to be discovered by reading the full file, not the auto-loaded context.

**Root cause:** MEMORY.md is used as both an index AND an inline content store. Top of file contains full sections (SocialsLink details, NutriScan phases, Grace CRM notes, DivinityAGI, etc.) instead of one-line pointers. That inline content eats the line budget. The "Synced from another machine" section at the bottom follows the correct index format — but gets truncated.

**What Memoir should do (fix plan):**

1. **Audit inline vs topic files** — many big inline sections already have matching topic files (`project_socialslink.md`, `project_nutriscan.md`, `project_grace_crm.md`, `project_ideas.md`). Delete the duplicated inline blocks from MEMORY.md.

2. **Extract inline-only content to new files:**
   - `project_divinityagi.md` (DivinityAGI Website section)
   - `dev_resources.md` — confirm Free Avatars block lives there; if so, delete from MEMORY.md
   - `project_intelmap.md` already exists — delete inline
   - `design_inspiration.md` (new) — Stripe gradient note
   - `marketing_setup.md` OR merge into `project_socialslink.md` (Google Ads / X / Resend details)
   - `password_reset_flow.md` OR merge into `project_socialslink.md`

3. **Rewrite MEMORY.md as a pure index** — each line: `- [Title](file.md) — one-line hook`, under ~150 chars. A few `##` section dividers (Projects, Feedback, References) are fine.

4. **Dedupe** — `snaproast.md` + `project_roastdeck.md` look redundant; `socialslink.md` + `project_socialslink.md` too. Pick one per topic, delete the other, update index.

5. **Verify under budget** — `wc -l MEMORY.md` ≤ 180 lines to leave headroom.

**Longer-term feature idea for Memoir:** automatic index hygiene — detect when MEMORY.md is pushing the loader cap, warn user, or auto-extract inline blocks into topic files. This problem will recur for every heavy user.

**Related:** pairs with cross-machine-sync-bug.md — both are core memory-system usability issues that made April 16 a frustrating session.
