// `memoir forget <text>` — retract a decision.
//
// Sets the SPEC.md 5.3.1 absolute tombstone (hidden + hidden_at). Before
// 3.12 the ONLY thing that could do this was an unshipped dev script, so a
// user who auto-captured junk — or a secret — into the pinned block had no
// way to take it back. Now they do.
//
// Two rules that make this safe:
//   • Ambiguity is refused. Substring matching is convenient (same as
//     `memoir done`) but hiding is permanent by spec — hidden is monotonic
//     across every replica — so if more than one visible decision matches
//     we list them and ask for a more specific string, never guess.
//   • Interactive runs confirm before hiding. --yes skips that for scripts.
//
// --purge additionally redacts the text in place (keeps a sha256 identity
// so the tombstone still merges). Use it when the text itself must leave
// the file — a pasted key, a client name — not just leave the render.

import chalk from 'chalk';
import boxen from 'boxen';
import readline from 'readline';
import { readSession, matchDecisions, hideDecision } from '../session/state.js';
import { renderSession } from '../session/render.js';
import { injectInto, detectAvailableTargets } from '../session/inject.js';

async function refreshPinned() {
  const state = await readSession();
  const rendered = renderSession(state);
  const targets = detectAvailableTargets();
  for (const target of Object.values(targets)) {
    try { await injectInto(target, rendered); } catch {}
  }
}

function describe(d) {
  const lines = [chalk.white.bold(`  ${d.text}`)];
  if (d.why) lines.push(chalk.gray('    why: ') + chalk.white(d.why));
  if (d.rejected) lines.push(chalk.gray('    rejected: ') + chalk.white(d.rejected));
  if (d.date) lines.push(chalk.gray(`    ${String(d.date).slice(0, 10)}`));
  return lines.join('\n');
}

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  return /^y(es)?$/i.test(String(answer).trim());
}

export async function forgetCommand(text, options = {}) {
  const query = String(text || '').trim();
  if (!query) {
    console.log(chalk.yellow('\nUsage: ') + chalk.cyan('memoir forget "substring of the decision" [--purge] [--yes]\n'));
    return;
  }

  const state = await readSession();
  const matches = matchDecisions(state, query);

  if (matches.length === 0) {
    console.log('\n' + boxen(
      chalk.yellow(`No visible decision matches "${query}".`) + '\n\n' +
      chalk.gray('See what is recorded with: ') + chalk.cyan('memoir why'),
      { padding: 1, borderStyle: 'round', borderColor: 'yellow' }
    ) + '\n');
    return;
  }

  if (matches.length > 1) {
    console.log('\n' + chalk.yellow(`  "${query}" matches ${matches.length} decisions — be more specific, forgetting is permanent:`) + '\n');
    for (const d of matches) console.log(describe(d) + '\n');
    return;
  }

  const [target] = matches;
  console.log('\n' + chalk.cyan.bold(options.purge ? '  About to forget AND purge:' : '  About to forget:') + '\n');
  console.log(describe(target) + '\n');
  console.log(chalk.gray(options.purge
    ? '  The text will be redacted in session.json on this machine and, after sync, on every other machine. This cannot be undone.'
    : '  It will be hidden from the pinned block, memoir why, and MCP lookups on every machine after sync. This cannot be undone.'
  ) + '\n');

  if (!options.yes) {
    const ok = await confirm(chalk.white('  Forget it? [y/N] '));
    if (!ok) {
      console.log(chalk.gray('\n  Left as is.\n'));
      return;
    }
  }

  const res = await hideDecision(target.text, { purge: !!options.purge });
  if (!res.hidden) {
    console.log(chalk.yellow('\n  Nothing changed — it may have been forgotten by another process meanwhile.\n'));
    return;
  }
  await refreshPinned();
  console.log('\n' + chalk.green(res.purged ? '  ✓ Forgotten and purged.' : '  ✓ Forgotten.') +
    chalk.gray(' Run ') + chalk.cyan('memoir push') + chalk.gray(' to propagate the tombstone.\n'));
}
