import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import ora from 'ora';
import boxen from 'boxen';
import gradient from 'gradient-string';
import { getConfig } from '../config.js';
import { extractMemories, adapters } from '../adapters/index.js';
import { syncToLocal, syncToGit } from '../providers/index.js';
import inquirer from 'inquirer';
import { findClaudeSessions, parseSession, generateContextHandoff, shouldIgnoreProject, persistDecisions } from '../context/capture.js';
import { scanForSecrets, printSecurityReport } from '../security/scanner.js';
import { encryptDirectory, createVerifyToken } from '../security/encryption.js';
import { getRawConfig, saveConfig, migrateConfigToV2 } from '../config.js';
import { scanWorkspace } from '../workspace/tracker.js';

export async function pushCommand(options = {}) {
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
  const spinner = ora({ text: chalk.gray('Scanning for AI tools...'), spinner: 'dots' }).start();

  const stagingDir = path.join(os.tmpdir(), `memoir-staging-${Date.now()}`);
  await fs.ensureDir(stagingDir);

  let encryptedDir = null;

  try {
    // Profile-level tool filter (config.only) merged with CLI --only flag
    const onlyRaw = options.only || (config.only ? config.only.join(',') : null);
    const onlyFilter = onlyRaw ? onlyRaw.split(',').map(t => t.trim().toLowerCase()) : null;
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

    // Capture session context from latest Claude session
    let contextCaptured = false;
    let sessionInfo = null;
    spinner.text = chalk.gray('Capturing session context...');
    try {
      const sessions = findClaudeSessions();
      if (sessions.length > 0) {
        const parsed = parseSession(sessions[0].path);
        if (parsed.userMessages.length > 0) {
          // Scan the generated handoff for any remaining secrets
          const handoff = generateContextHandoff(parsed);
          const { found, clean } = scanForSecrets(handoff);

          // Save handoff to staging dir
          const handoffDir = path.join(stagingDir, 'handoffs');
          await fs.ensureDir(handoffDir);
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          await fs.writeFile(path.join(handoffDir, `${timestamp}-claude.md`), clean);
          await fs.writeFile(path.join(handoffDir, 'latest.md'), clean);

          // Also save locally for memoir resume
          const localHandoffDir = path.join(os.homedir(), '.config', 'memoir', 'handoffs');
          await fs.ensureDir(localHandoffDir);
          await fs.writeFile(path.join(localHandoffDir, `${timestamp}-claude.md`), clean);
          await fs.writeFile(path.join(localHandoffDir, 'latest.md'), clean);

          // Persist decisions to Claude's memory so they survive across sessions
          let decisionCount = 0;
          if (parsed.decisions.length > 0) {
            try {
              decisionCount = persistDecisions(parsed.decisions);
            } catch {}
          }

          contextCaptured = true;
          sessionInfo = {
            slug: parsed.slug,
            filesModified: parsed.filesWritten.length,
            decisions: decisionCount,
            duration: parsed.firstTimestamp && parsed.lastTimestamp
              ? (() => {
                  const ms = new Date(parsed.lastTimestamp) - new Date(parsed.firstTimestamp);
                  const mins = Math.floor(ms / 60000);
                  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
                })()
              : null,
            secretsRedacted: found.length
          };

          spinner.stop();
          if (found.length > 0) {
            printSecurityReport(found);
          }
          spinner.start();
        }
      }
    } catch {
      // Context capture is best-effort — don't fail the push
    }

    // Scan workspace for projects (git repos + unbacked projects)
    let workspaceManifest = null;
    spinner.text = chalk.gray('Scanning workspace...');
    try {
      workspaceManifest = await scanWorkspace(stagingDir, spinner);
    } catch {
      // Workspace scan is best-effort
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

    // Encrypt if enabled (or ask on first push if not configured)
    let uploadDir = stagingDir;
    let encrypted = false;
    let shouldEncrypt = config.encrypt;

    if (shouldEncrypt === undefined) {
      // First push since encryption was added — ask once and save preference
      spinner.stop();
      const { wantEncrypt } = await inquirer.prompt([{
        type: 'confirm',
        name: 'wantEncrypt',
        message: 'Enable E2E encryption? (protects your backup even if compromised)',
        default: true
      }]);
      shouldEncrypt = wantEncrypt;

      // Save to config so we don't ask again
      try {
        let raw = await getRawConfig();
        if (raw) {
          if (!raw.version || raw.version < 2) {
            raw = migrateConfigToV2(raw);
          }
          const profileName = options.profile || raw.activeProfile || 'default';
          if (raw.profiles?.[profileName]) {
            raw.profiles[profileName].encrypt = shouldEncrypt;
          } else {
            raw.encrypt = shouldEncrypt;
          }
          await saveConfig(raw);
        }
      } catch {}
      spinner.start();
    }

    if (shouldEncrypt) {
      spinner.stop();
      const { passphrase } = await inquirer.prompt([{
        type: 'password',
        name: 'passphrase',
        message: '🔒 Encryption passphrase:',
        mask: '*',
        validate: (input) => input.length >= 6 ? true : 'Passphrase must be at least 6 characters'
      }]);
      spinner.start(chalk.gray('Encrypting...'));

      encryptedDir = path.join(os.tmpdir(), `memoir-encrypted-${Date.now()}`);
      await fs.ensureDir(encryptedDir);
      await encryptDirectory(stagingDir, encryptedDir, passphrase, spinner);

      // Save verify token so restore can check passphrase before decrypting
      const token = createVerifyToken(passphrase);
      await fs.writeFile(path.join(encryptedDir, 'verify.enc'), token);

      uploadDir = encryptedDir;
      encrypted = true;
    }

    spinner.text = chalk.gray('Uploading to ' + (config.provider === 'git' ? 'GitHub' : 'local storage') + '...');

    if (config.provider === 'local' || config.provider.includes('local')) {
      await syncToLocal(config, uploadDir, spinner);
    } else if (config.provider === 'git' || config.provider.includes('git')) {
      await syncToGit(config, uploadDir, spinner);
    } else {
      spinner.fail(chalk.red(`Unknown provider: ${config.provider}`));
      return;
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

    const dest = config.provider === 'git' ? config.gitRepo : config.localPath;

    // Success output
    const toolList = found.map(t => chalk.cyan('  ✔ ' + t)).join('\n');
    let contextLine = '';
    if (contextCaptured && sessionInfo) {
      const parts = [];
      if (sessionInfo.slug) parts.push(sessionInfo.slug);
      if (sessionInfo.duration) parts.push(sessionInfo.duration);
      if (sessionInfo.filesModified) parts.push(`${sessionInfo.filesModified} files changed`);
      contextLine = '\n' + chalk.green('  ✔ Session Context') + chalk.gray(` (${parts.join(', ')})`) + '\n';
      if (sessionInfo.decisions > 0) {
        contextLine += chalk.green(`  ✔ ${sessionInfo.decisions} decision(s) saved to persistent memory`) + '\n';
      }
      if (sessionInfo.secretsRedacted > 0) {
        contextLine += chalk.yellow(`  🔒 ${sessionInfo.secretsRedacted} secret(s) auto-redacted`) + '\n';
      }
    }
    let workspaceLine = '';
    if (workspaceManifest && workspaceManifest.projects.length > 0) {
      const gitCount = workspaceManifest.projects.filter(p => p.type === 'git' && p.gitRemote).length;
      const bundleCount = workspaceManifest.projects.filter(p => p.bundleFile).length;
      const parts = [];
      if (gitCount > 0) parts.push(`${gitCount} git`);
      if (bundleCount > 0) parts.push(`${bundleCount} bundled`);
      workspaceLine = '\n' + chalk.green('  ✔ Workspace') + chalk.gray(` (${workspaceManifest.projects.length} projects — ${parts.join(', ')})`) + '\n';
    }
    console.log('\n' + boxen(
      gradient.pastel('  Backed up!  ') + '\n\n' +
      toolList + contextLine + workspaceLine + '\n' +
      chalk.white(`${totalFiles} files from ${found.length} tool${found.length !== 1 ? 's' : ''}`) + '\n' +
      (encrypted ? chalk.green('  🔒 E2E encrypted') + '\n' : '') +
      chalk.gray(`→ ${dest}`) + '\n\n' +
      chalk.gray('Restore on another machine with: ') + chalk.cyan('memoir restore'),
      { padding: 1, borderStyle: 'round', borderColor: 'green', dimBorder: true }
    ) + '\n');
  } catch (error) {
    spinner.fail(chalk.red('Sync failed: ') + error.message);
  } finally {
    await fs.remove(stagingDir);
    // Clean up encrypted dir if it was created
    if (encryptedDir) {
      await fs.remove(encryptedDir).catch(() => {});
    }
  }
}
