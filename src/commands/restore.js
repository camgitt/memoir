import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import ora from 'ora';
import boxen from 'boxen';
import gradient from 'gradient-string';
import inquirer from 'inquirer';
import { getConfig } from '../config.js';
import { fetchFromLocal, fetchFromGit } from '../providers/restore.js';
import { decryptDirectory, verifyPassphrase } from '../security/encryption.js';
import { detectLocalHomeKey } from '../adapters/restore.js';

const home = os.homedir();

export async function restoreCommand(options = {}) {
  const config = await getConfig(options.profile);

  if (!config) {
    console.log('\n' + boxen(
      chalk.red('✖ Not configured yet\n\n') +
      chalk.white('Run ') + chalk.cyan.bold('memoir init') + chalk.white(' to get started.'),
      { padding: 1, borderStyle: 'round', borderColor: 'red' }
    ) + '\n');
    return;
  }

  console.log();
  const spinner = ora({ text: chalk.gray('Fetching memories from ' + (config.provider === 'git' ? 'GitHub' : 'local storage') + '...'), spinner: 'dots' }).start();

  const stagingDir = path.join(os.tmpdir(), `memoir-restore-${Date.now()}`);
  await fs.ensureDir(stagingDir);

  try {
    let restored = false;

    const onlyFilter = options.only ? options.only.split(',').map(t => t.trim().toLowerCase()) : null;

    const autoYes = options.yes || false;

    if (config.provider === 'local' || config.provider.includes('local')) {
      restored = await fetchFromLocal(config, stagingDir, spinner, onlyFilter, autoYes);
    } else if (config.provider === 'git' || config.provider.includes('git')) {
      restored = await fetchFromGit(config, stagingDir, spinner, onlyFilter, autoYes);
    } else {
      spinner.fail(chalk.red(`Unknown provider: ${config.provider}`));
      return;
    }

    // If backup is encrypted, decrypt it first then re-restore
    const manifestPath = path.join(stagingDir, 'manifest.enc');
    if (!restored && await fs.pathExists(manifestPath)) {
      spinner.stop();
      console.log(chalk.cyan('\n  🔒 Backup is encrypted'));

      // Verify passphrase first
      const verifyPath = path.join(stagingDir, 'verify.enc');
      let passphrase;
      for (let attempt = 0; attempt < 3; attempt++) {
        const { pass } = await inquirer.prompt([{
          type: 'password',
          name: 'pass',
          message: 'Decryption passphrase:',
          mask: '*',
        }]);
        passphrase = pass;

        if (await fs.pathExists(verifyPath)) {
          const token = await fs.readFile(verifyPath);
          if (!verifyPassphrase(token, passphrase)) {
            console.log(chalk.red('  Wrong passphrase. Try again.'));
            passphrase = null;
            continue;
          }
        }
        break;
      }

      if (!passphrase) {
        console.log(chalk.red('\n  Too many failed attempts.'));
        return;
      }

      spinner.start(chalk.gray('Decrypting...'));
      const decryptedDir = path.join(os.tmpdir(), `memoir-decrypted-${Date.now()}`);
      try {
        const count = await decryptDirectory(stagingDir, decryptedDir, passphrase);
        spinner.succeed(chalk.green(`Decrypted ${count} files`));

        // Now restore from decrypted dir
        spinner.start(chalk.gray('Restoring...'));
        const { restoreMemories } = await import('../adapters/restore.js');
        restored = await restoreMemories(decryptedDir, spinner, onlyFilter, autoYes);

        // Copy staging dir contents for handoff injection below
        await fs.copy(decryptedDir, stagingDir, { overwrite: true });
      } catch (err) {
        spinner.fail(chalk.red('Decryption failed: ') + err.message);
        return;
      } finally {
        await fs.remove(decryptedDir);
      }
    }

    spinner.stop();

    // Auto-inject session handoff if available
    let handoffInjected = false;
    let handoffInfo = null;
    if (restored) {
      try {
        // Check staging dir for handoffs (came from backup)
        const handoffDir = path.join(stagingDir, 'handoffs');
        let handoffContent = null;

        if (await fs.pathExists(handoffDir)) {
          const latestPath = path.join(handoffDir, 'latest.md');
          if (await fs.pathExists(latestPath)) {
            handoffContent = await fs.readFile(latestPath, 'utf8');
          } else {
            // Find newest handoff
            const files = (await fs.readdir(handoffDir))
              .filter(f => f.endsWith('.md'))
              .sort()
              .reverse();
            if (files.length > 0) {
              handoffContent = await fs.readFile(path.join(handoffDir, files[0]), 'utf8');
            }
          }
        }

        if (handoffContent) {
          // Save locally
          const localHandoffDir = path.join(home, '.config', 'memoir', 'handoffs');
          await fs.ensureDir(localHandoffDir);
          await fs.writeFile(path.join(localHandoffDir, 'latest.md'), handoffContent);

          // Inject into Claude's home-level memory so it's always loaded
          // Use detection (reads what Claude actually created) with corrected fallback
          const claudeDir = path.join(home, '.claude');
          if (await fs.pathExists(claudeDir)) {
            let homeKey = detectLocalHomeKey(claudeDir);
            if (!homeKey) {
              // Fallback: compute key matching Claude's actual encoding
              if (process.platform === 'win32') {
                homeKey = home.replace(/\\/g, '-').replace(/:/g, '-');
              } else {
                homeKey = '-' + home.replace(/^\//, '').replace(/\//g, '-');
              }
            }
            const claudeMemDir = path.join(claudeDir, 'projects', homeKey, 'memory');
            await fs.ensureDir(claudeMemDir);
            await fs.writeFile(path.join(claudeMemDir, 'handoff.md'), handoffContent);
            handoffInjected = true;
          }

          // Extract info for display — handles both old and new handoff formats
          const fromMatch = handoffContent.match(/\*\*From:\*\*\s*(.+)/) || handoffContent.match(/from \*\*(.+?)\*\*/);
          const whenMatch = handoffContent.match(/\*\*When:\*\*\s*(.+)/) || handoffContent.match(/on (\d{4}-\d{2}-\d{2}) at (.+)/);
          const durationMatch = handoffContent.match(/\*\*Duration:\*\*\s*(.+)/) || handoffContent.match(/Session: (\w+)/);
          handoffInfo = {
            from: fromMatch ? fromMatch[1] : 'another machine',
            when: whenMatch ? (whenMatch[2] ? `${whenMatch[1]} ${whenMatch[2]}` : whenMatch[1]) : 'recently',
            duration: durationMatch ? durationMatch[1] : null,
          };
        }
      } catch {
        // Handoff injection is best-effort
      }
    }

    if (restored) {
      let handoffMsg = '';
      if (handoffInjected && handoffInfo) {
        handoffMsg = '\n\n' + chalk.cyan('📋 Session context injected') + '\n' +
          chalk.gray(`   From: ${handoffInfo.from}`) + '\n' +
          chalk.gray(`   When: ${handoffInfo.when}`) +
          (handoffInfo.duration ? '\n' + chalk.gray(`   Duration: ${handoffInfo.duration}`) : '') + '\n' +
          chalk.gray('   Your AI will pick up where you left off.');
      }
      console.log(boxen(
        gradient.pastel('  Done!  ') + '\n\n' +
        chalk.white('Your AI tools have their memories back.') +
        handoffMsg + '\n' +
        chalk.gray(handoffInjected ? '' : 'Restart your AI tools to pick up the changes.'),
        { padding: 1, borderStyle: 'round', borderColor: 'green', dimBorder: true }
      ) + '\n');
    } else {
      console.log('\n' + boxen(
        chalk.yellow('Nothing was restored.\n\n') +
        chalk.white('This can happen if:\n') +
        chalk.gray('  1. You haven\'t run ') + chalk.cyan('memoir push') + chalk.gray(' on another machine yet\n') +
        chalk.gray('  2. You skipped all the restore prompts\n') +
        chalk.gray('  3. The backup repo is empty\n\n') +
        chalk.gray('Try: ') + chalk.cyan('memoir view') + chalk.gray(' to see what\'s in your backup'),
        { padding: 1, borderStyle: 'round', borderColor: 'yellow' }
      ) + '\n');
    }

  } catch (error) {
    spinner.fail(chalk.red('Restore failed: ') + error.message);
  } finally {
    await fs.remove(stagingDir);
  }
}
