#!/usr/bin/env node
// One-off cleanup script — tombstones (hidden:true) specific known-junk
// decisions in a session.json file. NOT wired into any CLI command or
// package.json script; this is meant to be run manually, once, by a human
// who has filled in the real junk text below and reviewed a --dry-run first.
//
// Background: the Commit 3 fix (anchor the user-note regex to message
// start) stops NEW junk decisions like this from being captured, but it
// does not retroactively clean up decisions that were already captured and
// persisted before the fix shipped. `hidden:true` is the tombstone field
// added in this commit (distinct from the existing `rejected` field, which
// is a live, user-facing "alternative considered and rejected" string) —
// render.js, why.js, and mcp.js's memoir_why handler all filter it out.
//
// Usage:
//   node scripts/cleanup-junk-decisions-2026-07.mjs <path-to-session.json> --dry-run   (review first)
//   node scripts/cleanup-junk-decisions-2026-07.mjs <path-to-session.json>              (apply)
//
// ⚠️  BEFORE RUNNING FOR REAL: JUNK_TEXT_SUBSTRINGS below are PLACEHOLDERS.
// Replace them with the exact junk decision text (the two junk entries
// described in the Commit 3 root-cause writeup) before running without
// --dry-run. Always run with --dry-run first and review the reported
// matches — a substring match against the wrong text would tombstone a
// real decision.
//
// Safety: always backs up the original file first (a NEW backup, separate
// from any automatic schema-migration backup readSession() might also take)
// before writing anything. Idempotent — running it twice never double-
// tombstones or errors; already-hidden decisions are skipped.

import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { migrateSessionData } from '../src/session/migrations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── FILL IN BEFORE RUNNING FOR REAL ───────────────────────────────────
// Substring match against decision.text (case-sensitive on purpose, to
// avoid over-matching). Keep these as a named, easy-to-find constant so
// they're trivial to verify before anyone runs this for real.
export const JUNK_TEXT_SUBSTRINGS = [
  'the service key is read as SUPABASE_SERVICE_KEY.',
  'off-screen render cost is ALREADY mitigated by content-visibility:auto',
  "the API keys live…' survives; any anchor/length fix must keep short message-start notes working",
  'Postgres for the database layer',
];
// ─────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const target = args.find((a) => !a.startsWith('--'));
  return { target, dryRun };
}

/**
 * Core logic, exported for direct testing against a synthetic fixture path
 * (never real data) — parseArgs/main below are the CLI wrapper.
 */
export async function cleanupJunkDecisions(sessionPath, { dryRun = false, junkSubstrings = JUNK_TEXT_SUBSTRINGS, log = console.log } = {}) {
  const resolvedPath = path.resolve(sessionPath);
  if (!(await fs.pathExists(resolvedPath))) {
    throw new Error(`No such file: ${resolvedPath}`);
  }

  const raw = await fs.readFile(resolvedPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Not valid JSON: ${resolvedPath} (${err.message})`);
  }

  // Same migrate-on-load normalization state.js's readSession() uses (pure,
  // no I/O — see src/session/migrations.js). This script accepts an
  // arbitrary path, not necessarily under the current process's $HOME, so
  // it can't call readSession() directly (that's hardcoded to the current
  // HOME's session.json) — this keeps identical normalization semantics
  // without that constraint.
  const { future, state } = migrateSessionData(parsed);
  if (future) {
    throw new Error(`Refusing to run: ${resolvedPath} is from a NEWER memoir schema version than this script understands. Upgrade memoir first.`);
  }

  const decisions = state.current?.decisions || [];
  const matched = [];
  for (const d of decisions) {
    if (d.hidden) continue; // already tombstoned — idempotent, skip
    const text = String(d.text || '');
    if (junkSubstrings.some((sub) => text.includes(sub))) {
      matched.push(d);
    }
  }

  if (matched.length === 0) {
    log(`No matching junk decisions found in ${resolvedPath}. Nothing to do.`);
    return { matched: [], backupPath: null, dryRun };
  }

  log(`${dryRun ? '[DRY RUN] Would tombstone' : 'Tombstoning'} ${matched.length} decision(s):`);
  for (const d of matched) {
    const preview = d.text.length > 100 ? d.text.slice(0, 100) + '...' : d.text;
    log(`  - "${preview}"`);
  }

  if (dryRun) {
    log('\nDry run — nothing written. Re-run without --dry-run to apply.');
    return { matched: matched.map((d) => d.text), backupPath: null, dryRun: true };
  }

  // Explicit backup, separate from any automatic migration backup.
  const backupPath = `${resolvedPath}.pre-cleanup-${Date.now()}`;
  await fs.copy(resolvedPath, backupPath);
  log(`Backed up original to: ${backupPath}`);

  const now = new Date().toISOString();
  for (const d of matched) {
    d.hidden = true;
    d.hidden_at = now;
  }

  const tmp = `${resolvedPath}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.move(tmp, resolvedPath, { overwrite: true });

  log(`Done — ${matched.length} decision(s) tombstoned (hidden:true) in ${resolvedPath}.`);
  return { matched: matched.map((d) => d.text), backupPath, dryRun: false };
}

async function main() {
  const { target, dryRun } = parseArgs(process.argv);
  if (!target) {
    console.error('Usage: node scripts/cleanup-junk-decisions-2026-07.mjs <path-to-session.json> [--dry-run]');
    process.exit(1);
  }
  try {
    await cleanupJunkDecisions(target, { dryRun });
  } catch (err) {
    console.error('cleanup-junk-decisions failed:', err.message);
    process.exit(1);
  }
}

// Only run the CLI wrapper when invoked directly (`node scripts/....mjs`),
// not when imported by a test.
if (path.resolve(process.argv[1] || '') === path.resolve(__dirname, 'cleanup-junk-decisions-2026-07.mjs')) {
  main();
}
