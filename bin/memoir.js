#!/usr/bin/env node
import { program } from 'commander';
import chalk from 'chalk';
import boxen from 'boxen';
import gradient from 'gradient-string';
import { initCommand } from '../src/commands/init.js';
import { pushCommand } from '../src/commands/push.js';
import { restoreCommand } from '../src/commands/restore.js';
import { statusCommand } from '../src/commands/status.js';
import { doctorCommand } from '../src/commands/doctor.js';
import { viewCommand } from '../src/commands/view.js';
import { diffCommand } from '../src/commands/diff.js';
import { migrateCommand } from '../src/commands/migrate.js';
import { snapshotCommand } from '../src/commands/snapshot.js';
import { resumeCommand } from '../src/commands/resume.js';
import { profileListCommand, profileCreateCommand, profileSwitchCommand, profileDeleteCommand } from '../src/commands/profile.js';
import { loginCommand, logoutCommand, forgotPasswordCommand, deleteAccountCommand } from '../src/commands/login.js';
import { cloudPushCommand, cloudRestoreCommand } from '../src/commands/cloud.js';
import { shareCommand } from '../src/commands/share.js';
import { historyCommand } from '../src/commands/history.js';
import { projectsListCommand, projectsTodoCommand } from '../src/commands/projects.js';
import { upgradeCommand } from '../src/commands/upgrade.js';
import { activateCommand, deactivateCommand } from '../src/commands/activate.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { version: VERSION } = require('../package.json');

// Check for updates (non-blocking)
async function checkForUpdate() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch('https://registry.npmjs.org/memoir-cli/latest', { signal: controller.signal });
    clearTimeout(timeout);
    const data = await res.json();
    const latest = data.version;
    // Only notify if remote is actually newer (not just different)
    const isNewer = (a, b) => {
      const [a1, a2, a3] = a.split('.').map(Number);
      const [b1, b2, b3] = b.split('.').map(Number);
      return a1 > b1 || (a1 === b1 && a2 > b2) || (a1 === b1 && a2 === b2 && a3 > b3);
    };
    if (latest && isNewer(latest, VERSION)) {
      console.log(
        '\n' + boxen(
          chalk.yellow(`Update available: ${VERSION} → ${chalk.green.bold(latest)}`) + '\n' +
          chalk.gray('Run: ') + chalk.cyan('memoir update'),
          { padding: { top: 0, bottom: 0, left: 1, right: 1 }, borderStyle: 'round', borderColor: 'yellow', dimBorder: true }
        )
      );
    }
  } catch {}
}

// When run with no args: auto-push (zero-config)
if (process.argv.length <= 2) {
  // Pass 'push' as the command so Commander routes to pushCommand
  process.argv.push('push');
}

// Custom help banner
program.addHelpText('beforeAll', '\n' + boxen(
  gradient.pastel.multiline('  memoir  ') + '\n' +
  chalk.gray('  Your AI remembers everything.') + '\n\n' +
  chalk.white.bold('Zero-config:') + ' just run ' + chalk.cyan('memoir') + ' or ' + chalk.cyan('npx memoir-cli') + '\n' +
  chalk.gray('Auto-detects your GitHub, creates a private repo, and backs up.'),
  { padding: { top: 0, bottom: 0, left: 1, right: 1 }, borderStyle: 'round', borderColor: 'cyan', dimBorder: true }
) + '\n');

program
  .name('memoir')
  .description(chalk.white('Sync your AI memory across every device.'))
  .version(VERSION);

program
  .command('init')
  .description('Set up memoir with your storage provider')
  .option('--direction <direction>', 'Upload or download (upload, download)')
  .option('--provider <provider>', 'Storage provider (git, local)')
  .option('--local-path <path>', 'Local folder path (for local provider)')
  .option('--username <name>', 'GitHub username (for git provider)')
  .option('--repo <name>', 'GitHub repo name (for git provider)')
  .option('--encrypt', 'Enable E2E encryption')
  .option('--no-encrypt', 'Disable E2E encryption')
  .action(async (options) => {
    try {
      await initCommand(options);
    } catch (err) {
      console.error(chalk.red('\n✖ Error during initialization:'), err.message);
      process.exit(1);
    }
  });

program
  .command('push')
  .alias('remember')
  .description('Back up your AI memory to the cloud')
  .option('--only <tools>', 'Only sync specific tools (comma-separated)')
  .option('-p, --profile <name>', 'Use a specific profile')
  .action(async (options) => {
    try {
      await pushCommand(options);
    } catch (err) {
      console.error(chalk.red('\n✖ Error during sync:'), err.message);
      process.exit(1);
    }
  });

program
  .command('restore')
  .alias('pull')
  .description('Restore your AI memory on this machine')
  .option('--only <tools>', 'Only restore specific tools (comma-separated)')
  .option('-i, --interactive', 'Confirm each tool before restoring')
  .option('-p, --profile <name>', 'Use a specific profile')
  .option('--from <token>', 'Restore from a share link token')
  .action(async (options) => {
    try {
      await restoreCommand(options);
    } catch (err) {
      console.error(chalk.red('\n✖ Error during restore:'), err.message);
      process.exit(1);
    }
  });

program
  .command('share')
  .description('Share your AI memory via a secure link')
  .option('--only <tools>', 'Only share specific tools (comma-separated)')
  .option('--expires <hours>', 'Link expiry in hours (default: 24)')
  .option('--uses <number>', 'Max number of uses (default: 5)')
  .action(async (options) => {
    try {
      await shareCommand(options);
    } catch (err) {
      console.error(chalk.red('\n✖ Error during share:'), err.message);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('See what AI tools are on this machine')
  .option('-p, --profile <name>', 'Use a specific profile')
  .action(async (options) => {
    try {
      await statusCommand(options);
    } catch (err) {
      console.error(chalk.red('\n✖ Error:'), err.message);
      process.exit(1);
    }
  });

program
  .command('doctor')
  .alias('diagnose')
  .description('Diagnose common issues with your memoir setup')
  .option('-p, --profile <name>', 'Use a specific profile')
  .action(async (options) => {
    try {
      await doctorCommand(options);
    } catch (err) {
      console.error(chalk.red('\n✖ Error:'), err.message);
      process.exit(1);
    }
  });

program
  .command('view')
  .alias('ls')
  .description('Preview what files are in your backup')
  .option('-p, --profile <name>', 'Use a specific profile')
  .action(async (options) => {
    try {
      await viewCommand(options);
    } catch (err) {
      console.error(chalk.red('\n✖ Error:'), err.message);
      process.exit(1);
    }
  });

program
  .command('diff')
  .alias('changes')
  .description('Show what changed since your last backup')
  .option('-p, --profile <name>', 'Use a specific profile')
  .action(async (options) => {
    try {
      await diffCommand(options);
    } catch (err) {
      console.error(chalk.red('\n✖ Error:'), err.message);
      process.exit(1);
    }
  });

program
  .command('snapshot')
  .alias('handoff')
  .description('Capture your current coding session for handoff')
  .option('--smart', 'Use AI to generate a better summary (requires Gemini API key)')
  .option('--goal <goal>', 'What you want to do next (goal-directed handoff)')
  .option('-p, --profile <name>', 'Use a specific profile')
  .action(async (options) => {
    try {
      await snapshotCommand(options);
    } catch (err) {
      console.error(chalk.red('\n✖ Error during snapshot:'), err.message);
      process.exit(1);
    }
  });

program
  .command('resume')
  .description('Pick up where you left off on another machine')
  .option('--inject', 'Write the handoff where your AI tool will read it')
  .option('--to <tool>', 'Target tool for injection (claude, gemini, cursor, codex)')
  .option('-p, --profile <name>', 'Use a specific profile')
  .action(async (options) => {
    try {
      await resumeCommand(options);
    } catch (err) {
      console.error(chalk.red('\n✖ Error during resume:'), err.message);
      process.exit(1);
    }
  });

program
  .command('update')
  .description('Update memoir to the latest version')
  .action(async () => {
    try {
      const res = await fetch('https://registry.npmjs.org/memoir-cli/latest');
      const data = await res.json();
      const latest = data.version;

      if (latest === VERSION) {
        console.log('\n' + boxen(
          chalk.green('✔ Already up to date!') + '\n' +
          chalk.gray(`v${VERSION}`),
          { padding: { top: 0, bottom: 0, left: 1, right: 1 }, borderStyle: 'round', borderColor: 'green', dimBorder: true }
        ) + '\n');
        return;
      }

      console.log('\n' + chalk.cyan(`Updating memoir ${VERSION} → ${chalk.green.bold(latest)}...`) + '\n');

      const { execSync } = await import('child_process');
      // Always use npm — bun installs to a different location and can cause PATH conflicts
      const cmd = 'npm install -g memoir-cli';

      execSync(cmd, { stdio: 'inherit' });

      console.log('\n' + boxen(
        gradient.pastel('  Updated!  ') + '\n\n' +
        chalk.white(`memoir ${VERSION} → ${chalk.green.bold(latest)}`),
        { padding: 1, borderStyle: 'round', borderColor: 'green', dimBorder: true }
      ) + '\n');
      process.exit(0); // Exit immediately — old process still has old VERSION
    } catch (err) {
      console.error(chalk.red('\n✖ Update failed:'), err.message);
      console.log(chalk.gray('Try manually: ') + chalk.cyan('npm install -g memoir-cli'));
      process.exit(1);
    }
  });

program
  .command('upgrade')
  .alias('pro')
  .description('View plans and upgrade your memoir subscription')
  .action(async () => {
    try {
      await upgradeCommand();
    } catch (err) {
      console.error(chalk.red('\n✖ Error:'), err.message);
      process.exit(1);
    }
  });

program
  .command('activate')
  .description('Add memoir instructions to this project so your AI uses it automatically')
  .action(async () => {
    try {
      await activateCommand();
    } catch (err) {
      console.error(chalk.red('\n✖ Error:'), err.message);
      process.exit(1);
    }
  });

program
  .command('deactivate')
  .description('Remove memoir instructions from this project')
  .action(async () => {
    try {
      await deactivateCommand();
    } catch (err) {
      console.error(chalk.red('\n✖ Error:'), err.message);
      process.exit(1);
    }
  });

program
  .command('encrypt')
  .description('Toggle E2E encryption for your backups')
  .option('--on', 'Enable encryption without prompting')
  .option('--off', 'Disable encryption without prompting')
  .action(async (options) => {
    try {
      const { getConfig, getRawConfig, saveConfig, migrateConfigToV2 } = await import('../src/config.js');
      const config = await getConfig();
      if (!config) {
        console.error(chalk.red('\n✖ Not configured. Run memoir init first.'));
        process.exit(1);
      }
      const current = config.encrypt || false;
      console.log(chalk.white(`\n  Encryption is currently: ${current ? chalk.green('ON') : chalk.red('OFF')}`));

      let newValue;
      if (options.on) {
        newValue = true;
      } else if (options.off) {
        newValue = false;
      } else {
        const inquirer = (await import('inquirer')).default;
        const { toggle } = await inquirer.prompt([{
          type: 'confirm',
          name: 'toggle',
          message: current ? 'Disable encryption?' : 'Enable encryption?',
          default: !current
        }]);
        newValue = toggle ? !current : current;
      }

      if (newValue !== current) {
        let raw = await getRawConfig();
        if (!raw.version || raw.version < 2) raw = migrateConfigToV2(raw);
        const profileName = raw.activeProfile || 'default';
        if (raw.profiles?.[profileName]) {
          raw.profiles[profileName].encrypt = newValue;
        } else {
          raw.encrypt = newValue;
        }
        await saveConfig(raw);
        console.log(chalk.green(`\n  ✔ Encryption ${newValue ? 'enabled' : 'disabled'}. Next push will ${newValue ? 'encrypt' : 'skip encryption'}.\n`));
      }
    } catch (err) {
      console.error(chalk.red('\n✖ Error:'), err.message);
      process.exit(1);
    }
  });

program
  .command('migrate')
  .description('Translate memory between AI tools (Claude, Gemini, Codex, Cursor, etc.)')
  .option('--from <tool>', 'Source tool (claude, gemini, codex, cursor, copilot, windsurf, aider)')
  .option('--to <tool>', 'Target tool (claude, gemini, codex, cursor, copilot, windsurf, aider, all)')
  .option('--dry-run', 'Preview translation without writing files')
  .action(async (options) => {
    try {
      await migrateCommand(options);
    } catch (err) {
      console.error(chalk.red('\n✖ Error during migration:'), err.message);
      process.exit(1);
    }
  });

// Cloud auth
program
  .command('login')
  .description('Sign in to memoir cloud')
  .option('--email <email>', 'Email address (skip interactive prompt)')
  .option('--password <password>', 'Password (skip interactive prompt)')
  .option('--signup', 'Create a new account instead of signing in')
  .action(async (options) => {
    try {
      await loginCommand(options);
    } catch (err) {
      console.error(chalk.red('\n✖ Error:'), err.message);
      process.exit(1);
    }
  });

program
  .command('logout')
  .description('Sign out of memoir cloud')
  .action(async () => {
    try {
      await logoutCommand();
    } catch (err) {
      console.error(chalk.red('\n✖ Error:'), err.message);
      process.exit(1);
    }
  });

program
  .command('forgot-password')
  .alias('reset-password')
  .description('Send a password reset email')
  .option('--email <email>', 'Email address (skip interactive prompt)')
  .action(async (options) => {
    try {
      await forgotPasswordCommand(options);
    } catch (err) {
      console.error(chalk.red('\n✖ Error:'), err.message);
      process.exit(1);
    }
  });

// Account management
const account = program.command('account').description('Manage your memoir account');

account
  .command('delete')
  .description('Permanently delete your account and all cloud data')
  .option('--confirm', 'Skip interactive prompt (Node 25 workaround)')
  .action(async (options) => {
    try {
      await deleteAccountCommand(options);
    } catch (err) {
      console.error(chalk.red('\n✖ Error:'), err.message);
      process.exit(1);
    }
  });

// Cloud sync
const cloud = program.command('cloud').description('Cloud backup and restore (Pro)');

cloud
  .command('push')
  .description('Back up your AI memory to the cloud')
  .option('--only <tools>', 'Only sync specific tools (comma-separated)')
  .action(async (options) => {
    try {
      await cloudPushCommand(options);
    } catch (err) {
      console.error(chalk.red('\n✖ Error:'), err.message);
      process.exit(1);
    }
  });

cloud
  .command('restore')
  .description('Restore your AI memory from the cloud')
  .option('--only <tools>', 'Only restore specific tools (comma-separated)')
  .option('-y, --yes', 'Skip confirmation prompts')
  .option('--version <number>', 'Restore a specific version')
  .action(async (options) => {
    try {
      await cloudRestoreCommand(options);
    } catch (err) {
      console.error(chalk.red('\n✖ Error:'), err.message);
      process.exit(1);
    }
  });

program
  .command('history')
  .description('View your cloud backup history')
  .action(async () => {
    try {
      await historyCommand();
    } catch (err) {
      console.error(chalk.red('\n✖ Error:'), err.message);
      process.exit(1);
    }
  });

// Profile management
const profile = program.command('profile').description('Manage profiles (personal, work, etc.)');

profile
  .command('list')
  .alias('ls')
  .description('List all profiles')
  .action(async () => {
    try {
      await profileListCommand();
    } catch (err) {
      console.error(chalk.red('\n✖ Error:'), err.message);
      process.exit(1);
    }
  });

profile
  .command('create <name>')
  .description('Create a new profile')
  .action(async (name) => {
    try {
      await profileCreateCommand(name);
    } catch (err) {
      console.error(chalk.red('\n✖ Error:'), err.message);
      process.exit(1);
    }
  });

profile
  .command('switch <name>')
  .alias('use')
  .description('Switch to a profile')
  .action(async (name) => {
    try {
      await profileSwitchCommand(name);
    } catch (err) {
      console.error(chalk.red('\n✖ Error:'), err.message);
      process.exit(1);
    }
  });

profile
  .command('delete <name>')
  .alias('rm')
  .description('Delete a profile')
  .action(async (name) => {
    try {
      await profileDeleteCommand(name);
    } catch (err) {
      console.error(chalk.red('\n✖ Error:'), err.message);
      process.exit(1);
    }
  });

// Project tracker
const projects = program.command('projects').alias('p').description('Track and manage your projects');

projects
  .command('list', { isDefault: true })
  .alias('ls')
  .description('List all projects with recent activity')
  .option('--all', 'Show all projects (default: top 15)')
  .option('-v, --verbose', 'Show more commits and todos')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      await projectsListCommand(options);
    } catch (err) {
      console.error(chalk.red('\n✖ Error:'), err.message);
      process.exit(1);
    }
  });

projects
  .command('todo <project> [text]')
  .description('Add or manage todos for a project')
  .option('--done <index>', 'Mark a todo as done by number')
  .option('--clear', 'Clear all todos for this project')
  .action(async (project, text, options) => {
    try {
      await projectsTodoCommand(project, text, options);
    } catch (err) {
      console.error(chalk.red('\n✖ Error:'), err.message);
      process.exit(1);
    }
  });

program
  .command('mcp')
  .description('Start the MCP server (for Claude Code, Cursor, VS Code integration)')
  .action(async () => {
    // Import and run the MCP server directly
    await import('../src/mcp.js');
  });

program.hook('postAction', async () => {
  await checkForUpdate();
});

program.parse();
