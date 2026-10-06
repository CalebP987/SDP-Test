# Repo Analysis Tool (RAT)

A dependency-free Node.js web dashboard for analyzing Git repositories. It implements the COMS3011A test brief requirements: repository ingestion, multi-repository support, author merging, filtering, and metrics for files, directories, repositories, commit sets, and authors.

## Features

- Remote repository ingestion with a full `git clone` in a background worker.
- ZIP upload ingestion for archives containing a `.git` file or directory.
- Multiple repository support with persistent JSON storage.
- `.mailmap` author normalization through `git check-mailmap`.
- Manual author merging in the dashboard, alias display, and reset/rebuild of manual merges.
- Filters by repository, author, file/directory object, date range, and manually selected commits.
- Large-repo friendly commit selection: the picker shows the latest 500 commits and manual hash entry supports any full or short commit hash.
- File metrics: added lines, removed lines, growth, and churn.
- Directory and repository metrics using root/directory rollups.
- Commit set metrics: added, removed, growth, churn, modifications, modification frequency, and churn rate.
- Author metrics: modifications, churn, and ownership.
- Dashboard visualizations: KPI cards, timeline bars, searchable/paginated hotspots, and author ownership.
- Cached metric responses for repeated dashboard/filter requests, invalidated after analysis rebuilds or author merges.

## Requirements

- Node.js 18+
- Git CLI
- `unzip` CLI for ZIP uploads

No npm dependencies are required.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Test

```bash
npm test
```

The tests create temporary Git repositories and verify parser behavior, file/root metrics, commit-set aggregation, author ownership, and `.mailmap` merging.

## How metrics are computed

For every non-merge commit reachable from the selected reference, RAT compares the commit to its first parent. The initial commit is compared to Git’s empty tree. File changes are extracted with:

```bash
git diff --numstat -M50% <parent> <commit>
```

This matches the brief’s requirements for 50% rename detection. Binary files are ignored when Git reports `-` for added/removed lines.

- Added lines: lines added for an object.
- Removed lines: lines removed for an object.
- Growth: added minus removed.
- Churn: added plus removed.
- Modifications: number of commits in the selected commit set with churn greater than zero for the object.
- Modification frequency: modifications divided by selected commit count.
- Churn rate: churn divided by selected commit count.
- Author ownership: author churn divided by total object churn.

Directory and repository metrics are precomputed by rolling each changed file up through its parent directories. The root directory `/` represents repository-level metrics.

## Suggested validation repositories

Use the public repositories listed in the brief:

- cJSON: `https://github.com/DaveGamble/cJSON.git`
- Redis: `https://github.com/redis/redis.git`
- Git: `https://github.com/git/git.git`

Large repositories can take time because the tool intentionally performs a full-history analysis for metric correctness.

## Project structure

```text
src/gitAnalyzer.js     Core Git analysis and metric formulas
src/analysisWorker.js Background clone/upload analysis worker
src/server.js          HTTP server, API routes, ingestion, persistence
public/index.html      Dashboard markup
public/styles.css   Dashboard styling
public/app.js       Browser-side API and rendering logic
test/               Node test suite
```

## Notes for submission

- Submit the URL to a public repository containing this project.
- The app does not require GitHub CLI.
- Generated analysis data is stored under `data/` at runtime and should not be committed.
