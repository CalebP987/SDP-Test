const $ = (selector) => document.querySelector(selector);
const fmt = new Intl.NumberFormat('en-US');
let state = { repositories: [], jobs: [], selectedRepoId: '', repoDetail: null, metrics: null, selectedCommitHashes: [], objectOffset: 0, objectLimit: 100 };

function setStatus(message, isError = false) {
  const el = $('#status');
  el.textContent = message;
  el.classList.toggle('error', isError);
}

async function api(path, options = {}) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed with ${res.status}`);
  return data;
}

function pct(value) {
  return `${((Number(value) || 0) * 100).toFixed(1)}%`;
}

function unixFromDate(value, end = false) {
  if (!value) return '';
  const date = new Date(`${value}T00:00:00`);
  if (end) date.setDate(date.getDate() + 1);
  return Math.floor(date.getTime() / 1000);
}

function option(value, label, extra = {}) {
  const el = document.createElement('option');
  el.value = value;
  el.textContent = label;
  Object.assign(el.dataset, extra);
  return el;
}

async function refreshState() {
  const data = await api('/api/state');
  state.repositories = data.repositories || [];
  state.jobs = data.jobs || [];
  $('#repo-count').textContent = state.repositories.filter((r) => r.status === 'ready').length;
  renderRepositories();
  renderRepoSelect();
  if (!state.selectedRepoId && state.repositories[0]) {
    state.selectedRepoId = state.repositories[0].id;
    $('#repo-select').value = state.selectedRepoId;
    await loadRepository(state.selectedRepoId);
  } else if (state.selectedRepoId) {
    await loadRepository(state.selectedRepoId);
  }
}

function renderRepositories() {
  const list = $('#repo-list');
  list.innerHTML = '';
  if (!state.repositories.length) {
    list.innerHTML = '<p class="muted">No repositories yet. Clone or upload one to begin.</p>';
    return;
  }
  for (const repo of state.repositories) {
    const job = state.jobs.find((item) => item.repositoryId === repo.id);
    const card = document.createElement('div');
    card.className = `repo-card ${repo.id === state.selectedRepoId ? 'active' : ''}`;
    const progress = job && repo.status !== 'ready' ? `<div class="progress"><span style="width:${job.progress || 0}%"></span></div><small>${job.message || ''}</small>` : '';
    const error = repo.error ? `<small class="error-text">${repo.error}</small>` : '';
    card.innerHTML = `<strong>${repo.name}</strong><span>${repo.sourceType} • ${repo.commitCount || 0} commits • ${repo.authorCount || 0} authors</span><br><span class="badge ${repo.status === 'error' ? 'error' : ''}">${repo.status}</span>${progress}${error}`;
    card.addEventListener('click', async () => {
      state.selectedRepoId = repo.id;
      $('#repo-select').value = repo.id;
      await loadRepository(repo.id);
    });
    list.appendChild(card);
  }
}

function renderRepoSelect() {
  const select = $('#repo-select');
  select.innerHTML = '';
  for (const repo of state.repositories) select.appendChild(option(repo.id, `${repo.name} (${repo.status})`));
  if (state.selectedRepoId) select.value = state.selectedRepoId;
}

async function loadRepository(id) {
  if (!id) return;
  state.selectedRepoId = id;
  state.repoDetail = await api(`/api/repos/${id}`);
  populateFilters();
  if (state.repoDetail.repository?.status === 'ready') {
    await loadMetrics();
  } else {
    state.metrics = { commitCount: 0, object: { type: 'directory', path: '/' }, summary: {}, objects: [], authors: [], timeline: [] };
    renderMetrics();
    const job = state.jobs.find((item) => item.repositoryId === id);
    setStatus(job?.message || `Repository is ${state.repoDetail.repository?.status || 'queued'}.`);
  }
  renderRepositories();
}

function populateFilters() {
  const detail = state.repoDetail || {};
  const authors = detail.authors || [];
  const objects = detail.objects || [];
  const commits = detail.commits || [];
  const authorSelect = $('#author-select');
  const target = $('#merge-target');
  const sources = $('#merge-sources');
  authorSelect.innerHTML = '';
  target.innerHTML = '';
  sources.innerHTML = '';
  authorSelect.appendChild(option('', 'All authors'));
  for (const author of authors) {
    const label = `${author.name} <${author.email}>`;
    authorSelect.appendChild(option(author.id, label));
    target.appendChild(option(author.id, label));
    sources.appendChild(option(author.id, label));
  }
  renderAuthorAliases(authors);
  const objectSelect = $('#object-select');
  objectSelect.innerHTML = '';
  objectSelect.appendChild(option('/', 'directory: /', { type: 'directory' }));
  for (const object of objects) {
    if (object.path === '/' && object.type === 'directory') continue;
    objectSelect.appendChild(option(object.path, `${object.type}: ${object.path}`, { type: object.type }));
  }
  const commitPicker = $('#commit-picker');
  commitPicker.innerHTML = '';
  const totalCommits = detail.commitTotal || commits.length;
  commitPicker.appendChild(option('', `Select a commit to add (${commits.length}/${totalCommits} shown)`));
  for (const commit of commits.slice().reverse()) {
    const date = new Date(commit.committerDate * 1000).toISOString().slice(0, 10);
    commitPicker.appendChild(option(commit.hash, `${commit.shortHash} • ${date} • ${commit.subject || '(no subject)'}`));
  }
  renderSelectedCommitChips();
}

function currentFilterQuery() {
  const params = new URLSearchParams();
  const object = $('#object-select').selectedOptions[0];
  params.set('repoId', state.selectedRepoId);
  params.set('path', $('#object-select').value || '/');
  params.set('type', object?.dataset.type || 'directory');
  if ($('#author-select').value) params.set('authorId', $('#author-select').value);
  if ($('#from-date').value) params.set('from', unixFromDate($('#from-date').value));
  if ($('#to-date').value) params.set('to', unixFromDate($('#to-date').value, true));
  const typedCommits = $('#commit-filter').value.split(',').map((v) => v.trim()).filter(Boolean);
  const commits = [...new Set([...state.selectedCommitHashes, ...typedCommits])];
  if (commits.length) params.set('commits', commits.join(','));
  if ($('#object-search')?.value) params.set('objectSearch', $('#object-search').value.trim());
  params.set('limit', String(state.objectLimit));
  params.set('offset', String(state.objectOffset));
  return params;
}

async function loadMetrics() {
  if (!state.selectedRepoId) return;
  state.metrics = await api(`/api/metrics?${currentFilterQuery().toString()}`);
  renderMetrics();
}

function renderMetrics() {
  const data = state.metrics || { summary: {}, objects: [], authors: [], timeline: [] };
  const s = data.summary || {};
  $('#kpi-added').textContent = fmt.format(s.added || 0);
  $('#kpi-removed').textContent = fmt.format(s.removed || 0);
  $('#kpi-growth').textContent = fmt.format(s.growth || 0);
  $('#kpi-churn').textContent = fmt.format(s.churn || 0);
  $('#kpi-mods').textContent = fmt.format(s.modifications || 0);
  $('#kpi-frequency').textContent = pct(s.modificationFrequency || 0);
  $('#commit-count').textContent = `${fmt.format(data.commitCount || 0)} commits in set • ${data.object?.type || 'directory'} ${data.object?.path || '/'}`;
  const shownEnd = Math.min((data.objectOffset || 0) + (data.objects || []).length, data.objectTotal || 0);
  $('#object-page-info').textContent = `${fmt.format((data.objectOffset || 0) + ((data.objects || []).length ? 1 : 0))}-${fmt.format(shownEnd)} of ${fmt.format(data.objectTotal || 0)} objects`;
  $('#prev-objects').disabled = (data.objectOffset || 0) <= 0;
  $('#next-objects').disabled = shownEnd >= (data.objectTotal || 0);
  renderTimeline(data.timeline || []);
  renderObjects(data.objects || []);
  renderAuthors(data.authors || []);
}

function renderTimeline(rows) {
  const el = $('#timeline');
  el.innerHTML = '';
  if (!rows.length) {
    el.innerHTML = '<p class="muted">No timeline data for this filter.</p>';
    return;
  }
  const max = Math.max(...rows.map((r) => r.churn), 1);
  for (const row of rows.slice(-180)) {
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.height = `${Math.max(4, (row.churn / max) * 150)}px`;
    bar.title = `${row.date}: churn ${row.churn}, growth ${row.growth}`;
    el.appendChild(bar);
  }
}

function renderObjects(rows) {
  const tbody = $('#objects-table');
  tbody.innerHTML = '';
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${row.type}</td><td class="path-cell">${row.path}</td><td>${fmt.format(row.added)}</td><td>${fmt.format(row.removed)}</td><td>${fmt.format(row.growth)}</td><td>${fmt.format(row.churn)}</td><td>${fmt.format(row.modifications)}</td><td>${pct(row.modificationFrequency)}</td><td>${fmt.format(row.churnRate.toFixed(2))}</td>`;
    tr.addEventListener('click', async () => {
      $('#object-select').value = row.path;
      const selected = [...$('#object-select').options].find((o) => o.value === row.path && o.dataset.type === row.type);
      if (selected) selected.selected = true;
      await loadMetrics();
    });
    tbody.appendChild(tr);
  }
  if (!rows.length) tbody.innerHTML = '<tr><td colspan="9">No changed objects for this filter.</td></tr>';
}

function renderAuthorAliases(authors) {
  const el = $('#author-aliases');
  if (!el) return;
  el.innerHTML = '';
  const withAliases = authors.filter((author) => (author.aliases || []).length > 1 || (author.aliases || []).some((alias) => alias.source === 'manual'));
  if (!withAliases.length) {
    el.innerHTML = '<p class="muted">No alternate aliases detected yet.</p>';
    return;
  }
  for (const author of withAliases) {
    const item = document.createElement('div');
    item.className = 'alias-item';
    const aliases = (author.aliases || []).map((alias) => `${alias.name} <${alias.email}> (${alias.source})`).join(' • ');
    item.innerHTML = `<strong>${author.name} &lt;${author.email}&gt;</strong><span>${aliases}</span>`;
    el.appendChild(item);
  }
}

function renderSelectedCommitChips() {
  const el = $('#selected-commits');
  if (!el) return;
  el.innerHTML = '';
  const commits = state.repoDetail?.commits || [];
  const lookup = new Map(commits.map((commit) => [commit.hash, commit]));
  for (const hash of state.selectedCommitHashes) {
    const commit = lookup.get(hash);
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = `<span>${commit ? `${commit.shortHash} • ${commit.subject || '(no subject)'}` : hash}</span><button type="button" aria-label="Remove commit">×</button>`;
    chip.querySelector('button').addEventListener('click', async () => {
      state.selectedCommitHashes = state.selectedCommitHashes.filter((item) => item !== hash);
      renderSelectedCommitChips();
      await loadMetrics();
    });
    el.appendChild(chip);
  }
}

function addSelectedCommit(hash) {
  const clean = String(hash || '').trim();
  if (!clean || state.selectedCommitHashes.includes(clean)) return;
  state.selectedCommitHashes.push(clean);
  renderSelectedCommitChips();
}

function renderAuthors(rows) {
  const tbody = $('#authors-table');
  tbody.innerHTML = '';
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${row.name}</td><td>${row.email}</td><td>${fmt.format(row.modifications)}</td><td>${fmt.format(row.churn)}</td><td>${pct(row.ownership)}</td>`;
    tbody.appendChild(tr);
  }
  if (!rows.length) tbody.innerHTML = '<tr><td colspan="5">No author ownership data for this object.</td></tr>';
}

function bindEvents() {
  document.querySelectorAll('.tab').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      button.classList.add('active');
      $(`#${button.dataset.tab}-form`).classList.add('active');
    });
  });

  $('#clone-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    setStatus('Cloning and analyzing. This can take a while for large repositories...');
    try {
      const payload = await api('/api/repos/clone', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: $('#repo-url').value }) });
      state.selectedRepoId = payload.repository.id;
      setStatus('Clone queued. Progress will update automatically.');
      await refreshState();
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  $('#zip-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData();
    const file = $('#zip-file').files[0];
    if (!file) return setStatus('Choose a ZIP file first.', true);
    form.append('repo', file);
    setStatus('Uploading and analyzing ZIP...');
    try {
      const payload = await api('/api/repos/upload', { method: 'POST', body: form });
      state.selectedRepoId = payload.repository.id;
      setStatus('ZIP analysis queued. Progress will update automatically.');
      await refreshState();
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  $('#repo-select').addEventListener('change', (event) => {
    state.selectedCommitHashes = [];
    loadRepository(event.target.value);
  });
  $('#commit-picker').addEventListener('change', async (event) => {
    addSelectedCommit(event.target.value);
    event.target.value = '';
    state.objectOffset = 0;
    await loadMetrics();
  });
  $('#object-search').addEventListener('input', async () => {
    state.objectOffset = 0;
    await loadMetrics();
  });
  $('#prev-objects').addEventListener('click', async () => {
    state.objectOffset = Math.max(0, state.objectOffset - state.objectLimit);
    await loadMetrics();
  });
  $('#next-objects').addEventListener('click', async () => {
    state.objectOffset += state.objectLimit;
    await loadMetrics();
  });
  $('#apply-filters').addEventListener('click', async () => {
    state.objectOffset = 0;
    await loadMetrics();
  });
  $('#clear-filters').addEventListener('click', async () => {
    $('#author-select').value = '';
    $('#object-select').value = '/';
    $('#from-date').value = '';
    $('#to-date').value = '';
    $('#commit-filter').value = '';
    $('#object-search').value = '';
    state.selectedCommitHashes = [];
    state.objectOffset = 0;
    renderSelectedCommitChips();
    await loadMetrics();
  });

  $('#merge-authors').addEventListener('click', async () => {
    const targetAuthorId = $('#merge-target').value;
    const sourceAuthorIds = [...$('#merge-sources').selectedOptions].map((o) => o.value).filter((id) => id && id !== targetAuthorId);
    if (!targetAuthorId || !sourceAuthorIds.length) return setStatus('Choose a target and at least one different source author.', true);
    try {
      await api('/api/authors/merge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repoId: state.selectedRepoId, targetAuthorId, sourceAuthorIds }) });
      setStatus('Authors merged and metrics updated.');
      await loadRepository(state.selectedRepoId);
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  $('#reset-authors').addEventListener('click', async () => {
    if (!state.selectedRepoId) return setStatus('Select a repository first.', true);
    try {
      await api('/api/authors/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repoId: state.selectedRepoId }) });
      setStatus('Author merges reset queued. Progress will update automatically.');
      await refreshState();
    } catch (error) {
      setStatus(error.message, true);
    }
  });
}

bindEvents();
refreshState().catch((error) => setStatus(error.message, true));
setInterval(() => {
  const hasActiveJob = state.repositories.some((repo) => ['queued', 'analyzing'].includes(repo.status));
  if (hasActiveJob) refreshState().catch((error) => setStatus(error.message, true));
}, 1500);
