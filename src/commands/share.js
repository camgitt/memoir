import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import ora from 'ora';
import boxen from 'boxen';
import gradient from 'gradient-string';
import inquirer from 'inquirer';
import { getSession } from '../cloud/auth.js';
import { extractMemories, adapters } from '../adapters/index.js';
import { encryptDirectory, createVerifyToken } from '../security/encryption.js';
import { bundleDir } from '../cloud/storage.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY, STORAGE_BUCKET } from '../cloud/constants.js';

export async function shareCommand(options = {}) {
  // Must be logged in to share
  const session = await getSession();
  if (!session) {
    console.log('\n' + boxen(
      chalk.red('✖ Not logged in\n\n') +
      chalk.white('Sharing requires a memoir cloud account.\n') +
      chalk.white('Run ') + chalk.cyan.bold('memoir login') + chalk.white(' to sign in.'),
      { padding: 1, borderStyle: 'round', borderColor: 'red' }
    ) + '\n');
    return;
  }

  console.log();
  const spinner = ora({ text: chalk.gray('Scanning for AI tools...'), spinner: 'dots' }).start();

  const stagingDir = path.join(os.tmpdir(), `memoir-share-${Date.now()}`);
  await fs.ensureDir(stagingDir);

  let encryptedDir = null;

  try {
    // Scan and extract memories (same as push)
    const onlyFilter = options.only ? options.only.split(',').map(t => t.trim().toLowerCase()) : null;
    const foundAny = await extractMemories(stagingDir, spinner, onlyFilter);

    if (!foundAny) {
      spinner.stop();
      console.log('\n' + boxen(
        chalk.yellow('No AI tools detected on this machine.\n\n') +
        chalk.gray('Supported: Claude, Gemini, Codex, Cursor, Copilot, Windsurf, Aider'),
        { padding: 1, borderStyle: 'round', borderColor: 'yellow' }
      ) + '\n');
      return;
    }

    // Count what was found
    const found = [];
    for (const adapter of adapters) {
      if (adapter.customExtract) {
        for (const file of adapter.files) {
          if (await fs.pathExists(path.join(adapter.source, file))) {
            found.push(adapter.name);
            break;
          }
        }
      } else if (await fs.pathExists(adapter.source)) {
        found.push(adapter.name);
      }
    }

    // Ask for encryption passphrase
    spinner.stop();
    const { passphrase } = await inquirer.prompt([{
      type: 'password',
      name: 'passphrase',
      message: '🔒 Set a passphrase for this share link (recipient will need it):',
      mask: '*',
      validate: (input) => input.length >= 6 ? true : 'Passphrase must be at least 6 characters'
    }]);

    spinner.start(chalk.gray('Encrypting...'));

    encryptedDir = path.join(os.tmpdir(), `memoir-share-enc-${Date.now()}`);
    await fs.ensureDir(encryptedDir);
    await encryptDirectory(stagingDir, encryptedDir, passphrase, spinner);

    // Save verify token so recipient can check passphrase
    const token = await createVerifyToken(passphrase);
    await fs.writeFile(path.join(encryptedDir, 'verify.enc'), token);

    // Bundle and upload to Supabase Storage
    spinner.text = chalk.gray('Uploading share bundle...');
    const gzipped = await bundleDir(encryptedDir);

    const shareToken = crypto.randomUUID();
    const storagePath = `shares/${session.user.id}/${shareToken}.gz`;

    const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${storagePath}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'apikey': SUPABASE_ANON_KEY,
        'Content-Type': 'application/octet-stream',
      },
      body: gzipped,
    });

    if (!uploadRes.ok) {
      const err = await uploadRes.text();
      throw new Error(`Upload failed: ${err}`);
    }

    // Parse options
    const expiresHours = parseInt(options.expires) || 24;
    const maxUses = parseInt(options.uses) || 5;
    const expiresAt = new Date(Date.now() + expiresHours * 60 * 60 * 1000).toISOString();

    // Store share metadata in shared_links table
    spinner.text = chalk.gray('Creating share link...');
    const metaRes = await fetch(`${SUPABASE_URL}/rest/v1/shared_links`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'apikey': SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify({
        token: shareToken,
        backup_id: storagePath,
        created_by: session.user.id,
        expires_at: expiresAt,
        max_uses: maxUses,
        use_count: 0,
        tools: found,
        size_bytes: gzipped.length,
      }),
    });

    if (!metaRes.ok) {
      const err = await metaRes.text();
      throw new Error(`Failed to create share link: ${err}`);
    }

    spinner.stop();

    // Count total files
    let totalFiles = 0;
    for (const adapter of adapters) {
      const adapterDir = path.join(stagingDir, adapter.name.toLowerCase().replace(/ /g, '-'));
      if (await fs.pathExists(adapterDir)) {
        const countDir = async (dir) => {
          let c = 0;
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const e of entries) {
            if (e.isDirectory()) c += await countDir(path.join(dir, e.name));
            else c++;
          }
          return c;
        };
        totalFiles += await countDir(adapterDir);
      }
    }

    // Format expiry for display
    const expiryDate = new Date(expiresAt);
    const expiryStr = expiryDate.toLocaleString();

    // Success output
    const shareUrl = `https://memoir.sh/share/${shareToken}`;
    const restoreCmd = `memoir restore --from ${shareToken}`;
    const toolList = found.map(t => chalk.cyan('  ✔ ' + t)).join('\n');

    console.log('\n' + boxen(
      gradient.pastel('  Shared!  ') + '\n\n' +
      toolList + '\n' +
      chalk.white(`${totalFiles} files from ${found.length} tool${found.length !== 1 ? 's' : ''}`) + '\n' +
      chalk.green('  🔒 E2E encrypted') + '\n\n' +
      chalk.white.bold('Share link:') + '\n' +
      chalk.cyan(`  ${shareUrl}`) + '\n\n' +
      chalk.white.bold('Recipient runs:') + '\n' +
      chalk.cyan(`  ${restoreCmd}`) + '\n\n' +
      chalk.gray(`Expires: ${expiryStr} (${expiresHours}h)`) + '\n' +
      chalk.gray(`Max uses: ${maxUses}`),
      { padding: 1, borderStyle: 'round', borderColor: 'green', dimBorder: true }
    ) + '\n');

  } catch (error) {
    spinner.fail(chalk.red('Share failed: ') + error.message);
  } finally {
    await fs.remove(stagingDir);
    if (encryptedDir) {
      await fs.remove(encryptedDir).catch(() => {});
    }
  }
}
