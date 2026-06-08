// Auto-refresh — called by the Claude Code SessionStart hook.
// Reads current session.json (local) and re-injects the pinned block into
// CLAUDE.md. Instant, no network, no side effects beyond that file.
//
// For cross-machine pull-on-start, that's a separate concern — handled by
// periodic auto-restore or explicit `memoir restore`. This hook only ensures
// the pinned block matches the current local session state.

import { readSession } from '../session/state.js';
import { renderSession } from '../session/render.js';
import { injectInto, detectAvailableTargets } from '../session/inject.js';
import { ensureRecallInstruction } from './activate.js';
import { tidyIndex } from './tidy.js';
import { resolveHomeMemoryDir } from '../context/capture.js';

export async function autoRefreshCommand(options = {}) {
  const verbose = !!options.verbose;
  try {
    const state = await readSession();
    const rendered = renderSession(state);
    const targets = detectAvailableTargets();
    for (const [tool, target] of Object.entries(targets)) {
      try {
        const res = await injectInto(target, rendered);
        if (verbose) console.log(`memoir auto-refresh: ${res.replaced ? 'updated' : 'created'} ${tool} → ${res.path}`);
      } catch (err) {
        if (verbose) console.error(`memoir auto-refresh: ${tool} failed: ${err.message}`);
      }
    }
    // Ensure recall is globally active (idempotent) so the AI uses memoir in
    // every project without a manual `memoir activate`.
    try {
      const r = await ensureRecallInstruction();
      if (verbose && r.added) console.log(`memoir auto-refresh: enabled recall in ${r.added} global config(s)`);
    } catch (err) {
      if (verbose) console.error(`memoir auto-refresh: ensureRecallInstruction failed: ${err.message}`);
    }
    // Lean-memory: keep the loaded index under budget so the AI loads ALL of it
    // and wastes no context on bloat. Over-budget-only, archive-not-delete,
    // opt out with MEMOIR_NO_AUTO_TIDY.
    if (!process.env.MEMOIR_NO_AUTO_TIDY) {
      try {
        const dir = resolveHomeMemoryDir();
        if (dir) {
          const t = await tidyIndex(dir, { stamp: 'auto' });
          if (verbose && t.archived?.length) {
            console.log(`memoir auto-refresh: tidied index → archived ${t.archived.length} section(s), now ${t.newLineCount} lines`);
          }
        }
      } catch (err) {
        if (verbose) console.error(`memoir auto-refresh: tidy failed: ${err.message}`);
      }
    }
  } catch (err) {
    if (verbose) console.error(`memoir auto-refresh: ${err.message}`);
    // Never fail the hook — session start must proceed.
  }
}
