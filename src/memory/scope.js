import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execFileSync } from 'child_process';

const cache = new Map();
export function projectIdentity(project = process.env.MEMOIR_PROJECT_ROOT || process.cwd()) {
  if (project === 'shared') return 'shared';
  if (/^(git|local):[a-f0-9]{32}$/.test(project)) return project;
  let absolute = path.resolve(project.replace(/^~/, os.homedir()));
  try { absolute = fs.realpathSync(absolute); } catch {}
  const old = cache.get(absolute);
  if (old && Date.now() - old.at < 60_000) return old.id;
  let home = os.homedir();
  try { home = fs.realpathSync(home); } catch {}
  let key = path.relative(home, absolute).replace(/\\/g, '/');
  let kind = 'local';
  try {
    const remote = execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd: absolute, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim();
    if (remote) {
      // Normalize common SSH/HTTPS spellings; never persist embedded credentials.
      key = remote.replace(/^git@([^:]+):/, '$1/').replace(/^https?:\/\/(?:[^/@]+@)?/, '').replace(/^ssh:\/\/git@/, '').replace(/\.git\/?$/, '').replace(/\/$/, '');
      kind = 'git';
    }
  } catch {}
  const id = kind + ':' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);
  cache.set(absolute, { id, at: Date.now() });
  return id;
}

// Resolve project paths once per query, not once for every stored record.
// A new predicate is created on each query so time-based validity is current.
export function memoryVisibility({ project = process.env.MEMOIR_PROJECT_ROOT || process.cwd(), allProjects = false, now = Date.now() } = {}) {
  let activeId, currentKey, sharedKey;
  const identities = new Map();
  return item => {
    if (!item || item.hidden === true || item.hidden === 'true' || item.deleted === true || ['deleted', 'hidden', 'superseded'].includes(item.status) || item.superseded_by) return false;
    if (item.valid_from && Date.parse(item.valid_from) > now) return false;
    if (item.valid_until && Date.parse(item.valid_until) <= now) return false;
    if (!allProjects && item.claudeProjectKey) {
      currentKey ??= path.resolve(project.replace(/^~/, os.homedir())).replace(/[\\/:]/g, '-');
      sharedKey ??= os.homedir().replace(/[\\/:]/g, '-');
      if (item.claudeProjectKey !== currentKey && item.claudeProjectKey !== sharedKey) return false;
    }
    if (allProjects || !item.project || item.project === 'shared') return true;
    activeId ??= projectIdentity(project);
    const key = String(item.project);
    if (!identities.has(key)) identities.set(key, projectIdentity(key));
    return identities.get(key) === activeId;
  };
}

export function visibleMemory(item, options = {}) {
  return memoryVisibility(options)(item);
}

export function sessionView(state, options = {}) {
  const current = { ...(state?.current || {}) };
  for (const key of ['goals', 'next_actions', 'parked_actions', 'open_questions', 'decisions']) {
    const archived = { goals: 'archived_goals', decisions: 'archived_decisions', open_questions: 'archived_questions' }[key];
    current[key] = [...(current[key] || []), ...(archived ? current[archived] || [] : [])].filter(item => visibleMemory(item, options));
  }
  return { ...state, current, history: (state?.history || []).filter(item => visibleMemory(item, options)) };
}
