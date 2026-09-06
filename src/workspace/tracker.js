import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { relativeFile, readSafeFile, writeSafeFile, restoreFileSet } from '../security/files.js';
import { scanForSecrets } from '../security/scanner.js';
import { projectIdentity } from '../memory/scope.js';
import { repositoryState } from '../memory/repository.js';

const skippedDirectories = new Set(['.git', 'node_modules', '.next', '.cache', '.venv', 'venv', 'dist', 'build', '__pycache__']);
const sensitive = /(^|\/)(\.env(?:\..*)?|\.npmrc|\.pypirc|credentials[^/]*|secrets?[^/]*|id_rsa|id_ed25519)$|\.(pem|key|p12|pfx)$/i;

// Explicit opt-in captures only the active project. No home-wide discovery,
// external archive extraction, or remote repository instructions are executed.
export async function scanWorkspace(stagingDir, spinner, opts = {}) {
  const project = await fs.realpath(path.resolve(opts.project || process.env.MEMOIR_PROJECT_ROOT || process.cwd()));
  const repository = repositoryState(project);
  let candidates = [];
  if (repository.head) {
    candidates = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: project, encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024,
    }).split('\0').filter(Boolean);
  } else {
    const walk = async (dir, prefix = '') => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (skippedDirectories.has(entry.name)) continue;
        const rel = prefix + entry.name;
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel + '/');
        else candidates.push(rel);
        if (candidates.length > 50000) throw new Error('Workspace file count limit exceeded');
      }
    };
    await walk(project);
  }
  if (candidates.length > 50000) throw new Error('Workspace file count limit exceeded');
  const projectId = projectIdentity(project);
  const key = crypto.createHash('sha256').update(projectId).digest('hex').slice(0, 16);
  const files = [], omitted = [];
  let bytes = 0;
  for (const candidate of [...new Set(candidates)].sort()) {
    const rel = relativeFile(candidate);
    if (rel.split('/').some(p => skippedDirectories.has(p)) || sensitive.test(rel)) { omitted.push({ path: rel, reason: 'excluded' }); continue; }
    let content;
    try { content = await readSafeFile(project, rel); }
    catch (err) {
      if (err.code === 'ENOENT') { omitted.push({ path: rel, reason: 'deleted' }); continue; }
      throw err;
    }
    // A heuristic, not a guarantee: omitted matches remain visible in the manifest.
    if (scanForSecrets(content.toString('utf8')).found.length) { omitted.push({ path: rel, reason: 'potential-secret' }); continue; }
    bytes += content.length;
    if (bytes > (opts.maxBundleSize || 50 * 1024 * 1024)) throw new Error('Workspace size limit exceeded');
    const stored = 'workspace-files/' + key + '/' + rel;
    await writeSafeFile(stagingDir, stored, content);
    files.push({ path: rel, stored, sha256: crypto.createHash('sha256').update(content).digest('hex') });
  }
  const manifest = { version: 2, scannedAt: new Date().toISOString(), projects: [{
    name: path.basename(project), identity: projectId, key, type: 'files',
    repository, files, omitted, size: bytes,
  }] };
  await writeSafeFile(stagingDir, 'workspace.json', JSON.stringify(manifest, null, 2));
  return manifest;
}

// Recovery produces a separate directory for inspection, never overlays an
// existing checkout. The recorded commit is evidence, not a claim of Git history.
export async function restoreWorkspace(sourceDir, spinner, autoYes = false) {
  let raw;
  try { raw = await readSafeFile(sourceDir, 'workspace.json'); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  const manifest = JSON.parse(raw.toString());
  if (manifest.version !== 2) throw new Error('Legacy workspace archives cannot be safely auto-restored. Keep the backup and inspect its archive separately, or create a new workspace snapshot.');
  if (!Array.isArray(manifest.projects) || manifest.projects.length > 100) throw new Error('Invalid workspace manifest');
  const plans = [];
  let totalBytes = 0, totalFiles = 0;
  for (const project of manifest.projects) {
    if (!/^[a-f0-9]{16}$/.test(project.key) || !Array.isArray(project.files)) throw new Error('Invalid workspace project');
    const entries = [];
    for (const file of project.files) {
      if (++totalFiles > 50000) throw new Error('Workspace file count limit exceeded');
      const rel = relativeFile(file.path);
      if (file.stored !== 'workspace-files/' + project.key + '/' + rel) throw new Error('Invalid workspace source path');
      const content = await readSafeFile(sourceDir, file.stored);
      totalBytes += content.length;
      if (totalBytes > 256 * 1024 * 1024) throw new Error('Workspace size limit exceeded');
      if (crypto.createHash('sha256').update(content).digest('hex') !== file.sha256) throw new Error('Workspace content failed verification');
      entries.push({ path: rel, content });
    }
    plans.push({ project, entries });
  }
  const results = { cloned: [], unpacked: [], patched: [], skipped: [] };
  for (const { project, entries } of plans) {
    const parent = path.join(os.homedir(), 'memoir-restored');
    await fs.ensureDir(parent);
    const destination = await fs.mkdtemp(path.join(parent, project.key + '-'));
    try { await restoreFileSet(destination, entries); }
    catch (err) { await fs.remove(destination); throw err; }
    results.unpacked.push({ name: project.name, path: destination, omitted: project.omitted?.length || 0 });
  }
  return results;
}
