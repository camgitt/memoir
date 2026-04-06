import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import ora from 'ora';
import boxen from 'boxen';
import gradient from 'gradient-string';
import inquirer from 'inquirer';
import { getConfig, autoSetup } from '../config.js';
import { fetchFromLocal, fetchFromGit } from '../providers/restore.js';
import { decryptDirectory, verifyPassphrase } from '../security/encryption.js';
import { detectLocalHomeKey } from '../adapters/restore.js';
import { restoreWorkspace } from '../workspace/tracker.js';
import { getSession } from '../cloud/auth.js';
import { unbundleToDir } from '../cloud/storage.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY, STORAGE_BUCKET } from '../cloud/constants.js';

const home = os.homedir();

export async function restoreCommand(options = {}) {
  // Handle --from <token> for shared links
  if (options.from) {
    return restoreFromShare(options);
  }

  let config = await getConfig(options.profile);

  if (!config) {
    const setupSpinner = ora({ text: chalk.gray('Setting up memoir automatically...'), spinner: 'dots' }).start();
    config = await autoSetup();
    if (config) {
      setupSpinner.succeed(chalk.green('Auto-configured') + chalk.gray(` → ${config.gitRepo}`));
    } else {
      setupSpinner.fail(chalk.red('Could not detect GitHub username'));
      console.log('\n' + boxen(
        chalk.white('Run ') + chalk.cyan.bold('memoir init') + chalk.white(' to set up manually.'),
        { padding: 1, borderStyle: 'round', borderColor: 'yellow' }
      ) + '\n');
      return;
    }
  }

  console.log();
  const spinner = ora({ text: chalk.gray('Fetching memories from ' + (config.provider === 'git' ? 'GitHub' : 'local storage') + '...'), spinner: 'dots' }).start();

  const stagingDir = path.join(os.tmpdir(), `memoir-restore-${Date.now()}`);
  await fs.ensureDir(stagingDir);

  try {
    let restored = false;

    const onlyFilter = options.only ? options.only.split(',').map(t => t.trim().toLowerCase()) : null;

    const autoYes = !options.interactive;

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
          if (!(await verifyPassphrase(token, passphrase))) {
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
        const count = await decryptDirectory(stagingDir, decryptedDir, passphrase, spinner);
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

    // Restore workspace (clone git projects, unpack bundles)
    let workspaceResults = null;
    try {
      spinner.start(chalk.gray('Checking workspace...'));
      workspaceResults = await restoreWorkspace(stagingDir, spinner, autoYes);
      spinner.stop();

      if (workspaceResults) {
        const { cloned, unpacked, patched, skipped } = workspaceResults;
        if (cloned.length > 0 || unpacked.length > 0) {
          console.log('\n' + chalk.cyan.bold('  📁 Workspace restored:'));
          for (const p of cloned) {
            console.log(chalk.green(`    ✔ ${p.name}`) + chalk.gray(` → ${p.path}`));
          }
          for (const p of unpacked) {
            console.log(chalk.green(`    ✔ ${p.name}`) + chalk.gray(` → ${p.path} (unpacked)`));
          }
          if (patched.length > 0) {
            for (const p of patched) {
              console.log(chalk.yellow(`    ↻ ${p.name}`) + chalk.gray(` — uncommitted changes applied`));
            }
          }
          const existingCount = skipped.filter(s => s.reason === 'exists').length;
          if (existingCount > 0) {
            console.log(chalk.gray(`    ⏭ ${existingCount} project(s) already on this machine`));
          }
          restored = true;
        }
      }
    } catch {
      // Workspace restore is best-effort
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
      let workspaceMsg = '';
      if (workspaceResults) {
        const total = workspaceResults.cloned.length + workspaceResults.unpacked.length;
        if (total > 0) {
          workspaceMsg = '\n' + chalk.cyan(`📁 ${total} project(s) restored to this machine`);
        }
      }
      console.log(boxen(
        gradient.pastel('  Done!  ') + '\n\n' +
        chalk.white('Your AI tools have their memories back.') +
        handoffMsg + workspaceMsg + '\n' +
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

async function restoreFromShare(options) {
  const shareToken = options.from;

  console.log();
  const spinner = ora({ text: chalk.gray('Fetching share link...'), spinner: 'dots' }).start();

  const stagingDir = path.join(os.tmpdir(), `memoir-share-restore-${Date.now()}`);
  await fs.ensureDir(stagingDir);

  try {
    // Fetch share metadata from Supabase
    const metaRes = await fetch(
      `${SUPABASE_URL}/rest/v1/shared_links?select=*&token=eq.${shareToken}&limit=1`,
      {
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!metaRes.ok) {
      throw new Error('Failed to fetch share link');
    }

    const links = await metaRes.json();
    if (!links || links.length === 0) {
      spinner.stop();
      console.log('\n' + boxen(
        chalk.red('✖ Share link not found\n\n') +
        chalk.gray('The link may have expired or been deleted.'),
        { padding: 1, borderStyle: 'round', borderColor: 'red' }
      ) + '\n');
      return;
    }

    const shareLink = links[0];

    // Check expiry
    if (new Date(shareLink.expires_at) < new Date()) {
      spinner.stop();
      console.log('\n' + boxen(
        chalk.red('✖ Share link expired\n\n') +
        chalk.gray(`This link expired on ${new Date(shareLink.expires_at).toLocaleString()}`),
        { padding: 1, borderStyle: 'round', borderColor: 'red' }
      ) + '\n');
      return;
    }

    // Check use count
    if (shareLink.use_count >= shareLink.max_uses) {
      spinner.stop();
      console.log('\n' + boxen(
        chalk.red('✖ Share link exhausted\n\n') +
        chalk.gray(`This link has been used ${shareLink.use_count}/${shareLink.max_uses} times.`),
        { padding: 1, borderStyle: 'round', borderColor: 'red' }
      ) + '\n');
      return;
    }

    // Show share info
    spinner.stop();
    const tools = shareLink.tools || [];
    if (tools.length > 0) {
      console.log(chalk.cyan('\n  Shared tools: ') + chalk.white(tools.join(', ')));
    }
    console.log(chalk.gray(`  Uses: ${shareLink.use_count + 1}/${shareLink.max_uses}`) +
      chalk.gray(` | Expires: ${new Date(shareLink.expires_at).toLocaleString()}`));
    console.log();

    // Download the backup
    spinner.start(chalk.gray('Downloading share bundle...'));

    // Try authenticated first, fall back to anon key
    const session = await getSession();
    const authHeaders = session
      ? { 'Authorization': `Bearer ${session.access_token}`, 'apikey': SUPABASE_ANON_KEY }
      : { 'apikey': SUPABASE_ANON_KEY };

    const dlRes = await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${shareLink.backup_id}`, {
      headers: authHeaders,
    });

    if (!dlRes.ok) {
      throw new Error(`Download failed: ${await dlRes.text()}`);
    }

    const gzipped = Buffer.from(await dlRes.arrayBuffer());
    await unbundleToDir(gzipped, stagingDir);

    // Decrypt — backup is always encrypted for shares
    const manifestPath = path.join(stagingDir, 'manifest.enc');
    if (!await fs.pathExists(manifestPath)) {
      throw new Error('Share bundle is missing encryption manifest');
    }

    spinner.stop();
    console.log(chalk.cyan('  🔒 This share is encrypted'));

    // Verify passphrase
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
        if (!(await verifyPassphrase(token, passphrase))) {
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
    const decryptedDir = path.join(os.tmpdir(), `memoir-share-decrypted-${Date.now()}`);
    let restored = false;

    try {
      const count = await decryptDirectory(stagingDir, decryptedDir, passphrase, spinner);
      spinner.succeed(chalk.green(`Decrypted ${count} files`));

      // Restore from decrypted dir
      spinner.start(chalk.gray('Restoring...'));
      const onlyFilter = options.only ? options.only.split(',').map(t => t.trim().toLowerCase()) : null;
      const autoYes = !options.interactive;
      const { restoreMemories } = await import('../adapters/restore.js');
      restored = await restoreMemories(decryptedDir, spinner, onlyFilter, autoYes);
    } catch (err) {
      spinner.fail(chalk.red('Decryption failed: ') + err.message);
      return;
    } finally {
      await fs.remove(decryptedDir);
    }

    // Increment use_count
    try {
      const patchHeaders = { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' };
      if (session) patchHeaders['Authorization'] = `Bearer ${session.access_token}`;

      await fetch(`${SUPABASE_URL}/rest/v1/shared_links?token=eq.${shareToken}`, {
        method: 'PATCH',
        headers: patchHeaders,
        body: JSON.stringify({ use_count: shareLink.use_count + 1 }),
      });
    } catch {
      // Best-effort — don't fail restore if count update fails
    }

    spinner.stop();

    if (restored) {
      console.log('\n' + boxen(
        gradient.pastel('  Done!  ') + '\n\n' +
        chalk.white('Shared memories restored successfully.') + '\n' +
        chalk.gray('Restart your AI tools to pick up the changes.'),
        { padding: 1, borderStyle: 'round', borderColor: 'green', dimBorder: true }
      ) + '\n');
    } else {
      console.log('\n' + boxen(
        chalk.yellow('Nothing was restored.\n\n') +
        chalk.gray('You may have skipped all the restore prompts.'),
        { padding: 1, borderStyle: 'round', borderColor: 'yellow' }
      ) + '\n');
    }

  } catch (error) {
    spinner.fail(chalk.red('Restore from share failed: ') + error.message);
  } finally {
    await fs.remove(stagingDir);
  }
}
