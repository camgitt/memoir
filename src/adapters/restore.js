import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import inquirer from 'inquirer';
import { adapters } from '../adapters/index.js';

// Detect the local home key by looking at what Claude has ALREADY created
// on this machine, rather than trying to compute the encoding ourselves.
// Claude's path encoding varies across platforms and versions, so detection
// is the only reliable approach.
function detectLocalHomeKey(adapterSource) {
  const localProjectsDir = path.join(adapterSource, 'projects');
  if (!fs.existsSync(localProjectsDir)) return null;

  const entries = fs.readdirSync(localProjectsDir)
    .filter(e => fs.statSync(path.join(localProjectsDir, e)).isDirectory());
  if (entries.length === 0) return null;

  // Find dirs with a memory/ subfolder that aren't sub-projects of another dir
  const candidates = entries.filter(entry => {
    const hasMemory = fs.existsSync(path.join(localProjectsDir, entry, 'memory'));
    if (!hasMemory) return false;
    // A sub-project dir starts with another dir + '-'
    const isSubProject = entries.some(other =>
      other !== entry && entry.startsWith(other + '-')
    );
    return !isSubProject;
  });

  if (candidates.length === 1) return candidates[0];

  if (candidates.length > 1) {
    // Multiple home-key candidates (e.g. encoding changed between Claude versions)
    // Pick the most recently modified one — that's what Claude is actively using
    return candidates.sort((a, b) => {
      const aDir = path.join(localProjectsDir, a, 'memory');
      const bDir = path.join(localProjectsDir, b, 'memory');
      return fs.statSync(bDir).mtimeMs - fs.statSync(aDir).mtimeMs;
    })[0];
  }

  // No dir has memory/ — fall back to shortest dir that's a prefix of others
  const prefixDirs = entries.filter(entry =>
    entries.some(other => other !== entry && other.startsWith(entry + '-'))
  ).sort((a, b) => a.length - b.length);

  return prefixDirs[0] || entries[0];
}

// Claude CLI stores projects under paths like `projects/-Users-camarthur/`
// This remaps ALL foreign machine dirs to match the current machine.
function remapProjectPaths(backupDir, adapterSource) {
  const projectsDir = path.join(backupDir, 'projects');
  if (!fs.existsSync(projectsDir)) return [];

  const backupEntries = fs.readdirSync(projectsDir)
    .filter(e => fs.statSync(path.join(projectsDir, e)).isDirectory());
  if (backupEntries.length === 0) return [];

  // Step 1: Detect the local home key from existing Claude dirs
  let localHomeKey = detectLocalHomeKey(adapterSource);

  // Step 2: Fallback — compute from homedir (only for fresh installs)
  if (!localHomeKey) {
    const home = os.homedir();
    // Use the same encoding Claude uses: path with separators → dashes
    localHomeKey = '-' + home.replace(/^\//, '').replace(/\\/g, '-').replace(/\//g, '-').replace(/:/g, '');
  }

  // Step 3: Identify foreign home keys in the backup
  // A "home key" is a dir that: has memory/, OR is a prefix of other dirs, AND is not a sub-project
  // Also detect alternate local encodings (e.g. -C-Users-X and C--Users-X are the same machine)
  const foreignHomeKeys = new Set();
  const localAltKeys = new Set(); // alternate encodings of local home dir

  // Detect alternate local encodings by checking if a dir resolves to the same homedir
  const home = os.homedir();
  const homeNormalized = home.toLowerCase().replace(/[\\/:]/g, '');

  for (const entry of backupEntries) {
    // Skip dirs that already match the primary local key
    if (entry === localHomeKey || entry.startsWith(localHomeKey + '-')) continue;

    // Check if this entry is an alternate encoding of the local home dir
    const entryNormalized = entry.replace(/^[-]/, '').toLowerCase().replace(/[-]/g, '');
    if (entryNormalized === homeNormalized || homeNormalized.endsWith(entryNormalized) || entryNormalized.endsWith(homeNormalized)) {
      // This is an alternate encoding of the local home — treat as local, not foreign
      localAltKeys.add(entry);
      continue;
    }

    // Is this a sub-project of another backup dir? Then skip — its parent handles it
    const isSubProject = backupEntries.some(other =>
      other !== entry && entry.startsWith(other + '-')
    );
    if (isSubProject) continue;

    // Is this a sub-project of an alternate local key? Skip too
    const isAltSubProject = [...localAltKeys].some(alt => entry.startsWith(alt + '-'));
    if (isAltSubProject) continue;

    // Has memory/ subfolder = definitely a home key
    const hasMemory = fs.existsSync(path.join(projectsDir, entry, 'memory'));
    // Is a prefix of other dirs = likely a home key
    const isPrefix = backupEntries.some(other =>
      other !== entry && other.startsWith(entry + '-')
    );

    if (hasMemory || isPrefix) {
      foreignHomeKeys.add(entry);
    }
  }

  // Step 4: Build remaps — remap each foreign home key and its sub-projects
  const remaps = [];
  const processed = new Set();

  for (const foreignKey of foreignHomeKeys) {
    // Find all dirs belonging to this foreign home key
    for (const dir of backupEntries) {
      if (processed.has(dir)) continue;
      if (dir !== foreignKey && !dir.startsWith(foreignKey + '-')) continue;

      processed.add(dir);
      const suffix = dir.slice(foreignKey.length); // "" or "-alfred" etc.
      const newName = localHomeKey + suffix;
      if (dir !== newName) {
        remaps.push({ oldName: dir, newName });
      }
    }
  }

  return remaps;
}

// Merge memory dirs from a foreign machine — copies files that don't exist locally,
// and for files that exist on both, keeps the newer version.
async function mergeMemoryDirs(src, dest) {
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await fs.ensureDir(destPath);
      await mergeMemoryDirs(srcPath, destPath);
    } else {
      if (await fs.pathExists(destPath)) {
        // Both machines have this file — keep the newer one
        const srcStat = await fs.stat(srcPath);
        const destStat = await fs.stat(destPath);
        if (srcStat.mtimeMs > destStat.mtimeMs) {
          await fs.copy(srcPath, destPath);
        }
      } else {
        // File only exists on foreign machine — always copy it
        await fs.copy(srcPath, destPath);
      }
    }
  }
}

async function syncFiles(src, dest, changes) {
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await fs.ensureDir(destPath);
      await syncFiles(srcPath, destPath, changes);
    } else {
      if (await fs.pathExists(destPath)) {
        // Compare modification times — update if backup is newer
        const srcStat = await fs.stat(srcPath);
        const destStat = await fs.stat(destPath);
        if (srcStat.mtimeMs > destStat.mtimeMs) {
          await fs.copy(srcPath, destPath);
          changes.updated.push(destPath);
        } else {
          changes.skipped.push(destPath);
        }
      } else {
        await fs.copy(srcPath, destPath);
        changes.added.push(destPath);
      }
    }
  }
}

export async function restoreMemories(sourceDir, spinner, onlyFilter = null, autoYes = false) {
  let restoredAny = false;
  const allResults = [];

  for (const adapter of adapters) {
    // Skip if --only filter is set and this adapter doesn't match
    if (onlyFilter) {
      const matches = onlyFilter.some(f => adapter.name.toLowerCase().includes(f));
      if (!matches) continue;
    }

    const backupDir = path.join(sourceDir, adapter.name.toLowerCase().replace(/ /g, '-'));

    if (await fs.pathExists(backupDir)) {
      spinner.stop();

      console.log('\n' + chalk.cyan(`${adapter.icon} Found backup for ${chalk.bold(adapter.name)}`));
      console.log(chalk.gray(`  Will restore to: ${adapter.source}`));

      let confirm = true;
      if (!autoYes) {
        const answer = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'confirm',
            message: `Restore ${adapter.name}?`,
            default: true
          }
        ]);
        confirm = answer.confirm;
      } else {
        console.log(chalk.green(`  Auto-restoring ${adapter.name}...`));
      }

      spinner.start();

      if (confirm) {
        const changes = { added: [], updated: [], skipped: [] };

        // Remap Claude project paths from source machine to this machine
        if (adapter.name === 'Claude CLI') {
          const remaps = remapProjectPaths(backupDir, adapter.source);
          if (remaps.length > 0) {
            spinner.stop();
            for (const remap of remaps) {
              console.log(chalk.gray(`  Remapping: ${remap.oldName} → ${remap.newName}`));
              const oldDir = path.join(backupDir, 'projects', remap.oldName);
              const newDir = path.join(backupDir, 'projects', remap.newName);
              if (await fs.pathExists(oldDir)) {
                if (await fs.pathExists(newDir)) {
                  // Merge into existing directory — force-copy new files from foreign machine
                  await mergeMemoryDirs(oldDir, newDir);
                  await fs.remove(oldDir);
                } else {
                  await fs.move(oldDir, newDir);
                }
              }
            }
            spinner.start();
          }
        }

        if (adapter.customExtract) {
          const files = await fs.readdir(backupDir);
          for (const file of files) {
            const destFile = path.join(adapter.source, file);
            if (await fs.pathExists(destFile)) {
              const srcStat = await fs.stat(path.join(backupDir, file));
              const destStat = await fs.stat(destFile);
              if (srcStat.mtimeMs > destStat.mtimeMs) {
                await fs.copy(path.join(backupDir, file), destFile);
                changes.updated.push(destFile);
              } else {
                changes.skipped.push(destFile);
              }
            } else {
              await fs.copy(path.join(backupDir, file), destFile);
              changes.added.push(destFile);
            }
          }
        } else {
          spinner.text = `Restoring ${chalk.cyan(adapter.name)} to ${adapter.source}...`;
          await fs.ensureDir(adapter.source);
          await syncFiles(backupDir, adapter.source, changes);
        }

        // Show summary of changes
        spinner.stop();
        const totalChanged = changes.added.length + changes.updated.length;
        const relPath = (f) => path.relative(adapter.source, f);
        if (totalChanged > 0) {
          console.log(chalk.green.bold(`\n  ${adapter.icon} ${adapter.name} — ${totalChanged} file(s) restored to ${chalk.underline(adapter.source)}`));
          for (const f of changes.added) {
            console.log(chalk.green(`    + ${relPath(f)}`) + chalk.gray(` (new)`));
          }
          for (const f of changes.updated) {
            console.log(chalk.yellow(`    ↻ ${relPath(f)}`) + chalk.gray(` (updated)`));
          }
        }
        if (changes.skipped.length > 0) {
          console.log(chalk.gray(`  ⏭ ${changes.skipped.length} file(s) already up to date:`));
          for (const f of changes.skipped) {
            console.log(chalk.gray(`    = ${relPath(f)}`));
          }
        }
        if (totalChanged === 0 && changes.skipped.length === 0) {
          console.log(chalk.gray(`  ✔ ${adapter.name} — nothing to restore`));
        }
        spinner.start();

        allResults.push({ name: adapter.name, icon: adapter.icon, dest: adapter.source, added: changes.added.length, updated: changes.updated.length });
        restoredAny = true;
      } else {
        spinner.info(chalk.gray(`Skipped ${adapter.name}.`));
        spinner.start();
      }
    }
  }

  // Restore per-project AI configs
  const projectsDir = path.join(sourceDir, 'projects');
  if (await fs.pathExists(projectsDir)) {
    const projectEntries = await fs.readdir(projectsDir, { withFileTypes: true });
    const projectDirs = projectEntries.filter(e => e.isDirectory() && e.name !== '.git');

    if (projectDirs.length > 0) {
      spinner.stop();
      console.log('\n' + chalk.cyan(`📁 Found ${chalk.bold(projectDirs.length + ' project(s)')} with AI configs`));

      // Try to find matching local project dirs
      const home = os.homedir();
      let totalRestored = 0;

      for (const proj of projectDirs) {
        const backupProjDir = path.join(projectsDir, proj.name);
        const files = await fs.readdir(backupProjDir);

        // Search for project on local machine (up to 3 levels deep)
        let localProjDir = null;
        const searchDirs = [home];
        for (const searchDir of searchDirs) {
          const candidate = path.join(searchDir, proj.name);
          if (await fs.pathExists(candidate)) {
            localProjDir = candidate;
            break;
          }
          // Check one level deeper
          try {
            const entries = await fs.readdir(searchDir, { withFileTypes: true });
            for (const e of entries) {
              if (!e.isDirectory() || e.name.startsWith('.')) continue;
              const deeper = path.join(searchDir, e.name, proj.name);
              if (await fs.pathExists(deeper)) {
                localProjDir = deeper;
                break;
              }
            }
          } catch {}
          if (localProjDir) break;
        }

        if (!localProjDir) {
          console.log(chalk.gray(`  ○ ${proj.name} — not found on this machine, skipping`));
          continue;
        }

        console.log(chalk.white(`  📁 ${proj.name}`) + chalk.gray(` → ${localProjDir}`));

        let confirm = true;
        if (!autoYes) {
          const answer = await inquirer.prompt([
            {
              type: 'confirm',
              name: 'confirm',
              message: `Restore AI configs to ${proj.name}?`,
              default: true
            }
          ]);
          confirm = answer.confirm;
        }

        if (confirm) {
          for (const file of files) {
            const src = path.join(backupProjDir, file);
            const dest = path.join(localProjDir, file);
            const stat = await fs.stat(src);

            if (stat.isDirectory()) {
              await fs.ensureDir(dest);
              await syncFiles(src, dest, { added: [], updated: [], skipped: [] });
            } else {
              if (await fs.pathExists(dest)) {
                const srcStat = await fs.stat(src);
                const destStat = await fs.stat(dest);
                if (srcStat.mtimeMs > destStat.mtimeMs) {
                  await fs.copy(src, dest);
                  console.log(chalk.yellow(`    ↻ ${file}`) + chalk.gray(` (updated)`));
                } else {
                  console.log(chalk.gray(`    = ${file} (up to date)`));
                }
              } else {
                await fs.ensureDir(path.dirname(dest));
                await fs.copy(src, dest);
                console.log(chalk.green(`    + ${file}`) + chalk.gray(` (new)`));
              }
              totalRestored++;
            }
          }
        }
      }

      if (totalRestored > 0) {
        allResults.push({ name: `Projects (${projectDirs.length})`, icon: '📁', dest: 'various', added: totalRestored, updated: 0 });
        restoredAny = true;
      }
      spinner.start();
    }
  }

  // Final recap
  if (allResults.length > 0) {
    spinner.stop();
    console.log('\n' + chalk.gray('─'.repeat(40)));
    console.log(chalk.bold.white('\n  Restore Summary:\n'));
    for (const r of allResults) {
      const count = r.added + r.updated;
      console.log(`  ${r.icon} ${chalk.white(r.name)}`);
      console.log(chalk.gray(`     ${count} file(s) → ${r.dest}`));
    }
    console.log('');
  }

  return restoredAny;
}
