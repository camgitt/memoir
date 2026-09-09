// Find and tombstone decisions that capture.js minted from a regex match
// rather than from anything the user actually decided.
//
// Why this is a command and not a third dated one-off script:
// scripts/cleanup-junk-decisions-2026-07.mjs was written for the July batch and
// its constants are that batch's text. The same class of row came back in
// September. A cleanup that has to be re-authored with hard-coded strings every
// time the extractor leaks is a workaround, not a fix — so the detector lives
// here, is tested, and runs on demand.
//
// What it looks for. extractDecisions() stores `match[0].trim().slice(0, 120)`
// — the matched SPAN, not the captured value — so a leaked row is literally the
// opening of one of its own patterns, cut wherever the regex stopped:
//
//   "rename the app from"      "let's use Redis for"    "the name is taken"
//
// The two signals that separate those from a real decision are the pattern
// lead-in and a trailing function word, and neither fires on a written one.
// A `why` is treated as proof of authorship: capture.js never writes one, and
// memoir_note always offers it. Length is the backstop — on this store the
// leaked rows run 16-31 characters and the shortest real one is 334.

import { visibleMemory } from '../memory/scope.js';

// The lead-ins are the extractDecisions() patterns' own opening clauses,
// anchored to the start of the text. A real decision that happens to contain
// "switch to X" mid-sentence is not matched.
const LEAD_IN = new RegExp([
  /^(?:the\s+)?(?:new\s+)?name\s+(?:is|will be|should be)\b/,
  /^(?:rename|call|name)\s+(?:it|this|the)\b/,
  /^(?:rebrand|rebranding)\s+(?:to|as)\b/,
  /^(?:let'?s|we(?:'ll| will| should)?|going to|decided to)\s+use\b/,
  /^(?:switch|migrate|move)\s+(?:from\s+\S+\s+)?to\b/,
  /^(?:stack|framework|database|backend|frontend|hosting|infra)\s+(?:is|will be|should be)\b/,
].map(r => r.source).join('|'), 'i');

// A sentence that stops on a preposition, article or copula was cut mid-clause.
const DANGLING = /\b(?:from|for|to|with|as|by|the|a|an|and|or|of|in|on|at|is|are|was|were|be)$/i;

// Above this length the row carries enough prose to be someone's actual words.
export const MAX_ARTIFACT_LENGTH = 60;

/**
 * Is this decision a capture artifact rather than a recorded decision?
 * Deliberately conservative — a false negative leaves one junk row in the
 * store, a false positive hides something the user meant to keep.
 */
export function isCaptureArtifact(decision) {
  if (!decision || decision.why || decision.rejected) return false;
  const text = String(decision.text || '').trim();
  if (!text || text.length > MAX_ARTIFACT_LENGTH) return false;
  return LEAD_IN.test(text) || DANGLING.test(text);
}

/**
 * Every live capture artifact in the store, with the reason each was flagged.
 * Already-tombstoned rows are skipped: they are the previous cleanup's output,
 * and re-reporting them would make each run look like a fresh problem.
 */
export function findCaptureArtifacts(state) {
  const buckets = ['decisions', 'archived_decisions'];
  const found = [];
  for (const bucket of buckets) {
    for (const [index, decision] of (state?.current?.[bucket] || []).entries()) {
      if (decision?.hidden) continue;
      if (!isCaptureArtifact(decision)) continue;
      const text = String(decision.text || '').trim();
      found.push({
        bucket,
        index,
        text,
        date: decision.date,
        reason: LEAD_IN.test(text) ? 'opens with a capture pattern' : 'ends mid-clause',
      });
    }
  }
  return found;
}

/**
 * Tombstone the given rows in place. `hidden: true` is memoir's existing
 * tombstone (render.js, why.js and the memoir_why handler all filter it), so
 * this hides rather than deletes — the text stays on disk and stays auditable.
 */
export function tombstone(state, artifacts, now = new Date().toISOString()) {
  for (const { bucket, index } of artifacts) {
    const decision = state.current?.[bucket]?.[index];
    if (!decision || decision.hidden) continue;
    decision.hidden = true;
    decision.hidden_at = now;
    decision.hidden_reason = 'capture-artifact';
  }
  return state;
}

/** Count of decisions a human would still see, for the report's denominator. */
export function visibleDecisionCount(state) {
  return [...(state?.current?.decisions || []), ...(state?.current?.archived_decisions || [])]
    .filter(d => !d?.hidden && visibleMemory(d, { allProjects: true })).length;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

/**
 * `memoir clean-decisions [--apply]`
 * Dry-run by default: nothing is written unless --apply is passed, because the
 * target is the user's live session.json.
 */
export async function cleanDecisionsCommand(options = {}) {
  const chalk = (await import('chalk')).default;
  const { readSession, writeSession } = await import('../session/state.js');

  const state = await readSession();
  const artifacts = findCaptureArtifacts(state);
  const total = visibleDecisionCount(state);

  if (!artifacts.length) {
    console.log('\n' + chalk.green(`  ✓ No capture artifacts among ${total} visible decision(s).\n`));
    return { found: 0, applied: 0 };
  }

  console.log('\n' + chalk.bold(`  ${artifacts.length} suspected capture artifact(s) of ${total} visible decision(s):`) + '\n');
  for (const a of artifacts) {
    console.log('    ' + chalk.red(JSON.stringify(a.text)));
    console.log('      ' + chalk.gray(`${(a.date || '').slice(0, 10)} · ${a.reason}`));
  }

  if (!options.apply) {
    console.log('\n' + chalk.yellow('  Dry run — nothing written.') +
      chalk.gray(' Re-run with --apply to tombstone these.\n'));
    return { found: artifacts.length, applied: 0 };
  }

  tombstone(state, artifacts);
  await writeSession(state);
  console.log('\n' + chalk.green(`  ✓ Tombstoned ${artifacts.length}.`) +
    chalk.gray(' Hidden, not deleted — the text stays on disk.\n'));
  return { found: artifacts.length, applied: artifacts.length };
}
