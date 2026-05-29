// Inject / update the pinned session block in target files.
//
// Primary target: ~/.claude/CLAUDE.md (user-global, always loaded by Claude Code
// regardless of MEMORY.md truncation).
//
// Rules:
// - If markers are present, replace the block in place. Nothing else is touched.
// - If markers are absent, prepend the block at the top of the file (after any
//   leading frontmatter or title line).
// - If the file doesn't exist, create it containing only the block.
// - Never touch content outside the markers.

import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { BLOCK_START, BLOCK_END } from './render.js';

const home = os.homedir();
const isWin = process.platform === 'win32';
const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');

// Every target that memoir knows how to inject the pinned block into.
// Added when we extend cross-tool support. Each target is a single file path.
//
// Claude:   ~/.claude/CLAUDE.md                (always loaded by Claude Code)
// Cursor:   ~/.cursor/rules/memoir-session.mdc (global user rules — auto-loaded)
// Windsurf: {AppSupport}/Windsurf/User/memoir-session.md (user-global instructions)
// Gemini:   ~/.gemini/GEMINI.md                (user-global)
export const INJECTION_TARGETS = {
  claude:   path.join(home, '.claude', 'CLAUDE.md'),
  cursor:   path.join(home, '.cursor', 'rules', 'memoir-session.mdc'),
  windsurf: isWin
    ? path.join(appData, 'Windsurf', 'User', 'memoir-session.md')
    : path.join(home, 'Library', 'Application Support', 'Windsurf', 'User', 'memoir-session.md'),
  gemini:   path.join(home, '.gemini', 'GEMINI.md'),
};

// Returns the target paths whose parent infrastructure exists — i.e. the tool
// is actually installed. Avoids creating empty tool dirs for tools the user
// doesn't use.
export function detectAvailableTargets() {
  const detectors = {
    claude:   path.join(home, '.claude'),
    cursor:   path.join(home, '.cursor'),
    windsurf: isWin
      ? path.join(appData, 'Windsurf', 'User')
      : path.join(home, 'Library', 'Application Support', 'Windsurf', 'User'),
    gemini:   path.join(home, '.gemini'),
  };
  const available = {};
  for (const [name, dir] of Object.entries(detectors)) {
    try {
      if (fs.existsSync(dir)) available[name] = INJECTION_TARGETS[name];
    } catch {}
  }
  return available;
}

// Pattern that matches the whole block including markers. Tolerant of the
// marker text evolving across versions — anchors on `memoir:session-block`.
const BLOCK_RE = /<!--\s*memoir:session-block[^>]*-->[\s\S]*?<!--\s*\/memoir:session-block\s*-->/;

export async function injectInto(targetPath, renderedBlock) {
  await fs.ensureDir(path.dirname(targetPath));

  let content = '';
  let existed = false;
  try {
    content = await fs.readFile(targetPath, 'utf8');
    existed = true;
  } catch {
    // Doesn't exist yet — will create.
  }

  const updated = applyBlock(content, renderedBlock, existed);

  // Atomic write
  const tmp = `${targetPath}.tmp-${process.pid}`;
  await fs.writeFile(tmp, updated);
  await fs.move(tmp, targetPath, { overwrite: true });

  return { path: targetPath, created: !existed, replaced: existed && BLOCK_RE.test(content) };
}

// Apply the block to existing content. Exported for tests.
export function applyBlock(content, renderedBlock, existed = true) {
  if (!existed || content.trim() === '') {
    // Fresh file — block only, plus a trailing newline for poetry.
    return renderedBlock + '\n';
  }

  if (BLOCK_RE.test(content)) {
    // Replace in place.
    return content.replace(BLOCK_RE, renderedBlock);
  }

  // No existing block — prepend. Preserve any H1 title at the top by placing
  // the block immediately after it. Otherwise put it at the very top.
  const h1Match = content.match(/^(#\s.+\n+)/);
  if (h1Match) {
    return h1Match[1] + renderedBlock + '\n\n' + content.slice(h1Match[1].length);
  }
  return renderedBlock + '\n\n' + content;
}

// Remove the block, if present. Used when user wants memoir to stop managing CLAUDE.md.
export async function uninjectFrom(targetPath) {
  if (!await fs.pathExists(targetPath)) return { removed: false };
  const content = await fs.readFile(targetPath, 'utf8');
  if (!BLOCK_RE.test(content)) return { removed: false };
  // Strip the block and any trailing blank lines that follow it
  const cleaned = content.replace(BLOCK_RE, '').replace(/\n{3,}/g, '\n\n').trimStart();
  const tmp = `${targetPath}.tmp-${process.pid}`;
  await fs.writeFile(tmp, cleaned);
  await fs.move(tmp, targetPath, { overwrite: true });
  return { removed: true };
}
