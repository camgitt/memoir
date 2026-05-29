import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import ora from 'ora';
import boxen from 'boxen';
import gradient from 'gradient-string';
import { getConfig, autoSetup } from '../config.js';
import { extractMemories, adapters } from '../adapters/index.js';
import { syncToLocal, syncToGit } from '../providers/index.js';
import inquirer from 'inquirer';
import { findClaudeSessions, parseSession, generateContextHandoff, shouldIgnoreProject, persistDecisions } from '../context/capture.js';
import { scanForSecrets, printSecurityReport } from '../security/scanner.js';
import { encryptDirectory, createVerifyToken } from '../security/encryption.js';
import { getRawConfig, saveConfig, migrateConfigToV2 } from '../config.js';
import { scanWorkspace } from '../workspace/tracker.js';
import { promptActivate } from './activate.js';
import { paths as sessionPaths, readSession, addNote, recordSessionEnd } from '../session/state.js';
import { renderSession } from '../session/render.js';
import { injectInto, detectAvailableTargets } from '../session/inject.js';

// Recursively scan every staged file (the REAL tool memory/config files about
// to be uploaded — CLAUDE.md, .cursorrules, settings.json, project configs,
// etc.) for secrets. When `redact` is true, rewrite each offending file in
// place so the cleaned version is what gets uploaded (and encrypted, if on).
// Returns { findings, scanned } where findings is a flat list of detections
// keyed by file. Best-effort: unreadable/binary files are skipped.
export async function scanStagedFiles(dir, { redact = false } = {}) {
  const findings = [];
  let scanned = 0;

  const walk = async (d) => {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch { return; }
    for (const entry of entries) {
      const fullPath = path.join(d, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      try {
        const stat = await fs.stat(fullPath);
        // Skip files larger than 1MB — same threshold as doctor's scan
        if (stat.size > 1024 * 1024) continue;
        const content = await fs.readFile(fullPath, 'utf-8');
        scanned++;
        const { found, clean } = scanForSecrets(content);
        if (found.length > 0) {
          for (const f of found) {
            findings.push({ file: fullPath, label: f.label, redacted: f.redacted });
          }
          if (redact && clean !== content) {
            await fs.writeFile(fullPath, clean);
          }
        }
      } catch {
        // Skip unreadable / non-text files
      }
    }
  };

  await walk(dir);
  return { findings, scanned };
}

export async function pushCommand(options = {}) {
  let config = await getConfig(options.profile);

  if (!config) {
    // Zero-config: auto-detect GitHub user, create repo, save config
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

          // Also feed structured decisions into session.json so they appear in
          // the pinned block and sync cross-machine. Dedupe against anything
          // the AI already captured via MCP tools or the user via `memoir note`.
          try {
            const current = await readSession();
            const existingTexts = new Set(
              current.current.decisions.map(d => (d.text || '').trim().toLowerCase())
            );
            // Quality filter: auto-extracted decisions come from regex patterns
            // that sometimes catch table cells or prose fragments. Keep only
            // substantive-looking entries.
            const isQuality = (text) => {
              if (!text) return false;
              if (text.length < 15) return false;                // too short to be a real decision
              if (text.length > 200) return false;               // probably a snippet, not a decision
              if (/\|/.test(text)) return false;                 // markdown table fragment
              if (/[_*`]{3,}/.test(text)) return false;          // markdown formatting leaked in
              if (!/[a-zA-Z]/.test(text)) return false;          // no actual words
              const words = text.split(/\s+/).length;
              if (words < 3) return false;                       // less than 3 words isn't a decision
              return true;
            };
            for (const d of parsed.decisions.slice(0, 10)) {
              const text = String(d.value || '').trim();
              if (!isQuality(text)) continue;
              if (existingTexts.has(text.toLowerCase())) continue;
              await addNote(text, { why: d.context ? `auto-captured: ${d.context.slice(0, 80)}` : undefined });
            }
            // Record a session summary in history for "recent sessions" section
            const filesList = Array.from(parsed.filesWritten || []).slice(0, 10);
            const durationMin = (parsed.firstTimestamp && parsed.lastTimestamp)
              ? Math.floor((new Date(parsed.lastTimestamp) - new Date(parsed.firstTimestamp)) / 60000)
              : null;
            const summary = parsed.slug ? `Worked on ${parsed.slug}` : `${filesList.length} file(s) touched`;
            await recordSessionEnd({ summary, filesTouched: filesList, durationMin });
            // Re-render into every detected tool so the pinned block reflects
            // what was just auto-captured from the .jsonl
            try {
              const state = await readSession();
              const rendered = renderSession(state);
              for (const target of Object.values(detectAvailableTargets())) {
                try { await injectInto(target, rendered); } catch {}
              }
            } catch {}
          } catch {
            // Session.json capture is best-effort
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

    // Include session.json (continuity state) so it syncs across machines
    let sessionIncluded = false;
    try {
      if (await fs.pathExists(sessionPaths.session)) {
        await fs.copy(sessionPaths.session, path.join(stagingDir, 'session.json'));
        sessionIncluded = true;
      }
    } catch {
      // Best-effort — don't fail the push over this
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

    // Scan the REAL files being synced (the staged tool memory/config files,
    // not just the handoff blob) for secrets before they leave the machine.
    //   • --redact            → strip secrets in place, then upload (sanitized)
    //   • otherwise           → WARN and continue
    //   • background autopush → stay silent and continue
    // We deliberately do NOT hard-block. This is a zero-knowledge encrypted
    // backup of the user's OWN files; silently refusing to back up — which the
    // detached `autopush` Stop-hook path (stdio:'ignore', MEMOIR_AUTOPUSH=1, no
    // TTY) would hit on any false-positive match — is a worse failure than
    // backing up. A future `--strict` flag could fail-closed for the
    // encrypt-off / shared-destination case. Wrapped so a scanner error can
    // never break the push.
    const background = process.env.MEMOIR_AUTOPUSH === '1';
    try {
      const { findings } = await scanStagedFiles(stagingDir, { redact: options.redact === true });
      if (findings.length > 0) {
        if (options.redact === true) {
          spinner.stop();
          console.log(chalk.yellow(`\n  🔒 Redacted ${findings.length} secret(s) from synced files before upload:`));
          for (const f of findings.slice(0, 5)) {
            console.log(chalk.gray(`     ${path.basename(f.file)}: ${f.label} (${f.redacted})`));
          }
          if (findings.length > 5) console.log(chalk.gray(`     ...and ${findings.length - 5} more`));
          spinner.start();
        } else if (!background) {
          // Warn (interactive or piped) but never block — the backup proceeds.
          spinner.stop();
          console.log(chalk.yellow(`\n  ⚠️  ${findings.length} potential secret(s) in synced files (backed up as-is):`));
          for (const f of findings.slice(0, 5)) {
            console.log(chalk.gray(`     ${path.basename(f.file)}: ${f.label} (${f.redacted})`));
          }
          if (findings.length > 5) console.log(chalk.gray(`     ...and ${findings.length - 5} more`));
          console.log(chalk.gray('  Re-run with ') + chalk.cyan('--redact') + chalk.gray(' to strip them from the backup.'));
          spinner.start();
        }
        // background autopush: silent, continue — never block the auto-backup
      }
    } catch {
      // Secret scan is best-effort — never let it break the push.
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
      spinner.start(chalk.gray('Deriving encryption key...'));

      encryptedDir = path.join(os.tmpdir(), `memoir-encrypted-${Date.now()}`);
      await fs.ensureDir(encryptedDir);
      const encryptedCount = await encryptDirectory(stagingDir, encryptedDir, passphrase, spinner);
      spinner.succeed(chalk.green(spinner.text));
      spinner.start();

      // Save verify token so restore can check passphrase before decrypting
      const token = await createVerifyToken(passphrase);
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

    // Prompt to activate memoir in this project (first push only)
    try {
      await promptActivate();
    } catch {
      // Activation prompt is best-effort
    }
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
