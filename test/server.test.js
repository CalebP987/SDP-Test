const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { server, DATA_DIR } = require('../src/server');

function sh(cwd, args) {
  return execFileSync(args[0], args.slice(1), { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rat-api-repo-'));
  sh(repo, ['git', 'init']);
  sh(repo, ['git', 'config', 'user.name', 'Api User']);
  sh(repo, ['git', 'config', 'user.email', 'api@example.com']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
  sh(repo, ['git', 'add', '.']);
  sh(repo, ['git', 'commit', '-m', 'initial']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n');
  sh(repo, ['git', 'add', '.']);
  sh(repo, ['git', 'commit', '-m', 'add line']);
  fs.writeFileSync(path.join(repo, 'b.txt'), 'bee\n');
  sh(repo, ['git', 'add', '.']);
  execFileSync('git', ['commit', '-m', 'bob file'], {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 'Bob', GIT_AUTHOR_EMAIL: 'bob@example.com', GIT_COMMITTER_NAME: 'Bob', GIT_COMMITTER_EMAIL: 'bob@example.com' },
  });
  return repo;
}

function makeZip(repo) {
  const zipPath = path.join(os.tmpdir(), `rat-api-${Date.now()}.zip`);
  execFileSync('zip', ['-qr', zipPath, '.'], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  return zipPath;
}

function multipartBody(fieldName, filename, data) {
  const boundary = `----rat-${Date.now().toString(36)}`;
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { boundary, body: Buffer.concat([head, data, tail]) };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReady(base, repoId) {
  for (let i = 0; i < 80; i += 1) {
    const detail = await fetch(`${base}/api/repos/${repoId}`).then((res) => res.json());
    if (detail.repository.status === 'ready') return detail;
    if (detail.repository.status === 'error') throw new Error(detail.repository.error || 'Repository analysis failed.');
    await sleep(100);
  }
  throw new Error('Repository did not become ready in time.');
}

test('ZIP upload endpoint analyzes repository and metrics endpoint returns root metrics', async (t) => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  const listener = server.listen(0);
  t.after(async () => {
    listener.closeAllConnections?.();
    await new Promise((resolve) => listener.close(resolve));
  });
  const base = `http://127.0.0.1:${listener.address().port}`;
  const repo = makeRepo();
  const zipPath = makeZip(repo);
  const { boundary, body } = multipartBody('repo', 'sample.zip', fs.readFileSync(zipPath));

  const upload = await fetch(`${base}/api/repos/upload`, {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  assert.equal(upload.status, 202);
  const payload = await upload.json();
  assert.equal(payload.repository.status, 'queued');
  assert.equal(payload.job.status, 'queued');

  const detail = await waitForReady(base, payload.repository.id);
  assert.equal(detail.commits.length, 3);
  assert.equal(detail.authors.length, 2);

  const metrics = await fetch(`${base}/api/metrics?repoId=${payload.repository.id}&type=directory&path=/&debugCache=1`);
  assert.equal(metrics.status, 200);
  const metricPayload = await metrics.json();
  assert.equal(metricPayload.summary.added, 4);
  assert.equal(metricPayload.summary.churn, 4);
  assert.equal(metricPayload.cache.hit, false);
  const cachedMetrics = await fetch(`${base}/api/metrics?repoId=${payload.repository.id}&type=directory&path=/&debugCache=1`).then((res) => res.json());
  assert.equal(cachedMetrics.cache.hit, true);

  const paged = await fetch(`${base}/api/metrics?repoId=${payload.repository.id}&type=directory&path=/&limit=1&offset=0&objectSearch=.txt`).then((res) => res.json());
  assert.equal(paged.objects.length, 1);
  assert.ok(paged.objectTotal >= 2);

  const bob = detail.authors.find((author) => author.email === 'bob@example.com');
  const bobMetrics = await fetch(`${base}/api/metrics?repoId=${payload.repository.id}&type=directory&path=/&authorId=${bob.id}`).then((res) => res.json());
  assert.equal(bobMetrics.summary.added, 1);
  assert.equal(bobMetrics.summary.churn, 1);
  assert.equal(bobMetrics.authors.length, 1);
  assert.equal(bobMetrics.authors[0].ownership, 1);

  const [target, source] = detail.authors;
  const merge = await fetch(`${base}/api/authors/merge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repoId: payload.repository.id, targetAuthorId: target.id, sourceAuthorIds: [source.id] }),
  });
  assert.equal(merge.status, 200);
  const afterMerge = await fetch(`${base}/api/repos/${payload.repository.id}`).then((res) => res.json());
  assert.equal(afterMerge.authors.length, 1);

  const reset = await fetch(`${base}/api/authors/reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repoId: payload.repository.id }),
  });
  assert.equal(reset.status, 202);
  const afterReset = await waitForReady(base, payload.repository.id);
  assert.equal(afterReset.authors.length, 2);

  const state = await fetch(`${base}/api/state`).then((res) => res.json());
  assert.equal(state.repositories.length, 1);
  assert.equal(state.repositories[0].status, 'ready');
  assert.equal(state.repositories[0].localPath, undefined);
});
