/**
 * Skills System Commands
 *
 * Reusable workflows stored as structured templates.
 * Stored in ~/.memoir/skills/<skill-name>/
 */

import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import chalk from 'chalk';
import boxen from 'boxen';

const SKILLS_DIR = path.join(os.homedir(), '.memoir', 'skills');

async function ensureSkillsDir() {
  await fs.ensureDir(SKILLS_DIR);
}

// ── Core skill operations (used by MCP + CLI) ──────────────────────────────

export async function listSkills() {
  await ensureSkillsDir();

  const entries = await fs.readdir(SKILLS_DIR, { withFileTypes: true });
  const skills = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillJsonPath = path.join(SKILLS_DIR, entry.name, 'skill.json');
    if (await fs.pathExists(skillJsonPath)) {
      try {
        const skill = await fs.readJson(skillJsonPath);
        skills.push(skill);
      } catch {
        skills.push({ name: entry.name, description: '(invalid skill.json)' });
      }
    }
  }

  return skills;
}

export async function getSkill(name) {
  const skillDir = path.join(SKILLS_DIR, name);
  const skillJsonPath = path.join(skillDir, 'skill.json');
  const workflowPath = path.join(skillDir, 'workflow.md');

  if (!(await fs.pathExists(skillJsonPath))) {
    return null;
  }

  const skill = await fs.readJson(skillJsonPath);
  if (await fs.pathExists(workflowPath)) {
    skill.workflow = await fs.readFile(workflowPath, 'utf8');
  }

  return skill;
}

export async function createSkill(name, options = {}) {
  await ensureSkillsDir();
  const skillDir = path.join(SKILLS_DIR, name);
  await fs.ensureDir(skillDir);

  const skill = {
    name,
    description: options.description || '',
    triggers: options.triggers ? options.triggers.split(',').map(t => t.trim()) : [],
    council_mode: options.councilMode || null,
    council_agents: options.councilAgents ? options.councilAgents.split(',').map(a => a.trim()) : [],
    steps: options.steps ? options.steps.split(';').map(s => s.trim()) : [],
    createdAt: new Date().toISOString(),
  };

  await fs.writeJson(path.join(skillDir, 'skill.json'), skill, { spaces: 2 });

  // Create a workflow template
  const workflow = `# ${name}\n\n${skill.description || 'Describe the workflow here.'}\n\n## Steps\n\n${skill.steps.length > 0 ? skill.steps.map((s, i) => `${i + 1}. ${s}`).join('\n') : '1. Step one\n2. Step two\n3. Step three'}\n`;
  await fs.writeFile(path.join(skillDir, 'workflow.md'), workflow);

  return skill;
}

export async function runSkill(name, input = '') {
  const skill = await getSkill(name);
  if (!skill) {
    return { error: `Skill not found: ${name}` };
  }

  // Return the skill definition + workflow for the AI to execute
  return {
    skill,
    input,
    instructions: `Execute the "${skill.name}" skill with the following workflow. ${input ? `Input: ${input}` : ''}`,
  };
}

// ── CLI Commands ────────────────────────────────────────────────────────────

export async function skillListCommand() {
  const skills = await listSkills();

  if (skills.length === 0) {
    console.log(chalk.gray('\n  No skills created yet. Use "memoir skill create <name>" to start.\n'));
    return;
  }

  const parts = [
    chalk.cyan.bold('Skills'),
    '',
  ];

  for (const skill of skills) {
    parts.push(`  ${chalk.white.bold(skill.name)}${skill.description ? chalk.gray(` — ${skill.description}`) : ''}`);
    if (skill.triggers?.length) {
      parts.push(chalk.gray(`    Triggers: ${skill.triggers.join(', ')}`));
    }
    if (skill.steps?.length) {
      parts.push(chalk.gray(`    Steps: ${skill.steps.length}`));
    }
  }

  console.log('\n' + boxen(parts.join('\n'), {
    padding: 1, borderStyle: 'round', borderColor: 'cyan', dimBorder: true
  }) + '\n');
}

export async function skillCreateCommand(name, options = {}) {
  if (!name) {
    console.error(chalk.red('\n✖ Usage: memoir skill create <name> [--description "..."]'));
    return;
  }

  const existing = await getSkill(name);
  if (existing) {
    console.error(chalk.red(`\n✖ Skill "${name}" already exists. Delete it first or choose a different name.\n`));
    return;
  }

  const skill = await createSkill(name, options);
  console.log(chalk.green(`\n  ✔ Skill created: ${name}`));
  console.log(chalk.gray(`  Location: ${path.join(SKILLS_DIR, name)}`));
  console.log(chalk.gray(`  Edit workflow: ${path.join(SKILLS_DIR, name, 'workflow.md')}\n`));
}

export async function skillRunCommand(name, options = {}) {
  if (!name) {
    console.error(chalk.red('\n✖ Usage: memoir skill run <name> [--input "..."]'));
    return;
  }

  const result = await runSkill(name, options.input || '');

  if (result.error) {
    console.error(chalk.red(`\n✖ ${result.error}\n`));
    return;
  }

  const skill = result.skill;
  const parts = [
    chalk.cyan.bold(`Running: ${skill.name}`),
    '',
  ];

  if (skill.description) parts.push(chalk.gray(`  ${skill.description}`));
  if (result.input) parts.push(`  Input: ${chalk.white(result.input)}`);

  parts.push('');

  if (skill.workflow) {
    parts.push(chalk.white.bold('  Workflow:'));
    parts.push(skill.workflow.split('\n').map(l => `  ${l}`).join('\n'));
  } else if (skill.steps?.length) {
    parts.push(chalk.white.bold('  Steps:'));
    for (let i = 0; i < skill.steps.length; i++) {
      parts.push(`  ${i + 1}. ${skill.steps[i]}`);
    }
  }

  console.log('\n' + boxen(parts.join('\n'), {
    padding: 1, borderStyle: 'round', borderColor: 'cyan', dimBorder: true
  }) + '\n');

  console.log(chalk.gray('  Tip: Use this via MCP in any AI tool for the AI to execute the workflow.\n'));
}

export async function skillSyncCommand() {
  await ensureSkillsDir();
  const skills = await listSkills();
  console.log(chalk.green(`\n  ✔ ${skills.length} skill${skills.length !== 1 ? 's' : ''} ready for sync`));
  console.log(chalk.gray(`  Location: ${SKILLS_DIR}`));
  console.log(chalk.gray('\n  Run "memoir push" or "memoir cloud push" to sync.\n'));
}
