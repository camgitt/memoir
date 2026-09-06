// Development regression evaluation, not a held-out SOTA benchmark.
// All storage is synthetic; no model/network calls or user memory are used.
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const fixturePath = fileURLToPath(new URL('./cases.json', import.meta.url));
const fixtureRaw = await fs.readFile(fixturePath);
const fixture = JSON.parse(fixtureRaw);
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-evaluation-'));
process.env.HOME = scratch;
process.env.USERPROFILE = scratch;
process.env.APPDATA = path.join(scratch, 'AppData', 'Roaming');
process.env.DO_NOT_TRACK = '1';
process.env.CI = '1';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = path.join(scratch, 'gitconfig');
globalThis.fetch = async () => { throw new Error('Network prohibited during evaluation'); };
try {
  const projects = { alpha: path.join(scratch, 'alpha'), beta: path.join(scratch, 'beta') };
  await Promise.all(Object.values(projects).map(dir => fs.ensureDir(dir)));
  process.env.MEMOIR_PROJECT_ROOT = projects.alpha;
  const { rememberMemory, readStoredMemories } = await import('../src/memory/store.js');
  const { searchMemories } = await import('../src/memory/search.js');
  const ids = new Map();
  for (const record of fixture.records) {
    const metadata = { ...(record.metadata || {}), name: record.key };
    const content = ['---', ...Object.entries(metadata).map(([key, value]) => key + ': ' + JSON.stringify(value)), '---', record.text].join('\n');
    const saved = await rememberMemory({
      filename: record.key + '.md', content,
      project: projects[record.project || 'alpha'],
      scope: record.project === 'shared' ? 'shared' : 'project',
      aliases: record.aliases || [],
    });
    ids.set(saved.id, record.key);
  }
  const raw = await readStoredMemories();
  const rows = [];
  for (const test of fixture.cases) {
    const started = performance.now();
    const output = await searchMemories(test.query, { project: projects[test.project || 'alpha'], limit: 5, budget: 1800 });
    const milliseconds = performance.now() - started;
    const reference = await searchMemories(test.query, { project: projects[test.project || 'alpha'], limit: 5, budget: 1800, engine: 'scan' });
    const retrieved = output.results.map(r => ids.get(r.id)).filter(Boolean);
    const substring = raw.filter(doc => test.query.trim() && doc.content.toLowerCase().includes(test.query.toLowerCase()))
      .slice(0, 5).map(doc => ids.get(path.basename(doc.path, '.md')));
    rows.push({ name: test.name, expected: test.expected, forbidden: test.forbidden || [], retrieved, substring, milliseconds,
      scan_reference: reference.results.map(r => ids.get(r.id)).filter(Boolean),
      matches_scan_output: JSON.stringify(output) === JSON.stringify(reference),
      passage_characters: output.results.reduce((sum, r) => sum + r.passage.length, 0) });
  }
  const metrics = field => {
    const positive = rows.filter(r => r.expected.length);
    const hits = positive.map(r => r.expected.filter(id => r[field].includes(id)).length / r.expected.length);
    const rr = positive.map(r => { const rank = r[field].findIndex(id => r.expected.includes(id)); return rank < 0 ? 0 : 1 / (rank + 1); });
    const negatives = rows.filter(r => !r.expected.length);
    return {
      recall_at_5: hits.reduce((a,b) => a+b, 0) / positive.length,
      mean_reciprocal_rank: rr.reduce((a,b) => a+b, 0) / positive.length,
      correct_abstentions: negatives.filter(r => r[field].length === 0).length,
      abstention_cases: negatives.length,
      forbidden_results: rows.reduce((sum, r) => sum + r[field].filter(id => r.forbidden.includes(id)).length, 0),
    };
  };
  const latencies = rows.map(r => r.milliseconds).sort((a,b) => a-b);
  const report = {
    label: 'Development fixture evaluation; created after implementation, not held out',
    fixture_sha256: crypto.createHash('sha256').update(fixtureRaw).digest('hex'),
    runtime: process.version, platform: process.platform, architecture: process.arch,
    records: fixture.records.length, cases: rows.length,
    memoir: metrics('retrieved'),
    scoped_scan_reference: metrics('scan_reference'),
    indexed_scan_agreement_cases: rows.filter(r => r.matches_scan_output).length,
    scan_reference_limit: 'Exhaustive scoring using the same source reader, visibility rules, and ranking formula. Measures index equivalence, not competitive quality. Use retrieval-performance.mjs for latency.',
    unscoped_substring_control: metrics('substring'),
    control_limit: 'Simple substring control, not the previous released ranking engine or a competing product',
    latency_ms: { median: latencies[Math.floor(latencies.length / 2)], p95: latencies[Math.ceil(latencies.length * .95)-1] },
    rows,
  };
  const json = JSON.stringify(report, null, 2) + '\n';
  if (process.argv[2]) await fs.outputFile(path.resolve(process.argv[2]), json);
  console.log(json);
  if (report.memoir.forbidden_results || report.memoir.recall_at_5 < 1 || report.memoir.correct_abstentions !== report.memoir.abstention_cases || report.indexed_scan_agreement_cases !== rows.length) process.exitCode = 1;
} finally { await fs.remove(scratch); }
