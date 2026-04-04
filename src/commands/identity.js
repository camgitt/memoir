/**
 * Identity Layer Commands
 *
 * Manages user identity (TELOS): mission, goals, projects, preferences, challenges, ideas.
 * Stored as structured JSON in ~/.memoir/identity/
 */

import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import boxen from 'boxen';

const IDENTITY_DIR = path.join(os.homedir(), '.memoir', 'identity');
const SECTIONS = ['mission', 'goals', 'projects', 'preferences', 'challenges', 'ideas'];

async function ensureIdentityDir() {
  await fs.ensureDir(IDENTITY_DIR);
  // Initialize missing sections with templates
  const templateDir = path.join(new URL('.', import.meta.url).pathname, '..', '..', 'templates', 'identity');
  for (const section of SECTIONS) {
    const filePath = path.join(IDENTITY_DIR, `${section}.json`);
    if (!(await fs.pathExists(filePath))) {
      const templatePath = path.join(templateDir, `${section}.json`);
      if (await fs.pathExists(templatePath)) {
        await fs.copy(templatePath, filePath);
      }
    }
  }
}

async function readSection(section) {
  await ensureIdentityDir();
  const filePath = path.join(IDENTITY_DIR, `${section}.json`);
  if (await fs.pathExists(filePath)) {
    return await fs.readJson(filePath);
  }
  return null;
}

async function writeSection(section, data) {
  await ensureIdentityDir();
  data.updatedAt = new Date().toISOString();
  const filePath = path.join(IDENTITY_DIR, `${section}.json`);
  await fs.writeJson(filePath, data, { spaces: 2 });
}

// ── Load identity for MCP ──────────────────────────────────────────────────

export async function loadIdentity(section = 'all') {
  await ensureIdentityDir();

  if (section === 'all') {
    const identity = {};
    for (const s of SECTIONS) {
      identity[s] = await readSection(s);
    }
    return identity;
  }

  if (!SECTIONS.includes(section)) {
    return { error: `Unknown section: ${section}. Available: ${SECTIONS.join(', ')}` };
  }

  return await readSection(section);
}

// ── CLI Commands ────────────────────────────────────────────────────────────

export async function identitySetCommand(section, value) {
  if (!section) {
    console.error(chalk.red('\n✖ Usage: memoir identity set <section> <value>'));
    console.log(chalk.gray(`  Sections: ${SECTIONS.join(', ')}`));
    return;
  }

  if (section === 'mission') {
    const data = (await readSection('mission')) || { statement: '', updatedAt: null };
    data.statement = value;
    await writeSection('mission', data);
    console.log(chalk.green('\n  ✔ Mission updated'));
    console.log(chalk.gray(`  "${value}"\n`));
    return;
  }

  if (section === 'preference' || section === 'preferences') {
    const data = (await readSection('preferences')) || { preferences: [], updatedAt: null };
    // Parse "key: value" format
    const colonIdx = value.indexOf(':');
    if (colonIdx > 0) {
      const key = value.slice(0, colonIdx).trim();
      const val = value.slice(colonIdx + 1).trim();
      // Update existing or add new
      const existing = data.preferences.findIndex(p => p.key === key);
      if (existing >= 0) {
        data.preferences[existing].value = val;
      } else {
        data.preferences.push({ key, value: val });
      }
    } else {
      data.preferences.push({ key: value, value: true });
    }
    await writeSection('preferences', data);
    console.log(chalk.green('\n  ✔ Preference saved'));
    console.log(chalk.gray(`  "${value}"\n`));
    return;
  }

  console.error(chalk.red(`\n✖ Cannot "set" on section "${section}". Use "memoir identity add" for list sections.`));
  console.log(chalk.gray('  Settable sections: mission, preference\n'));
}

export async function identityAddCommand(section, value, options = {}) {
  if (!section || !value) {
    console.error(chalk.red('\n✖ Usage: memoir identity add <section> <value> [--flags]'));
    return;
  }

  const now = new Date().toISOString();

  if (section === 'goal' || section === 'goals') {
    const data = (await readSection('goals')) || { goals: [], updatedAt: null };
    const goal = {
      text: value,
      priority: options.priority ? parseInt(options.priority) : data.goals.length + 1,
      status: 'active',
      deadline: options.deadline || null,
      createdAt: now,
    };
    data.goals.push(goal);
    data.goals.sort((a, b) => a.priority - b.priority);
    await writeSection('goals', data);
    console.log(chalk.green('\n  ✔ Goal added'));
    console.log(chalk.gray(`  [P${goal.priority}] ${value}`));
    if (goal.deadline) console.log(chalk.gray(`  Deadline: ${goal.deadline}`));
    console.log('');
    return;
  }

  if (section === 'project' || section === 'projects') {
    const data = (await readSection('projects')) || { projects: [], updatedAt: null };
    const project = {
      name: value,
      status: options.status || 'active',
      stack: options.stack || '',
      description: options.description || '',
      createdAt: now,
    };
    data.projects.push(project);
    await writeSection('projects', data);
    console.log(chalk.green('\n  ✔ Project added'));
    console.log(chalk.gray(`  ${value} [${project.status}]`));
    if (project.stack) console.log(chalk.gray(`  Stack: ${project.stack}`));
    console.log('');
    return;
  }

  if (section === 'challenge' || section === 'challenges') {
    const data = (await readSection('challenges')) || { challenges: [], updatedAt: null };
    data.challenges.push({
      text: value,
      status: 'active',
      createdAt: now,
    });
    await writeSection('challenges', data);
    console.log(chalk.green('\n  ✔ Challenge added'));
    console.log(chalk.gray(`  ${value}\n`));
    return;
  }

  if (section === 'idea' || section === 'ideas') {
    const data = (await readSection('ideas')) || { ideas: [], updatedAt: null };
    data.ideas.push({
      text: value,
      tags: options.tags ? options.tags.split(',').map(t => t.trim()) : [],
      createdAt: now,
    });
    await writeSection('ideas', data);
    console.log(chalk.green('\n  ✔ Idea added'));
    console.log(chalk.gray(`  ${value}\n`));
    return;
  }

  console.error(chalk.red(`\n✖ Unknown section: ${section}`));
  console.log(chalk.gray(`  Addable sections: goal, project, challenge, idea\n`));
}

export async function identityShowCommand(section) {
  const identity = await loadIdentity(section || 'all');

  if (identity.error) {
    console.error(chalk.red(`\n✖ ${identity.error}\n`));
    return;
  }

  if (section && section !== 'all') {
    console.log('\n' + boxen(
      chalk.white.bold(section.charAt(0).toUpperCase() + section.slice(1)) + '\n\n' +
      formatSection(section, identity),
      { padding: 1, borderStyle: 'round', borderColor: 'cyan', dimBorder: true }
    ) + '\n');
    return;
  }

  // Show all sections
  const parts = [];
  for (const s of SECTIONS) {
    const data = identity[s];
    if (!data) continue;
    parts.push(chalk.white.bold(s.charAt(0).toUpperCase() + s.slice(1)) + '\n' + formatSection(s, data));
  }

  console.log('\n' + boxen(
    chalk.cyan.bold('Your Identity') + '\n\n' + parts.join('\n\n'),
    { padding: 1, borderStyle: 'round', borderColor: 'cyan', dimBorder: true }
  ) + '\n');
}

function formatSection(section, data) {
  if (!data) return chalk.gray('  (empty)');

  switch (section) {
    case 'mission':
      return data.statement ? `  ${data.statement}` : chalk.gray('  (not set)');

    case 'goals':
      if (!data.goals?.length) return chalk.gray('  (none)');
      return data.goals.map(g => {
        const status = g.status === 'done' ? chalk.green('✔') : chalk.yellow('○');
        const deadline = g.deadline ? chalk.gray(` (due: ${g.deadline})`) : '';
        return `  ${status} [P${g.priority}] ${g.text}${deadline}`;
      }).join('\n');

    case 'projects':
      if (!data.projects?.length) return chalk.gray('  (none)');
      return data.projects.map(p => {
        const statusColor = p.status === 'active' ? chalk.green : p.status === 'paused' ? chalk.yellow : chalk.gray;
        return `  ${statusColor('●')} ${p.name} [${p.status}]${p.stack ? chalk.gray(` — ${p.stack}`) : ''}`;
      }).join('\n');

    case 'preferences':
      if (!data.preferences?.length) return chalk.gray('  (none)');
      return data.preferences.map(p => `  ${chalk.cyan(p.key)}: ${p.value}`).join('\n');

    case 'challenges':
      if (!data.challenges?.length) return chalk.gray('  (none)');
      return data.challenges.map(c => {
        const status = c.status === 'resolved' ? chalk.green('✔') : chalk.red('!');
        return `  ${status} ${c.text}`;
      }).join('\n');

    case 'ideas':
      if (!data.ideas?.length) return chalk.gray('  (none)');
      return data.ideas.map(i => {
        const tags = i.tags?.length ? chalk.gray(` [${i.tags.join(', ')}]`) : '';
        return `  ◇ ${i.text}${tags}`;
      }).join('\n');

    default:
      return JSON.stringify(data, null, 2);
  }
}

export async function identitySyncCommand() {
  // Identity sync piggybacks on the existing memoir push/cloud push system
  // This just confirms identity files exist and are ready
  await ensureIdentityDir();
  const counts = {};
  for (const s of SECTIONS) {
    const data = await readSection(s);
    if (s === 'mission') {
      counts[s] = data?.statement ? 1 : 0;
    } else {
      const key = s; // goals, projects, etc.
      counts[s] = data?.[key]?.length || 0;
    }
  }

  console.log(chalk.green('\n  ✔ Identity ready for sync'));
  console.log(chalk.gray(`  Location: ${IDENTITY_DIR}`));
  for (const [section, count] of Object.entries(counts)) {
    console.log(chalk.gray(`  ${section}: ${count} item${count !== 1 ? 's' : ''}`));
  }
  console.log(chalk.gray('\n  Run "memoir push" or "memoir cloud push" to sync.\n'));
}
