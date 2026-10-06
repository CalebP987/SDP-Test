const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function git(repoPath, args, options = {}) {
  return execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
    maxBuffer: options.maxBuffer || 1024 * 1024 * 64,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

function safeId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function authorKey(name, email) {
  return `${String(name || '').trim()} <${String(email || '').trim().toLowerCase()}>`;
}

function parseIdentity(value) {
  const match = String(value || '').match(/^(.*)<([^>]+)>\s*$/);
  if (!match) return { name: String(value || '').trim(), email: '' };
  return { name: match[1].trim(), email: match[2].trim().toLowerCase() };
}

function canonicalAuthor(repoPath, name, email) {
  const raw = `${name} <${email}>`;
  try {
    const out = git(repoPath, ['check-mailmap', raw]);
    return parseIdentity(out || raw);
  } catch {
    return { name, email: String(email || '').toLowerCase() };
  }
}

function parseNumstatPath(rawPath) {
  if (!rawPath) return { path: '', oldPath: '', renamed: false };
  const renameMatch = rawPath.match(/^(.*?)(?: ?\{)(.+) => (.+)\}(.*)$/);
  if (renameMatch) {
    const prefix = renameMatch[1] || '';
    const suffix = renameMatch[4] || '';
    const oldPath = `${prefix}${renameMatch[2]}${suffix}`.replace(/\/+/g, '/');
    const newPath = `${prefix}${renameMatch[3]}${suffix}`.replace(/\/+/g, '/');
    return { path: newPath, oldPath, renamed: true };
  }
  const arrow = rawPath.indexOf(' => ');
  if (arrow !== -1) {
    const left = rawPath.slice(0, arrow).replace(/[{}]/g, '').trim();
    const right = rawPath.slice(arrow + 4).replace(/[{}]/g, '').trim();
    return { path: right || rawPath, oldPath: left, renamed: true };
  }
  return { path: rawPath.replace(/\/+/g, '/'), oldPath: '', renamed: false };
}

function parentDirs(filePath) {
  const clean = String(filePath || '').replace(/^\/+|\/+$/g, '');
  const parts = clean.split('/').filter(Boolean);
  const dirs = ['/'];
  for (let i = 0; i < parts.length - 1; i += 1) {
    dirs.push(parts.slice(0, i + 1).join('/'));
  }
  return dirs;
}

function directoryObjectsForFile(filePath) {
  const clean = String(filePath || '').replace(/^\/+|\/+$/g, '');
  const parts = clean.split('/').filter(Boolean);
  const dirs = new Set(['/']);
  for (let i = 0; i < parts.length - 1; i += 1) {
    dirs.add(parts.slice(0, i + 1).join('/'));
  }
  return [...dirs];
}

function buildObjectsFromChanges(fileChanges, dirChanges) {
  const objects = new Map();
  for (const change of fileChanges) {
    objects.set(`file:${change.path}`, { path: change.path, type: 'file' });
    for (const dir of directoryObjectsForFile(change.path)) {
      objects.set(`directory:${dir}`, { path: dir, type: 'directory' });
    }
  }
  for (const change of dirChanges) {
    objects.set(`directory:${change.path}`, { path: change.path, type: 'directory' });
  }
  return [...objects.values()].sort((a, b) => a.type.localeCompare(b.type) || a.path.localeCompare(b.path));
}

function getDefaultRef(repoPath) {
  try {
    return git(repoPath, ['symbolic-ref', '--short', 'HEAD']) || 'HEAD';
  } catch {
    return 'HEAD';
  }
}

function analyzeRepository(repoPath, onProgress = () => {}) {
  const ref = getDefaultRef(repoPath);
  const hashesText = git(repoPath, ['rev-list', '--no-merges', '--reverse', ref], { maxBuffer: 1024 * 1024 * 128 });
  const hashes = hashesText ? hashesText.split('\n').filter(Boolean) : [];
  const authorsByKey = new Map();
  const commits = [];
  const fileChanges = [];
  const dirChanges = [];

  for (let index = 0; index < hashes.length; index += 1) {
    const hash = hashes[index];
    const meta = git(repoPath, ['show', '-s', '--format=%H%x00%P%x00%ct%x00%an%x00%ae%x00%s', hash]);
    const [fullHash, parentsRaw, tsRaw, authorName, authorEmail, ...subjectParts] = meta.split('\u0000');
    const parentHash = (parentsRaw || '').split(' ').filter(Boolean)[0] || EMPTY_TREE;
    const canonical = canonicalAuthor(repoPath, authorName, authorEmail);
    const key = authorKey(canonical.name, canonical.email);
    if (!authorsByKey.has(key)) {
      authorsByKey.set(key, {
        id: safeId('author'),
        name: canonical.name || authorName || 'Unknown',
        email: canonical.email || String(authorEmail || '').toLowerCase(),
        aliases: [{ name: authorName || 'Unknown', email: String(authorEmail || '').toLowerCase(), source: 'git' }],
      });
    } else {
      const author = authorsByKey.get(key);
      const aliasKey = authorKey(authorName, authorEmail);
      if (!author.aliases.some((a) => authorKey(a.name, a.email) === aliasKey)) {
        author.aliases.push({ name: authorName || 'Unknown', email: String(authorEmail || '').toLowerCase(), source: 'git' });
      }
    }
    const author = authorsByKey.get(key);
    commits.push({
      hash: fullHash,
      shortHash: fullHash.slice(0, 8),
      parentHash: parentHash === EMPTY_TREE ? null : parentHash,
      committerDate: Number(tsRaw) || 0,
      authorId: author.id,
      rawAuthorName: authorName || 'Unknown',
      rawAuthorEmail: String(authorEmail || '').toLowerCase(),
      subject: subjectParts.join('\u0000') || '',
    });

    const diff = git(repoPath, ['diff', '--numstat', '-M50%', parentHash, hash], { maxBuffer: 1024 * 1024 * 128 });
    const dirMap = new Map();
    if (diff) {
      for (const line of diff.split('\n')) {
        if (!line.trim()) continue;
        const cols = line.split('\t');
        const addedRaw = cols[0];
        const removedRaw = cols[1];
        const rawPath = cols.slice(2).join('\t');
        if (addedRaw === '-' || removedRaw === '-') continue;
        const added = Number(addedRaw) || 0;
        const removed = Number(removedRaw) || 0;
        const churn = added + removed;
        if (churn === 0) continue;
        const parsed = parseNumstatPath(rawPath);
        const targetPath = parsed.path || parsed.oldPath;
        const change = {
          commitHash: fullHash,
          authorId: author.id,
          path: targetPath,
          oldPath: parsed.oldPath || null,
          added,
          removed,
          growth: added - removed,
          churn,
          renamed: parsed.renamed,
        };
        fileChanges.push(change);
        for (const dir of parentDirs(targetPath)) {
          const existing = dirMap.get(dir) || { commitHash: fullHash, authorId: author.id, path: dir, added: 0, removed: 0, growth: 0, churn: 0 };
          existing.added += added;
          existing.removed += removed;
          existing.growth += added - removed;
          existing.churn += churn;
          dirMap.set(dir, existing);
        }
      }
    }
    dirChanges.push(...dirMap.values());
    if (index % 25 === 0 || index === hashes.length - 1) {
      onProgress({ done: index + 1, total: hashes.length, commit: hash });
    }
  }

  const authors = [...authorsByKey.values()].sort((a, b) => a.name.localeCompare(b.name));
  const objects = buildObjectsFromChanges(fileChanges, dirChanges);
  return { ref, commits, authors, fileChanges, dirChanges, objects, analyzedAt: new Date().toISOString() };
}

function aggregate(changes, commitSet, pathValue, authorId = '') {
  const selected = new Set(commitSet.map((c) => c.hash));
  const rows = changes.filter((c) => selected.has(c.commitHash) && c.path === pathValue && (!authorId || c.authorId === authorId));
  const commitHits = new Set(rows.filter((r) => r.churn > 0).map((r) => r.commitHash));
  const added = rows.reduce((n, r) => n + r.added, 0);
  const removed = rows.reduce((n, r) => n + r.removed, 0);
  const growth = rows.reduce((n, r) => n + r.growth, 0);
  const churn = rows.reduce((n, r) => n + r.churn, 0);
  const denominator = commitSet.length;
  return {
    added,
    removed,
    growth,
    churn,
    modifications: commitHits.size,
    modificationFrequency: denominator ? commitHits.size / denominator : 0,
    churnRate: denominator ? churn / denominator : 0,
  };
}

function matchesSelectedCommit(commit, selectedHashes) {
  if (!selectedHashes) return true;
  return selectedHashes.some((hash) => {
    const clean = String(hash || '').trim();
    return clean && (commit.hash === clean || commit.shortHash === clean || commit.hash.startsWith(clean));
  });
}

function filterCommits(commits, filters = {}) {
  const selectedHashes = Array.isArray(filters.commits) && filters.commits.length ? filters.commits.map((hash) => String(hash).trim()).filter(Boolean) : null;
  const from = filters.from ? Number(filters.from) : null;
  const to = filters.to ? Number(filters.to) : null;
  return commits.filter((commit) => {
    if (!matchesSelectedCommit(commit, selectedHashes)) return false;
    if (from && commit.committerDate < from) return false;
    if (to && commit.committerDate >= to) return false;
    if (filters.authorId && commit.authorId !== filters.authorId) return false;
    return true;
  });
}

function emptyMetric(commitSet) {
  return {
    added: 0,
    removed: 0,
    growth: 0,
    churn: 0,
    modifications: 0,
    modificationFrequency: 0,
    churnRate: 0,
    commitHits: new Set(),
  };
}

function addMetric(metric, row) {
  metric.added += row.added;
  metric.removed += row.removed;
  metric.growth += row.growth;
  metric.churn += row.churn;
  if (row.churn > 0) metric.commitHits.add(row.commitHash);
}

function finalizeMetric(metric, commitSet) {
  const modifications = metric.commitHits.size;
  const denominator = commitSet.length;
  return {
    added: metric.added,
    removed: metric.removed,
    growth: metric.growth,
    churn: metric.churn,
    modifications,
    modificationFrequency: denominator ? modifications / denominator : 0,
    churnRate: denominator ? metric.churn / denominator : 0,
  };
}

function computeMetrics(analysis, filters = {}) {
  const objectType = filters.type || 'directory';
  const objectPath = filters.path || '/';
  const selectedAuthorId = filters.authorId || '';
  const objectSearch = String(filters.objectSearch || '').trim().toLowerCase();
  const objectLimit = Math.min(Math.max(Number(filters.limit) || 100, 1), 500);
  const objectOffset = Math.max(Number(filters.offset) || 0, 0);
  const commitSet = filterCommits(analysis.commits || [], filters);
  const selected = new Set(commitSet.map((c) => c.hash));
  const commitByHash = new Map(commitSet.map((c) => [c.hash, c]));
  const authorLookup = new Map((analysis.authors || []).map((a) => [a.id, a]));
  const summaryAccumulator = emptyMetric(commitSet);
  const objectMetrics = new Map();
  const authors = new Map();
  const dayMap = new Map();

  const visitRows = (rows, type) => {
    for (const row of rows || []) {
      if (!selected.has(row.commitHash)) continue;
      if (selectedAuthorId && row.authorId !== selectedAuthorId) continue;

      if (row.path === objectPath && type === objectType) {
        addMetric(summaryAccumulator, row);
        const currentAuthor = authors.get(row.authorId) || {
          authorId: row.authorId,
          name: authorLookup.get(row.authorId)?.name || 'Unknown',
          email: authorLookup.get(row.authorId)?.email || '',
          modifications: new Set(),
          churn: 0,
        };
        if (row.churn > 0) currentAuthor.modifications.add(row.commitHash);
        currentAuthor.churn += row.churn;
        authors.set(row.authorId, currentAuthor);

        const commit = commitByHash.get(row.commitHash);
        if (commit) {
          const day = new Date(commit.committerDate * 1000).toISOString().slice(0, 10);
          const currentDay = dayMap.get(day) || { date: day, added: 0, removed: 0, growth: 0, churn: 0 };
          currentDay.added += row.added;
          currentDay.removed += row.removed;
          currentDay.growth += row.growth;
          currentDay.churn += row.churn;
          dayMap.set(day, currentDay);
        }
      }

      if (objectSearch && !row.path.toLowerCase().includes(objectSearch) && !type.includes(objectSearch)) continue;
      const key = `${type}:${row.path}`;
      const metric = objectMetrics.get(key) || { type, path: row.path, ...emptyMetric(commitSet) };
      addMetric(metric, row);
      objectMetrics.set(key, metric);
    }
  };

  visitRows(analysis.fileChanges, 'file');
  visitRows(analysis.dirChanges, 'directory');

  const summary = finalizeMetric(summaryAccumulator, commitSet);
  const authorMetrics = [...authors.values()].map((a) => ({
    authorId: a.authorId,
    name: a.name,
    email: a.email,
    modifications: a.modifications.size,
    churn: a.churn,
    ownership: summary.churn ? a.churn / summary.churn : 0,
  })).sort((a, b) => b.churn - a.churn);

  const sortedObjects = [...objectMetrics.values()]
    .map((metric) => ({ type: metric.type, path: metric.path, ...finalizeMetric(metric, commitSet) }))
    .filter((metric) => metric.churn > 0)
    .sort((a, b) => b.churn - a.churn);

  return {
    commitCount: commitSet.length,
    object: { type: objectType, path: objectPath },
    summary,
    objects: sortedObjects.slice(objectOffset, objectOffset + objectLimit),
    objectTotal: sortedObjects.length,
    objectLimit,
    objectOffset,
    authors: authorMetrics,
    timeline: [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

module.exports = {
  EMPTY_TREE,
  analyzeRepository,
  computeMetrics,
  filterCommits,
  parseNumstatPath,
  parentDirs,
  safeId,
};
