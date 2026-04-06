import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import inquirer from 'inquirer';

// The instruction files each AI tool reads, in priority order
const INSTRUCTION_FILES = [
  { file: 'CLAUDE.md', tool: 'Claude' },
  { file: '.cursorrules', tool: 'Cursor' },
  { file: '.windsurfrules', tool: 'Windsurf' },
  { file: '.github/copilot-instructions.md', tool: 'Copilot' },
  { file: '.clinerules', tool: 'Cline' },
  { file: 'GEMINI.md', tool: 'Gemini' },
  { file: '.aider.system-prompt.md', tool: 'Aider' },
];

const BLOCK_START = '<!-- memoir:start -->';
const BLOCK_END = '<!-- memoir:end -->';

const MEMOIR_BLOCK = `${BLOCK_START}
# Memoir — Persistent Memory
<!-- Cross-session memory for AI tools — https://memoir.sh -->
<!-- Install: npm i -g memoir-cli -->
Use memoir_recall to search past context before answering project questions.
Use memoir_remember to save important decisions, architecture choices, or context worth keeping.
${BLOCK_END}`;

/**
 * Detect which instruction files exist in the current project.
 * Returns array of { file, tool, fullPath, exists }
 */
function detectInstructionFiles(projectDir) {
  return INSTRUCTION_FILES.map(({ file, tool }) => {
    const fullPath = path.join(projectDir, file);
    return { file, tool, fullPath, exists: fs.existsSync(fullPath) };
  });
}

/**
 * Check if a file already has the memoir block
 */
function hasMemoir(content) {
  return content.includes(BLOCK_START);
}

/**
 * Inject memoir block into a file (append, or create)
 */
async function injectBlock(filePath) {
  await fs.ensureDir(path.dirname(filePath));

  if (await fs.pathExists(filePath)) {
    const content = await fs.readFile(filePath, 'utf-8');
    if (hasMemoir(content)) {
      return 'already';
    }
    // Append with spacing
    const separator = content.endsWith('\n') ? '\n' : '\n\n';
    await fs.writeFile(filePath, content + separator + MEMOIR_BLOCK + '\n');
    return 'appended';
  } else {
    await fs.writeFile(filePath, MEMOIR_BLOCK + '\n');
    return 'created';
  }
}

/**
 * Remove memoir block from a file
 */
async function removeBlock(filePath) {
  if (!await fs.pathExists(filePath)) return 'not_found';

  const content = await fs.readFile(filePath, 'utf-8');
  if (!hasMemoir(content)) return 'not_present';

  const startIdx = content.indexOf(BLOCK_START);
  const endIdx = content.indexOf(BLOCK_END);
  if (startIdx === -1 || endIdx === -1) return 'not_present';

  const before = content.slice(0, startIdx).replace(/\n+$/, '');
  const after = content.slice(endIdx + BLOCK_END.length).replace(/^\n+/, '');
  const cleaned = (before + (before && after ? '\n\n' : '') + after).trim();

  if (!cleaned) {
    // File would be empty — delete it
    await fs.remove(filePath);
    return 'deleted';
  }

  await fs.writeFile(filePath, cleaned + '\n');
  return 'removed';
}

/**
 * Track which projects have been activated
 */
function getActivatedPath() {
  return path.join(os.homedir(), '.config', 'memoir', 'activated-projects.json');
}

async function loadActivated() {
  const p = getActivatedPath();
  if (await fs.pathExists(p)) {
    const data = await fs.readJson(p);
    return Array.isArray(data) ? data : [];
  }
  return [];
}

async function markActivated(projectDir) {
  const activated = await loadActivated();
  if (!activated.includes(projectDir)) {
    activated.push(projectDir);
    await fs.ensureDir(path.dirname(getActivatedPath()));
    await fs.writeJson(getActivatedPath(), activated);
  }
}

async function markDeactivated(projectDir) {
  let activated = await loadActivated();
  activated = activated.filter(p => p !== projectDir);
  await fs.ensureDir(path.dirname(getActivatedPath()));
  await fs.writeJson(getActivatedPath(), activated);
}

export async function isActivated(projectDir) {
  const activated = await loadActivated();
  return activated.includes(projectDir);
}

/**
 * memoir activate — inject memoir instructions into project AI config files
 */
export async function activateCommand(options = {}) {
  const projectDir = process.cwd();
  const detected = detectInstructionFiles(projectDir);
  const existing = detected.filter(d => d.exists);

  if (existing.length === 0) {
    // No instruction files exist — create CLAUDE.md by default
    const result = await injectBlock(path.join(projectDir, 'CLAUDE.md'));
    console.log(chalk.green('\n  ✔ Created CLAUDE.md with memoir instructions'));
    console.log(chalk.gray('    Your AI will use memoir_recall and memoir_remember automatically.\n'));
    await markActivated(projectDir);
    return;
  }

  // Inject into all existing instruction files
  let injected = 0;
  for (const { file, tool, fullPath } of existing) {
    const result = await injectBlock(fullPath);
    if (result === 'appended') {
      console.log(chalk.green(`  ✔ Added memoir to ${file}`) + chalk.gray(` (${tool})`));
      injected++;
    } else if (result === 'created') {
      console.log(chalk.green(`  ✔ Created ${file} with memoir instructions`) + chalk.gray(` (${tool})`));
      injected++;
    } else if (result === 'already') {
      console.log(chalk.gray(`  · ${file} already has memoir`) + chalk.gray(` (${tool})`));
    }
  }

  if (injected > 0) {
    console.log(chalk.gray('\n    Your AI tools will now use memoir automatically.\n'));
  } else {
    console.log(chalk.gray('\n    memoir is already active in this project.\n'));
  }

  await markActivated(projectDir);
}

/**
 * memoir deactivate — remove memoir instructions from project AI config files
 */
export async function deactivateCommand(options = {}) {
  const projectDir = process.cwd();
  const detected = detectInstructionFiles(projectDir);

  let removed = 0;
  for (const { file, tool, fullPath } of detected) {
    const result = await removeBlock(fullPath);
    if (result === 'removed') {
      console.log(chalk.yellow(`  ✔ Removed memoir from ${file}`) + chalk.gray(` (${tool})`));
      removed++;
    } else if (result === 'deleted') {
      console.log(chalk.yellow(`  ✔ Deleted ${file}`) + chalk.gray(' (was only memoir block)'));
      removed++;
    }
  }

  if (removed === 0) {
    console.log(chalk.gray('  · memoir is not active in this project.\n'));
  } else {
    console.log(chalk.gray('\n    memoir instructions removed.\n'));
  }

  await markDeactivated(projectDir);
}

/**
 * Prompt to activate — called from push on first push per project
 */
export async function promptActivate() {
  const projectDir = process.cwd();

  // Don't prompt if already activated or if not in a project directory
  if (await isActivated(projectDir)) return;

  // Check if we're in a project (has git, or has instruction files, or has package.json etc.)
  const projectSignals = ['.git', 'package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'Makefile'];
  const isProject = projectSignals.some(f => fs.existsSync(path.join(projectDir, f)));
  if (!isProject) {
    await markActivated(projectDir); // Don't ask again for non-projects
    return;
  }

  console.log('');
  const { activate } = await inquirer.prompt([{
    type: 'confirm',
    name: 'activate',
    message: 'Add memoir instructions to this project so your AI uses it automatically?',
    default: true,
  }]);

  if (activate) {
    await activateCommand();
  } else {
    await markActivated(projectDir); // Don't ask again
    console.log(chalk.gray('  · Skipped. Run ') + chalk.cyan('memoir activate') + chalk.gray(' anytime to enable.\n'));
  }
}
