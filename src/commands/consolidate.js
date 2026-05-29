import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import ora from 'ora';
import boxen from 'boxen';
import gradient from 'gradient-string';
import inquirer from 'inquirer';
import { getConfig, getGeminiApiKey } from '../config.js';
import { adapters } from '../adapters/index.js';

const home = os.homedir();

// ── Helpers ──────────────────────────────────────────────────────────────────

async function readMemoryFiles(adapter) {
  const files = [];

  if (adapter.customExtract) {
    for (const file of adapter.files) {
      const filePath = path.join(adapter.source, file);
      if (await fs.pathExists(filePath)) {
        try {
          const content = await fs.readFile(filePath, 'utf8');
          const stat = await fs.stat(filePath);
          files.push({ path: file, fullPath: filePath, content, tool: adapter.name, icon: adapter.icon, mtime: stat.mtimeMs, size: content.length });
        } catch {}
      }
    }
    return files;
  }

  if (!(await fs.pathExists(adapter.source))) return files;

  const walk = async (dir, prefix = '') => {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (adapter.filter(fullPath)) {
          await walk(fullPath, relPath);
        }
      } else if (/\.(md|json|yml|yaml)$/.test(entry.name)) {
        if (adapter.filter(fullPath)) {
          try {
            const content = await fs.readFile(fullPath, 'utf8');
            const stat = await fs.stat(fullPath);
            files.push({ path: relPath, fullPath, content, tool: adapter.name, icon: adapter.icon, mtime: stat.mtimeMs, size: content.length });
          } catch {}
        }
      }
    }
  };

  await walk(adapter.source);
  return files;
}

function daysAgo(mtimeMs) {
  return Math.floor((Date.now() - mtimeMs) / (1000 * 60 * 60 * 24));
}

function contentFingerprint(content) {
  // Normalize whitespace and case for comparison
  return content.toLowerCase().replace(/\s+/g, ' ').trim();
}

function similarity(a, b) {
  // Jaccard similarity on word sets
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  return intersection / (wordsA.size + wordsB.size - intersection);
}

// ── Analysis ─────────────────────────────────────────────────────────────────

function analyzeMemories(allFiles) {
  const issues = { duplicates: [], stale: [], bloated: [], contradictions: [], empty: [] };

  // 1. Find exact duplicates (same content across tools)
  const fingerprints = new Map();
  for (const file of allFiles) {
    const fp = contentFingerprint(file.content);
    if (fp.length < 10) {
      issues.empty.push(file);
      continue;
    }
    if (!fingerprints.has(fp)) {
      fingerprints.set(fp, []);
    }
    fingerprints.get(fp).push(file);
  }
  for (const [, group] of fingerprints) {
    if (group.length > 1) {
      issues.duplicates.push(group);
    }
  }

  // 2. Find near-duplicates (>70% word overlap)
  const nonDuplicateFiles = allFiles.filter(f => contentFingerprint(f.content).length >= 10);
  const alreadyDuplicate = new Set(issues.duplicates.flat().map(f => f.fullPath));

  for (let i = 0; i < nonDuplicateFiles.length; i++) {
    for (let j = i + 1; j < nonDuplicateFiles.length; j++) {
      const a = nonDuplicateFiles[i];
      const b = nonDuplicateFiles[j];
      if (alreadyDuplicate.has(a.fullPath) && alreadyDuplicate.has(b.fullPath)) continue;
      const sim = similarity(a.content, b.content);
      if (sim > 0.7) {
        issues.duplicates.push([a, b]);
        alreadyDuplicate.add(a.fullPath);
        alreadyDuplicate.add(b.fullPath);
      }
    }
  }

  // 3. Find stale memories (not modified in 60+ days)
  for (const file of allFiles) {
    const age = daysAgo(file.mtime);
    if (age > 60) {
      issues.stale.push({ ...file, age });
    }
  }

  // 4. Find bloated files (>10KB)
  for (const file of allFiles) {
    if (file.size > 10240) {
      issues.bloated.push(file);
    }
  }

  return issues;
}

// ── LLM Consolidation ────────────────────────────────────────────────────────

async function llmConsolidate(allFiles, apiKey) {
  // Build a summary of all memories for the LLM
  const memoryDigest = allFiles
    .filter(f => f.content.trim().length > 10)
    .map(f => `[${f.tool} / ${f.path}] (${daysAgo(f.mtime)}d old, ${f.size}B)\n${f.content.slice(0, 500)}${f.content.length > 500 ? '...' : ''}`)
    .join('\n\n---\n\n');

  const prompt = `You are a memory consolidation engine. Analyze these AI tool memory files and produce a consolidation report.

MEMORIES:
${memoryDigest}

Produce a JSON response with these fields:
{
  "merge_groups": [
    { "files": ["tool/path1", "tool/path2"], "reason": "why these should be merged", "merged_content": "the consolidated content" }
  ],
  "prune": [
    { "file": "tool/path", "reason": "why this should be removed" }
  ],
  "contradictions": [
    { "files": ["tool/path1", "tool/path2"], "description": "what contradicts" }
  ],
  "summary": "1-2 sentence summary of the consolidation"
}

Rules:
- Only suggest merging files that have significant content overlap or cover the same topic
- Only suggest pruning files that are clearly outdated, empty, or superseded
- Flag contradictions where two files give conflicting instructions about the same thing
- Be conservative — when in doubt, keep the memory
- Return valid JSON only, no markdown fences`;

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 4000, temperature: 0.2, responseMimeType: 'application/json' }
    })
  });

  if (!response.ok) {
    throw new Error(`Gemini API error: ${response.status}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty response from Gemini');

  return JSON.parse(text);
}

// ── Display ──────────────────────────────────────────────────────────────────

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function printIssues(issues, allFiles) {
  const totalIssues = issues.duplicates.length + issues.stale.length + issues.bloated.length + issues.empty.length;

  if (totalIssues === 0) {
    console.log('\n' + boxen(
      chalk.green.bold('Your memories look clean!') + '\n\n' +
      chalk.gray(`Scanned ${allFiles.length} files across all tools. No issues found.`),
      { padding: 1, borderStyle: 'round', borderColor: 'green', dimBorder: true }
    ) + '\n');
    return false;
  }

  console.log('\n' + boxen(
    gradient.pastel('  Consolidation Report  ') + '\n\n' +
    chalk.white(`Scanned ${chalk.cyan(allFiles.length)} memory files`) + chalk.gray(` | ${totalIssues} issues found`),
    { padding: { top: 0, bottom: 0, left: 1, right: 1 }, borderStyle: 'round', borderColor: 'cyan', dimBorder: true }
  ));

  if (issues.duplicates.length > 0) {
    console.log('\n' + chalk.yellow.bold(`  Duplicates (${issues.duplicates.length})`));
    for (const group of issues.duplicates) {
      const sim = group.length === 2 ? ` ${Math.round(similarity(group[0].content, group[1].content) * 100)}% similar` : ' exact match';
      console.log(chalk.gray(`  ┌${sim}`));
      for (const f of group) {
        console.log(`  │ ${f.icon} ${chalk.cyan(f.tool)} ${chalk.white(f.path)} ${chalk.gray(formatSize(f.size))}`);
      }
      console.log(chalk.gray('  └'));
    }
  }

  if (issues.stale.length > 0) {
    console.log('\n' + chalk.yellow.bold(`  Stale (${issues.stale.length}) — not modified in 60+ days`));
    for (const f of issues.stale.sort((a, b) => b.age - a.age).slice(0, 15)) {
      console.log(`  ${f.icon} ${chalk.cyan(f.tool)} ${chalk.white(f.path)} ${chalk.gray(`${f.age}d ago`)}`);
    }
    if (issues.stale.length > 15) {
      console.log(chalk.gray(`  ...and ${issues.stale.length - 15} more`));
    }
  }

  if (issues.bloated.length > 0) {
    console.log('\n' + chalk.yellow.bold(`  Bloated (${issues.bloated.length}) — over 10KB`));
    for (const f of issues.bloated.sort((a, b) => b.size - a.size)) {
      console.log(`  ${f.icon} ${chalk.cyan(f.tool)} ${chalk.white(f.path)} ${chalk.red(formatSize(f.size))}`);
    }
  }

  if (issues.empty.length > 0) {
    console.log('\n' + chalk.yellow.bold(`  Empty / near-empty (${issues.empty.length})`));
    for (const f of issues.empty) {
      console.log(`  ${f.icon} ${chalk.cyan(f.tool)} ${chalk.white(f.path)}`);
    }
  }

  console.log('');
  return true;
}

function printLlmReport(report) {
  console.log('\n' + boxen(
    gradient.pastel('  AI Consolidation  '),
    { padding: { top: 0, bottom: 0, left: 1, right: 1 }, borderStyle: 'round', borderColor: 'magenta', dimBorder: true }
  ));

  if (report.summary) {
    console.log('\n  ' + chalk.white(report.summary));
  }

  if (report.merge_groups?.length > 0) {
    console.log('\n' + chalk.magenta.bold(`  Merge suggestions (${report.merge_groups.length})`));
    for (const group of report.merge_groups) {
      console.log(chalk.gray(`  ┌ ${group.reason}`));
      for (const file of group.files) {
        console.log(`  │ ${chalk.cyan(file)}`);
      }
      console.log(chalk.gray('  └'));
    }
  }

  if (report.contradictions?.length > 0) {
    console.log('\n' + chalk.red.bold(`  Contradictions (${report.contradictions.length})`));
    for (const c of report.contradictions) {
      console.log(chalk.gray(`  ┌ ${c.description}`));
      for (const file of c.files) {
        console.log(`  │ ${chalk.cyan(file)}`);
      }
      console.log(chalk.gray('  └'));
    }
  }

  if (report.prune?.length > 0) {
    console.log('\n' + chalk.yellow.bold(`  Prune suggestions (${report.prune.length})`));
    for (const p of report.prune) {
      console.log(`  ${chalk.cyan(p.file)} ${chalk.gray('— ' + p.reason)}`);
    }
  }

  console.log('');
}

// ── Actions ──────────────────────────────────────────────────────────────────

async function applyPrune(files, allFiles) {
  const choices = files.map(f => ({
    name: `${f.icon || ''} ${f.tool || ''} ${f.path} ${chalk.gray(`(${f.age ? f.age + 'd old' : formatSize(f.size)})`)}`,
    value: f,
    checked: false
  }));

  const { toDelete } = await inquirer.prompt([{
    type: 'checkbox',
    name: 'toDelete',
    message: 'Select memories to delete:',
    choices
  }]);

  if (toDelete.length === 0) {
    console.log(chalk.gray('  Nothing selected.\n'));
    return 0;
  }

  const { confirm } = await inquirer.prompt([{
    type: 'confirm',
    name: 'confirm',
    message: `Delete ${toDelete.length} file(s)? This cannot be undone.`,
    default: false
  }]);

  if (!confirm) {
    console.log(chalk.gray('  Cancelled.\n'));
    return 0;
  }

  let deleted = 0;
  for (const file of toDelete) {
    try {
      await fs.remove(file.fullPath);
      console.log(chalk.red(`  ✖ Deleted: ${file.tool}/${file.path}`));
      deleted++;
    } catch (err) {
      console.log(chalk.red(`  ✖ Failed to delete ${file.path}: ${err.message}`));
    }
  }

  return deleted;
}

async function applyMerge(duplicateGroups, allFiles) {
  let merged = 0;

  for (const group of duplicateGroups) {
    console.log(chalk.gray('\n  ┌ Duplicate group:'));
    for (const f of group) {
      console.log(`  │ ${f.icon} ${chalk.cyan(f.tool)}/${chalk.white(f.path)} ${chalk.gray(`(${daysAgo(f.mtime)}d old)`)}`);
    }
    console.log(chalk.gray('  └'));

    // Keep the newest file, offer to delete the rest
    const sorted = [...group].sort((a, b) => b.mtime - a.mtime);
    const keep = sorted[0];
    const remove = sorted.slice(1);

    console.log(chalk.green(`  Keep: ${keep.tool}/${keep.path} (newest)`));
    for (const r of remove) {
      console.log(chalk.red(`  Remove: ${r.tool}/${r.path}`));
    }

    const { confirm } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirm',
      message: `Remove ${remove.length} duplicate(s), keep the newest?`,
      default: true
    }]);

    if (confirm) {
      for (const r of remove) {
        try {
          await fs.remove(r.fullPath);
          console.log(chalk.red(`  ✖ Removed: ${r.tool}/${r.path}`));
          merged++;
        } catch (err) {
          console.log(chalk.red(`  ✖ Failed: ${err.message}`));
        }
      }
    }
  }

  return merged;
}

// ── Main Command ─────────────────────────────────────────────────────────────

export async function consolidateCommand(options = {}) {
  console.log();
  const spinner = ora({ text: chalk.gray('Scanning memories across all tools...'), spinner: 'dots' }).start();

  // Collect all memory files
  const allFiles = [];
  for (const adapter of adapters) {
    spinner.text = `${adapter.icon} Scanning ${chalk.cyan(adapter.name)}...`;
    const files = await readMemoryFiles(adapter);
    allFiles.push(...files);
  }

  if (allFiles.length === 0) {
    spinner.fail(chalk.red('No memory files found.'));
    return;
  }

  spinner.text = chalk.gray(`Analyzing ${allFiles.length} files...`);

  // Run heuristic analysis
  const issues = analyzeMemories(allFiles);

  spinner.stop();

  // Print heuristic report
  const hasIssues = printIssues(issues, allFiles);

  // Run LLM analysis if --smart
  let llmReport = null;
  if (options.smart) {
    const apiKey = await getGeminiApiKey();
    if (!apiKey) {
      console.log(chalk.yellow('  No Gemini API key found. Set GEMINI_API_KEY or run memoir init to configure.'));
      console.log(chalk.gray('  Skipping AI-powered analysis.\n'));
    } else {
      const llmSpinner = ora({ text: chalk.gray('Running AI-powered consolidation...'), spinner: 'dots' }).start();
      try {
        llmReport = await llmConsolidate(allFiles, apiKey);
        llmSpinner.stop();
        printLlmReport(llmReport);
      } catch (err) {
        llmSpinner.fail(chalk.yellow(`AI analysis failed: ${err.message}`));
      }
    }
  }

  // Apply changes if --apply
  if (options.apply && hasIssues) {
    let totalActions = 0;

    if (issues.empty.length > 0) {
      console.log(chalk.white.bold('  Clean up empty files?\n'));
      totalActions += await applyPrune(issues.empty, allFiles);
    }

    if (issues.duplicates.length > 0) {
      console.log(chalk.white.bold('  Merge duplicates?\n'));
      totalActions += await applyMerge(issues.duplicates, allFiles);
    }

    if (issues.stale.length > 0) {
      console.log(chalk.white.bold('  Prune stale memories?\n'));
      totalActions += await applyPrune(issues.stale, allFiles);
    }

    if (totalActions > 0) {
      console.log('\n' + boxen(
        chalk.green.bold(`Consolidated ${totalActions} file(s)`) + '\n' +
        chalk.gray('Run memoir push to sync changes to your backup.'),
        { padding: { top: 0, bottom: 0, left: 1, right: 1 }, borderStyle: 'round', borderColor: 'green', dimBorder: true }
      ) + '\n');
    }
  } else if (hasIssues && !options.apply) {
    console.log(chalk.gray('  Run ') + chalk.cyan('memoir consolidate --apply') + chalk.gray(' to clean up.'));
    if (!options.smart) {
      console.log(chalk.gray('  Run ') + chalk.cyan('memoir consolidate --smart') + chalk.gray(' for AI-powered analysis.\n'));
    }
  }
}
