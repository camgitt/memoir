// Synthetic filesystem benchmark. No models, network, or real user memories.
// Run unchanged against a prior checkout with --repo to compare implementations.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const option = (key, fallback) => { const i = args.indexOf('--' + key); return i < 0 ? fallback : args[i + 1]; };
const repo = path.resolve(option('repo', fileURLToPath(new URL('..', import.meta.url))));
const sizes = option('sizes', '1000,10000').split(',').map(Number);
const samples = Number(option('samples', '120'));
const kinds = option('kinds', 'adapter,canonical').split(',');
if (!sizes.every(n => Number.isInteger(n) && n > 0 && n <= 50000) || !Number.isInteger(samples) || samples < 2 || samples > 1000 || !kinds.every(k => ['adapter', 'canonical'].includes(k))) throw new Error('Invalid benchmark options');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-retrieval-bench-'));
const realHomedir = os.homedir;
// Only this process sees the fixture home; no system environment is repurposed.
os.homedir = () => scratch;
process.env.DO_NOT_TRACK = '1';
globalThis.fetch = async () => { throw new Error('Network prohibited in evaluation'); };
const fixtureVersion = 'coding-retrieval-v1';
const prose = [
  'The migration must create the new table before updating the reader. Keep the old reader available until the verification passes.',
  'The rejected approach used a timer to hide the race. A transaction with an idempotency key prevents duplicate work.',
  'The last session tested rollback against a disposable local database. That result describes the saved checkout, not every later commit.',
  'An unsuccessful retry reused the old session token. Fetch the current token and confirm the request belongs to this project.',
  'Record evidence from the test output and keep the pending check separate from a verified result.',
  'Résumé: vérifier la migration et conserver les preuves. 数据库迁移需要验证。認証の更新を確認する。',
].join('\n');
const queries = [
  'amberkingfisher recovery', 'migration reader', 'transaction idempotency', 'rejected timer',
  'rollback disposable', 'session token', 'verification evidence', 'migration vérifi',
  '数据库迁移', '認証', 'zzunknownnothing', 'component42',
];
const results = [];
try {
  const { adapters } = await import(pathToFileURL(path.join(repo, 'src/adapters/index.js')));
  const { searchMemories, clearSearchCache } = await import(pathToFileURL(path.join(repo, 'src/memory/search.js')));
  const { projectIdentity } = await import(pathToFileURL(path.join(repo, 'src/memory/scope.js')));
  const { memoryRoot } = await import(pathToFileURL(path.join(repo, 'src/memory/store.js')));
  const project = path.join(scratch, 'project');
  await fs.mkdir(project);
  const projectId = projectIdentity(project);
  const source = path.join(scratch, 'adapter');
  for (const kind of kinds) for (const count of sizes) {
    await fs.rm(source, { recursive: true, force: true });
    await fs.rm(memoryRoot, { recursive: true, force: true });
    const dest = kind === 'canonical' ? memoryRoot : source;
    await fs.mkdir(dest, { recursive: true });
    adapters.splice(0, adapters.length, ...(kind === 'adapter' ? [{ name: 'Benchmark', source, filter: () => true }] : []));
    const digest = crypto.createHash('sha256');
    let bytes = 0;
    for (let offset = 0; offset < count; offset += 32) {
      const writes = [];
      for (let i = offset; i < Math.min(count, offset + 32); i++) {
        const id = crypto.createHash('sha256').update('record-' + i).digest('hex');
        const filename = kind === 'canonical' ? id + '.md' : 'record-' + i + '.md';
        const content = ['---', 'id: ' + id, 'name: component' + i, 'project: ' + projectId, 'type: decision', 'description: Component migration and recovery constraints', '---', '# Component ' + i, prose, i === count - 1 ? 'amberkingfisher recovery uses the verified snapshot.' : 'Routine component operations require a current smoke check.'].join('\n');
        // Exclude machine-specific project IDs from the portable fixture hash.
        digest.update(filename + '\0' + content.replace(projectId, '<project>'));
        bytes += Buffer.byteLength(content);
        writes.push(fs.writeFile(path.join(dest, filename), content));
      }
      await Promise.all(writes);
    }
    clearSearchCache();
    const all = [];
    for (let i = 0; i <= samples; i++) {
      const query = i === 0 ? queries[0] : queries[(i - 1) % queries.length];
      const start = performance.now();
      const r = await searchMemories(query, { root: project, project, limit: 5, budget: 1800 });
      const ms = performance.now() - start;
      if (query === queries[0] && !r.results.some(x => x.passage.includes('verified snapshot'))) throw new Error('Required result missing');
      if (query === 'zzunknownnothing' && r.results.length) throw new Error('No-evidence query returned a result');
      all.push({ query, ms, total: r.total, results: r.results.length });
    }
    const warm = all.slice(1).map(r => r.ms).sort((a, b) => a - b);
    const row = { kind, records: count, bytes, fixture_sha256: digest.digest('hex'), cold_ms: all[0].ms, warm_samples: samples, warm_median_ms: warm[Math.floor(warm.length / 2)], warm_p95_ms: warm[Math.ceil(warm.length * .95) - 1], rss_bytes: process.memoryUsage().rss, queries: all };
    results.push(row);
    console.error(JSON.stringify({ kind, count, cold_ms: row.cold_ms, median_ms: row.warm_median_ms, p95_ms: row.warm_p95_ms }));
  }
  let commit = null;
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(); } catch {}
  const sourceFiles = {};
  for (const relative of ['src/memory/search.js', 'src/memory/scope.js', 'src/memory/lexical-index.js', 'src/security/files.js']) {
    try { sourceFiles[relative] = crypto.createHash('sha256').update(await fs.readFile(path.join(repo, relative))).digest('hex'); }
    catch (err) { if (err.code !== 'ENOENT') throw err; sourceFiles[relative] = null; }
  }
  const report = { label: 'Synthetic retrieval latency; not a coding utility or SOTA evaluation', fixture_version: fixtureVersion, harness_sha256: crypto.createHash('sha256').update(await fs.readFile(fileURLToPath(import.meta.url))).digest('hex'), source_commit: commit, source_file_sha256: sourceFiles, measured_at: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, protocol: 'In-process public search API, including filesystem discovery/validation, parsing, ranking, and passage generation. One cold query then a fixed mixed query cycle. OS file cache is not flushed. RSS is process-wide. Sources are synthetic. File hashes identify the measured implementation even if the checkout has uncommitted edits.', results };
  const json = JSON.stringify(report, null, 2) + '\n';
  if (option('output', null)) await fs.writeFile(path.resolve(option('output')), json);
  else console.log(json);
} finally {
  os.homedir = realHomedir;
  await fs.rm(scratch, { recursive: true, force: true });
}
