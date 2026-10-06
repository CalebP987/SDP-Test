const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { execFileSync } = require('node:child_process');
const { computeMetrics, safeId } = require('./gitAnalyzer');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const REPOS_DIR = path.join(DATA_DIR, 'repos');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_PATH = path.join(DATA_DIR, 'rat-db.json');
const PORT = Number(process.env.PORT || 3000);
const METRICS_CACHE_LIMIT = 200;
const metricsCache = new Map();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function ensureDirs() {
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(REPOS_DIR, { recursive: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

function defaultDb() {
  return { repositories: [], analyses: {}, jobs: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}

function loadDb() {
  ensureDirs();
  if (!fs.existsSync(DB_PATH)) return defaultDb();
  try {
    return { ...defaultDb(), ...JSON.parse(fs.readFileSync(DB_PATH, 'utf8')) };
  } catch {
    return defaultDb();
  }
}

function saveDb(db) {
  db.updatedAt = new Date().toISOString();
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function cacheKey(repoId, analysis, filters) {
  return `${repoId}:${analysis.analyzedAt || ''}:${JSON.stringify(filters)}`;
}

function setMetricsCache(key, value) {
  metricsCache.set(key, value);
  if (metricsCache.size > METRICS_CACHE_LIMIT) {
    const oldestKey = metricsCache.keys().next().value;
    metricsCache.delete(oldestKey);
  }
}

function clearMetricsCache(repoId = '') {
  for (const key of [...metricsCache.keys()]) {
    if (!repoId || key.startsWith(`${repoId}:`)) metricsCache.delete(key);
  }
}

function json(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}

function text(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 1024 * 1024 * 200) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function repoNameFromUrl(url) {
  const clean = String(url || '').replace(/\/+$/, '');
  const name = clean.split('/').pop()?.replace(/\.git$/, '') || 'repository';
  return name.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80) || 'repository';
}

function validateRemoteUrl(url) {
  const value = String(url || '').trim();
  if (!value) throw new HttpError(400, 'Repository URL is required.');
  if (!/^(https?:\/\/|git@)/.test(value)) throw new HttpError(400, 'Use an HTTPS Git URL or SSH Git URL.');
  return value;
}

function runGit(args, cwd = ROOT) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 * 64 }).trim();
}

function uniqueRepoPath(name) {
  const base = `${Date.now().toString(36)}-${name}`;
  return path.join(REPOS_DIR, base);
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function findGitRoot(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const hasGit = entries.some((entry) => entry.name === '.git');
  if (hasGit) return dir;
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const child = path.join(dir, entry.name);
      const found = findGitRoot(child);
      if (found) return found;
    }
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

function parseMultipart(buffer, contentType) {
  const boundaryMatch = /boundary=(?:(?:\"([^\"]+)\")|([^;]+))/i.exec(contentType || '');
  if (!boundaryMatch) throw new Error('Missing multipart boundary.');
  const boundary = `--${boundaryMatch[1] || boundaryMatch[2]}`;
  const body = buffer.toString('binary');
  const parts = body.split(boundary).slice(1, -1);
  const fields = {};
  const files = {};
  for (const part of parts) {
    const clean = part.replace(/^\r\n/, '').replace(/\r\n$/, '');
    const split = clean.indexOf('\r\n\r\n');
    if (split === -1) continue;
    const rawHeaders = clean.slice(0, split);
    const rawData = clean.slice(split + 4);
    const nameMatch = /name="([^"]+)"/.exec(rawHeaders);
    if (!nameMatch) continue;
    const filenameMatch = /filename="([^"]*)"/.exec(rawHeaders);
    const name = nameMatch[1];
    const data = Buffer.from(rawData, 'binary');
    if (filenameMatch && filenameMatch[1]) files[name] = { filename: filenameMatch[1], data };
    else fields[name] = data.toString('utf8');
  }
  return { fields, files };
}

function updateJob(repositoryId, updater) {
  const db = loadDb();
  const repo = db.repositories.find((item) => item.id === repositoryId);
  const job = db.jobs.find((item) => item.repositoryId === repositoryId && ['queued', 'running'].includes(item.status)) || db.jobs.find((item) => item.repositoryId === repositoryId);
  if (!repo || !job) return;
  updater(db, repo, job);
  saveDb(db);
}

function startAnalysisJob(repo, workerData) {
  const worker = new Worker(path.join(__dirname, 'analysisWorker.js'), { workerData });
  worker.on('message', (message) => {
    updateJob(repo.id, (db, currentRepo, job) => {
      if (message.type === 'progress') {
        currentRepo.status = 'analyzing';
        job.status = 'running';
        job.progress = message.progress || job.progress || 0;
        job.message = message.message || job.message;
      }
      if (message.type === 'complete') {
        db.analyses[currentRepo.id] = message.analysis;
        clearMetricsCache(currentRepo.id);
        currentRepo.status = 'ready';
        currentRepo.localPath = message.repoRoot;
        currentRepo.error = '';
        Object.assign(currentRepo, message.stats || {});
        job.status = 'complete';
        job.progress = 100;
        job.message = 'Analysis complete';
        job.finishedAt = new Date().toISOString();
      }
      if (message.type === 'error') {
        currentRepo.status = 'error';
        currentRepo.error = message.message;
        job.status = 'error';
        job.message = message.message;
        job.finishedAt = new Date().toISOString();
      }
    });
  });
  worker.on('error', (error) => {
    updateJob(repo.id, (db, currentRepo, job) => {
      currentRepo.status = 'error';
      currentRepo.error = error.message;
      job.status = 'error';
      job.message = error.message;
      job.finishedAt = new Date().toISOString();
    });
  });
  worker.on('exit', (code) => {
    if (code === 0) return;
    updateJob(repo.id, (db, currentRepo, job) => {
      if (job.status === 'complete' || job.status === 'error') return;
      currentRepo.status = 'error';
      currentRepo.error = `Analysis worker exited with code ${code}.`;
      job.status = 'error';
      job.message = currentRepo.error;
      job.finishedAt = new Date().toISOString();
    });
  });
}

async function cloneRepository(req, res) {
  const body = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8') || '{}');
  const url = validateRemoteUrl(body.url);
  const name = repoNameFromUrl(url);
  const localPath = uniqueRepoPath(name);
  const db = loadDb();
  const repo = {
    id: safeId('repo'),
    name,
    sourceType: 'remote-url',
    source: url,
    localPath,
    status: 'queued',
    createdAt: new Date().toISOString(),
    error: '',
  };
  const job = { id: safeId('job'), repositoryId: repo.id, status: 'queued', progress: 0, message: 'Repository queued for cloning.', startedAt: new Date().toISOString() };
  db.repositories.unshift(repo);
  db.jobs.unshift(job);
  saveDb(db);
  startAnalysisJob(repo, { mode: 'remote', repositoryId: repo.id, url, localPath });
  json(res, 202, { repository: { ...repo, localPath: undefined }, job });
}

async function uploadRepository(req, res) {
  ensureDirs();
  const buffer = await readBody(req);
  const { files } = parseMultipart(buffer, req.headers['content-type']);
  const file = files.repo || files.file || Object.values(files)[0];
  if (!file) throw new Error('Upload a ZIP file containing a Git repository.');
  const name = repoNameFromUrl(file.filename.replace(/\.zip$/i, ''));
  const zipPath = path.join(UPLOAD_DIR, `${Date.now().toString(36)}-${name}.zip`);
  const extractPath = uniqueRepoPath(name);
  fs.writeFileSync(zipPath, file.data);
  const db = loadDb();
  const repo = {
    id: safeId('repo'),
    name,
    sourceType: 'zip-upload',
    source: file.filename,
    localPath: extractPath,
    status: 'queued',
    createdAt: new Date().toISOString(),
    error: '',
  };
  const job = { id: safeId('job'), repositoryId: repo.id, status: 'queued', progress: 0, message: 'Repository queued for ZIP extraction.', startedAt: new Date().toISOString() };
  db.repositories.unshift(repo);
  db.jobs.unshift(job);
  saveDb(db);
  startAnalysisJob(repo, { mode: 'zip', repositoryId: repo.id, zipPath, extractPath });
  json(res, 202, { repository: { ...repo, localPath: undefined }, job });
}

function getState(res) {
  const db = loadDb();
  const repositories = db.repositories.map((repo) => ({ ...repo, localPath: undefined }));
  json(res, 200, { repositories, jobs: db.jobs.slice(0, 20) });
}

function getRepository(res, id) {
  const db = loadDb();
  const repo = db.repositories.find((r) => r.id === id);
  if (!repo) return json(res, 404, { error: 'Repository not found.' });
  const analysis = db.analyses[id];
  const commits = analysis?.commits || [];
  return json(res, 200, {
    repository: { ...repo, localPath: undefined },
    authors: analysis?.authors || [],
    commits: commits.slice(-500),
    commitTotal: commits.length,
    objects: analysis?.objects || [],
  });
}

function metrics(res, url) {
  const db = loadDb();
  const repoId = url.searchParams.get('repoId');
  const analysis = db.analyses[repoId];
  if (!analysis) return json(res, 404, { error: 'Analysis not found for repository.' });
  const commits = url.searchParams.get('commits');
  const filters = {
    path: url.searchParams.get('path') || '/',
    type: url.searchParams.get('type') || 'directory',
    authorId: url.searchParams.get('authorId') || '',
    from: url.searchParams.get('from') || '',
    to: url.searchParams.get('to') || '',
    commits: commits ? commits.split(',').filter(Boolean) : [],
    objectSearch: url.searchParams.get('objectSearch') || '',
    limit: url.searchParams.get('limit') || '100',
    offset: url.searchParams.get('offset') || '0',
  };
  const key = cacheKey(repoId, analysis, filters);
  const debugCache = url.searchParams.get('debugCache') === '1';
  if (metricsCache.has(key)) {
    const cached = metricsCache.get(key);
    return json(res, 200, debugCache ? { ...cached, cache: { hit: true, size: metricsCache.size } } : cached);
  }
  const computed = computeMetrics(analysis, filters);
  setMetricsCache(key, computed);
  return json(res, 200, debugCache ? { ...computed, cache: { hit: false, size: metricsCache.size } } : computed);
}

async function mergeAuthors(req, res) {
  const body = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8') || '{}');
  const db = loadDb();
  const analysis = db.analyses[body.repoId];
  if (!analysis) return json(res, 404, { error: 'Analysis not found.' });
  const target = analysis.authors.find((a) => a.id === body.targetAuthorId);
  const sources = new Set(body.sourceAuthorIds || []);
  if (!target || sources.size === 0) return json(res, 400, { error: 'Choose a target author and at least one source author.' });
  const sourceAuthors = analysis.authors.filter((a) => sources.has(a.id));
  for (const source of sourceAuthors) target.aliases.push(...(source.aliases || []), { name: source.name, email: source.email, source: 'manual' });
  for (const commit of analysis.commits) if (sources.has(commit.authorId)) commit.authorId = target.id;
  for (const row of analysis.fileChanges) if (sources.has(row.authorId)) row.authorId = target.id;
  for (const row of analysis.dirChanges) if (sources.has(row.authorId)) row.authorId = target.id;
  analysis.authors = analysis.authors.filter((a) => !sources.has(a.id));
  analysis.analyzedAt = new Date().toISOString();
  clearMetricsCache(body.repoId);
  saveDb(db);
  return json(res, 200, { authors: analysis.authors });
}

async function resetAuthorMerges(req, res) {
  const body = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8') || '{}');
  const db = loadDb();
  const repo = db.repositories.find((item) => item.id === body.repoId);
  if (!repo) return json(res, 404, { error: 'Repository not found.' });
  if (!repo.localPath || !fs.existsSync(repo.localPath)) return json(res, 400, { error: 'Repository files are missing; cannot reset author merges.' });
  const job = { id: safeId('job'), repositoryId: repo.id, status: 'queued', progress: 0, message: 'Resetting manual author merges...', startedAt: new Date().toISOString() };
  repo.status = 'queued';
  repo.error = '';
  db.jobs.unshift(job);
  saveDb(db);
  startAnalysisJob(repo, { mode: 'reanalyze', repositoryId: repo.id, localPath: repo.localPath });
  return json(res, 202, { repository: { ...repo, localPath: undefined }, job });
}

function serveStatic(res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const fullPath = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!fullPath.startsWith(PUBLIC_DIR)) return text(res, 403, 'Forbidden');
  if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) return text(res, 404, 'Not found');
  const ext = path.extname(fullPath).toLowerCase();
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
  text(res, 200, fs.readFileSync(fullPath), types[ext] || 'application/octet-stream');
}

async function route(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/api/state') return getState(res);
    if (req.method === 'GET' && url.pathname.startsWith('/api/repos/')) return getRepository(res, url.pathname.split('/').pop());
    if (req.method === 'GET' && url.pathname === '/api/metrics') return metrics(res, url);
    if (req.method === 'POST' && url.pathname === '/api/repos/clone') return cloneRepository(req, res);
    if (req.method === 'POST' && url.pathname === '/api/repos/upload') return uploadRepository(req, res);
    if (req.method === 'POST' && url.pathname === '/api/authors/merge') return mergeAuthors(req, res);
    if (req.method === 'POST' && url.pathname === '/api/authors/reset') return resetAuthorMerges(req, res);
    if (req.method === 'GET') return serveStatic(res, url.pathname);
    return json(res, 405, { error: 'Method not allowed.' });
  } catch (error) {
    return json(res, 500, { error: error.message || 'Unexpected server error.' });
  }
}

ensureDirs();
const server = http.createServer(route);
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Repo Analysis Tool running at http://localhost:${PORT}`);
  });
}

module.exports = { server, loadDb, saveDb, DATA_DIR, REPOS_DIR, validateZipEntries };
