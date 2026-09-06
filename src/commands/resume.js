import fs from 'fs-extra';
import path from 'path';
import { buildResumeBrief, formatResumeBrief } from '../session/brief.js';
import { BLOCK_START, BLOCK_END } from '../session/render.js';
import { injectInto } from '../session/inject.js';
import { safePath, writeSafeFile } from '../security/files.js';

export async function resumeCommand(options = {}) {
  const project = options.project || process.env.MEMOIR_PROJECT_ROOT || process.cwd();
  const brief = await buildResumeBrief(project);
  const content = formatResumeBrief(brief);
  console.log(content);
  if (options.inject) {
    const targets = { claude: 'CLAUDE.md', codex: 'AGENTS.md', gemini: 'GEMINI.md', cursor: '.cursor/rules/memoir-resume.mdc' };
    const tool = options.to || 'claude';
    if (!targets[tool]) throw new Error('Supported injection targets: claude, codex, gemini, cursor');
    const target = await safePath(path.resolve(project), targets[tool], { createParents: true });
    if (tool === 'cursor' && !await fs.pathExists(target)) await writeSafeFile(path.resolve(project), targets[tool], '---\ndescription: Memoir project handoff\nalwaysApply: true\n---\n');
    await injectInto(target, [BLOCK_START, content, BLOCK_END].join('\n'));
    console.log('\nUpdated the managed handoff in ' + target);
  }
  return brief;
}
