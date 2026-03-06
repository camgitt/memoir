import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import inquirer from 'inquirer';
import { adapters } from '../adapters/index.js';

// Claude CLI stores projects under paths like `projects/-Users-camarthur/`
// This converts the path from the backup machine to match the current machine
function remapProjectPath(backupDir, adapterSource) {
  const projectsDir = path.join(backupDir, 'projects');
  if (!fs.existsSync(projectsDir)) return null;

  const entries = fs.readdirSync(projectsDir);
  // Find the backed-up home dir key (e.g., "-Users-camarthur")
  const oldHomeKey = entries.find(e => {
    return fs.statSync(path.join(projectsDir, e)).isDirectory();
  });
  if (!oldHomeKey) return null;

  // Build the current machine's home dir key
  // Claude uses the homedir path with / replaced by - and leading -
  const home = os.homedir();
  const newHomeKey = '-' + home.replace(/^\//, '').replace(/\\/g, '-').replace(/\//g, '-').replace(/:/g, '');

  if (oldHomeKey === newHomeKey) return null; // Same machine, no remap needed

  return { oldHomeKey, newHomeKey };
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

export async function restoreMemories(sourceDir, spinner, onlyFilter = null) {
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
      const { confirm } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: `Restore ${adapter.name}?`,
          default: true
        }
      ]);

      spinner.start();

      if (confirm) {
        const changes = { added: [], updated: [], skipped: [] };

        // Remap Claude project paths from source machine to this machine
        if (adapter.name === 'Claude CLI') {
          const remap = remapProjectPath(backupDir, adapter.source);
          if (remap) {
            spinner.stop();
            console.log(chalk.gray(`  Remapping project path: ${remap.oldHomeKey} → ${remap.newHomeKey}`));
            spinner.start();
            // Rename the directory in staging so it restores to the right place
            const oldDir = path.join(backupDir, 'projects', remap.oldHomeKey);
            const newDir = path.join(backupDir, 'projects', remap.newHomeKey);
            if (await fs.pathExists(oldDir) && !(await fs.pathExists(newDir))) {
              await fs.move(oldDir, newDir);
            }
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
