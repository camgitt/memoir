# Cross-Machine Memory Sync (Mac ↔ Windows)

**Status (April 17, 2026):** Root cause fixed in `src/adapters/restore.js`. Two changes:
1. `detectLocalHomeKey` now prefers the encoded `os.homedir()` over mtime — stale foreign dirs can have newer mtimes and used to win.
2. New `cleanupLocalForeignKeys` sweep runs before remap on restore, merging any stale foreign home-key dirs into the local one and archiving the originals under `.memoir-archived-{ts}/`.

Trigger to re-open: if `~/.claude/projects/` ever grows a dir matching another machine's encoding (e.g. `C--Users-*` on Mac) and restore doesn't clean it up, those fixes aren't holding.

---

**Original problem:** User works across Mac (`/Users/camarthur/`) and Windows (`C:\Users\Asian-Beast\`). Memory stored on one machine is invisible on the other. Real pain point — user described it as "driving me bonkers" (April 16, 2026).

**Symptom:** Claude on Mac can't find projects that live on Windows (and vice versa). User has to re-explain project context or manually sync memory files via git. Searching for a project name on the wrong machine returns nothing.

**What Memoir should do:**
- Sync memory across machines automatically (cloud-backed store, or git-backed with auto push/pull)
- Unified project index — "which machine is project X on?" should be answerable from either side
- Resolve conflicts gracefully when same memory file edited on both machines

**Priority:** High — this is a daily-driver annoyance, not a nice-to-have.

**Related:** MEMORY.md already notes "User works on both Mac and Windows - use git for cross-machine state" but that's manual and hasn't been enough.
