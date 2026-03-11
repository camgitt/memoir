import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import ora from 'ora';
import boxen from 'boxen';
import gradient from 'gradient-string';
import { getSession, getSubscription } from '../cloud/auth.js';
import { uploadBackup, downloadBackup, listBackups, cleanupOldBackups } from '../cloud/storage.js';
import { extractMemories } from '../adapters/index.js';
import { MAX_BACKUPS_FREE } from '../cloud/constants.js';

export async function cloudPushCommand(options = {}) {
  const session = await getSession();
  if (!session) {
    console.log('\n' + boxen(
      chalk.red('✖ Not logged in') + '\n\n' +
      chalk.white('Run ') + chalk.cyan('memoir login') + chalk.white(' first.'),
      { padding: 1, borderStyle: 'round', borderColor: 'red' }
    ) + '\n');
    return;
  }

  const sub = await getSubscription(session);
  const isPro = sub.status === 'pro';

  // Check backup count for free users
  if (!isPro) {
    const existing = await listBackups(session);
    if (existing.length >= MAX_BACKUPS_FREE) {
      console.log('\n' + boxen(
        chalk.yellow('Free plan limit reached') + '\n\n' +
        chalk.white(`You have ${existing.length}/${MAX_BACKUPS_FREE} backups.`) + '\n' +
        chalk.white('Oldest backup will be replaced.') + '\n\n' +
        chalk.gray('Upgrade to Pro for 50 backups + version history.'),
        { padding: 1, borderStyle: 'round', borderColor: 'yellow' }
      ) + '\n');
    }
  }

  console.log();
  const spinner = ora({ text: chalk.gray('Scanning AI tools...'), spinner: 'dots' }).start();

  const stagingDir = path.join(os.tmpdir(), `memoir-cloud-${Date.now()}`);
  await fs.ensureDir(stagingDir);

  try {
    const onlyFilter = options.only ? options.only.split(',').map(t => t.trim().toLowerCase()) : null;
    const foundAny = await extractMemories(stagingDir, spinner, onlyFilter);

    if (!foundAny) {
      spinner.fail(chalk.yellow('No AI tools found to back up.'));
      return;
    }

    // Collect tool results for metadata
    const toolResults = [];
    const entries = await fs.readdir(stagingDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        toolResults.push({ adapter: { name: entry.name } });
      }
    }

    spinner.start(chalk.gray('Uploading to memoir cloud...'));

    const backup = await uploadBackup(stagingDir, session, toolResults);

    // Cleanup old backups
    const deleted = await cleanupOldBackups(session, isPro);

    spinner.stop();

    const sizeStr = backup.sizeBytes < 1024
      ? `${backup.sizeBytes}B`
      : backup.sizeBytes < 1024 * 1024
        ? `${(backup.sizeBytes / 1024).toFixed(1)}KB`
        : `${(backup.sizeBytes / (1024 * 1024)).toFixed(1)}MB`;

    console.log(boxen(
      gradient.pastel('  Backed up to cloud  ') + '\n\n' +
      chalk.green('✔ ') + chalk.white(`Version ${backup.version}`) + '\n' +
      chalk.gray(`  ${backup.file_count} files, ${sizeStr}`) + '\n' +
      chalk.gray(`  from ${os.hostname()}`) +
      (deleted > 0 ? '\n' + chalk.gray(`  ${deleted} old backup${deleted > 1 ? 's' : ''} cleaned up`) : '') + '\n\n' +
      chalk.gray('Restore with: ') + chalk.cyan('memoir cloud restore'),
      { padding: 1, borderStyle: 'round', borderColor: 'green', dimBorder: true }
    ) + '\n');

  } catch (error) {
    spinner.fail(chalk.red('Cloud push failed: ') + error.message);
  } finally {
    await fs.remove(stagingDir);
  }
}

export async function cloudRestoreCommand(options = {}) {
  const session = await getSession();
  if (!session) {
    console.log('\n' + boxen(
      chalk.red('✖ Not logged in') + '\n\n' +
      chalk.white('Run ') + chalk.cyan('memoir login') + chalk.white(' first.'),
      { padding: 1, borderStyle: 'round', borderColor: 'red' }
    ) + '\n');
    return;
  }

  console.log();
  const spinner = ora({ text: chalk.gray('Fetching from memoir cloud...'), spinner: 'dots' }).start();

  try {
    const backups = await listBackups(session);

    if (backups.length === 0) {
      spinner.fail(chalk.yellow('No backups found in the cloud.'));
      console.log(chalk.gray('\n  Run ') + chalk.cyan('memoir cloud push') + chalk.gray(' to create your first backup.\n'));
      return;
    }

    // Use specified version or latest
    let backup;
    if (options.version) {
      backup = backups.find(b => b.version === parseInt(options.version));
      if (!backup) {
        spinner.fail(chalk.red(`Version ${options.version} not found.`));
        console.log(chalk.gray('\n  Run ') + chalk.cyan('memoir history') + chalk.gray(' to see available versions.\n'));
        return;
      }
    } else {
      backup = backups[0]; // Latest
    }

    spinner.text = chalk.gray(`Downloading version ${backup.version}...`);

    const stagingDir = path.join(os.tmpdir(), `memoir-cloud-restore-${Date.now()}`);
    await fs.ensureDir(stagingDir);

    const fileCount = await downloadBackup(backup, stagingDir, session);

    spinner.text = chalk.gray('Restoring files...');

    // Use the existing restore logic
    const { restoreMemories } = await import('../adapters/restore.js');
    const onlyFilter = options.only ? options.only.split(',').map(t => t.trim().toLowerCase()) : null;
    const autoYes = options.yes || false;

    const restored = await restoreMemories(stagingDir, spinner, onlyFilter, autoYes);

    spinner.stop();

    if (restored) {
      const date = new Date(backup.created_at).toLocaleDateString();
      console.log(boxen(
        gradient.pastel('  Restored from cloud  ') + '\n\n' +
        chalk.green('✔ ') + chalk.white(`Version ${backup.version}`) + chalk.gray(` from ${date}`) + '\n' +
        chalk.gray(`  ${backup.tools.join(', ')}`) + '\n' +
        (backup.machine_name ? chalk.gray(`  Originally from ${backup.machine_name}`) + '\n' : '') + '\n' +
        chalk.gray('Restart your AI tools to pick up the changes.'),
        { padding: 1, borderStyle: 'round', borderColor: 'green', dimBorder: true }
      ) + '\n');
    } else {
      console.log('\n' + boxen(
        chalk.yellow('Nothing was restored.'),
        { padding: 1, borderStyle: 'round', borderColor: 'yellow' }
      ) + '\n');
    }

    await fs.remove(stagingDir);

  } catch (error) {
    spinner.fail(chalk.red('Cloud restore failed: ') + error.message);
  }
}
