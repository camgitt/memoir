#!/usr/bin/env node
// Retrieval tests — src/memory/search.js (memoir_recall + `memoir recall`).
//
// The failure these guard against is the one shipped through 3.11: recall
// returned the FIRST 500 chars of each matching file (i.e. the YAML
// frontmatter), ranked purely by how many query words appeared anywhere.
// A model that called it got headers, not answers.

import fs from 'fs-extra';
import path from 'path';
import os from 'os';

// ⚠️  HOME MUST BE SHIMMED BEFORE THE FIRST ./src IMPORT — see
// test-decisions-hidden.mjs for the incident that made this rule.
const scratchHome = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-recall-test-'));
process.env.HOME = scratchHome;
process.env.USERPROFILE = scratchHome;

const BOLD = '\x1b[1m', GREEN = '\x1b[32m', RED = '\x1b[31m', CYAN = '\x1b[36m', RESET = '\x1b[0m';
let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ${GREEN}PASS${RESET} ${msg}`); pass++; }
  else      { console.log(`  ${RED}FAIL${RESET} ${msg}`); fail++; }
}

const {
  tokenize, normalize, termMatch, queryTerms, buildDoc, scoreDoc, extractPassage,
  searchMemories, formatRecallResults, withFrontmatterLists, clearSearchCache,
} = await import('./src/memory/search.js');

// Fixture store: what the Claude adapter walks is ~/.claude/projects/**/*.md
const memDir = path.join(scratchHome, '.claude', 'projects', '-scratch', 'memory');
await fs.ensureDir(memDir);

const FM = (fields, body) => `---\n${fields}\n---\n\n${body}\n`;

await fs.writeFile(path.join(memDir, 'project_wire_tape_surface.md'), FM(
`name: project_wire_tape_surface
description: "The Wire as a vertical swipe feed at /tape — full-screen story cards, one per swipe, its own analytics dimension"
type: project
aliases:
  - tiktok
  - reels
  - /tape
tags:
  - algothesis
  - mobile`,
`# The /tape surface

Built 2026-07-19 as an A/B against the list view. Each story is a full-screen card;
swipe up for the next. Uses a transform pager, not scroll-snap (iOS drift).

## Analytics
Every card view logs surface=tape so we can compare dwell time against the list.`));

await fs.writeFile(path.join(memDir, 'reference_authentication_flow.md'), FM(
`name: reference_authentication_flow
description: "How authentication works — Supabase getUser() server-side, cookie named from the client URL host"
type: reference`,
`Server components must call getUser(), never getSession(). The session cookie
name is derived from the Supabase URL host, so preview deployments differ.

Deployments that skip this step fail with 401 on the first authenticated route.`));

await fs.writeFile(path.join(memDir, 'project_deploy_notes.md'), FM(
`name: project_deploy_notes
description: "Deploy checklist for the app"
type: project`,
`fly deploy builds from the CWD's working tree. Deploy from a clean checkout.
After deploying, grep the machine for a string from your change to prove the
deploy actually shipped. Deploy deploy deploy — this file says deploy a lot.
Deploying on Fridays is fine if the deploy is small.`));

// A file that mentions every word once, weakly, in body only.
await fs.writeFile(path.join(memDir, 'misc_notes.md'), FM(
`name: misc_notes
description: "Assorted"
type: reference`,
`We talked about authentication once, and about the deploy, and about the tape.
Nothing decided.`));

// Legacy bare-markdown entry (no frontmatter) — must still be searchable.
await fs.writeFile(path.join(memDir, 'legacy_bare.md'),
`# Legacy note about the Databento spending limit

Never set a Databento spending limit; it silently drops symbols.
`);

// A per-project CLAUDE.md the project scan should find.
const projDir = path.join(scratchHome, 'someproject');
await fs.ensureDir(projDir);
await fs.writeFile(path.join(projDir, 'CLAUDE.md'), `# someproject\n\n## Surfaces\n- /tape — vertical swipe feed (see memory)\n`);

// ── Tokenizing / morphology ───────────────────────────────────────
console.log(`\n${BOLD}${CYAN}tokenize / normalize / termMatch${RESET}\n`);
assert(JSON.stringify(tokenize('Hello, World! foo_bar baz-qux v3.10.2')) === JSON.stringify(['hello', 'world', 'foo_bar', 'baz', 'qux', 'v3', '10']),
  'tokenize splits on punctuation and dots/dashes, keeps underscores');
assert(normalize('deploys') === 'deploy' && normalize('deploying') === 'deploy' && normalize('deployed') === 'deploy', 'normalize folds -s/-ing/-ed');
assert(normalize('was') === 'was' && normalize('ring') === 'ring' && normalize('this') === 'thi' || normalize('this') === 'this', 'normalize leaves short words alone (no sub-4-char stems)');
assert(normalize('policies') === 'policy' && normalize('classes') === 'class', 'normalize handles -ies and -sses');
assert(termMatch('auth', 'authentication') > 0 && termMatch('auth', 'authentication') < 1, 'prefix match auth→authentication scores below exact');
assert(termMatch('in', 'index') === 0, 'no prefix match below 4 chars ("in" ≠ "index")');
assert(JSON.stringify(queryTerms('what is the deploy process')) === JSON.stringify(['deploy', 'process']), 'queryTerms drops stopwords');
assert(queryTerms('what is it').length > 0, 'all-stopword query still yields terms rather than nothing');

// ── Scoring + passages ───────────────────────────────────────────
console.log(`\n${BOLD}${CYAN}searchMemories — ranking${RESET}\n`);
clearSearchCache();
let r = await searchMemories('tiktok', { root: scratchHome });
assert(r.results.length >= 1 && r.results[0].path.endsWith('project_wire_tape_surface.md'),
  '"tiktok" finds the vertical-swipe-feed file via aliases (the /tape amnesia case)');
assert(!/^---/.test(r.results[0].passage) && !/aliases:/.test(r.results[0].passage),
  'passage never contains frontmatter');

r = await searchMemories('auth cookie', { root: scratchHome });
assert(r.results[0].path.endsWith('reference_authentication_flow.md'), '"auth" prefix-matches "authentication"; both terms rank the auth file first');
assert(/getUser|cookie/i.test(r.results[0].passage), 'passage is the matched lines, not the file opening');

r = await searchMemories('deploy tape authentication', { root: scratchHome });
const order = r.results.map((x) => path.basename(x.path));
assert(order[0] === 'misc_notes.md',
  `coverage: the file that mentions all three terms outranks single-term files (got: ${order.slice(0, 3).join(' > ')})`);
assert(r.results.find((x) => x.path.endsWith('project_deploy_notes.md')).matched === 1, 'per-file matched-term count is reported');

r = await searchMemories('deploy', { root: scratchHome });
const deployHit = r.results.find((x) => x.path.endsWith('project_deploy_notes.md'));
assert(deployHit && r.results[0] === deployHit, 'a file that discusses deploy at length outranks a passing mention');
assert(deployHit.passage.length <= 720, `passage respects the ~700 char budget (${deployHit.passage.length})`);

r = await searchMemories('databento limit', { root: scratchHome });
assert(r.results[0]?.path.endsWith('legacy_bare.md') && /spending limit/.test(r.results[0].passage), 'legacy bare-markdown entries are searchable and yield a passage');

r = await searchMemories('surfaces', { root: scratchHome });
assert(r.results.some((x) => x.tool.startsWith('Project:') && x.path.endsWith('CLAUDE.md')), 'per-project CLAUDE.md files are indexed');

r = await searchMemories('zzzz qqqq', { root: scratchHome });
assert(r.results.length === 0 && /No memories found/.test(formatRecallResults('zzzz qqqq', r)), 'no-match path is clean');

// ── Frontmatter-only hits ─────────────────────────────────────────
r = await searchMemories('analytics dimension', { root: scratchHome });
assert(r.results[0].path.endsWith('project_wire_tape_surface.md') && r.results[0].passage.length > 0,
  'a description-only match still returns a body passage (opening lines)');

// ── Cache ────────────────────────────────────────────────────────
console.log(`\n${BOLD}${CYAN}cache${RESET}\n`);
{
  const realReadFile = fs.readFile;
  let reads = 0;
  fs.readFile = async (...a) => { reads++; return realReadFile.apply(fs, a); };
  try {
    await searchMemories('tiktok', { root: scratchHome });
    const afterFirst = reads;
    await searchMemories('tiktok', { root: scratchHome });
    assert(reads === afterFirst, `second identical search re-reads no files (${reads - afterFirst} reads)`);
    // Touch a file → exactly that file is re-read.
    const p = path.join(memDir, 'misc_notes.md');
    await new Promise((res) => setTimeout(res, 20));
    await fs.writeFile(p, (await realReadFile.call(fs, p, 'utf8')) + '\nEdited: tiktok mention added.\n');
    const before = reads;
    const r2 = await searchMemories('tiktok', { root: scratchHome });
    assert(reads === before + 1, `an edited file is re-read once (${reads - before} reads)`);
    assert(r2.results.some((x) => x.path.endsWith('misc_notes.md')), 'and the edit is visible to search immediately');
  } finally {
    fs.readFile = realReadFile;
  }
}

// ── withFrontmatterLists (write side) ─────────────────────────────
console.log(`\n${BOLD}${CYAN}withFrontmatterLists${RESET}\n`);
{
  const noFm = withFrontmatterLists('# Hello\n\nbody', { aliases: ['a', 'b'] });
  assert(/^---\naliases:\n  - "a"\n  - "b"\n---\n# Hello/.test(noFm), 'creates minimal frontmatter when absent');
  const withFm = withFrontmatterLists('---\nname: x\ntags:\n  - one\n---\nbody', { aliases: ['zeta'], tags: ['two', 'one'] });
  const { fields } = (await import('./src/commands/validate.js')).parseFrontmatter(withFm);
  assert(fields.name === 'x', 'preserves existing fields');
  assert(JSON.stringify(fields.tags) === JSON.stringify(['one', 'two']), 'merges + dedupes an existing list');
  assert(JSON.stringify(fields.aliases) === JSON.stringify(['zeta']), 'adds a missing list');
  assert(withFrontmatterLists('plain', {}) === 'plain' && withFrontmatterLists('plain', { aliases: [] }) === 'plain', 'no-op when nothing to add');
  const doc = buildDoc({ path: 'x.md', content: withFm, tool: 't' });
  assert(scoreDoc(doc, ['zeta']).score > 0, 'the injected alias is scored on read');
}

// ── Passage extraction shape ─────────────────────────────────────
console.log(`\n${BOLD}${CYAN}extractPassage${RESET}\n`);
{
  const body = Array.from({ length: 40 }, (_, i) => `line ${i} ${i === 10 || i === 30 ? 'needle' : 'hay'}`).join('\n');
  const doc = buildDoc({ path: 'p.md', content: body, tool: 't' });
  const p = extractPassage(doc, ['needle']);
  assert(/line 9 hay\nline 10 needle\nline 11 hay/.test(p), 'window = hit ± 1 line of context');
  assert(/⋯/.test(p) && /line 30 needle/.test(p), 'multiple windows joined with a separator, in document order');
  assert(!/line 20/.test(p), 'unmatched regions are omitted');
}

await fs.remove(scratchHome).catch(() => {});
console.log(`\n${BOLD}${pass} passed, ${fail} failed${RESET}\n`);
process.exit(fail ? 1 : 0);
