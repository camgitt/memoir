// `memoir recall <query>` — the same search the memoir_recall MCP tool runs,
// from the terminal. Exists so a human can see exactly what their AI would
// be handed for a question ("what would it see if it asked about X?"),
// which is the fastest way to notice a memory that was never written, or
// one that needs an `aliases:` line to be findable.

import chalk from 'chalk';
import { searchMemories } from '../memory/search.js';

export async function recallCommand(query, options = {}) {
  const q = String(query || '').trim();
  if (!q) {
    console.log(chalk.yellow('\nUsage: ') + chalk.cyan('memoir recall "what you want to find" [--limit N] [--json]\n'));
    return;
  }
  const limit = Math.max(1, Math.min(50, parseInt(options.limit, 10) || 10));
  const t0 = Date.now();
  const res = await searchMemories(q, { limit });
  const ms = Date.now() - t0;

  if (options.json) {
    console.log(JSON.stringify({ query: q, terms: res.terms, total: res.total, results: res.results }, null, 2));
    return;
  }

  if (!res.results.length) {
    console.log('\n' + chalk.yellow(`  No memories match "${q}"`) +
      (res.terms.length ? chalk.gray(` (searched: ${res.terms.join(', ')})`) : '') + '\n');
    return;
  }

  console.log('\n' + chalk.cyan.bold(`  ${res.total} match${res.total === 1 ? '' : 'es'} for "${q}"`) +
    chalk.gray(` · top ${res.results.length} · ${ms}ms · terms: ${res.terms.join(', ')}`) + '\n');
  res.results.forEach((r, i) => {
    const cov = r.matched < res.terms.length ? chalk.gray(` · ${r.matched}/${res.terms.length} terms`) : '';
    console.log(chalk.green(`  ${i + 1}. `) + chalk.white.bold(`${r.tool} / ${r.path}`) + cov);
    const meta = [r.type, r.description].filter(Boolean).join(' · ');
    if (meta) console.log(chalk.gray(`     ${meta}`));
    for (const line of r.passage.split('\n')) console.log(chalk.white('     ' + line));
    console.log('');
  });
}
