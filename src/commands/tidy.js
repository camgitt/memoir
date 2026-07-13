// Lean-memory: keep the loaded memory index (MEMORY.md) under a line budget so
// the AI loads ALL of it (Claude Code reads only ~200 lines) and wastes no
// context on bloat. When over budget, the fattest *inline* sections are moved
// into a dated archive file and replaced with one-line pointers.
//
// Guarantees: archive-not-delete (nothing lost), never touches the critical
// behavior-rules section or the preamble, idempotent, dry-run capable,
// code-fence aware, content-deduped, atomic writes, graceful on errors.

import fs from 'fs-extra';
import path from 'path';
import { appendEvent } from '../events/log.js';

export const DEFAULT_BUDGET = 180; // Claude loads ~200 lines of MEMORY.md; leave headroom.

// Split into ## sections — but a "## " INSIDE a fenced code block (``` or ~~~)
// is content, not a header, so we never split there (would orphan content +
// leave an unclosed fence = invalid markdown + data loss).
function splitSections(text) {
  const sections = [];
  let cur = { header: '(preamble)', lines: [] };
  let fence = null; // active fence marker while inside a code block
  for (const line of text.split('\n')) {
    const t = line.trimStart();
    const m = t.match(/^(```|~~~)/);
    if (m) {
      if (!fence) fence = m[1];
      else if (t.startsWith(fence)) fence = null;
    }
    if (!fence && /^##\s/.test(line)) {
      sections.push(cur);
      cur = { header: line.replace(/^##\s+/, '').trim(), lines: [line] };
    } else {
      cur.lines.push(line);
    }
  }
  sections.push(cur);
  return sections;
}

// A line is a lightweight pointer (not inline content to archive) if it's a
// clean `- [text](file)` OR any link to one of our archive files.
function isPointer(t) {
  if (/^- \[[^\]]+\]\([^)]+\)/.test(t)) return true;
  if (/\[[^\]]*\]\(memory_index_archive_[^)]*\)/.test(t)) return true;
  return false;
}

function inlineWeight(section) {
  return section.lines.filter(l => {
    const t = l.trim();
    if (!t) return false;
    if (/^#{2,3}\s/.test(t)) return false;
    if (isPointer(t)) return false;
    return true;
  }).length;
}

const PROTECTED = (header) => /critical behavior rules/i.test(header) || header === '(preamble)';

// Informational-only schema marker for MEMORY.md itself (distinct from — and
// unrelated to — session.json's SCHEMA_VERSION). No enforcement/refusal
// logic: this file is human-edited markdown, so a strict gate would hurt UX,
// not help it. Appended as a single HTML comment line (invisible when
// rendered) only when tidyIndex actually rewrites the file, and only once —
// idempotent, never duplicated on repeat runs. Counted in newLineCount like
// any other line, so it never causes a silent budget overshoot.
const MEMORY_SCHEMA_MARKER = '<!-- memoir:schemaVersion 1 -->';

async function atomicWrite(filePath, content) {
  const tmp = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(tmp, content);
  await fs.move(tmp, filePath, { overwrite: true });
}

/**
 * Tidy MEMORY.md down under `budgetLines`.
 * @returns { overBudget, lineCount, newLineCount?, budgetLines, archived[], archiveFile?, dryRun? } | { ok:false, reason }
 */
export async function tidyIndex(memoryDir, { budgetLines = DEFAULT_BUDGET, dryRun = false, stamp = 'archive' } = {}) {
  const mdPath = path.join(memoryDir, 'MEMORY.md');
  let text;
  try {
    if (!await fs.pathExists(mdPath)) return { ok: false, reason: 'no MEMORY.md' };
    text = await fs.readFile(mdPath, 'utf8');
  } catch (err) {
    return { ok: false, reason: `read failed: ${err.code || err.message}` };
  }

  const lineCount = text.split('\n').length;
  if (lineCount <= budgetLines) return { overBudget: false, lineCount, budgetLines, archived: [] };

  const sections = splitSections(text);
  const archiveFile = `memory_index_archive_${stamp}.md`;
  const archivePath = path.join(memoryDir, archiveFile);

  // Read the prior archive ONCE so we can content-dedup (no re-append bloat).
  let priorArchive = '';
  try { if (await fs.pathExists(archivePath)) priorArchive = await fs.readFile(archivePath, 'utf8'); } catch {}

  // Fattest inline sections first; skip empty headers (would make `- []()`) and
  // protected sections.
  const candidates = sections
    .map((s, i) => ({ i, s, weight: inlineWeight(s) }))
    .filter(c => c.weight >= 6 && c.s.header.trim().length > 0 && !PROTECTED(c.s.header))
    .sort((a, b) => b.weight - a.weight);

  const removeIdx = new Map();
  const archived = [];
  let toAppend = '';
  let projected = lineCount;
  for (const c of candidates) {
    if (projected <= budgetLines) break;
    const body = c.s.lines.join('\n');
    const key = body.trim();
    // Only append content not already archived — dedup prevents bloat; the
    // section is still safely in the archive so removing it from MEMORY.md is
    // never a loss.
    if (key && !priorArchive.includes(key) && !toAppend.includes(key)) {
      toAppend += body + '\n\n';
    }
    removeIdx.set(c.i, `- [${c.s.header}](${archiveFile}) — moved out of the index ${stamp} (full detail in file)`);
    archived.push({ section: c.s.header, lines: c.s.lines.length });
    projected -= (c.s.lines.length - 1);
  }

  if (!archived.length) return { overBudget: true, lineCount, budgetLines, archived: [], note: 'over budget but no fat inline sections found' };
  if (dryRun) return { overBudget: true, lineCount, projectedLines: projected, budgetLines, wouldArchive: archived, dryRun: true };

  const out = [];
  for (let i = 0; i < sections.length; i++) {
    if (removeIdx.has(i)) out.push(removeIdx.get(i));
    else out.push(...sections[i].lines);
  }

  if (!out.some(l => l.includes('memoir:schemaVersion'))) {
    out.push(MEMORY_SCHEMA_MARKER);
  }

  const fm = `---\nname: Memory index archive (${stamp})\ndescription: Fat inline sections moved out of MEMORY.md to keep the loaded index under ${budgetLines} lines. Nothing deleted; pointers remain in MEMORY.md.\nmetadata:\n  type: reference\n---\n`;
  const base = priorArchive || fm;
  if (toAppend) await atomicWrite(archivePath, base.trimEnd() + '\n\n' + toAppend.trimEnd() + '\n');
  await atomicWrite(mdPath, out.join('\n'));

  // Only reached when tidyIndex actually changed something (both earlier
  // no-op paths — under budget, or over budget with nothing archivable —
  // return before this point, and dryRun never writes). The event should
  // mean "something happened," not "this function was called."
  await appendEvent('tidy_ran', { archived_count: archived.length, from_lines: lineCount, to_lines: out.length });

  return { overBudget: true, lineCount, newLineCount: out.length, budgetLines, archived, archiveFile };
}
