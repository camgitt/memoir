import path from 'node:path';
import { readSession } from './state.js';
import { sessionView, projectIdentity } from '../memory/scope.js';
import { repositoryState } from '../memory/repository.js';

export async function buildResumeBrief(project = process.env.MEMOIR_PROJECT_ROOT || process.cwd()) {
  const view = sessionView(await readSession(), { project });
  const repository = repositoryState(path.resolve(project));
  const history = [...view.history].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const lastObserved = history.find(item => item.repo_head) || null;
  const drift = lastObserved && repository.head ? lastObserved.repo_head !== repository.head : null;
  return {
    project: projectIdentity(project),
    repository,
    objective: view.current.goals[0] || null,
    next_actions: view.current.next_actions.slice(-3).reverse(),
    open_questions: view.current.open_questions.slice(0, 3),
    decisions: view.current.decisions.slice(0, 5).map(d => ({
      id: d.id, text: d.text, why: d.why, rejected: d.rejected, date: d.date, source: 'session.json',
    })),
    last_observed_session: lastObserved || history[0] || null,
    code_changed_since_observation: drift,
    verification: 'Saved context is historical evidence. No current test result is implied; verify the checkout before continuing.',
  };
}

export function formatResumeBrief(brief) {
  const lines = [
    '# Resume this project',
    'Project: ' + brief.project,
    'Goal: ' + (brief.objective?.text || 'No goal recorded.'),
    'Checkout: ' + (brief.repository.branch || 'not a Git repository') + (brief.repository.head ? ' @ ' + brief.repository.head.slice(0, 12) : ''),
    'Working tree: ' + (brief.repository.dirty === null ? 'unknown' : brief.repository.dirty ? 'has uncommitted changes' : 'clean'),
  ];
  if (brief.code_changed_since_observation === true) lines.push('The commit changed since the saved observation; recheck the earlier assumptions.');
  else if (brief.code_changed_since_observation === null) lines.push('No saved commit is available for a drift comparison.');
  lines.push('', 'Next actions:');
  for (const action of brief.next_actions) lines.push('- ' + action.text);
  if (!brief.next_actions.length) lines.push('- No next action recorded.');
  if (brief.open_questions.length) lines.push('', 'Open questions:', ...brief.open_questions.map(q => '- ' + q.text));
  if (brief.decisions.length) {
    lines.push('', 'Decisions and evidence:');
    for (const d of brief.decisions) lines.push('- ' + d.text + (d.why ? ' — ' + d.why : '') + ' [session.json; ' + (d.date || 'date unknown') + ']');
  }
  lines.push('', brief.verification);
  return lines.join('\n');
}
