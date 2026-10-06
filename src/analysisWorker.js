const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { analyzeRepository } = require('./gitAnalyzer');

function runGit(args, cwd = process.cwd()) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 * 64 }).trim();
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function findGitRoot(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (entries.some((entry) => entry.name === '.git')) return dir;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findGitRoot(path.join(dir, entry.name));
    if (found) return found;
  }
  return null;
}

function validateZipEntries(zipPath) {
  const listing = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  for (const entry of listing.split('\n').filter(Boolean)) {
    const normalized = path.posix.normalize(entry.replace(/\\/g, '/'));
    if (normalized.startsWith('../') || normalized === '..' || path.posix.isAbsolute(normalized)) {
      throw new Error('Unsafe ZIP path detected.');
    }
  }
}

function prepareRepository() {
  if (workerData.mode === 'reanalyze') {
    parentPort.postMessage({ type: 'progress', progress: 10, message: 'Rebuilding author and metric data...' });
    if (!workerData.localPath || !fs.existsSync(workerData.localPath)) {
      throw new Error('Repository path is missing; cannot reanalyze.');
    }
    return workerData.localPath;
  }

  if (workerData.mode === 'remote') {
    parentPort.postMessage({ type: 'progress', progress: 5, message: 'Cloning repository...' });
    fs.rmSync(workerData.localPath, { recursive: true, force: true });
    runGit(['clone', '--', workerData.url, workerData.localPath]);
    return workerData.localPath;
  }

  if (workerData.mode === 'zip') {
    parentPort.postMessage({ type: 'progress', progress: 5, message: 'Validating ZIP archive...' });
    validateZipEntries(workerData.zipPath);
    parentPort.postMessage({ type: 'progress', progress: 10, message: 'Extracting ZIP archive...' });
    fs.rmSync(workerData.extractPath, { recursive: true, force: true });
    fs.mkdirSync(workerData.extractPath, { recursive: true });
    execFileSync('unzip', ['-q', workerData.zipPath, '-d', workerData.extractPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    const repoRoot = findGitRoot(workerData.extractPath);
    if (!repoRoot || !isInside(workerData.extractPath, repoRoot)) {
      throw new Error('The ZIP must contain a repository with a .git file or directory.');
    }
    return repoRoot;
  }

  throw new Error(`Unknown analysis mode: ${workerData.mode}`);
}

try {
  const repoRoot = prepareRepository();
  parentPort.postMessage({ type: 'progress', progress: 15, message: 'Analyzing commits...' });
  const analysis = analyzeRepository(repoRoot, (p) => {
    const commitProgress = p.total ? Math.round((p.done / p.total) * 80) : 80;
    parentPort.postMessage({
      type: 'progress',
      progress: Math.min(95, 15 + commitProgress),
      message: `Analyzed ${p.done}/${p.total} commits`,
    });
  });
  parentPort.postMessage({
    type: 'complete',
    repoRoot,
    analysis,
    stats: {
      ref: analysis.ref,
      commitCount: analysis.commits.length,
      authorCount: analysis.authors.length,
      objectCount: analysis.objects.length,
      analyzedAt: analysis.analyzedAt,
    },
  });
} catch (error) {
  parentPort.postMessage({ type: 'error', message: error.message || 'Analysis failed.' });
}
