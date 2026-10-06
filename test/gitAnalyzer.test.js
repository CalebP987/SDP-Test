const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { analyzeRepository, computeMetrics, parseNumstatPath, parentDirs } = require('../src/gitAnalyzer');

function sh(repo, args) {
  return execFileSync(args[0], args.slice(1), { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rat-test-'));
  sh(repo, ['git', 'init']);
  sh(repo, ['git', 'config', 'user.name', 'Alice']);
  sh(repo, ['git', 'config', 'user.email', 'alice@example.com']);
  return repo;
}

function commit(repo, message, env = {}) {
  sh(repo, ['git', 'add', '.']);
  execFileSync('git', ['commit', '-m', message], {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  return sh(repo, ['git', 'rev-parse', 'HEAD']).trim();
}

test('parses git numstat rename paths', () => {
  assert.deepEqual(parseNumstatPath('src/{old.js => new.js}'), { path: 'src/new.js', oldPath: 'src/old.js', renamed: true });
  assert.deepEqual(parentDirs('src/lib/file.js'), ['/', 'src', 'src/lib']);
});

test('analyzes file, directory, repository, commit-set, and author metrics', () => {
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'a.txt'), 'one\ntwo\n');
  commit(repo, 'initial');
  fs.writeFileSync(path.join(repo, 'src', 'a.txt'), 'one\ntwo\nthree\n');
  commit(repo, 'add line');
  fs.writeFileSync(path.join(repo, 'src', 'a.txt'), 'one\nthree\n');
  commit(repo, 'remove line');

  const analysis = analyzeRepository(repo);
  assert.equal(analysis.commits.length, 3);
  assert.equal(analysis.fileChanges.length, 3);

  const root = computeMetrics(analysis, { type: 'directory', path: '/' });
  assert.equal(root.summary.added, 3);
  assert.equal(root.summary.removed, 1);
  assert.equal(root.summary.growth, 2);
  assert.equal(root.summary.churn, 4);
  assert.equal(root.summary.modifications, 3);
  assert.equal(root.commitCount, 3);

  const file = computeMetrics(analysis, { type: 'file', path: 'src/a.txt' });
  assert.equal(file.summary.added, 3);
  assert.equal(file.summary.removed, 1);
  assert.equal(file.authors[0].ownership, 1);
});

test('supports date ranges and manual commit-set filtering with short hashes', () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  const first = commit(repo, 'first', { GIT_AUTHOR_DATE: '2024-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2024-01-01T00:00:00Z' });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
  const second = commit(repo, 'second', { GIT_AUTHOR_DATE: '2024-02-01T00:00:00Z', GIT_COMMITTER_DATE: '2024-02-01T00:00:00Z' });

  const analysis = analyzeRepository(repo);
  const feb = Math.floor(new Date('2024-02-01T00:00:00Z').getTime() / 1000);
  const byDate = computeMetrics(analysis, { type: 'file', path: 'a.txt', from: feb });
  assert.equal(byDate.commitCount, 1);
  assert.equal(byDate.summary.added, 1);

  const byShortHash = computeMetrics(analysis, { type: 'file', path: 'a.txt', commits: [second.slice(0, 8)] });
  assert.equal(byShortHash.commitCount, 1);
  assert.equal(byShortHash.summary.added, 1);
  assert.equal(computeMetrics(analysis, { type: 'file', path: 'a.txt', commits: [first] }).summary.added, 1);
});

test('attributes rename plus content changes to the new path', () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'old.txt'), 'one\ntwo\n');
  commit(repo, 'initial');
  sh(repo, ['git', 'mv', 'old.txt', 'new.txt']);
  fs.writeFileSync(path.join(repo, 'new.txt'), 'one\ntwo\nthree\n');
  commit(repo, 'rename and add');

  const analysis = analyzeRepository(repo);
  const newPath = computeMetrics(analysis, { type: 'file', path: 'new.txt' });
  const oldPath = computeMetrics(analysis, { type: 'file', path: 'old.txt' });
  assert.equal(newPath.summary.added, 1);
  assert.equal(newPath.summary.churn, 1);
  assert.equal(oldPath.summary.churn, 2);
});

test('ignores binary files reported by git numstat', () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'binary.dat'), Buffer.from([0, 1, 2, 3, 4, 0, 255]));
  commit(repo, 'binary initial');
  fs.writeFileSync(path.join(repo, 'binary.dat'), Buffer.from([0, 1, 2, 3, 4, 5, 6, 0, 255]));
  commit(repo, 'binary change');

  const analysis = analyzeRepository(repo);
  assert.equal(computeMetrics(analysis, { type: 'file', path: 'binary.dat' }).summary.churn, 0);
});

test('excludes merge commits from analysis history', () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'main.txt'), 'base\n');
  commit(repo, 'base');
  sh(repo, ['git', 'checkout', '-b', 'feature']);
  fs.writeFileSync(path.join(repo, 'feature.txt'), 'feature\n');
  commit(repo, 'feature');
  sh(repo, ['git', 'checkout', 'master']);
  fs.writeFileSync(path.join(repo, 'main.txt'), 'base\nmain\n');
  commit(repo, 'main');
  sh(repo, ['git', 'merge', '--no-ff', 'feature', '-m', 'merge feature']);

  const analysis = analyzeRepository(repo);
  assert.equal(analysis.commits.length, 3);
  assert.ok(!analysis.commits.some((commit) => commit.subject === 'merge feature'));
});

test('applies .mailmap aliases for author merging', () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, '.mailmap'), 'Alice <alice@example.com> Alicia <alicia@example.com>\n');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  commit(repo, 'mailmap', {
    GIT_AUTHOR_NAME: 'Alicia',
    GIT_AUTHOR_EMAIL: 'alicia@example.com',
    GIT_COMMITTER_NAME: 'Alicia',
    GIT_COMMITTER_EMAIL: 'alicia@example.com',
  });

  const analysis = analyzeRepository(repo);
  assert.equal(analysis.authors.length, 1);
  assert.equal(analysis.authors[0].name, 'Alice');
  assert.equal(analysis.authors[0].email, 'alice@example.com');
});
