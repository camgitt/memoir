import { projectIdentity } from '../memory/scope.js';
import { restoreStoredMemories, stageMemories } from '../memory/store.js';
import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import ora from 'ora';
import boxen from 'boxen';
import gradient from 'gradient-string';
import { execFileSync } from 'child_process';
import { getConfig, autoSetup } from '../config.js';
import { extractMemories, adapters } from '../adapters/index.js';
import { syncToLocal, syncToGit, withLocalBackupLock, cloneForSync, remoteHasFile, checkoutFromRemote } from '../providers/index.js';
import inquirer from 'inquirer';
import { appendEvent } from '../events/log.js';
import { findClaudeSessions, parseSession, generateContextHandoff, shouldIgnoreProject, persistDecisions, isQuality, enrichWithGit } from '../context/capture.js';
import { saveHandoff, handoffFilename } from '../context/handoffs.js';
import { scanForSecrets, printSecurityReport } from '../security/scanner.js';
import { encryptDirectory, decryptDirectory, createVerifyToken } from '../security/encryption.js';
import { getRawConfig, saveConfig, migrateConfigToV2 } from '../config.js';
import { scanWorkspace } from '../workspace/tracker.js';
import { promptActivate } from './activate.js';
import { paths as sessionPaths, readSession, writeSession, mergeSessions, addNote, recordSessionEnd } from '../session/state.js';
import { migrateSessionData } from '../session/migrations.js';
import { withSessionLock } from '../session/lock.js';
import { listSafeFiles, readSafeFile, writeSafeFile } from '../security/files.js';
import { renderSession } from '../session/render.js';
import { injectInto, detectAvailableTargets } from '../session/inject.js';

// A failed read never authorizes replacing an existing snapshot. Encrypted
// snapshots are authenticated before merging, using the same user-held key.
async function fetchRemoteSessionBestEffort(config, getPassphrase) {
  let cloneDir = null;
  let plainDir = null;
  try {
    let source;
    if (config.provider?.includes('local')) {
      source = (config.localPath || '').replace(/^~/, os.homedir());
      if (!source || !await fs.pathExists(source)) return { session: null };
    } else if (config.provider?.includes('git')) {
      cloneDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-push-peek-'));
      cloneForSync(config.gitRepo, cloneDir, { timeout: 120000 });
      source = cloneDir;
      // Materialize the complete tree before merging a snapshot. Correctness
      // comes before the old optimization that omitted encrypted session data.
      if (remoteHasFile(cloneDir, 'manifest.enc') || config.encrypt !== false) {
        if (remoteHasFile(cloneDir, '.')) {
          if (!checkoutFromRemote(cloneDir, '.')) throw new Error('Could not read prior backup');
        }
      } else if (remoteHasFile(cloneDir, 'session.json') && !checkoutFromRemote(cloneDir, 'session.json')) {
        throw new Error('Could not read prior session');
      }
    } else { throw new Error('Unsupported backup provider'); }

    if (cloneDir && remoteHasFile(cloneDir, 'projects.json') && !checkoutFromRemote(cloneDir, 'projects.json')) throw new Error('Could not read prior project mapping');
    if (cloneDir && remoteHasFile(cloneDir, 'memoir-memories') && !checkoutFromRemote(cloneDir, 'memoir-memories')) throw new Error('Could not read prior memory records');
    const encrypted = await fs.pathExists(path.join(source, 'manifest.enc'));
    if (encrypted) {
      if (config.encrypt === false) throw new Error('The destination is encrypted. Restore it before choosing a new plaintext destination.');
      plainDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-prior-'));
      await decryptDirectory(source, plainDir, await getPassphrase());
      source = plainDir;
    }
    const file = path.join(source, 'session.json');
    let session = null;
    if (await fs.pathExists(file)) {
      const migrated = migrateSessionData(JSON.parse((await readSafeFile(source, 'session.json')).toString('utf8')));
      if (migrated.future) throw new Error('Backup uses a newer session schema; upgrade Memoir first.');
      session = migrated.state;
    }
    return { session, cloneDir, plainDir, source, encrypted };
  } catch (err) {
    if (cloneDir) await fs.remove(cloneDir).catch(() => {});
    if (plainDir) await fs.remove(plainDir).catch(() => {});
    throw new Error('Previous backup could not be verified; it was left unchanged. ' + err.message);
  }
}

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
      setupSpinner.succeed(chalk.green('Auto-configured') + chalk.gray(` → ${config.gitRepo || config.localPath}`));
    } else {
      setupSpinner.fail(chalk.red('Could not detect GitHub username'));
      console.log('\n' + boxen(
        chalk.white('Run ') + chalk.cyan.bold('memoir init') + chalk.white(' to set up manually.'),
        { padding: 1, borderStyle: 'round', borderColor: 'yellow' }
      ) + '\n');
      return;
    }
  }

  // Serialize the complete read/merge/write cycle, including encrypted reads.
  if (config.provider?.includes('local') && !options.localLockHeld) {
    return withLocalBackupLock(config, () => pushCommand({ ...options, localLockHeld: true }));
  }

  console.log();
  const spinner = ora({ text: chalk.gray('Scanning for AI tools...'), spinner: 'dots' }).start();

  const stagingDir = path.join(os.tmpdir(), `memoir-staging-${Date.now()}`);
  await fs.ensureDir(stagingDir);

  let encryptedDir = null;
  let remoteCloneDir = null;
  let remotePlainDir = null;
  let backupPassphrase = process.env.MEMOIR_PASSPHRASE || '';
  const getPassphrase = async () => {
    if (backupPassphrase.length >= 6) return backupPassphrase;
    if (!process.stdin.isTTY) throw new Error('Encrypted backup requires MEMOIR_PASSPHRASE; no files were uploaded.');
    spinner.stop();
    const answer = await inquirer.prompt([{ type: 'password', name: 'passphrase', message: 'Encryption passphrase:', mask: '*', validate: value => value.length >= 6 || 'Use at least 6 characters' }]);
    backupPassphrase = answer.passphrase;
    spinner.start();
    return backupPassphrase;
  };

  try {
    // Profile-level tool filter (config.only) merged with CLI --only flag
    const onlyRaw = options.only || (config.only ? config.only.join(',') : null);
    const onlyFilter = onlyRaw ? onlyRaw.split(',').map(t => t.trim().toLowerCase()) : null;
    const foundAny = await extractMemories(stagingDir, spinner, onlyFilter);

    if (!foundAny && !await fs.pathExists(sessionPaths.session)) {
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
        const parsed = enrichWithGit(parseSession(sessions[0].path));
        if (parsed.cwd && projectIdentity(parsed.cwd) === projectIdentity() && parsed.userMessages.length > 0) {
          // Scan the generated handoff for any remaining secrets
          const handoff = generateContextHandoff(parsed);
          const { found, clean } = scanForSecrets(handoff);

          // Staged copy for upload + local copy for `memoir resume`, same
          // filename; the local dir is pruned to a bounded window.
          await saveHandoff(clean, {
            dirs: [path.join(stagingDir, 'handoffs'), path.join(os.homedir(), '.config', 'memoir', 'handoffs')],
            filename: handoffFilename(),
          });

          // Quality filter: auto-extracted decisions come from regex patterns
          // that sometimes catch table cells, prose fragments, or truncated
          // pasted-spec snippets. Run the SAME filter over parsed.decisions
          // ONCE, before either persistence sink — previously persistDecisions()
          // received the raw unfiltered list while only the session.json sink
          // below filtered, so junk could reach session-decisions.md even after
          // being rejected from session.json. Both sinks now agree on what's junk.
          // Gate on the string each sink actually PERSISTS, not on d.value.
          // For rename/tech captures d.value is a single whitespace-free
          // token, so isQuality's words>=3 rule rejected 100% of them —
          // two of the three advertised capture categories were dead code
          // while persistDecisions would have written the clean d.context.
          const decisionText = (d) => {
            const v = String(d.value || '').trim();
            const c = String(d.context || '').trim();
            return (d.type === 'rename' || d.type === 'tech') && c ? c : v;
          };
          const qualityDecisions = parsed.decisions.filter(d => isQuality(decisionText(d)));

          let decisionCount = qualityDecisions.length;

          // Also feed structured decisions into session.json so they appear in
          // the pinned block and sync cross-machine. Dedupe against anything
          // the AI already captured via MCP tools or the user via `memoir note`.
          try {
            const current = await readSession();
            const existingTexts = new Set(
              current.current.decisions.map(d => (d.text || '').trim().toLowerCase())
            );
            for (const d of qualityDecisions.slice(0, 10)) {
              const text = decisionText(d);
              if (existingTexts.has(text.toLowerCase())) continue;
              // A `why` that merely restates the text is not a rationale —
              // for rename/tech captures decisionText() IS d.context, so the
              // old line produced `why: "auto-captured: switch to Sonnet"`
              // under text "switch to Sonnet". Content-free, and it made
              // auto-captures indistinguishable from real reasoning in the
              // pinned block. Emit no why rather than a fake one.
              const ctx = String(d.context || '').trim();
              const restates = !ctx || ctx.toLowerCase() === text.trim().toLowerCase();
              await addNote(text, { project: parsed.cwd, why: restates ? undefined : `auto-captured: ${ctx.slice(0, 80)}` });
            }
            // Record a session summary in history for "recent sessions" section.
            // Project + branch + the last thing the user asked for — the old
            // summary was the transcript's random slug ("Worked on
            // calm-bubbling-liskov"), which told the next session nothing.
            const filesList = Array.from(parsed.filesWritten || []).slice(0, 10);
            const durationMin = (parsed.firstTimestamp && parsed.lastTimestamp)
              ? Math.floor((new Date(parsed.lastTimestamp) - new Date(parsed.firstTimestamp)) / 60000)
              : null;
            const lastAsk = [...parsed.userMessages].reverse().find((m) => m.length > 10) || '';
            const project = parsed.cwd ? path.basename(parsed.cwd) : (parsed.slug || 'session');
            const branch = parsed.gitBranch && parsed.gitBranch !== 'HEAD' ? ` (${parsed.gitBranch})` : '';
            const ask = lastAsk.replace(/\s+/g, ' ').trim().slice(0, 90);
            const summary = ask ? `${project}${branch}: ${ask}` : `${project}${branch}`;
            await recordSessionEnd({ summary, filesTouched: filesList, durationMin, sessionId: parsed.sessionId || null, project: parsed.cwd });
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
      if (options.workspace === true || config.workspace === true) workspaceManifest = await scanWorkspace(stagingDir, spinner);
    } catch (err) {
      throw new Error('Workspace capture failed: ' + err.message);
    }

    const prior = await fetchRemoteSessionBestEffort(config, getPassphrase);
    remoteCloneDir = prior.cloneDir || null;
    remotePlainDir = prior.plainDir || null;
    if (prior.source) await restoreStoredMemories(prior.source);
    // Keep mappings for projects that exist only on another machine.
    if (prior.source && await fs.pathExists(path.join(prior.source, 'projects.json'))) {
      const remoteProjects = JSON.parse((await readSafeFile(prior.source, 'projects.json')).toString());
      let localProjects = {};
      if (await fs.pathExists(path.join(stagingDir, 'projects.json'))) localProjects = JSON.parse((await readSafeFile(stagingDir, 'projects.json')).toString());
      await writeSafeFile(stagingDir, 'projects.json', JSON.stringify({ ...remoteProjects, ...localProjects }, null, 2));
    }

    await stageMemories(stagingDir);
    // Re-encryption always starts with a complete prior snapshot. Overlay
    // current files, preserve files absent on this machine, merge session below.
    if ((config.encrypt !== false || prior.encrypted) && prior.source) {
      const priorFiles = await listSafeFiles(prior.source).catch(async err => {
        // A checked-out Git tree contains .git, which is transport metadata.
        if (remoteCloneDir === prior.source) {
          const files = execFileSync('git', ['ls-files', '-z'], { cwd: prior.source, encoding: 'utf8' }).split('\0').filter(Boolean);
          return files;
        }
        throw err;
      });
      for (const rel of priorFiles) {
        if (rel.startsWith('memoir-memories/')) continue; // Already reconciled, including purge tombstones.
        if (!await fs.pathExists(path.join(stagingDir, rel))) await writeSafeFile(stagingDir, rel, await readSafeFile(prior.source, rel));
      }
    }
    let merged;
    await withSessionLock(sessionPaths.sessionLock, async () => {
      const local = await readSession();
      merged = prior.session ? mergeSessions(local, prior.session) : local;
      await writeSession(merged);
    });
    await writeSafeFile(stagingDir, 'session.json', JSON.stringify(merged, null, 2));
    const sessionIncluded = true;

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
    // Redaction is explicit and heuristic. Plaintext backups can contain
    // secrets; a warning does not promise that every secret was detected.
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
    let shouldEncrypt = prior.encrypted || config.encrypt;

    if (shouldEncrypt === undefined) {
      if (background || !process.stdin.isTTY) {
        // First push with nobody to ask (the detached autopush hook, CI, a
        // pipe). Any inquirer prompt here dies or hangs against ignored
        // stdio. Encrypt if MEMOIR_PASSPHRASE makes that possible;
        // otherwise push unencrypted THIS ONCE without persisting the
        // choice — a backup beats no backup, and the next interactive push
        // still gets the real question (default Yes).
        if (!process.env.MEMOIR_PASSPHRASE) throw new Error('Choose encryption explicitly with memoir init before sending this backup, or set MEMOIR_PASSPHRASE.');
        shouldEncrypt = true;
        if (!shouldEncrypt) {
          config.encrypt = undefined; // do not let the fallthrough persist "off"
        }
      } else {
      // First push since encryption was added — ask once and save preference
      spinner.stop();
      const { wantEncrypt } = await inquirer.prompt([{
        type: 'confirm',
        name: 'wantEncrypt',
        message: 'Enable E2E encryption? (protects your backup even if compromised)',
        default: true
      }]);
      shouldEncrypt = wantEncrypt;
      }

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
      // Headless pushes can supply the passphrase via env; interactive
      // pushes are asked as before.
      const passphrase = await getPassphrase();
      spinner.start(chalk.gray('Deriving encryption key...'));

      encryptedDir = path.join(os.tmpdir(), `memoir-encrypted-${Date.now()}`);
      await fs.ensureDir(encryptedDir);
      const encryptedCount = await encryptDirectory(stagingDir, encryptedDir, passphrase, spinner);
      spinner.succeed(chalk.green(spinner.text));
      spinner.start();

      // Save verify token so restore can check passphrase before decrypting
      const token = await createVerifyToken(passphrase);
      await fs.writeFile(path.join(encryptedDir, 'verify.enc'), token);

      if (prior.source && !prior.encrypted) {
        const verified = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-encryption-check-'));
        try {
          await decryptDirectory(encryptedDir, verified, passphrase);
          const expected = (await listSafeFiles(stagingDir)).sort();
          const actual = (await listSafeFiles(verified)).sort();
          if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('Encryption migration verification failed');
          for (const rel of expected) {
            if (!(await readSafeFile(stagingDir, rel)).equals(await readSafeFile(verified, rel))) throw new Error('Encryption migration content mismatch');
          }
        } finally { await fs.remove(verified); }
      }

      uploadDir = encryptedDir;
      encrypted = true;
    }

    spinner.text = chalk.gray('Uploading to ' + (config.provider === 'git' ? 'GitHub' : 'local storage') + '...');

    if (config.provider === 'local' || config.provider.includes('local')) {
      await syncToLocal(config, uploadDir, spinner, { verifiedReplacement: encrypted, lockHeld: options.localLockHeld });
    } else if (config.provider === 'git' || config.provider.includes('git')) {
      await syncToGit(config, uploadDir, spinner, {
        cloneDir: remoteCloneDir,
        additive: !encrypted,
      });
      remoteCloneDir = null; // syncToGit removed it
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
      const bundleCount = workspaceManifest.projects.filter(p => p.bundleFile || p.type === 'files').length;
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
    throw error;
  } finally {
    if (remotePlainDir) await fs.remove(remotePlainDir).catch(() => {});
    await fs.remove(stagingDir);
    // Clean up encrypted dir if it was created
    if (encryptedDir) {
      await fs.remove(encryptedDir).catch(() => {});
    }
    if (remoteCloneDir) {
      await fs.remove(remoteCloneDir).catch(() => {});
    }
  }
}
