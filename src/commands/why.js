// Decision registry lookup — `memoir why <query>`
// Search session.json decisions[] by text / why / rejected substring.
// Returns matching decisions sorted by recency.

import chalk from 'chalk';
import boxen from 'boxen';
import { readSession } from '../session/state.js';

function searchDecisions(decisions, query) {
  if (!query) return decisions;
  // Tokenize the query and match decisions containing any term, ranked by how
  // many terms hit (recency breaks ties). A single whole-phrase substring match
  // silently missed multi-word queries like "memoir positioning" even when every
  // word was present — which is exactly how the MCP memoir_why tool queries.
  const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return decisions;
  return decisions
    .map(d => {
      const haystack = [d.text, d.why, d.rejected].filter(Boolean).join(' ').toLowerCase();
      const score = terms.reduce((s, t) => s + (haystack.includes(t) ? 1 : 0), 0);
      return { d, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || String(b.d.date || '').localeCompare(String(a.d.date || '')))
    .map(x => x.d);
}

export async function whyCommand(query) {
  const state = await readSession();
  // hidden:true is a tombstone (distinct from the live `rejected` field) —
  // see scripts/cleanup-junk-decisions-2026-07.mjs. Excluded here so
  // tombstoned junk isn't fully discoverable via `memoir why` even after
  // being hidden from the pinned block.
  const decisions = (state.current?.decisions || []).filter(d => !d?.hidden);
  const matches = searchDecisions(decisions, query);

  if (matches.length === 0) {
    const msg = query
      ? chalk.yellow(`No decisions match "${query}".`) + '\n\n' +
        chalk.gray('Record one with: ') + chalk.cyan('memoir note "the decision" --why "rationale"')
      : chalk.yellow('No decisions recorded yet.') + '\n\n' +
        chalk.gray('Record one with: ') + chalk.cyan('memoir note "the decision" --why "rationale"');
    console.log('\n' + boxen(msg, { padding: 1, borderStyle: 'round', borderColor: 'yellow' }) + '\n');
    return;
  }

  const lines = [chalk.cyan.bold(`${matches.length} decision${matches.length !== 1 ? 's' : ''} matching "${query || '*'}":`)];
  lines.push('');
  for (const d of matches) {
    const date = (d.date || '').slice(0, 10);
    const label = state.machines?.[d.machine_id]?.label || '';
    lines.push(chalk.green('  ● ') + chalk.white.bold(d.text));
    if (d.why) lines.push(chalk.gray('    why: ') + chalk.white(d.why));
    if (d.rejected) lines.push(chalk.gray('    rejected: ') + chalk.white(d.rejected));
    if (date) lines.push(chalk.gray(`    ${date}${label ? ` on ${label}` : ''}`));
    lines.push('');
  }
  console.log('\n' + lines.join('\n'));
}

// Exported for MCP tool (memoir_why in mcp.js). Same hidden:true tombstone
// filter as whyCommand above — kept independent rather than relying solely
// on the caller, so this stays correct even if mcp.js's call chain changes.
export function findDecisions(state, query) {
  const decisions = (state.current?.decisions || []).filter(d => !d?.hidden);
  return searchDecisions(decisions, query);
}
