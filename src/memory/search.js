// Memory retrieval — the read side of memoir.
//
// Before 3.12 `memoir_recall` was `content.toLowerCase().includes(term)`
// per term, ranked by how many terms hit, and it returned the FIRST 500
// characters of each file. For a spec-shaped entry that is ~440 chars of
// YAML frontmatter and one truncated line of prose: the model asked a
// question, got ten headers back, and learned nothing. It also re-crawled
// ~1,000 directories under $HOME on every call to find project CLAUDE.md
// files (measured: 6,462 stat probes / call on a real machine).
//
// This module fixes the read path without adding a dependency:
//   • matched PASSAGES, frontmatter stripped, with a line of context;
//   • field-weighted scoring — aliases > name > description > headings >
//     body — with per-term saturation and a coverage multiplier so a file
//     that mentions all three query terms outranks one that hammers one;
//   • light morphology: plural/-ing/-ed folding plus prefix matching from
//     4 chars, so "auth" finds "authentication" and "deploys" finds
//     "deploy" (a real stemmer over-merges; this is deliberately timid);
//   • an mtime-keyed parse cache and a TTL'd project-file index, so a
//     long-lived MCP process stops re-reading and re-walking the disk.
//
// What it does NOT do: semantic/concept matching. "tiktok" still won't
// find a file that only ever says "vertical swipe feed". The honest,
// dependency-free answer to that is the `aliases:` frontmatter field
// (SPEC.md 3.2) written at save time and weighted heaviest here — the
// model that saves a memory knows what else it might be called.

import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { adapters } from '../adapters/index.js';
import { readStoredMemories } from './store.js';
import { visibleMemory, projectIdentity } from './scope.js';
import { readSession, allDecisions } from '../session/state.js';
import { readSafeFile, safePath } from '../security/files.js';
import { parseFrontmatter } from '../commands/validate.js';

const home = os.homedir();

// ── Tokenizing ───────────────────────────────────────────────────

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'it',
  'this', 'that', 'what', 'how', 'do', 'does', 'did', 'we', 'i', 'my', 'our',
  'with', 'about', 'was', 'were', 'be', 'are', 'at', 'by', 'from', 'as',
  'into', 'up', 'out', 'so', 'if', 'me', 'you', 'your', 'us',
  'why', 'when', 'where', 'which', 'who', 'can', 'should', 'would', 'could',
  'have', 'has', 'had', 'been', 'being', 'there', 'here', 'than', 'then',
]);

// Minimum length at which a token may match another by prefix. Below this
// "in" would match "index" and "at" would match "attribution".
const PREFIX_MIN = 4;

export function tokenize(str) {
  const chunks = String(str || '').normalize('NFKC').toLowerCase()
    .split(/[^\p{L}\p{N}_$./-]+/u).flatMap(t => t.split(/[./-]+/))
    .map(t => t.replace(/^[_$]+|[_$]+$/g, '')).filter(Boolean);
  return chunks.flatMap(t => {
    // CJK has no mandatory word separators. Index overlapping character
    // bigrams as well as the complete token; retain single-character queries.
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(t)) {
      const chars = Array.from(t);
      return [t, ...chars.slice(0, -1).map((c, i) => c + chars[i + 1])];
    }
    return t.length >= 2 || /^\p{N}$/u.test(t) ? [t] : [];
  });
}

// Fold the commonest English inflections. Conservative on purpose: every
// rule keeps a stem of at least 4 characters so short words are untouched
// ("was" -> "was", not "wa"), and -ing/-ed only strip from words long
// enough that the residue is still a word ("deploying" -> "deploy",
// "ring" -> "ring").
export function normalize(token) {
  let t = token;
  if (t.length >= 5 && t.endsWith('ies')) t = t.slice(0, -3) + 'y';
  else if (t.length >= 6 && t.endsWith('sses')) t = t.slice(0, -2);
  else if (t.length >= 4 && t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1);
  if (t.length >= 7 && t.endsWith('ing')) t = t.slice(0, -3);
  else if (t.length >= 6 && t.endsWith('ed')) t = t.slice(0, -2);
  return t;
}

// Does a normalized query term match a normalized document token?
// Returns 1 for an exact match, PREFIX_WEIGHT for a prefix match, 0 otherwise.
const PREFIX_WEIGHT = 0.6;
export function termMatch(term, token) {
  if (term === token) return 1;
  if (term.length >= PREFIX_MIN && token.startsWith(term)) return PREFIX_WEIGHT;
  if (token.length >= PREFIX_MIN && term.startsWith(token)) return PREFIX_WEIGHT;
  return 0;
}

export function queryTerms(query) {
  const raw = tokenize(query);
  const kept = raw.filter((t) => !STOPWORDS.has(t));
  // If the whole query was stopwords ("what is it"), search on it anyway
  // rather than returning nothing.
  const terms = (kept.length ? kept : raw).map(normalize);
  return Array.from(new Set(terms));
}

// ── Document model ───────────────────────────────────────────────

// Field weights. Aliases win because they exist for exactly one reason —
// they are the other names someone might search under. Then the entry's
// own name, its one-line description, headings, and finally prose.
const W = { aliases: 6, name: 4, description: 3, headings: 2, body: 1 };
// Body term-frequency saturates: 1 hit = 1.0, 3 = 1.5, 7 = 2.0. A file that
// says "deploy" forty times is not forty times more relevant.
const BODY_TF_CAP = 2;

function listField(v) {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v.trim()) return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

function fieldTokens(strings) {
  const out = new Map(); // normalized token -> count
  for (const s of strings) {
    for (const t of tokenize(s)) {
      const n = normalize(t);
      out.set(n, (out.get(n) || 0) + 1);
    }
  }
  return out;
}

/**
 * Parse a raw memory file into the shape the scorer wants. Cheap enough to
 * run on every file, but cached by (path, mtime, size) in readMemoryFiles.
 */
export function buildDoc({ path: relPath, content, tool, absPath, mtimeMs }) {
  const isMarkdown = /\.(md|mdc|markdown)$/i.test(relPath);
  const { fields, body: rawBody } = isMarkdown ? parseFrontmatter(content) : { fields: {}, body: content };
  const body = rawBody.replace(/<!--\s*memoir:session-block[^>]*-->[\s\S]*?<!--\s*\/memoir:session-block\s*-->/g, block => block.replace(/[^\r\n]/g, ''));
  const bodyLines = body.split(/\r?\n/);
  const headings = bodyLines.filter((l) => /^\s{0,3}#{1,6}\s/.test(l));

  const nameStrings = [path.basename(relPath).replace(/\.[^.]+$/, '')];
  if (fields.name) nameStrings.push(String(fields.name));

  return {
    ...fields,
    path: relPath,
    absPath,
    bodyStartLine: content.split(/\r?\n/).length - rawBody.split(/\r?\n/).length + 1,
    tool,
    mtimeMs: mtimeMs || 0,
    isMarkdown,
    type: fields.type || fields.metadata?.type || null,
    description: fields.description ? String(fields.description) : '',
    aliases: listField(fields.aliases),
    tags: listField(fields.tags),
    body,
    bodyLines,
    // Token maps per field
    tf: {
      aliases: fieldTokens([...listField(fields.aliases), ...listField(fields.tags)]),
      name: fieldTokens(nameStrings),
      description: fieldTokens([fields.description || '']),
      headings: fieldTokens(headings),
      body: fieldTokens(bodyLines),
    },
    // Kept for legacy callers (memoir_list sizes, memoir_read) — the raw file.
    content,
  };
}

// ── Scoring ──────────────────────────────────────────────────────

function fieldScore(tfMap, term) {
  // Best match across the field's tokens: exact beats prefix; tf saturates.
  let best = 0;
  let count = 0;
  for (const [token, n] of tfMap) {
    const m = termMatch(term, token);
    if (m > best) { best = m; count = n; }
    else if (m === best && m > 0) count += n;
  }
  if (!best) return 0;
  const tf = 0.5 + 0.5 * Math.log2(1 + count);
  return best * Math.min(BODY_TF_CAP, tf);
}

// A single term's evidence in one document is its best field hit plus a
// quarter of the rest, capped. Without the cap, a term that appears in the
// alias list AND the name AND the description AND a heading (which is
// exactly what a well-formed entry looks like) stacked to ~16 and let a
// one-term match outrank a file that covered every term in the query.
const TERM_CAP = 8;

export function scoreDoc(doc, terms) {
  let sum = 0;
  let matched = 0;
  const perTerm = {};
  for (const term of terms) {
    const fieldScores = Object.keys(W).map((f) => W[f] * fieldScore(doc.tf[f], term)).sort((a, b) => b - a);
    const s = Math.min(TERM_CAP, fieldScores[0] + 0.25 * fieldScores.slice(1).reduce((x, y) => x + y, 0));
    if (s > 0) matched++;
    perTerm[term] = s;
    sum += s;
  }
  if (!matched) return { score: 0, matched: 0, perTerm };
  const coverage = matched / terms.length;
  // Coverage-squared: a file that covers all the terms beats a file that
  // covers a third of them unless the partial match is overwhelming
  // (2/3 coverage keeps 44% of its raw score, 1/3 keeps 11%). This is the
  // "over-recall" fix — a common word no longer drags in every file that
  // mentions it once. Non-markdown (settings.json etc.) is de-weighted:
  // it is config, not memory, and matches on it are usually noise.
  const score = sum * coverage * coverage * (doc.isMarkdown ? 1 : 0.5);
  return { score, matched, coverage, perTerm };
}

// ── Passage extraction ───────────────────────────────────────────

const PASSAGE_BUDGET = 700;   // chars per result
const CONTEXT_LINES = 1;      // lines of context either side of a hit
const MAX_LINE = 240;         // clamp very long lines (pasted JSON, tables)

function lineMatches(line, terms) {
  const toks = tokenize(line).map(normalize);
  if (!toks.length) return 0;
  let hits = 0;
  for (const term of terms) {
    if (toks.some((t) => termMatch(term, t) > 0)) hits++;
  }
  return hits;
}

function clampLine(l) {
  const s = l.replace(/\s+$/, '');
  return s.length > MAX_LINE ? s.slice(0, MAX_LINE - 1) + '…' : s;
}

/**
 * The passage(s) of a document that best answer the query: matched lines
 * with a line of context either side, best windows first, within a byte
 * budget. Frontmatter is never included — callers get the description
 * separately for the header line.
 */
export function extractPassage(doc, terms, budget = PASSAGE_BUDGET) {
  const lines = doc.bodyLines;
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    const h = lineMatches(l, terms);
    if (h) hits.push({ i, h });
  }

  if (!hits.length) {
    // Match lived in frontmatter only (name/description/aliases). Show the
    // opening of the body so the reader still gets substance.
    const opening = lines.filter((l) => l.trim()).slice(0, 6).map(clampLine).join('\n');
    return opening.slice(0, budget);
  }

  // Merge hits into windows [start, end] with context, then rank windows by
  // (distinct terms matched desc, position asc).
  const windows = [];
  for (const { i, h } of hits) {
    const start = Math.max(0, i - CONTEXT_LINES);
    const end = Math.min(lines.length - 1, i + CONTEXT_LINES);
    const last = windows[windows.length - 1];
    if (last && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
      last.h = Math.max(last.h, h);
      last.hits++;
    } else {
      windows.push({ start, end, h, hits: 1 });
    }
  }
  windows.sort((a, b) => b.h - a.h || b.hits - a.hits || a.start - b.start);

  const chosen = [];
  let used = 0;
  for (const w of windows) {
    const text = lines.slice(w.start, w.end + 1).filter((l) => l.trim()).map(clampLine).join('\n');
    if (!text) continue;
    if (used && used + text.length > budget) continue;
    chosen.push({ ...w, text: used + text.length > budget ? text.slice(0, budget - used - 1) + '…' : text });
    used += text.length + 2;
    if (used >= budget) break;
  }
  // Present in document order so the excerpt reads naturally.
  chosen.sort((a, b) => a.start - b.start);
  return chosen.map((c) => c.text).join('\n⋯\n');
}

// ── Reading + caching ────────────────────────────────────────────

// (absPath) -> { mtimeMs, size, doc }. The MCP server is a long-lived
// process; memory files change rarely relative to how often recall runs.
const docCache = new Map();

async function readDoc(absPath, relPath, tool, root = path.dirname(absPath)) {
  let st;
  try { await safePath(root, path.relative(root, absPath)); st = await fs.lstat(absPath); if (!st.isFile()) return null; } catch { return null; }
  const hit = docCache.get(absPath);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.ctimeMs === st.ctimeMs && hit.ino === st.ino && hit.size === st.size) return hit.doc;
  let content;
  try { content = (await readSafeFile(root, path.relative(root, absPath))).toString('utf8'); } catch { return null; }
  const doc = buildDoc({ path: relPath, content, tool, absPath, mtimeMs: st.mtimeMs });
  docCache.set(absPath, { mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, ino: st.ino, size: st.size, doc });
  return doc;
}

/** Test hook — drop every cached parse. */
export function clearSearchCache() {
  docCache.clear();
  projectIndex.at = 0;
  projectIndex.files = [];
}

const MEMORY_EXT = /\.(md|mdc|json|toml|ya?ml)$/i;

/**
 * Read every memory file an adapter owns, as parsed docs. Cached by mtime.
 */
export async function readMemoryFiles(adapter) {
  const files = [];

  if (adapter.customExtract) {
    for (const file of adapter.files) {
      const abs = path.join(adapter.source, file);
      const doc = await readDoc(abs, file, adapter.name, adapter.source);
      if (doc) files.push(doc);
    }
    return files;
  }

  if (!(await fs.pathExists(adapter.source))) return files;

  const walk = async (dir, prefix = '') => {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (let offset = 0; offset < entries.length; offset += 24) {
      await Promise.all(entries.slice(offset, offset + 24).map(async entry => {
      const fullPath = path.join(dir, entry.name);
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (adapter.filter(fullPath)) await walk(fullPath, relPath);
      } else if (entry.isFile() && MEMORY_EXT.test(entry.name) && adapter.filter(fullPath)) {
        const doc = await readDoc(fullPath, relPath, adapter.name, adapter.source);
        if (doc) {
          const match = adapter.name === 'Claude CLI' ? relPath.match(/^projects\/([^/]+)\//) : null;
          files.push(match ? { ...doc, claudeProjectKey: match[1] } : doc);
        }
      }
      }));
    }
  };

  await walk(adapter.source);
  return files;
}

// Per-project AI config files. Discovery (the directory walk) is the
// expensive part and changes rarely, so the found-path list is cached for
// PROJECT_INDEX_TTL_MS; the files themselves go through readDoc's mtime cache.
const PROJECT_FILES = ['CLAUDE.md', 'GEMINI.md', 'CHATGPT.md', 'AGENTS.md', '.cursorrules', '.windsurfrules', '.clinerules'];
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', '.vercel', 'dist', 'build', '__pycache__', '.venv', 'venv', '.cache', 'Library', '.Trash', 'Applications', 'Downloads', 'Movies', 'Music', 'Pictures']);
const PROJECT_INDEX_TTL_MS = 60_000;
const PROJECT_SCAN_DEPTH = 3;
const projectIndex = { at: 0, files: [] };

async function discoverProjectFiles(root) {
  const found = [];
  const scan = async (dir, depth) => {
    if (depth > PROJECT_SCAN_DEPTH) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    const names = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
    for (const f of PROJECT_FILES) {
      if (names.has(f)) found.push({ abs: path.join(dir, f), rel: `${path.basename(dir)}/${f}`, project: dir });
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      await scan(path.join(dir, entry.name), depth + 1);
    }
  };
  await scan(root, 0);
  return found;
}

async function projectDocs(root = home) {
  const now = Date.now();
  if (now - projectIndex.at > PROJECT_INDEX_TTL_MS || projectIndex.root !== root) {
    projectIndex.files = await discoverProjectFiles(root);
    projectIndex.at = now;
    projectIndex.root = root;
  }
  const docs = [];
  for (const f of projectIndex.files) {
    const doc = await readDoc(f.abs, f.rel, `Project: ${f.project}`);
    if (doc) docs.push({ ...doc, project: projectIdentity(f.project) });
  }
  return docs;
}

// ── Write-side helper: aliases/tags into frontmatter ─────────────

/**
 * Merge `aliases` / `tags` lists into a markdown entry's frontmatter.
 * If the content has frontmatter, lists are added (or extended, deduped)
 * in the SPEC.md 3.1 `- item` shape. If it has none, a minimal block is
 * created — the entry becomes findable without forcing the caller to
 * author YAML. Existing unrelated fields are preserved verbatim.
 */
export function withFrontmatterLists(content, lists = {}) {
  const wanted = {};
  for (const [k, v] of Object.entries(lists)) {
    const arr = Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : [];
    if (arr.length) wanted[k] = arr;
  }
  if (!Object.keys(wanted).length) return content;

  const src = String(content || '');
  const lines = src.split(/\r?\n/);
  const hasFm = (lines[0] || '').trim() === '---' && lines.slice(1).some((l) => l.trim() === '---');

  const renderList = (key, arr) => [`${key}:`, ...arr.map((a) => `  - ${JSON.stringify(a)}`)];

  if (!hasFm) {
    const fm = ['---'];
    for (const [k, arr] of Object.entries(wanted)) fm.push(...renderList(k, arr));
    fm.push('---', '');
    return fm.join('\n') + src;
  }

  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  const head = lines.slice(1, end);
  const { fields } = parseFrontmatter(src);
  const out = [];
  const done = new Set();
  for (let i = 0; i < head.length; i++) {
    const line = head[i];
    const m = line.match(/^([^:\s][^:]*):\s*(.*)$/);
    const key = m ? m[1].trim() : null;
    if (key && wanted[key]) {
      // Replace this key (and any nested/list lines under it) with the merged list.
      const existing = listField(fields[key]);
      const merged = Array.from(new Set([...existing, ...wanted[key]].map((s) => s.trim()).filter(Boolean)));
      out.push(...renderList(key, merged));
      done.add(key);
      while (i + 1 < head.length && /^\s/.test(head[i + 1]) && head[i + 1].trim()) i++;
      continue;
    }
    out.push(line);
  }
  for (const [k, arr] of Object.entries(wanted)) {
    if (!done.has(k)) out.push(...renderList(k, arr));
  }
  return ['---', ...out, '---', ...lines.slice(end + 1)].join('\n');
}

// ── Search ───────────────────────────────────────────────────────

/**
 * Search every memory file (all adapters + per-project configs).
 * Returns ranked results with a passage each. Never throws on a bad file.
 */
export async function searchMemories(query, { limit = 10, root = home, project, allProjects = false, budget = 6000 } = {}) {
  const terms = queryTerms(query);
  if (!terms.length) return { terms, results: [], total: 0 };
  const docs = [];
  for (const adapter of adapters) {
    try { docs.push(...await readMemoryFiles(adapter)); } catch {}
  }
  try { docs.push(...await projectDocs(root)); } catch {}
  for (const raw of await readStoredMemories()) docs.push(buildDoc(raw));
  const state = await readSession();
  for (const d of allDecisions(state)) {
    if (!visibleMemory(d, { project, allProjects })) continue;
    const doc = buildDoc({ path: 'decisions/' + (d.id || d.date || 'legacy') + '.md', tool: 'Memoir decisions', content: [d.text, d.why, d.rejected ? 'Rejected: ' + d.rejected : ''].filter(Boolean).join('\n') });
    docs.push({ ...doc, id: d.id, project: d.project, type: 'decision', mtimeMs: Date.parse(d.date) || 0, source: 'session.json', evidence: { date: d.date, machine_id: d.machine_id } });
  }
  const candidates = docs.filter(doc => visibleMemory(doc, { project, allProjects }));
  const scored = [];
  for (const doc of candidates) {
    const score = scoreDoc(doc, terms);
    if (score.score > 0) scored.push({ doc, ...score });
  }
  // IDF improves rare-term discrimination while preserving field/coverage
  // behavior. Document frequencies use the same matching rules as retrieval.
  const df = new Map(terms.map(term => [term, scored.filter(r => r.perTerm[term] > 0).length]));
  for (const r of scored) {
    const idf = terms.reduce((sum, term) => sum + (r.perTerm[term] > 0 ? Math.log(1 + (candidates.length - df.get(term) + 0.5) / (df.get(term) + 0.5)) : 0), 0);
    r.score *= idf / Math.max(1, r.matched);
  }
  scored.sort((a, b) => b.score - a.score || b.doc.mtimeMs - a.doc.mtimeMs || a.doc.path.localeCompare(b.doc.path));
  let remaining = Math.max(256, Math.min(16000, Number(budget) || 6000));
  const top = [];
  const seen = new Set();
  for (const r of scored) {
    if (top.length >= limit || remaining < 80) break;
    const key = r.doc.id || r.doc.absPath || r.doc.path;
    if (seen.has(key)) continue;
    seen.add(key);
    const passage = extractPassage(r.doc, terms, Math.min(PASSAGE_BUDGET, remaining));
    if (!passage.trim()) continue;
    remaining -= passage.length;
    top.push({
      id: r.doc.id, project: r.doc.project || 'shared', tool: r.doc.tool,
      path: r.doc.path, type: r.doc.type, description: r.doc.description,
      score: r.score, coverage: r.coverage, matched: r.matched, passage,
      source: r.doc.source || r.doc.path,
      matchedLines: r.doc.bodyLines.flatMap((line, i) => lineMatches(line, terms) ? [r.doc.bodyStartLine + i] : []),
      updated: r.doc.updated || null,
    });
  }
  return { terms, results: top, total: scored.length };
}

/**
 * Plain-text rendering shared by the MCP tool and `memoir recall`.
 */
export function formatRecallResults(query, { terms, results, total }) {
  if (!results.length) {
    return `No memories found matching "${query}"${terms.length ? ` (terms: ${terms.join(', ')})` : ''}.`;
  }
  const blocks = results.map((r, i) => {
    const meta = [r.type, r.description].filter(Boolean).join(' · ');
    const cov = r.matched < terms.length ? ` · ${r.matched}/${terms.length} terms` : '';
    return [
      `── ${i + 1}. ${r.tool} / ${r.path}${cov} ──`,
      meta ? `   ${meta}` : null,
      r.passage,
    ].filter(Boolean).join('\n');
  });
  const shown = results.length;
  const head = total > shown
    ? `Found ${total} memories matching "${query}" — showing the top ${shown}. Use memoir_read for a full file.`
    : `Found ${total} memor${total === 1 ? 'y' : 'ies'} matching "${query}":`;
  return `${head}\n\n${blocks.join('\n\n')}`;
}
