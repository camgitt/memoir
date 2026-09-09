// Lean-memory: keep the loaded memory index (MEMORY.md) under a budget so the
// AI loads ALL of it and wastes no context on bloat. When over budget, the
// fattest sections are moved into a dated archive file and replaced with
// one-line pointers.
//
// Two budgets, both enforced: lines (Claude Code reads only ~200) and
// characters (what the index actually costs in tokens). Characters were added
// after a real 19,450-character index sat at 84 lines — under half the line
// budget — and was therefore never tidied once, while costing ~5,000 tokens on
// every session.
//
// Guarantees: archive-not-delete (nothing lost), never touches the critical
// behavior-rules section or the preamble, idempotent, dry-run capable,
// code-fence aware, content-deduped, atomic writes, graceful on errors.

import fs from 'fs-extra';
import path from 'path';
import { appendEvent } from '../events/log.js';

export const DEFAULT_BUDGET = 180; // Claude loads ~200 lines of MEMORY.md; leave headroom.

// Lines were the wrong unit. A real index (19,450 chars in 84 lines) sat at
// less than half the line budget and was never tidied once, because the cost
// that matters is characters — those 84 lines were ~5,000 tokens, 12% of every
// session's opening prompt. Both budgets are enforced now; whichever is
// exceeded first triggers a tidy.
export const DEFAULT_BUDGET_CHARS = 12000; // ~3,000 tokens of loaded index.

// A pointer is only cheap if it is actually short. `- [Title](file.md) — hook`
// is a pointer; the same shape carrying 400 characters of summary is inline
// content wearing a pointer's costume, and treating it as weightless is what
// let the index grow unbounded while every section scored zero.
const POINTER_MAX_CHARS = 160;

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

// Lines of inline (non-pointer, non-header) content — the original metric,
// kept because the line budget still uses it.
function inlineWeight(section) {
  return section.lines.filter(l => {
    const t = l.trim();
    if (!t) return false;
    if (/^#{2,3}\s/.test(t)) return false;
    if (isPointer(t)) return false;
    return true;
  }).length;
}

// Characters a section costs to load. Headers are free (they stay either way).
// A short pointer is free; an over-long one is charged in full, because that is
// exactly the line the old metric scored at zero.
function charWeight(section) {
  let total = 0;
  for (const line of section.lines) {
    const t = line.trim();
    if (!t || /^#{2,3}\s/.test(t)) continue;
    if (isPointer(t) && t.length <= POINTER_MAX_CHARS) continue;
    total += line.length + 1; // + the newline it costs
  }
  return total;
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
 * Tidy MEMORY.md down under `budgetLines` AND `budgetChars`.
 * @returns { overBudget, lineCount, charCount, newLineCount?, newCharCount?, budgetLines, budgetChars, archived[], archiveFile?, dryRun? } | { ok:false, reason }
 */
export async function tidyIndex(memoryDir, { budgetLines = DEFAULT_BUDGET, budgetChars = DEFAULT_BUDGET_CHARS, dryRun = false, stamp = 'archive' } = {}) {
  const mdPath = path.join(memoryDir, 'MEMORY.md');
  let text;
  try {
    if (!await fs.pathExists(mdPath)) return { ok: false, reason: 'no MEMORY.md' };
    text = await fs.readFile(mdPath, 'utf8');
  } catch (err) {
    return { ok: false, reason: `read failed: ${err.code || err.message}` };
  }

  const lineCount = text.split('\n').length;
  const charCount = text.length;
  if (lineCount <= budgetLines && charCount <= budgetChars) {
    return { overBudget: false, lineCount, charCount, budgetLines, budgetChars, archived: [] };
  }

  const sections = splitSections(text);
  const archiveFile = `memory_index_archive_${stamp}.md`;
  const archivePath = path.join(memoryDir, archiveFile);

  // Read the prior archive ONCE so we can content-dedup (no re-append bloat).
  let priorArchive = '';
  try { if (await fs.pathExists(archivePath)) priorArchive = await fs.readFile(archivePath, 'utf8'); } catch {}

  // Skip empty headers (would make `- []()`) and protected sections.
  // A section is worth archiving if it is fat in EITHER unit. Ranked by
  // characters, since that is what the loaded index actually costs.
  const candidates = sections
    .map((s, i) => ({ i, s, weight: inlineWeight(s), chars: charWeight(s) }))
    .filter(c => (c.weight >= 6 || c.chars >= 600) && c.s.header.trim().length > 0 && !PROTECTED(c.s.header))
    .sort((a, b) => b.chars - a.chars || b.weight - a.weight);

  const removeIdx = new Map();
  const archived = [];
  let toAppend = '';
  let projected = lineCount;
  let projectedChars = charCount;
  for (const c of candidates) {
    if (projected <= budgetLines && projectedChars <= budgetChars) break;
    const body = c.s.lines.join('\n');
    const key = body.trim();
    // Only append content not already archived — dedup prevents bloat; the
    // section is still safely in the archive so removing it from MEMORY.md is
    // never a loss.
    if (key && !priorArchive.includes(key) && !toAppend.includes(key)) {
      toAppend += body + '\n\n';
    }
    const pointer = `- [${c.s.header}](${archiveFile}) — moved out of the index ${stamp} (full detail in file)`;
    removeIdx.set(c.i, pointer);
    archived.push({ section: c.s.header, lines: c.s.lines.length, chars: c.chars });
    projected -= (c.s.lines.length - 1);
    projectedChars -= (body.length - pointer.length);
  }

  if (!archived.length) return { overBudget: true, lineCount, charCount, budgetLines, budgetChars, archived: [], note: 'over budget but no fat inline sections found' };
  if (dryRun) return { overBudget: true, lineCount, charCount, projectedLines: projected, projectedChars, budgetLines, budgetChars, wouldArchive: archived, dryRun: true };

  const out = [];
  for (let i = 0; i < sections.length; i++) {
    if (removeIdx.has(i)) out.push(removeIdx.get(i));
    else out.push(...sections[i].lines);
  }

  if (!out.some(l => l.includes('memoir:schemaVersion'))) {
    out.push(MEMORY_SCHEMA_MARKER);
  }

  const fm = `---\nname: Memory index archive (${stamp})\ndescription: Fat sections moved out of MEMORY.md to keep the loaded index under ${budgetLines} lines and ${budgetChars} characters. Nothing deleted; pointers remain in MEMORY.md.\nmetadata:\n  type: reference\n---\n`;
  const base = priorArchive || fm;
  if (toAppend) await atomicWrite(archivePath, base.trimEnd() + '\n\n' + toAppend.trimEnd() + '\n');
  const newText = out.join('\n');
  await atomicWrite(mdPath, newText);

  // Only reached when tidyIndex actually changed something (both earlier
  // no-op paths — under budget, or over budget with nothing archivable —
  // return before this point, and dryRun never writes). The event should
  // mean "something happened," not "this function was called."
  await appendEvent('tidy_ran', {
    archived_count: archived.length,
    from_lines: lineCount, to_lines: out.length,
    from_chars: charCount, to_chars: newText.length,
  });

  return {
    overBudget: true,
    lineCount, newLineCount: out.length,
    charCount, newCharCount: newText.length,
    budgetLines, budgetChars, archived, archiveFile,
  };
}
