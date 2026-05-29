// Decision registry lookup — `memoir why <query>`
// Search session.json decisions[] by text / why / rejected substring.
// Returns matching decisions sorted by recency.

import chalk from 'chalk';
import boxen from 'boxen';
import { readSession } from '../session/state.js';

function searchDecisions(decisions, query) {
  if (!query) return decisions;
  const q = String(query).toLowerCase();
  return decisions.filter(d => {
    const haystack = [d.text, d.why, d.rejected].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(q);
  });
}

export async function whyCommand(query) {
  const state = await readSession();
  const decisions = state.current?.decisions || [];
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

// Exported for MCP tool
export function findDecisions(state, query) {
  return searchDecisions(state.current?.decisions || [], query);
}
