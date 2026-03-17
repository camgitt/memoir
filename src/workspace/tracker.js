import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

const home = os.homedir();

/**
 * Scan home directory for git projects and build a workspace manifest.
 * Tracks: git remote URL, branch, last commit, uncommitted changes (as patch).
 * For non-git projects with AI configs, bundles them as tar.gz.
 */
export async function scanWorkspace(stagingDir, spinner, opts = {}) {
  const maxDepth = opts.maxDepth || 3;
  const maxBundleSize = opts.maxBundleSize || 50 * 1024 * 1024; // 50MB

  const skipDirs = new Set([
    'node_modules', '.git', '.next', '.vercel', 'dist', 'build',
    '__pycache__', '.venv', 'venv', '.cache', '.npm', '.bun',
    'Library', '.Trash', 'Applications', 'Pictures', 'Music',
    'Movies', 'Public', 'Downloads', '.local', '.cargo', '.rustup',
    '.docker', '.ssh', '.config', '.claude', '.gemini'
  ]);

  // Project markers — files that indicate "this is a project"
  const projectMarkers = [
    'package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml',
    'requirements.txt', 'Gemfile', 'pom.xml', 'build.gradle',
    'Makefile', 'CMakeLists.txt', '.project', 'CLAUDE.md',
    'GEMINI.md', 'AGENTS.md', 'README.md',
    // Also detect dirs with .git or multiple content files
    '.gitignore', 'index.html', 'main.py', 'app.py', 'index.js',
  ];

  // Also detect dirs with multiple markdown/code files as potential projects
  const isContentProject = (entries) => {
    const mdFiles = entries.filter(e => !e.isDirectory() && e.name.endsWith('.md'));
    return mdFiles.length >= 2; // 2+ markdown files = likely a writing project
  };

  const projects = [];

  const scanDir = async (dir, depth = 0) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch { return; }

    // Check if this dir is a project
    const hasMarker = entries.some(e => !e.isDirectory() && projectMarkers.includes(e.name));
    const hasContent = isContentProject(entries);

    if ((hasMarker || hasContent) && dir !== home) {
      const info = await getProjectInfo(dir);
      if (info) projects.push(info);
      // Don't recurse into sub-projects deeper than this
      return;
    }

    // Recurse into subdirectories
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      if (skipDirs.has(entry.name)) continue;
      await scanDir(path.join(dir, entry.name), depth + 1);
    }
  };

  if (spinner) spinner.text = 'Scanning workspace for projects...';
  await scanDir(home);

  // Build manifest
  const manifest = {
    version: 1,
    machine: os.hostname(),
    platform: process.platform,
    home: home,
    scannedAt: new Date().toISOString(),
    projects: []
  };

  const bundleDir = path.join(stagingDir, 'workspace-bundles');

  for (const proj of projects) {
    const entry = {
      name: proj.name,
      relativePath: proj.relativePath,
      originalPath: proj.path,
      type: proj.hasGit ? 'git' : 'bundle',
    };

    if (proj.hasGit) {
      entry.gitRemote = proj.gitRemote;
      entry.branch = proj.branch;
      entry.lastCommit = proj.lastCommit;
      entry.lastCommitMessage = proj.lastCommitMessage;

      // Save uncommitted changes as patch
      if (proj.hasDirtyWork && proj.lastCommit) {
        try {
          const patchDir = path.join(stagingDir, 'workspace-patches');
          await fs.ensureDir(patchDir);
          const diff = execFileSync('git', ['diff', 'HEAD'], {
            cwd: proj.path,
            maxBuffer: 10 * 1024 * 1024,
            timeout: 10000
          }).toString();
          if (diff.trim()) {
            const patchFile = `${proj.name}.patch`;
            await fs.writeFile(path.join(patchDir, patchFile), diff);
            entry.patchFile = patchFile;
          }
        } catch {
          // Patch capture is best-effort
        }
      }
    } else {
      // Bundle non-git project (if small enough)
      const size = await getDirSize(proj.path);
      if (size <= maxBundleSize) {
        try {
          await fs.ensureDir(bundleDir);
          const bundleName = `${proj.name}.tar.gz`;
          execFileSync('tar', [
            'czf', path.join(bundleDir, bundleName),
            '-C', path.dirname(proj.path),
            '--exclude', 'node_modules',
            '--exclude', '.git',
            '--exclude', '__pycache__',
            '--exclude', '.venv',
            '--exclude', 'dist',
            '--exclude', 'build',
            proj.name
          ], { stdio: 'ignore', timeout: 30000 });
          entry.bundleFile = bundleName;
          entry.bundleSize = (await fs.stat(path.join(bundleDir, bundleName))).size;
        } catch {
          // Bundle is best-effort
          entry.bundleFailed = true;
        }
      } else {
        entry.tooLarge = true;
        entry.size = size;
      }
    }

    manifest.projects.push(entry);
  }

  // Save manifest
  await fs.writeFile(
    path.join(stagingDir, 'workspace.json'),
    JSON.stringify(manifest, null, 2)
  );

  return manifest;
}

/**
 * Restore workspace on this machine from a manifest.
 * Clones git projects, unpacks bundles, applies patches.
 */
export async function restoreWorkspace(sourceDir, spinner, autoYes = false) {
  const manifestPath = path.join(sourceDir, 'workspace.json');
  if (!await fs.pathExists(manifestPath)) return null;

  const manifest = await fs.readJson(manifestPath);
  if (!manifest.projects || manifest.projects.length === 0) return null;

  const results = { cloned: [], unpacked: [], patched: [], skipped: [] };

  for (const proj of manifest.projects) {
    // Determine where to put this project on the local machine
    const localPath = resolveLocalPath(proj);

    // Skip if project already exists locally
    if (await fs.pathExists(localPath)) {
      // But check if we should apply a patch
      if (proj.patchFile) {
        const patchPath = path.join(sourceDir, 'workspace-patches', proj.patchFile);
        if (await fs.pathExists(patchPath)) {
          try {
            execFileSync('git', ['apply', '--check', patchPath], {
              cwd: localPath, stdio: 'ignore'
            });
            execFileSync('git', ['apply', patchPath], {
              cwd: localPath, stdio: 'ignore'
            });
            results.patched.push({ name: proj.name, path: localPath });
          } catch {
            // Patch didn't apply cleanly — skip
          }
        }
      }
      results.skipped.push({ name: proj.name, path: localPath, reason: 'exists' });
      continue;
    }

    if (proj.type === 'git' && proj.gitRemote) {
      // Clone the repo
      if (spinner) spinner.text = `Cloning ${proj.name}...`;
      try {
        await fs.ensureDir(path.dirname(localPath));
        execFileSync('git', ['clone', proj.gitRemote, localPath], {
          stdio: 'ignore',
          timeout: 120000
        });

        // Checkout the right branch
        if (proj.branch && proj.branch !== 'main' && proj.branch !== 'master') {
          try {
            execFileSync('git', ['checkout', proj.branch], {
              cwd: localPath, stdio: 'ignore'
            });
          } catch {}
        }

        // Apply patch if available
        if (proj.patchFile) {
          const patchPath = path.join(sourceDir, 'workspace-patches', proj.patchFile);
          if (await fs.pathExists(patchPath)) {
            try {
              execFileSync('git', ['apply', patchPath], {
                cwd: localPath, stdio: 'ignore'
              });
              results.patched.push({ name: proj.name, path: localPath });
            } catch {}
          }
        }

        results.cloned.push({ name: proj.name, path: localPath, remote: proj.gitRemote });
      } catch (err) {
        results.skipped.push({ name: proj.name, reason: `clone failed: ${err.message}` });
      }
    } else if (proj.bundleFile) {
      // Unpack bundle
      const bundlePath = path.join(sourceDir, 'workspace-bundles', proj.bundleFile);
      if (await fs.pathExists(bundlePath)) {
        if (spinner) spinner.text = `Unpacking ${proj.name}...`;
        try {
          await fs.ensureDir(path.dirname(localPath));
          execFileSync('tar', ['xzf', bundlePath, '-C', path.dirname(localPath)], {
            stdio: 'ignore',
            timeout: 60000
          });
          results.unpacked.push({ name: proj.name, path: localPath });
        } catch (err) {
          results.skipped.push({ name: proj.name, reason: `unpack failed: ${err.message}` });
        }
      }
    } else {
      results.skipped.push({ name: proj.name, reason: proj.tooLarge ? 'too large' : 'no source' });
    }
  }

  return results;
}

/**
 * Figure out where a project should live on this machine.
 */
function resolveLocalPath(proj) {
  // If the project had a relative path from home, use that
  if (proj.relativePath) {
    return path.join(home, proj.relativePath);
  }
  // Default: put it in home directory
  return path.join(home, proj.name);
}

/**
 * Get info about a project directory.
 */
async function getProjectInfo(dir) {
  const name = path.basename(dir);
  const relativePath = path.relative(home, dir);
  const info = {
    name,
    path: dir,
    relativePath,
    hasGit: false,
    gitRemote: null,
    branch: null,
    lastCommit: null,
    lastCommitMessage: null,
    hasDirtyWork: false,
  };

  // Check for git
  const gitDir = path.join(dir, '.git');
  if (await fs.pathExists(gitDir)) {
    info.hasGit = true;
    try {
      const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd: dir, stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000
      }).toString().trim();
      info.gitRemote = remote;
    } catch {}

    try {
      info.branch = execFileSync('git', ['branch', '--show-current'], {
        cwd: dir, stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000
      }).toString().trim();
    } catch {}

    try {
      info.lastCommit = execFileSync('git', ['log', '-1', '--format=%H'], {
        cwd: dir, stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000
      }).toString().trim();
      info.lastCommitMessage = execFileSync('git', ['log', '-1', '--format=%s'], {
        cwd: dir, stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000
      }).toString().trim();
    } catch {}

    try {
      const status = execFileSync('git', ['status', '--porcelain'], {
        cwd: dir, stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000
      }).toString().trim();
      info.hasDirtyWork = status.length > 0;
    } catch {}
  }

  return info;
}

/**
 * Get total size of a directory (excluding common heavy dirs).
 */
async function getDirSize(dir) {
  let size = 0;
  const skip = new Set(['node_modules', '.git', '__pycache__', '.venv', 'dist', 'build']);

  const walk = async (d) => {
    let entries;
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!skip.has(e.name)) await walk(path.join(d, e.name));
      } else {
        try {
          const stat = await fs.stat(path.join(d, e.name));
          size += stat.size;
        } catch {}
      }
    }
  };
  await walk(dir);
  return size;
}
