#!/usr/bin/env node
import { program } from 'commander';
import chalk from 'chalk';
import boxen from 'boxen';
import gradient from 'gradient-string';
import { initCommand } from '../src/commands/init.js';
import { pushCommand } from '../src/commands/push.js';
import { restoreCommand } from '../src/commands/restore.js';
import { statusCommand } from '../src/commands/status.js';
import { viewCommand } from '../src/commands/view.js';
import { migrateCommand } from '../src/commands/migrate.js';
import { snapshotCommand } from '../src/commands/snapshot.js';
import { resumeCommand } from '../src/commands/resume.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { version: VERSION } = require('../package.json');

// Show quick start when run with no args
if (process.argv.length <= 2) {
  console.log('\n' + boxen(
    gradient.pastel.multiline('  memoir  ') + '\n' +
    chalk.gray('  Your AI remembers everything.') + '\n\n' +
    chalk.white.bold('Quick Start:') + '\n' +
    chalk.cyan('  memoir init      ') + chalk.gray('— first-time setup') + '\n' +
    chalk.cyan('  memoir push      ') + chalk.gray('— back up your AI memory') + '\n' +
    chalk.cyan('  memoir restore   ') + chalk.gray('— restore on a new machine') + '\n' +
    chalk.cyan('  memoir snapshot  ') + chalk.gray('— capture your current session') + '\n' +
    chalk.cyan('  memoir resume    ') + chalk.gray('— pick up where you left off') + '\n' +
    chalk.cyan('  memoir status    ') + chalk.gray('— see detected AI tools') + '\n\n' +
    chalk.gray('  Tip: use --only claude,gemini to sync specific tools') + '\n\n' +
    chalk.gray(`v${VERSION}`),
    { padding: 1, borderStyle: 'round', borderColor: 'cyan', dimBorder: true }
  ) + '\n');
  process.exit(0);
}

// Custom help banner
program.addHelpText('beforeAll', '\n' + boxen(
  gradient.pastel.multiline('  memoir  ') + '\n' +
  chalk.gray('  Your AI remembers everything.'),
  { padding: { top: 0, bottom: 0, left: 1, right: 1 }, borderStyle: 'round', borderColor: 'cyan', dimBorder: true }
) + '\n');

program
  .name('memoir')
  .description(chalk.white('Sync your AI memory across every device.'))
  .version(VERSION);

program
  .command('init')
  .description('Set up memoir with your storage provider')
  .action(async () => {
    try {
      await initCommand();
    } catch (err) {
      console.error(chalk.red('\n✖ Error during initialization:'), err.message);
      process.exit(1);
    }
  });

program
  .command('push')
  .alias('remember')
  .description('Back up your AI memory to the cloud')
  .option('--only <tools>', 'Only sync specific tools (comma-separated: claude,gemini,codex,cursor,copilot,windsurf,aider)')
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
  .option('--only <tools>', 'Only restore specific tools (comma-separated: claude,gemini,codex,cursor,copilot,windsurf,aider)')
  .option('-y, --yes', 'Skip confirmation prompts (restore all)')
  .action(async (options) => {
    try {
      await restoreCommand(options);
    } catch (err) {
      console.error(chalk.red('\n✖ Error during restore:'), err.message);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('See what AI tools are on this machine')
  .action(async () => {
    try {
      await statusCommand();
    } catch (err) {
      console.error(chalk.red('\n✖ Error:'), err.message);
      process.exit(1);
    }
  });

program
  .command('view')
  .alias('ls')
  .description('Preview what files are in your backup')
  .action(async () => {
    try {
      await viewCommand();
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
  .action(async (options) => {
    try {
      await resumeCommand(options);
    } catch (err) {
      console.error(chalk.red('\n✖ Error during resume:'), err.message);
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

program.parse();
