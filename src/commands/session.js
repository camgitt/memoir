// CLI commands for the session continuity feature.
//   memoir goal "..."      — set current goal
//   memoir next "..."      — add a next action
//   memoir done "..."      — mark a next action complete (removes it)
//   memoir note "..."      — record a decision (supports --why and --rejected)
//   memoir ask "..."       — capture an open question
//   memoir session         — show current session state
//   memoir session clear   — wipe current (history retained)
//
// Every mutator re-renders the pinned block into ~/.claude/CLAUDE.md so Claude
// picks it up at the next session start.

import chalk from 'chalk';
import boxen from 'boxen';
import gradient from 'gradient-string';
import {
  readSession,
  writeSession,
  addGoal,
  addNext,
  completeNext,
  addNote,
  addQuestion,
  getMachineId,
  paths,
} from '../session/state.js';
import { renderSession } from '../session/render.js';
import { injectInto, detectAvailableTargets } from '../session/inject.js';

// Render + inject into every detected tool. Best-effort; if a tool isn't
// installed, we just skip it silently (detectAvailableTargets filters).
async function refreshPinned() {
  const state = await readSession();
  const rendered = renderSession(state);
  const targets = detectAvailableTargets();
  const updated = [];
  for (const target of Object.values(targets)) {
    try {
      const res = await injectInto(target, rendered);
      updated.push(res.path);
    } catch {
      // Target not writable — skip silently.
    }
  }
  return { state, rendered, updated };
}

export async function goalCommand(text) {
  if (!text || !String(text).trim()) {
    console.log(chalk.yellow('\nUsage: ') + chalk.cyan('memoir goal "your current focus"\n'));
    return;
  }
  await addGoal(String(text).trim());
  const { updated } = await refreshPinned();
  console.log('\n' + chalk.green('  ✓ Goal set: ') + chalk.white(text));
  if (updated.length) console.log(chalk.gray(`    Pinned to: ${updated.join(', ')}\n`));
}

export async function nextCommand(text) {
  if (!text || !String(text).trim()) {
    console.log(chalk.yellow('\nUsage: ') + chalk.cyan('memoir next "the next action"\n'));
    return;
  }
  await addNext(String(text).trim());
  await refreshPinned();
  console.log('\n' + chalk.green('  ✓ Added to next: ') + chalk.white(text) + '\n');
}

export async function doneCommand(text) {
  if (!text || !String(text).trim()) {
    console.log(chalk.yellow('\nUsage: ') + chalk.cyan('memoir done "substring of the action"\n'));
    return;
  }
  const before = await readSession();
  await completeNext(String(text).trim());
  const after = await readSession();
  const removed = before.current.next_actions.length - after.current.next_actions.length;
  if (removed > 0) {
    await refreshPinned();
    console.log('\n' + chalk.green(`  ✓ Completed ${removed} action${removed !== 1 ? 's' : ''}\n`));
  } else {
    console.log('\n' + chalk.yellow('  No matching action found.\n'));
  }
}

export async function noteCommand(text, options = {}) {
  if (!text || !String(text).trim()) {
    console.log(chalk.yellow('\nUsage: ') + chalk.cyan('memoir note "the decision" [--why "rationale"] [--rejected "alternative"]\n'));
    return;
  }
  await addNote(String(text).trim(), {
    why: options.why ? String(options.why).trim() : undefined,
    rejected: options.rejected ? String(options.rejected).trim() : undefined,
  });
  await refreshPinned();
  console.log('\n' + chalk.green('  ✓ Decision recorded: ') + chalk.white(text));
  if (options.why) console.log(chalk.gray('    Why: ') + chalk.white(options.why));
  if (options.rejected) console.log(chalk.gray('    Rejected: ') + chalk.white(options.rejected));
  console.log('');
}

export async function askCommand(text) {
  if (!text || !String(text).trim()) {
    console.log(chalk.yellow('\nUsage: ') + chalk.cyan('memoir ask "the open question"\n'));
    return;
  }
  await addQuestion(String(text).trim());
  await refreshPinned();
  console.log('\n' + chalk.green('  ✓ Question captured: ') + chalk.white(text) + '\n');
}

export async function sessionShowCommand() {
  const state = await readSession();
  const machine = await getMachineId();
  const goals = state.current.goals;
  const nexts = state.current.next_actions;
  const questions = state.current.open_questions;
  const decisions = state.current.decisions;
  const history = state.history;

  const body = [];
  body.push(gradient.pastel('  Session  '));
  body.push('');
  body.push(chalk.gray(`  This machine: ${machine.label} (${machine.id.slice(0, 8)})`));
  body.push(chalk.gray(`  Storage: ${paths.session}`));
  body.push('');

  if (goals.length === 0) {
    body.push(chalk.yellow('  No goal set.') + chalk.gray('  Run ') + chalk.cyan('memoir goal "..."'));
  } else {
    body.push(chalk.white.bold('  Current goal:'));
    for (const g of goals) body.push('  ' + chalk.cyan('→ ') + chalk.white(g.text));
  }
  body.push('');

  if (nexts.length) {
    body.push(chalk.white.bold('  Next:'));
    for (const n of nexts) body.push('  ' + chalk.gray('[ ] ') + chalk.white(n.text));
    body.push('');
  }

  if (questions.length) {
    body.push(chalk.white.bold('  Open questions:'));
    for (const q of questions) body.push('  ' + chalk.yellow('? ') + chalk.white(q.text));
    body.push('');
  }

  if (decisions.length) {
    body.push(chalk.white.bold('  Recent decisions:'));
    for (const d of decisions.slice(0, 5)) {
      let line = '  ' + chalk.green('✓ ') + chalk.white(d.text);
      if (d.why) line += chalk.gray(` — ${d.why}`);
      body.push(line);
    }
    body.push('');
  }

  if (history.length) {
    body.push(chalk.white.bold('  Recent sessions:'));
    for (const h of history.slice(0, 5)) {
      const date = (h.date || '').slice(0, 10);
      const label = state.machines?.[h.machine_id]?.label || '?';
      const dur = h.duration_min ? chalk.gray(` (${h.duration_min}m)`) : '';
      body.push('  ' + chalk.gray(`${date} ${label}`) + dur + chalk.gray(': ') + chalk.white(h.summary || '—'));
    }
    body.push('');
  }

  const machineCount = Object.keys(state.machines || {}).length;
  if (machineCount > 1) {
    body.push(chalk.gray(`  ${machineCount} machines sync this session.`));
  }

  console.log('\n' + boxen(body.join('\n'), {
    padding: { top: 0, bottom: 0, left: 1, right: 1 },
    borderStyle: 'round',
    borderColor: 'cyan',
    dimBorder: true,
  }) + '\n');
}

export async function sessionClearCommand() {
  const state = await readSession();
  state.current = { goals: [], next_actions: [], open_questions: [], decisions: [] };
  await writeSession(state);
  await refreshPinned();
  console.log('\n' + chalk.green('  ✓ Current session cleared.') + chalk.gray(' History retained.\n'));
}
