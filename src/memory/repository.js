import { execFileSync } from 'node:child_process';

export function repositoryState(project) {
  const run = args => execFileSync('git', args, { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
  try {
    return {
      root: run(['rev-parse', '--show-toplevel']),
      head: run(['rev-parse', 'HEAD']),
      branch: run(['branch', '--show-current']) || '(detached)',
      dirty: run(['status', '--porcelain']).length > 0,
    };
  } catch { return { root: project, head: null, branch: null, dirty: null }; }
}
