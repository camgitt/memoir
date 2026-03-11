import chalk from 'chalk';
import boxen from 'boxen';
import inquirer from 'inquirer';
import { execFileSync } from 'child_process';
import {
  getRawConfig, listProfiles, getActiveProfileName,
  createProfile, switchProfile, deleteProfile
} from '../config.js';

function getGitHubUsername() {
  try {
    return execFileSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8' }).trim();
  } catch {
    try {
      return execFileSync('git', ['config', '--global', 'user.name'], { encoding: 'utf8' }).trim();
    } catch { return ''; }
  }
}

export async function profileListCommand() {
  const profiles = await listProfiles();
  const active = await getActiveProfileName();
  const raw = await getRawConfig();

  if (profiles.length === 0) {
    console.log('\n' + chalk.yellow('No profiles configured. Run ') + chalk.cyan('memoir init') + chalk.yellow(' first.\n'));
    return;
  }

  console.log();
  console.log(chalk.bold.white('  Profiles:\n'));

  for (const name of profiles) {
    const isActive = name === active;
    const marker = isActive ? chalk.green(' ✔ ') : chalk.gray('   ');
    const label = isActive ? chalk.white.bold(name) : chalk.white(name);

    // Get profile details
    let detail = '';
    if (raw.version >= 2 && raw.profiles?.[name]) {
      const p = raw.profiles[name];
      const dest = p.provider === 'git' ? p.gitRepo : p.localPath;
      detail = chalk.gray(` → ${dest}`);
      if (p.only) detail += chalk.gray(` (${p.only.join(', ')})`);
    } else if (!raw.version) {
      const dest = raw.provider === 'git' ? raw.gitRepo : raw.localPath;
      detail = chalk.gray(` → ${dest}`);
    }

    console.log(`${marker}${label}${detail}`);
  }
  console.log();
}

export async function profileCreateCommand(name) {
  const profiles = await listProfiles();
  if (profiles.includes(name)) {
    console.log(chalk.red(`\n✖ Profile "${name}" already exists.\n`));
    return;
  }

  console.log('\n' + chalk.cyan(`Creating profile: ${chalk.bold(name)}\n`));

  const detectedUser = getGitHubUsername();

  const { provider } = await inquirer.prompt([{
    type: 'list',
    name: 'provider',
    message: 'Storage for this profile?',
    choices: [
      { name: 'GitHub', value: 'git' },
      { name: 'Local folder', value: 'local' }
    ]
  }]);

  const profileConfig = { provider };

  if (provider === 'local') {
    const { localPath } = await inquirer.prompt([{
      type: 'input',
      name: 'localPath',
      message: 'Save to:',
      validate: (input) => input.trim() ? true : 'Required'
    }]);
    profileConfig.localPath = localPath;
  } else {
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'username',
        message: 'GitHub username:',
        default: detectedUser || undefined,
        validate: (input) => input.trim() ? true : 'Required'
      },
      {
        type: 'input',
        name: 'repo',
        message: 'Repo name:',
        default: `ai-memory-${name}`,
        validate: (input) => input.trim() ? true : 'Required'
      }
    ]);
    const username = answers.username.trim();
    const repo = answers.repo.trim();
    profileConfig.gitRepo = `https://github.com/${username}/${repo}.git`;

    // Auto-create repo if possible
    try {
      execFileSync('gh', ['repo', 'view', `${username}/${repo}`], { stdio: 'ignore' });
      console.log(chalk.gray(`  ✔ Repo exists`));
    } catch {
      try {
        execFileSync('gh', ['repo', 'create', `${username}/${repo}`, '--private', '--description', `AI memory backup - ${name} (memoir-cli)`], { stdio: 'ignore' });
        console.log(chalk.green(`  ✔ Created private repo`));
      } catch {
        console.log(chalk.yellow(`  ⚠ Could not auto-create repo. Create it manually on GitHub.`));
      }
    }
  }

  // Ask which tools to sync (optional filter)
  const { filterTools } = await inquirer.prompt([{
    type: 'confirm',
    name: 'filterTools',
    message: 'Limit this profile to specific tools?',
    default: false
  }]);

  if (filterTools) {
    const { tools } = await inquirer.prompt([{
      type: 'checkbox',
      name: 'tools',
      message: 'Which tools should this profile sync?',
      choices: [
        { name: 'Claude Code', value: 'claude' },
        { name: 'Gemini CLI', value: 'gemini' },
        { name: 'OpenAI Codex', value: 'codex' },
        { name: 'Cursor', value: 'cursor' },
        { name: 'GitHub Copilot', value: 'copilot' },
        { name: 'Windsurf', value: 'windsurf' },
        { name: 'Zed', value: 'zed' },
        { name: 'Cline', value: 'cline' },
        { name: 'Continue.dev', value: 'continue' },
        { name: 'Aider', value: 'aider' }
      ]
    }]);
    if (tools.length > 0) {
      profileConfig.only = tools;
    }
  }

  await createProfile(name, profileConfig);

  // Ask if they want to switch to it
  const { switchNow } = await inquirer.prompt([{
    type: 'confirm',
    name: 'switchNow',
    message: `Switch to "${name}" now?`,
    default: true
  }]);

  if (switchNow) {
    await switchProfile(name);
  }

  console.log('\n' + boxen(
    chalk.green(`✔ Profile "${name}" created`) +
    (switchNow ? chalk.gray(` (now active)`) : ''),
    { padding: { top: 0, bottom: 0, left: 1, right: 1 }, borderStyle: 'round', borderColor: 'green', dimBorder: true }
  ) + '\n');
}

export async function profileSwitchCommand(name) {
  try {
    await switchProfile(name);
    console.log('\n' + chalk.green(`✔ Switched to profile "${name}"\n`));
  } catch (err) {
    console.log('\n' + chalk.red(`✖ ${err.message}\n`));
  }
}

export async function profileDeleteCommand(name) {
  try {
    const { confirm } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirm',
      message: `Delete profile "${name}"? This cannot be undone.`,
      default: false
    }]);
    if (!confirm) {
      console.log(chalk.gray('\nCancelled.\n'));
      return;
    }
    await deleteProfile(name);
    console.log('\n' + chalk.green(`✔ Profile "${name}" deleted\n`));
  } catch (err) {
    console.log('\n' + chalk.red(`✖ ${err.message}\n`));
  }
}
