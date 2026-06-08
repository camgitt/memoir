// Lean-memory: keep the loaded memory index (MEMORY.md) under a line budget so
// the AI loads ALL of it (Claude Code reads only ~200 lines) and wastes no
// context on bloat. When over budget, the fattest *inline* sections are moved
// into a dated archive file and replaced with one-line pointers.
//
// Guarantees: archive-not-delete (nothing lost), never touches the critical
// behavior-rules section or the preamble, idempotent, dry-run capable.

import fs from 'fs-extra';
import path from 'path';

export const DEFAULT_BUDGET = 180; // Claude loads ~200 lines of MEMORY.md; leave headroom.

// Split into ## sections, each keeping its own lines (header + body) verbatim.
function splitSections(text) {
  const sections = [];
  let cur = { header: '(preamble)', lines: [] };
  for (const line of text.split('\n')) {
    if (/^##\s/.test(line)) { sections.push(cur); cur = { header: line.replace(/^##\s+/, '').trim(), lines: [line] }; }
    else cur.lines.push(line);
  }
  sections.push(cur);
  return sections;
}

// Count lines that are real inline detail — not blank, not a header, not a
// one-line pointer (`- [Title](file.md) …`). High = a fat inline block.
function inlineWeight(section) {
  return section.lines.filter(l => {
    const t = l.trim();
    if (!t) return false;
    if (/^#{2,3}\s/.test(t)) return false;
    if (/^- \[[^\]]+\]\([^)]+\)/.test(t)) return false; // clean pointer
    return true;
  }).length;
}

const PROTECTED = (header) => /critical behavior rules/i.test(header) || header === '(preamble)';

/**
 * Tidy MEMORY.md down under `budgetLines`.
 * @returns summary { overBudget, lineCount, newLineCount?, budgetLines, archived[], archiveFile?, dryRun? }
 */
export async function tidyIndex(memoryDir, { budgetLines = DEFAULT_BUDGET, dryRun = false, stamp = 'archive' } = {}) {
  const mdPath = path.join(memoryDir, 'MEMORY.md');
  if (!await fs.pathExists(mdPath)) return { ok: false, reason: 'no MEMORY.md' };

  const text = await fs.readFile(mdPath, 'utf8');
  const lineCount = text.split('\n').length;
  if (lineCount <= budgetLines) return { overBudget: false, lineCount, budgetLines, archived: [] };

  const sections = splitSections(text);
  const archiveFile = `memory_index_archive_${stamp}.md`;

  // Fattest inline sections first, until we're under budget.
  const candidates = sections
    .map((s, i) => ({ i, s, weight: inlineWeight(s) }))
    .filter(c => c.weight >= 6 && !PROTECTED(c.s.header))
    .sort((a, b) => b.weight - a.weight);

  const removeIdx = new Map();
  const archived = [];
  let archiveBody = '';
  let projected = lineCount;
  for (const c of candidates) {
    if (projected <= budgetLines) break;
    archiveBody += c.s.lines.join('\n') + '\n\n';
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

  const archivePath = path.join(memoryDir, archiveFile);
  const fm = `---\nname: Memory index archive (${stamp})\ndescription: Fat inline sections moved out of MEMORY.md to keep the loaded index under ${budgetLines} lines. Nothing deleted; pointers remain in MEMORY.md.\nmetadata:\n  type: reference\n---\n`;
  const prior = await fs.pathExists(archivePath) ? await fs.readFile(archivePath, 'utf8') : fm;
  await fs.writeFile(archivePath, prior.trimEnd() + '\n\n' + archiveBody.trimEnd() + '\n');
  await fs.writeFile(mdPath, out.join('\n'));

  return { overBudget: true, lineCount, newLineCount: out.length, budgetLines, archived, archiveFile };
}
