/**
 * Signal System Commands
 *
 * Self-improvement through feedback capture: ratings, failures, successes, learnings.
 * Stored in ~/.memoir/signals/
 */

import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import boxen from 'boxen';

const SIGNALS_DIR = path.join(os.homedir(), '.memoir', 'signals');

async function ensureSignalsDir() {
  await fs.ensureDir(SIGNALS_DIR);
  await fs.ensureDir(path.join(SIGNALS_DIR, 'failures'));
  await fs.ensureDir(path.join(SIGNALS_DIR, 'successes'));
  await fs.ensureDir(path.join(SIGNALS_DIR, 'synthesis'));
}

// ── Core signal operations (used by MCP + CLI) ─────────────────────────────

export async function rateSignal(rating, context = '', tags = []) {
  await ensureSignalsDir();
  const entry = {
    type: 'rating',
    rating,
    context,
    tags,
    timestamp: new Date().toISOString(),
  };
  const ratingsFile = path.join(SIGNALS_DIR, 'ratings.jsonl');
  await fs.appendFile(ratingsFile, JSON.stringify(entry) + '\n');
  return entry;
}

export async function logFailure(context, tags = []) {
  await ensureSignalsDir();
  const entry = {
    type: 'failure',
    context,
    tags,
    timestamp: new Date().toISOString(),
  };
  const filename = `${Date.now()}.json`;
  await fs.writeJson(path.join(SIGNALS_DIR, 'failures', filename), entry, { spaces: 2 });
  // Also append to ratings.jsonl for unified tracking
  const ratingsFile = path.join(SIGNALS_DIR, 'ratings.jsonl');
  await fs.appendFile(ratingsFile, JSON.stringify({ ...entry, rating: 1 }) + '\n');
  return entry;
}

export async function logSuccess(context, tags = []) {
  await ensureSignalsDir();
  const entry = {
    type: 'success',
    context,
    tags,
    timestamp: new Date().toISOString(),
  };
  const filename = `${Date.now()}.json`;
  await fs.writeJson(path.join(SIGNALS_DIR, 'successes', filename), entry, { spaces: 2 });
  const ratingsFile = path.join(SIGNALS_DIR, 'ratings.jsonl');
  await fs.appendFile(ratingsFile, JSON.stringify({ ...entry, rating: 5 }) + '\n');
  return entry;
}

export async function getLearnings(options = {}) {
  await ensureSignalsDir();
  const ratingsFile = path.join(SIGNALS_DIR, 'ratings.jsonl');

  if (!(await fs.pathExists(ratingsFile))) {
    return { totalSignals: 0, averageRating: 0, patterns: [], recentFailures: [], recentSuccesses: [] };
  }

  const raw = await fs.readFile(ratingsFile, 'utf8');
  const entries = raw.trim().split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);

  // Filter by time window
  let filtered = entries;
  if (options.last) {
    const match = options.last.match(/^(\d+)([dhm])$/);
    if (match) {
      const amount = parseInt(match[1]);
      const unit = match[2];
      const ms = unit === 'd' ? amount * 86400000 : unit === 'h' ? amount * 3600000 : amount * 60000;
      const cutoff = new Date(Date.now() - ms).toISOString();
      filtered = entries.filter(e => e.timestamp >= cutoff);
    }
  }

  // Compute stats
  const ratings = filtered.filter(e => e.rating != null);
  const avgRating = ratings.length > 0 ? ratings.reduce((s, e) => s + e.rating, 0) / ratings.length : 0;

  // Tag frequency analysis
  const tagCounts = {};
  const tagRatings = {};
  for (const e of filtered) {
    for (const tag of (e.tags || [])) {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      if (e.rating != null) {
        if (!tagRatings[tag]) tagRatings[tag] = [];
        tagRatings[tag].push(e.rating);
      }
    }
  }

  const patterns = Object.entries(tagRatings).map(([tag, rs]) => ({
    tag,
    count: tagCounts[tag],
    avgRating: (rs.reduce((s, r) => s + r, 0) / rs.length).toFixed(1),
  })).sort((a, b) => a.avgRating - b.avgRating);

  // Recent failures and successes
  const failures = filtered.filter(e => e.type === 'failure').slice(-5);
  const successes = filtered.filter(e => e.type === 'success').slice(-5);

  return {
    totalSignals: filtered.length,
    averageRating: avgRating.toFixed(1),
    patterns,
    recentFailures: failures,
    recentSuccesses: successes,
  };
}

// ── CLI Commands ────────────────────────────────────────────────────────────

export async function signalRateCommand(rating, options = {}) {
  if (!rating || isNaN(rating) || rating < 1 || rating > 5) {
    console.error(chalk.red('\n✖ Usage: memoir signal rate <1-5> [--context "..."]'));
    return;
  }

  const entry = await rateSignal(parseInt(rating), options.context || '', options.tags ? options.tags.split(',').map(t => t.trim()) : []);
  const stars = '★'.repeat(entry.rating) + '☆'.repeat(5 - entry.rating);
  console.log(chalk.green(`\n  ✔ Rated: ${chalk.yellow(stars)}`));
  if (entry.context) console.log(chalk.gray(`  Context: ${entry.context}`));
  console.log('');
}

export async function signalFailureCommand(options = {}) {
  if (!options.context) {
    console.error(chalk.red('\n✖ Usage: memoir signal failure --context "what went wrong"'));
    return;
  }

  await logFailure(options.context, options.tags ? options.tags.split(',').map(t => t.trim()) : []);
  console.log(chalk.red('\n  ✖ Failure logged'));
  console.log(chalk.gray(`  ${options.context}\n`));
}

export async function signalSuccessCommand(options = {}) {
  if (!options.context) {
    console.error(chalk.red('\n✖ Usage: memoir signal success --context "what worked"'));
    return;
  }

  await logSuccess(options.context, options.tags ? options.tags.split(',').map(t => t.trim()) : []);
  console.log(chalk.green('\n  ✔ Success logged'));
  console.log(chalk.gray(`  ${options.context}\n`));
}

export async function signalLearningsCommand(options = {}) {
  const learnings = await getLearnings(options);

  if (learnings.totalSignals === 0) {
    console.log(chalk.gray('\n  No signals recorded yet. Use "memoir signal rate <1-5>" to start.\n'));
    return;
  }

  const parts = [
    chalk.cyan.bold('Signal Learnings'),
    '',
    `  Total signals: ${chalk.white(learnings.totalSignals)}`,
    `  Average rating: ${chalk.yellow(learnings.averageRating + '/5')}`,
  ];

  if (learnings.patterns.length > 0) {
    parts.push('', chalk.white.bold('  Patterns by tag:'));
    for (const p of learnings.patterns) {
      const color = parseFloat(p.avgRating) >= 4 ? chalk.green : parseFloat(p.avgRating) <= 2 ? chalk.red : chalk.yellow;
      parts.push(`    ${color(p.avgRating)} avg  ${chalk.gray(`(${p.count}x)`)}  ${p.tag}`);
    }
  }

  if (learnings.recentFailures.length > 0) {
    parts.push('', chalk.red.bold('  Recent failures:'));
    for (const f of learnings.recentFailures) {
      parts.push(`    ✖ ${f.context}`);
    }
  }

  if (learnings.recentSuccesses.length > 0) {
    parts.push('', chalk.green.bold('  Recent successes:'));
    for (const s of learnings.recentSuccesses) {
      parts.push(`    ✔ ${s.context}`);
    }
  }

  console.log('\n' + boxen(parts.join('\n'), {
    padding: 1, borderStyle: 'round', borderColor: 'cyan', dimBorder: true
  }) + '\n');
}
