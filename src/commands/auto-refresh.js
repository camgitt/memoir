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
  } catch (err) {
    if (verbose) console.error(`memoir auto-refresh: ${err.message}`);
    // Never fail the hook — session start must proceed.
  }
}
