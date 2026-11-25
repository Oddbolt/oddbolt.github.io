// Data Admin: monitors SNM and the data repository, and makes changes only as pull
// requests (merging stays a separate, deliberate step). Talks to api.github.com with the
// token you enter; it holds no data or secrets of its own.
'use strict';

const API = 'https://api.github.com';
const CDN = 'https://oddbolt.github.io/amiibo-cdn';
const REPORTS_BRANCH = 'snm-reports';
const EDITABLE = ['name', 'character', 'gameSeries', 'amiiboSeries', 'type', 'imageFallback'];
const REGIONS = ['na', 'eu', 'jp', 'au'];

const state = { token: '', repo: '', user: null, catalogue: null, provenance: null, tab: 'overview' };
let currentHash = '';

// ─── Small helpers ──────────────────────────────────────────────────

const $ = (selector) => document.querySelector(selector);

/** Creates an element. Text children are always set as text, never parsed as HTML. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'href' || key === 'src') {
      if (/^(https:|blob:|data:image\/)/.test(String(value))) el.setAttribute(key, value);
    } else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.style.background = isError ? 'var(--danger)' : '';
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), isError ? 7000 : 3500);
}

function when(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  return isNaN(date) ? iso : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function storage(kind) {
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}
function getStored(key) {
  return storage('session')?.getItem(key) || storage('local')?.getItem(key) || '';
}

function pill(text, kind) {
  return h('span', { class: `pill ${kind || ''}` }, text);
}

function link(text, href) {
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
}

function view(...children) {
  const el = $('#view');
  el.replaceChildren(...children);
  return el;
}

function loading(text = 'Loading…') {
  view(h('p', { class: 'muted' }, text));
}

/** Asks for confirmation in a dialog. Resolves true only on the confirm button. */
function confirmDialog(title, body, confirmLabel = 'Confirm', danger = false) {
  return new Promise((resolve) => {
    const dialog = h('dialog', {},
      h('h2', {}, title),
      ...[].concat(body).map((line) => (line instanceof Node ? line : h('p', {}, line))),
      h('div', { class: 'row end' }),
    );
    const done = (value) => {
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    dialog.lastChild.append(
      h('button', { type: 'button', class: 'ghost', onclick: () => done(false) }, 'Cancel'),
      h('button', { type: 'button', class: danger ? 'danger' : '', onclick: () => done(true) }, confirmLabel),
    );
    dialog.addEventListener('cancel', () => done(false));
    document.body.append(dialog);
    dialog.showModal();
  });
}

// ─── GitHub API ─────────────────────────────────────────────────────

async function gh(path, options = {}) {
  const response = await fetch(path.startsWith('https://') ? path : `${API}${path}`, {
    method: options.method || 'GET',
    headers: {
      authorization: `Bearer ${state.token}`,
      accept: options.accept || 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    cache: 'no-store',
  });
  if (response.status === 204) return null;
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const data = await response.json();
      if (data.message) message = `${data.message} (${response.status})`;
    } catch {
      // Keep the status text.
    }
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  if (options.as === 'blob') return response.blob();
  if (options.as === 'text') return response.text();
  return response.json();
}

const repoPath = (suffix = '') => `/repos/${state.repo}${suffix}`;

/** A file's text at a ref, or null if it doesn't exist. */
async function fileText(path, ref = 'main') {
  try {
    return await gh(repoPath(`/contents/${path}?ref=${encodeURIComponent(ref)}`), {
      accept: 'application/vnd.github.raw+json',
      as: 'text',
    });
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function fileJson(path, ref = 'main') {
  const text = await fileText(path, ref);
  return text === null ? null : JSON.parse(text);
}

function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function ensureLabel(name, color, description) {
  try {
    await gh(repoPath(`/labels/${encodeURIComponent(name)}`));
  } catch (error) {
    if (error.status !== 404) throw error;
    await gh(repoPath('/labels'), { method: 'POST', body: { name, color, description } });
  }
}

/**
 * Proposes file changes as a pull request: new branch from main, one commit per file,
 * then the PR. Nothing reaches main until it's merged (after the Guard check).
 */
async function proposeChange({ branch, title, body, files, labels = [] }) {
  const main = await gh(repoPath('/git/ref/heads/main'));
  await gh(repoPath('/git/refs'), {
    method: 'POST',
    body: { ref: `refs/heads/${branch}`, sha: main.object.sha },
  });
  for (const file of files) {
    const current = await gh(repoPath(`/contents/${file.path}?ref=${encodeURIComponent(branch)}`));
    await gh(repoPath(`/contents/${file.path}`), {
      method: 'PUT',
      body: { message: title, content: utf8ToBase64(file.text), sha: current.sha, branch },
    });
  }
  const pr = await gh(repoPath('/pulls'), {
    method: 'POST',
    body: { title, head: branch, base: 'main', body },
  });
  for (const label of labels) {
    await ensureLabel(label, 'b7791f', 'Lets the Guard check accept this kind of change');
  }
  if (labels.length) {
    await gh(repoPath(`/issues/${pr.number}/labels`), { method: 'POST', body: { labels } });
  }
  return pr;
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
}

/** The catalogue as the data files store it: 2-space JSON with a trailing newline. */
function catalogueText(catalogue) {
  return `${JSON.stringify(catalogue, null, 2)}\n`;
}

async function loadCatalogue(force = false) {
  if (state.catalogue && !force) return state.catalogue;
  const [catalogue, provenance] = await Promise.all([
    fileJson('data/catalogue.json'),
    fileJson('snm/provenance.json').catch(() => null),
  ]);
  state.catalogue = catalogue;
  state.provenance = provenance || {};
  return catalogue;
}

function imageUrl(entry) {
  if (!entry.image) return entry.imageFallback || '';
  return /^https:/.test(entry.image) ? entry.image : `${CDN}/${entry.image}`;
}

function amiiboImage(entry, className = 'thumb') {
  const img = h('img', { class: className, alt: entry.name, loading: 'lazy', src: imageUrl(entry) });
  img.addEventListener('error', () => {
    if (entry.imageFallback && img.src !== entry.imageFallback) img.src = entry.imageFallback;
  }, { once: true });
  return img;
}

/** An image straight from the repo at a ref (for amiibo not published yet). */
async function repoImage(path, ref, alt) {
  const img = h('img', { class: 'thumb', alt });
  try {
    const blob = await gh(repoPath(`/contents/${path}?ref=${encodeURIComponent(ref)}`), {
      accept: 'application/vnd.github.raw+json',
      as: 'blob',
    });
    img.src = URL.createObjectURL(blob);
  } catch {
    img.alt = 'no image';
  }
  return img;
}

async function dispatch(workflow, inputs = {}) {
  await gh(repoPath(`/actions/workflows/${workflow}/dispatches`), {
    method: 'POST',
    body: { ref: 'main', inputs },
  });
}

// ─── Sign in ────────────────────────────────────────────────────────

async function signIn(token, repo, remember) {
  state.token = token;
  state.repo = repo;
  const [user, info] = await Promise.all([gh('/user'), gh(repoPath())]);
  if (!info.private) throw new Error('That repository is public. This dashboard is for the private data repository.');
  if (!info.permissions?.push) throw new Error('This token cannot write to the repository.');
  state.user = user;
  storage('local')?.setItem('admin.repo', repo);
  const store = storage(remember ? 'local' : 'session');
  store?.setItem('admin.token', token);
  $('#signin').hidden = true;
  $('#tabs').hidden = false;
  $('#signout').hidden = false;
  showTab(location.hash.slice(1) || 'overview');
}

function signOut() {
  storage('local')?.removeItem('admin.token');
  storage('session')?.removeItem('admin.token');
  state.token = '';
  state.catalogue = null;
  location.hash = '';
  location.reload();
}

// ─── Tabs ───────────────────────────────────────────────────────────

const TABS = { overview: showOverview, review: showReview, runs: showRuns, catalogue: showCatalogue, history: showHistory };

function showTab(name, ...args) {
  const [tab, ...rest] = name.split('/');
  if (args.length === 0 && rest.length) args = [decodeURIComponent(rest.join('/'))];
  if (!TABS[tab]) return showTab('overview');
  state.tab = tab;
  for (const button of document.querySelectorAll('#tabs button')) {
    button.classList.toggle('active', button.dataset.tab === tab);
  }
  currentHash = name;
  if (location.hash.slice(1) !== name) history.replaceState(null, '', `#${name}`);
  Promise.resolve(TABS[tab](...args)).catch((error) => {
    view(h('div', { class: 'card' }, h('p', { class: 'error' }, String(error.message || error))));
  });
}

// ─── Overview ───────────────────────────────────────────────────────

async function showOverview() {
  loading();
  const [latest, pulls, runs, issues, published] = await Promise.all([
    fileJson('latest.json', REPORTS_BRANCH).catch(() => null),
    gh(repoPath('/pulls?state=open&per_page=20')),
    gh(repoPath('/actions/runs?per_page=12')),
    gh(repoPath('/issues?state=open&per_page=20')),
    fetch(`${CDN}/data/catalogue.json`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  const openIssues = issues.filter((issue) => !issue.pull_request);
  const stat = (label, value, note) =>
    h('div', { class: 'card stat' }, h('div', { class: 'muted small' }, label), h('div', { class: 'value' }, value), note ? h('div', { class: 'small muted' }, note) : null);

  const runRows = runs.workflow_runs.map((run) =>
    h('tr', {},
      h('td', {}, run.name),
      h('td', {}, pill(run.conclusion || run.status, run.conclusion === 'success' ? 'ok' : run.conclusion === 'failure' ? 'error' : 'warn')),
      h('td', { class: 'small muted' }, when(run.created_at)),
      h('td', {}, link('Log', run.html_url)),
    ),
  );

  view(
    h('div', { class: 'grid' },
      stat('Published amiibo', published ? String(published.amiibo.length) : '?', published ? `Data from ${when(published.generatedAt)}` : 'Couldn’t read the public data'),
      stat('Last SNM run', latest ? `${latest.added.length} new · ${latest.filled.length} filled` : 'None yet',
        latest ? `${when(latest.startedAt)}${latest.dryRun ? ' · dry run' : ''} · guard ${latest.guard?.outcome || '?'}` : 'Run it from the Runs tab'),
      stat('Waiting for review', String(pulls.length), pulls.length ? 'See the Review tab' : 'Nothing to merge'),
      stat('Open issues', String(openIssues.length), openIssues.length ? 'Failures and reports below' : 'All clear'),
    ),
    h('div', { class: 'card' },
      h('div', { class: 'row spread' }, h('h2', {}, 'Actions'), null),
      h('div', { class: 'row' },
        h('button', { type: 'button', onclick: () => runSnm(true) }, 'Run SNM (dry run)'),
        h('button', { type: 'button', class: 'ghost', onclick: () => runSnm(false) }, 'Run SNM and open PR'),
        h('button', { type: 'button', class: 'ghost', onclick: () => runWorkflow('publish.yml', 'Publish') }, 'Publish now'),
        h('button', { type: 'button', class: 'ghost', onclick: () => runWorkflow('update-data.yml', 'Weekly update') }, 'Run weekly update'),
      ),
    ),
    openIssues.length
      ? h('div', { class: 'card' }, h('h2', {}, 'Open issues'),
          h('ul', { class: 'list' }, openIssues.map((issue) =>
            h('li', { class: 'row spread' }, h('span', {}, `#${issue.number} ${issue.title}`), link('Open', issue.html_url)))))
      : null,
    h('div', { class: 'card' }, h('h2', {}, 'Recent workflow runs'),
      h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Workflow'), h('th', {}, 'Result'), h('th', {}, 'Started'), h('th', {}, ''))), h('tbody', {}, runRows)))),
  );
}

async function runSnm(dryRun) {
  const ok = await confirmDialog(
    dryRun ? 'Run SNM as a dry run?' : 'Run SNM and open a pull request?',
    dryRun
      ? 'It reads the sources and saves a report. Nothing in the data changes.'
      : 'It reads the sources and, if it finds anything, opens or updates the SNM pull request. Nothing changes until you merge it.',
    'Run',
  );
  if (!ok) return;
  try {
    await dispatch('snm.yml', { dry_run: dryRun ? 'true' : 'false' });
    toast('SNM started. Its report appears in Runs when it finishes (a few minutes).');
  } catch (error) {
    toast(`Couldn’t start SNM: ${error.message}`, true);
  }
}

async function runWorkflow(file, label) {
  if (!(await confirmDialog(`Run ${label}?`, 'It runs on GitHub with its usual checks.', 'Run'))) return;
  try {
    await dispatch(file);
    toast(`${label} started.`);
  } catch (error) {
    toast(`Couldn’t start ${label}: ${error.message}`, true);
  }
}

// ─── Review (open pull requests) ───────────────────────────────────

async function showReview() {
  loading();
  const pulls = await gh(repoPath('/pulls?state=open&per_page=30'));
  if (pulls.length === 0) {
    view(h('div', { class: 'card' }, h('h2', {}, 'Nothing to review'), h('p', { class: 'muted' }, 'SNM, the weekly sync and your own edits open pull requests here.')));
    return;
  }
  const cards = await Promise.all(pulls.map(reviewCard));
  view(...cards);
}

async function reviewCard(pr) {
  const card = h('div', { class: 'card stack' });
  const checks = await gh(repoPath(`/commits/${pr.head.sha}/check-runs`)).catch(() => ({ check_runs: [] }));
  const checkPills = checks.check_runs.map((run) =>
    pill(`${run.name}: ${run.conclusion || run.status}`, run.conclusion === 'success' ? 'ok' : run.conclusion === 'failure' ? 'error' : 'warn'));
  const isSnm = pr.head.ref === 'snm/update';
  card.append(
    h('div', { class: 'row spread' },
      h('h2', {}, `#${pr.number} ${pr.title}`),
      link('Open on GitHub', pr.html_url)),
    h('div', { class: 'row small muted' },
      `${pr.head.ref} · ${when(pr.updated_at)}`,
      ...pr.labels.map((label) => pill(label.name)),
      ...checkPills),
  );
  let guardOutcome = null;
  if (isSnm) {
    const runId = (pr.body || '').match(/SNM run (\S+)/)?.[1];
    const report = runId ? await fileJson(`reports/${runId}.json`, REPORTS_BRANCH).catch(() => null) : null;
    guardOutcome = report?.guard?.outcome ?? null;
    if (report) card.append(await reportDetails(report, pr.head.ref));
    else card.append(h('pre', {}, pr.body || ''));
  } else {
    card.append(h('pre', {}, pr.body || '(no description)'));
  }
  const files = await gh(repoPath(`/pulls/${pr.number}/files?per_page=100`));
  card.append(
    h('h3', {}, `Files (${files.length})`),
    h('ul', { class: 'list small' }, files.slice(0, 30).map((file) =>
      h('li', {}, `${file.status} ${file.filename} (+${file.additions} −${file.deletions})`))),
    h('div', { class: 'row' },
      h('button', { type: 'button', onclick: () => mergePr(pr, checks.check_runs, guardOutcome) }, 'Merge'),
      h('button', { type: 'button', class: 'ghost', onclick: () => closePr(pr) }, 'Close without merging')),
  );
  return card;
}

async function mergePr(pr, checkRuns, guardOutcome) {
  const guardRun = checkRuns.find((run) => /guard/i.test(run.name));
  if (guardRun?.conclusion === 'failure' || (guardOutcome && guardOutcome !== 'success')) {
    return toast('The Guard check failed for this pull request, so the dashboard won’t merge it. Review it on GitHub.', true);
  }
  if (guardRun && !guardRun.conclusion) {
    return toast('The Guard check is still running. Try again in a minute.', true);
  }
  const failing = checkRuns.filter((run) => run.conclusion === 'failure');
  const pending = checkRuns.filter((run) => !run.conclusion);
  const notes = [`Merging publishes the data to the app (Publish runs its checks first).`];
  if (failing.length) notes.push(h('p', { class: 'error' }, `Failing checks: ${failing.map((run) => run.name).join(', ')}. GitHub may refuse the merge.`));
  if (pending.length) notes.push(h('p', { class: 'warn' }, `Still running: ${pending.map((run) => run.name).join(', ')}.`));
  if (!(await confirmDialog(`Merge #${pr.number}?`, notes, 'Merge'))) return;
  try {
    await gh(repoPath(`/pulls/${pr.number}/merge`), { method: 'PUT', body: { merge_method: 'squash', sha: pr.head.sha } });
    state.catalogue = null;
    toast(`Merged #${pr.number}. Publish is running.`);
    showTab('review');
  } catch (error) {
    toast(`Couldn’t merge: ${error.message}`, true);
  }
}

async function closePr(pr) {
  if (!(await confirmDialog(`Close #${pr.number}?`, 'The proposal is dropped. Nothing in the data changes.', 'Close PR'))) return;
  try {
    await gh(repoPath(`/pulls/${pr.number}`), { method: 'PATCH', body: { state: 'closed' } });
    toast(`Closed #${pr.number}.`);
    showTab('review');
  } catch (error) {
    toast(`Couldn’t close: ${error.message}`, true);
  }
}

// ─── Runs (SNM reports) ────────────────────────────────────────────

async function showRuns(runId) {
  if (runId) return showRun(runId);
  loading();
  const index = (await fileJson('index.json', REPORTS_BRANCH).catch(() => null)) || [];
  const rows = index.map((run) =>
    h('tr', { class: 'clickable', onclick: () => showTab(`runs/${run.runId}`, run.runId) },
      h('td', {}, when(run.startedAt)),
      h('td', {}, run.dryRun ? pill('dry run') : pill('PR', 'ok')),
      h('td', {}, String(run.added)),
      h('td', {}, String(run.filled)),
      h('td', {}, String(run.conflicts)),
      h('td', {}, run.errors ? pill(String(run.errors), 'warn') : '0'),
      h('td', {}, pill(run.guard, run.guard === 'success' ? 'ok' : 'error')),
    ));
  view(
    h('div', { class: 'card row spread' },
      h('div', {}, h('h2', {}, 'SNM runs'), h('p', { class: 'muted small' }, 'Every run saves a report, including dry runs.')),
      h('div', { class: 'row' },
        h('button', { type: 'button', onclick: () => runSnm(true) }, 'Dry run now'),
        h('button', { type: 'button', class: 'ghost', onclick: () => runSnm(false) }, 'Run and open PR'),
        index.length ? h('button', { type: 'button', class: 'ghost', onclick: () => exportRuns(index) }, 'Export recent runs') : null)),
    h('div', { class: 'card table-wrap' },
      index.length === 0
        ? h('p', { class: 'muted' }, 'No runs yet.')
        : h('table', {}, h('thead', {}, h('tr', {}, ...['Started', 'Kind', 'New', 'Filled', 'Disagree', 'Errors', 'Guard'].map((t) => h('th', {}, t)))), h('tbody', {}, rows))),
  );
}

async function showRun(runId) {
  loading();
  const report = await fileJson(`reports/${runId}.json`, REPORTS_BRANCH);
  if (!report) throw new Error('Report not found.');
  view(
    h('div', { class: 'card stack' },
      h('div', { class: 'row spread' },
        h('h2', {}, `SNM run ${when(report.startedAt)}`),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'ghost', onclick: () => showTab('runs') }, 'All runs'),
          report.runUrl ? link('Log on GitHub', report.runUrl) : null)),
      h('div', { class: 'row' },
        h('button', { type: 'button', onclick: () => copyText(reportToText(report)) }, 'Copy as text'),
        h('button', { type: 'button', class: 'ghost', onclick: () => download(`snm-run-${report.runId}.txt`, reportToText(report), 'text/plain') }, 'Download .txt'),
        h('button', { type: 'button', class: 'ghost', onclick: () => download(`snm-run-${report.runId}.json`, JSON.stringify(report, null, 2), 'application/json') }, 'Download .json')),
      h('p', { class: 'muted small' }, `${report.dryRun ? 'Dry run' : 'Pull request run'} · guard ${report.guard?.outcome || '?'}`),
      await reportDetails(report, null)),
  );
}

// ─── Export ─────────────────────────────────────────────────────────

/** The whole report as plain text: every item, the guard result and the run log. */
function reportToText(report) {
  const lines = [
    `SNM run ${report.runId}`,
    `Started: ${report.startedAt}  Finished: ${report.finishedAt || '?'}`,
    `Kind: ${report.dryRun ? 'dry run' : 'pull request run'}  Guard: ${report.guard?.outcome || '?'}`,
    report.runUrl ? `Log: ${report.runUrl}` : '',
    '',
    'SOURCES',
    ...Object.entries(report.sources || {}).map(([name, s]) => `  ${name}: ${s.pages} pages, ${s.read} read, ${s.failed} failed`),
  ];
  const section = (title, items, render) => {
    lines.push('', `${title} (${items.length})`);
    for (const item of items) lines.push(`  - ${render(item)}`);
  };
  section('NEW AMIIBO', report.added || [], (a) =>
    `${a.name} | ${a.amiiboSeries} | ${a.id} | ${a.releaseDate || 'no date'} | image ${a.image} | ${a.url}${a.guessed?.length ? ` | check: ${a.guessed.join('; ')}` : ''}`);
  section('FILLED', report.filled || [], (f) => `${f.name} | ${f.id} | ${f.field} = ${f.value} | ${f.source}${f.url ? ` | ${f.url}` : ''}`);
  section('SOURCES DISAGREE (not applied)', report.conflicts || [], (c) => `${c.name} | ${c.id} | ${c.field}: ours ${c.ours}, ${c.source} says ${c.theirs}${c.url ? ` | ${c.url}` : ''}`);
  section('MATCHED MORE THAN ONE (not applied)', report.ambiguous || [], (u) => `${u.name} | ${u.reason} | ${u.url}`);
  section('NOT MATCHED (not applied)', report.unmatched || [], (u) => `${u.name}${u.series ? ` | ${u.series}` : ''} | ${u.releaseDate || 'no date'} | ${u.reason} | ${u.url}`);
  section('ERRORS', report.errors || [], (e) => e);
  if (report.guard?.report) lines.push('', 'GUARD', report.guard.report);
  if (report.log?.length) lines.push('', 'RUN LOG', ...report.log);
  return `${lines.join('\n')}\n`;
}

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied. Paste it into the chat.');
  } catch {
    toast('Couldn’t copy here. Use Download .txt instead.', true);
  }
}

async function exportRuns(index) {
  const recent = index.slice(0, 10);
  toast(`Collecting ${recent.length} reports…`);
  try {
    const reports = await Promise.all(recent.map((run) => fileJson(`reports/${run.runId}.json`, REPORTS_BRANCH).catch(() => null)));
    const text = reports.filter(Boolean).map(reportToText).join(`\n${'='.repeat(72)}\n\n`);
    download(`snm-runs-${new Date().toISOString().slice(0, 10)}.txt`, text, 'text/plain');
  } catch (error) {
    toast(`Couldn’t export: ${error.message}`, true);
  }
}

/** Sources table, new amiibo, fills, disagreements, unmatched, errors. */
async function reportDetails(report, prBranch) {
  const wrap = h('div', { class: 'stack' });
  wrap.append(h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, ...['Source', 'Pages', 'Read', 'Failed'].map((t) => h('th', {}, t)))),
    h('tbody', {}, Object.entries(report.sources || {}).map(([name, s]) =>
      h('tr', {}, h('td', {}, name), h('td', {}, String(s.pages)), h('td', {}, String(s.read)), h('td', {}, s.failed ? pill(String(s.failed), 'warn') : '0')))))));

  if (report.added.length) {
    wrap.append(h('h3', {}, `New amiibo (${report.added.length})`));
    const list = h('ul', { class: 'list' });
    for (const item of report.added) {
      const img = prBranch
        ? await repoImage(`images/amiibo/${item.id}.webp`, prBranch, item.name)
        : h('span', {});
      list.append(h('li', { class: 'row' }, img,
        h('div', {},
          h('strong', {}, item.name), ` (${item.amiiboSeries}) `, h('code', {}, item.id),
          h('div', { class: 'small muted' }, `${item.releaseDate || 'no date'} · image ${item.image} · `, link('page', item.url)),
          item.guessed.length ? h('div', { class: 'small warn' }, `Check: ${item.guessed.join('; ')}`) : null)));
    }
    wrap.append(list);
  }
  const simpleList = (title, items, render) => {
    if (!items.length) return;
    wrap.append(h('h3', {}, `${title} (${items.length})`), h('ul', { class: 'list small' }, items.slice(0, 300).map((item) => h('li', {}, render(item)))));
  };
  simpleList('Filled empty fields', report.filled, (f) => [`${f.name} `, h('code', {}, f.id), ` ${f.field} = ${f.value} (${f.source})`]);
  simpleList('Sources disagree (not applied)', report.conflicts, (c) => [`${c.name} `, h('code', {}, c.id), ` ${c.field}: ours ${c.ours}, ${c.source} says ${c.theirs} `, c.url ? link('page', c.url) : null]);
  simpleList('Matched more than one (not applied)', report.ambiguous, (u) => [`${u.name}: ${u.reason} `, link('page', u.url)]);
  simpleList('Not matched (not applied)', report.unmatched, (u) => [`${u.name}${u.series ? ` (${u.series})` : ''}: ${u.reason} `, link('page', u.url)]);
  simpleList('Errors', report.errors, (e) => h('span', { class: 'error' }, e));
  if (report.guard?.report) wrap.append(h('h3', {}, 'Guard'), h('pre', {}, report.guard.report));
  if (report.log?.length && !prBranch) wrap.append(h('h3', {}, 'Run log'), h('pre', {}, report.log.join('\n')));
  return wrap;
}

// ─── Catalogue (view, edit, promote) ───────────────────────────────

async function showCatalogue(id) {
  loading('Loading the catalogue…');
  const catalogue = await loadCatalogue();
  if (id === 'new') return showNewEntry();
  if (id) return showEntry(decodeURIComponent(id));
  const search = h('input', { type: 'search', placeholder: 'Search name, id, series…', autocomplete: 'off' });
  const filter = h('select', {},
    h('option', { value: '' }, 'All'),
    h('option', { value: 'snm' }, 'Added by SNM'),
    h('option', { value: 'temp' }, 'Temporary ids'),
    h('option', { value: 'missing' }, 'Missing dates'));
  const body = h('tbody');
  const count = h('span', { class: 'muted small' });
  const render = () => {
    const q = search.value.trim().toLowerCase();
    const matches = catalogue.amiibo.filter((entry) => {
      if (filter.value === 'snm' && entry.source !== 'snm') return false;
      if (filter.value === 'temp' && !entry.id.startsWith('ob-')) return false;
      if (filter.value === 'missing' && REGIONS.every((r) => entry.release[r])) return false;
      if (!q) return true;
      return `${entry.name} ${entry.id} ${entry.amiiboSeries} ${entry.gameSeries} ${entry.character}`.toLowerCase().includes(q);
    });
    count.textContent = `${matches.length} of ${catalogue.amiibo.length}`;
    body.replaceChildren(...matches.slice(0, 200).map((entry) =>
      h('tr', { class: 'clickable', onclick: () => showTab(`catalogue/${encodeURIComponent(entry.id)}`, entry.id) },
        h('td', {}, amiiboImage(entry)),
        h('td', {}, h('strong', {}, entry.name), h('div', { class: 'small muted' }, `${entry.amiiboSeries} · ${entry.type}`)),
        h('td', {}, h('code', {}, entry.id)),
        h('td', { class: 'small' }, REGIONS.map((r) => `${r.toUpperCase()} ${entry.release[r] || '—'}`).join('  ')),
        h('td', {}, pill(entry.source)))));
  };
  search.addEventListener('input', render);
  filter.addEventListener('change', render);
  view(
    h('div', { class: 'card' },
      h('div', { class: 'row' }, h('div', { class: 'grow' }, search), h('div', {}, filter)),
      h('div', { class: 'row spread' }, count,
        h('div', { class: 'row' },
          h('button', { type: 'button', onclick: () => showTab('catalogue/new', 'new') }, 'Add amiibo'),
          h('button', { type: 'button', class: 'ghost', onclick: async () => { state.catalogue = null; showTab('catalogue'); } }, 'Reload')))),
    h('div', { class: 'card table-wrap' }, h('table', {}, h('tbody', {}, body))),
  );
  render();
  search.focus();
}

function showEntry(id) {
  const catalogue = state.catalogue;
  const entry = catalogue.amiibo.find((item) => item.id === id);
  if (!entry) throw new Error(`No amiibo with id ${id}.`);
  const prov = state.provenance[entry.id] || {};
  const inputs = {};
  const field = (key, label, value) => {
    const input = h('input', { value: value ?? '', autocomplete: 'off', spellcheck: 'false' });
    inputs[key] = input;
    const source = prov[key];
    return h('label', {}, label, input,
      source ? h('span', { class: 'small muted' }, `From ${source.source}, ${when(source.retrievedAt)} `, source.url ? link('page', source.url) : null) : null);
  };
  view(
    h('div', { class: 'card' },
      h('div', { class: 'row spread' },
        h('div', { class: 'row' }, amiiboImage(entry, 'big-thumb'),
          h('div', {}, h('h2', {}, entry.name), h('code', {}, entry.id),
            h('div', { class: 'small muted' }, `source: ${entry.source}${entry.aliases?.length ? ` · was ${entry.aliases.join(', ')}` : ''}`))),
        h('button', { type: 'button', class: 'ghost', onclick: () => showTab('catalogue') }, 'Back')),
      h('h3', {}, 'Details'),
      h('div', { class: 'fields' },
        field('name', 'Name', entry.name),
        field('character', 'Character', entry.character),
        field('amiiboSeries', 'amiibo series', entry.amiiboSeries),
        field('gameSeries', 'Game series', entry.gameSeries),
        field('type', 'Type', entry.type),
        field('imageFallback', 'Image fallback URL', entry.imageFallback),
        ...REGIONS.map((r) => field(`release.${r}`, `Release ${r.toUpperCase()} (YYYY-MM-DD)`, entry.release[r]))),
      h('div', { class: 'row' },
        h('button', { type: 'button', onclick: () => saveEntry(entry, inputs) }, 'Propose these changes'),
        entry.id.startsWith('ob-') ? h('button', { type: 'button', class: 'ghost', onclick: () => promoteEntry(entry) }, 'Set real id') : null,
        h('button', { type: 'button', class: 'danger', onclick: () => removeEntry(entry) }, 'Propose removal')),
      h('p', { class: 'small muted' }, 'Changes are opened as a pull request. They go live only after you merge them in Review.')),
  );
}

/** Form for an amiibo SNM couldn't add (no series on the page, not on Nintendo's sites…). */
function showNewEntry() {
  const catalogue = state.catalogue;
  const list = (id, values) => h('datalist', { id }, [...new Set(values)].sort().map((value) => h('option', { value })));
  const inputs = {};
  const field = (key, label, attrs = {}) => {
    inputs[key] = h('input', { autocomplete: 'off', spellcheck: 'false', ...attrs });
    return h('label', {}, label, inputs[key]);
  };
  const type = h('select', {}, ...['Figure', 'Card', 'Band', 'Yarn', 'Block'].map((value) => h('option', { value }, value)));
  view(
    h('div', { class: 'card' },
      h('div', { class: 'row spread' }, h('h2', {}, 'Add amiibo'), h('button', { type: 'button', class: 'ghost', onclick: () => showTab('catalogue') }, 'Back')),
      h('p', { class: 'small muted' }, 'It gets a temporary id (ob-year-number) until its real NFC id is known. Opened as a pull request.'),
      list('series-list', catalogue.amiibo.map((entry) => entry.amiiboSeries)),
      list('game-list', catalogue.amiibo.map((entry) => entry.gameSeries)),
      h('div', { class: 'fields' },
        field('name', 'Name'),
        field('character', 'Character'),
        field('amiiboSeries', 'amiibo series', { list: 'series-list' }),
        field('gameSeries', 'Game series', { list: 'game-list' }),
        h('label', {}, 'Type', type),
        field('imageFallback', 'Image URL (https, e.g. from Nintendo’s page)'),
        ...REGIONS.map((r) => field(`release.${r}`, `Release ${r.toUpperCase()} (YYYY-MM-DD)`))),
      h('button', { type: 'button', onclick: () => addEntry(inputs, type.value) }, 'Propose this amiibo')),
  );
}

async function addEntry(inputs, type) {
  const value = (key) => inputs[key].value.trim();
  const problems = [];
  for (const key of ['name', 'character', 'amiiboSeries', 'gameSeries']) if (!value(key)) problems.push(`${key} is required.`);
  if (!/^https:\/\/\S+$/.test(value('imageFallback'))) problems.push('Image URL must start with https://.');
  const release = {};
  for (const r of REGIONS) {
    const date = value(`release.${r}`);
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) problems.push(`Release ${r.toUpperCase()} must be YYYY-MM-DD.`);
    release[r] = date || null;
  }
  if (problems.length) return toast(problems.join(' '), true);
  const name = value('name');
  if (state.catalogue.amiibo.some((entry) => entry.name.toLowerCase() === name.toLowerCase() && entry.amiiboSeries.toLowerCase() === value('amiiboSeries').toLowerCase())) {
    return toast(`${name} (${value('amiiboSeries')}) is already in the catalogue.`, true);
  }
  const year = (Object.values(release).filter(Boolean).sort()[0] || new Date().toISOString()).slice(0, 4);
  if (!(await confirmDialog(`Add ${name}?`, [`${value('amiiboSeries')} · ${type} · ${REGIONS.map((r) => `${r.toUpperCase()} ${release[r] || '—'}`).join(' ')}`], 'Open pull request'))) return;
  try {
    let id = '';
    const catalogue = await freshCatalogueWith((copy) => {
      const taken = new Set(copy.amiibo.flatMap((entry) => [entry.id, ...(entry.aliases || [])]));
      for (let n = 1; !id; n++) {
        const candidate = `ob-${year}-${String(n).padStart(4, '0')}`;
        if (!taken.has(candidate)) id = candidate;
      }
      copy.amiibo.push({
        id, head: '', tail: '', name,
        character: value('character'), gameSeries: value('gameSeries'), amiiboSeries: value('amiiboSeries'), type,
        image: `images/amiibo/${id}.webp`, imageFallback: value('imageFallback'), release, source: 'oddbolt',
      });
      copy.amiibo.sort((a, b) => a.id.localeCompare(b.id));
    });
    const pr = await proposeChange({
      branch: `admin/add-${id}-${stamp()}`,
      title: `Add ${name}`,
      body: `Added in the dashboard by @${state.user.login} as \`${id}\`. The image is downloaded and converted the next time the weekly update runs.`,
      files: [{ path: 'data/catalogue.json', text: catalogueText(catalogue) }],
    });
    toast(`Opened #${pr.number}. Merge it in Review.`);
    showTab('review');
  } catch (error) {
    toast(`Couldn’t open the pull request: ${error.message}`, true);
  }
}

function readEdits(entry, inputs) {
  const next = structuredClone(entry);
  const problems = [];
  for (const key of EDITABLE) {
    const value = inputs[key].value.trim();
    if (key === 'imageFallback') {
      if (value && !/^https:\/\/\S+$/.test(value)) problems.push('Image fallback must be an https URL.');
      next[key] = value || null;
    } else {
      if (!value) problems.push(`${key} can’t be empty.`);
      next[key] = value;
    }
  }
  for (const r of REGIONS) {
    const value = inputs[`release.${r}`].value.trim();
    if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) problems.push(`Release ${r.toUpperCase()} must be YYYY-MM-DD.`);
    next.release[r] = value || null;
  }
  return { next, problems };
}

function describeDiff(before, after) {
  const lines = [];
  for (const key of EDITABLE) {
    if (before[key] !== after[key]) lines.push(`${key}: ${before[key] ?? '(empty)'} → ${after[key] ?? '(empty)'}`);
  }
  for (const r of REGIONS) {
    if (before.release[r] !== after.release[r]) lines.push(`release.${r}: ${before.release[r] ?? '(empty)'} → ${after.release[r] ?? '(empty)'}`);
  }
  return lines;
}

async function freshCatalogueWith(mutate) {
  // Always edit the latest main, not the copy loaded earlier.
  const catalogue = await loadCatalogue(true);
  const copy = structuredClone(catalogue);
  mutate(copy);
  copy.count = copy.amiibo.length;
  return copy;
}

async function saveEntry(entry, inputs) {
  const { next, problems } = readEdits(entry, inputs);
  if (problems.length) return toast(problems.join(' '), true);
  const diff = describeDiff(entry, next);
  if (!diff.length) return toast('Nothing changed.');
  const changesExisting = diff.some((line) => !line.includes('(empty) →'));
  const removesValue = diff.some((line) => line.endsWith('→ (empty)'));
  const labels = [changesExisting && 'allow-changes', removesValue && 'allow-removals'].filter(Boolean);
  if (!(await confirmDialog(`Propose changes to ${entry.name}?`, [h('pre', {}, diff.join('\n')), labels.length ? `Labels so the Guard accepts it: ${labels.join(', ')}.` : 'Only fills empty fields.'], 'Open pull request'))) return;
  try {
    const catalogue = await freshCatalogueWith((copy) => {
      const index = copy.amiibo.findIndex((item) => item.id === entry.id);
      if (index < 0) throw new Error('That amiibo is no longer in the catalogue.');
      copy.amiibo[index] = { ...copy.amiibo[index], ...Object.fromEntries(EDITABLE.map((k) => [k, next[k]])), release: next.release };
    });
    const pr = await proposeChange({
      branch: `admin/edit-${entry.id}-${stamp()}`,
      title: `Edit ${entry.name}`,
      body: `Edited in the dashboard by @${state.user.login}.\n\n${diff.map((line) => `- ${line}`).join('\n')}`,
      files: [{ path: 'data/catalogue.json', text: catalogueText(catalogue) }],
      labels,
    });
    toast(`Opened #${pr.number}. Merge it in Review.`);
    showTab('review');
  } catch (error) {
    toast(`Couldn’t open the pull request: ${error.message}`, true);
  }
}

async function promoteEntry(entry) {
  const input = h('input', { placeholder: '16 hex characters, e.g. 1f02000004440f02', autocomplete: 'off', spellcheck: 'false' });
  const dialogBody = [h('p', {}, `Replace the temporary id ${entry.id} with the real amiibo id (read from the figure’s NFC chip). Saved copies in the app move over automatically.`), h('label', {}, 'Real id', input)];
  if (!(await confirmDialog(`Set the real id of ${entry.name}`, dialogBody, 'Open pull request'))) return;
  const realId = input.value.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{16}$/.test(realId)) return toast('The id must be 16 hex characters.', true);
  try {
    const catalogue = await freshCatalogueWith((copy) => {
      if (copy.amiibo.some((item) => item.id === realId || (item.aliases || []).includes(realId))) {
        throw new Error(`${realId} is already in the catalogue.`);
      }
      const target = copy.amiibo.find((item) => item.id === entry.id);
      if (!target) throw new Error('That amiibo is no longer in the catalogue.');
      target.aliases = [...new Set([...(target.aliases || []), target.id])];
      target.id = realId;
      target.head = realId.slice(0, 8);
      target.tail = realId.slice(8);
      copy.amiibo.sort((a, b) => a.id.localeCompare(b.id));
    });
    const pr = await proposeChange({
      branch: `admin/promote-${entry.id}-${stamp()}`,
      title: `Real id for ${entry.name}`,
      body: `Set in the dashboard by @${state.user.login}: \`${entry.id}\` → \`${realId}\` (kept as an alias).`,
      files: [{ path: 'data/catalogue.json', text: catalogueText(catalogue) }],
    });
    toast(`Opened #${pr.number}. Merge it in Review.`);
    showTab('review');
  } catch (error) {
    toast(`Couldn’t open the pull request: ${error.message}`, true);
  }
}

async function removeEntry(entry) {
  const links = (await fileJson('data/links.json')) || { links: [] };
  const linked = links.links.filter((item) => item.amiiboId === entry.id);
  const notes = [
    `This removes ${entry.name} (${entry.id}) from the catalogue${linked.length ? ` and its ${linked.length} store link(s)` : ''}. Anyone who owns it in the app would see it disappear.`,
    'It opens a pull request labelled allow-removals. The image file is kept.',
  ];
  if (!(await confirmDialog(`Remove ${entry.name}?`, notes, 'Open removal PR', true))) return;
  try {
    const catalogue = await freshCatalogueWith((copy) => {
      copy.amiibo = copy.amiibo.filter((item) => item.id !== entry.id);
    });
    const files = [{ path: 'data/catalogue.json', text: catalogueText(catalogue) }];
    if (linked.length) {
      links.links = links.links.filter((item) => item.amiiboId !== entry.id);
      files.push({ path: 'data/links.json', text: `${JSON.stringify(links, null, 2)}\n` });
    }
    const pr = await proposeChange({
      branch: `admin/remove-${entry.id}-${stamp()}`,
      title: `Remove ${entry.name}`,
      body: `Removal proposed in the dashboard by @${state.user.login}.`,
      files,
      labels: ['allow-removals'],
    });
    toast(`Opened #${pr.number}. Merge it in Review.`);
    showTab('review');
  } catch (error) {
    toast(`Couldn’t open the pull request: ${error.message}`, true);
  }
}

// ─── History (roll back) ───────────────────────────────────────────

async function showHistory() {
  loading();
  const commits = await gh(repoPath('/commits?sha=main&path=data&per_page=40'));
  view(
    h('div', { class: 'card' }, h('h2', {}, 'Data history'),
      h('p', { class: 'muted small' }, 'Every change to data/ on main, newest first. “Roll back” proposes restoring the data to how it was before that change; it undoes that change and everything after it, as a pull request.')),
    h('div', { class: 'card' }, h('ul', { class: 'list' }, commits.map((commit, index) =>
      h('li', { class: 'row spread' },
        h('div', {},
          h('strong', {}, commit.commit.message.split('\n')[0]),
          h('div', { class: 'small muted' }, `${commit.commit.author?.name || ''} · ${when(commit.commit.author?.date)} · `, h('code', {}, commit.sha.slice(0, 7)))),
        h('div', { class: 'row' },
          link('Diff', commit.html_url),
          h('button', { type: 'button', class: 'ghost', onclick: () => rollBack(commit, commits.slice(0, index + 1)) }, 'Roll back')))))),
  );
}

async function rollBack(commit, undone) {
  const parent = commit.parents[0]?.sha;
  if (!parent) return toast('This is the first commit; there is nothing before it.', true);
  const notes = [
    h('p', {}, `Restores data/catalogue.json and data/links.json to how they were before ${commit.sha.slice(0, 7)}. This undoes:`),
    h('ul', {}, undone.map((c) => h('li', {}, `${c.sha.slice(0, 7)} ${c.commit.message.split('\n')[0]}`))),
    h('p', { class: 'small muted' }, 'Opened as a pull request (labels: allow-changes, allow-removals, allow-large). Images are left as they are.'),
  ];
  if (!(await confirmDialog('Roll back the data?', notes, 'Open rollback PR', true))) return;
  try {
    const files = [];
    for (const path of ['data/catalogue.json', 'data/links.json']) {
      const [before, now] = await Promise.all([fileText(path, parent), fileText(path, 'main')]);
      if (before !== null && before !== now) files.push({ path, text: before });
    }
    if (!files.length) return toast('The data already matches that version.');
    const pr = await proposeChange({
      branch: `admin/rollback-${commit.sha.slice(0, 7)}-${stamp()}`,
      title: `Roll back data to before ${commit.sha.slice(0, 7)}`,
      body: `Rollback proposed in the dashboard by @${state.user.login}. Undoes:\n\n${undone.map((c) => `- ${c.sha.slice(0, 7)} ${c.commit.message.split('\n')[0]}`).join('\n')}`,
      files,
      labels: ['allow-changes', 'allow-removals', 'allow-large'],
    });
    toast(`Opened #${pr.number}. Merge it in Review.`);
    showTab('review');
  } catch (error) {
    toast(`Couldn’t open the pull request: ${error.message}`, true);
  }
}

// ─── Start ──────────────────────────────────────────────────────────

function start() {
  $('#repo').value = storage('local')?.getItem('admin.repo') || '';
  for (const button of document.querySelectorAll('#tabs button')) {
    button.addEventListener('click', () => showTab(button.dataset.tab));
  }
  $('#signout').addEventListener('click', signOut);
  const submit = async () => {
    const token = $('#token').value.trim();
    const repo = $('#repo').value.trim();
    $('#signin-error').textContent = '';
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return ($('#signin-error').textContent = 'Enter the repository as owner/name.');
    if (!token) return ($('#signin-error').textContent = 'Enter a token.');
    try {
      await signIn(token, repo, $('#remember').checked);
      $('#token').value = '';
    } catch (error) {
      state.token = '';
      $('#signin-error').textContent = error.status === 401 ? 'GitHub rejected the token.' : error.status === 404 ? 'Repository not found, or the token can’t see it.' : String(error.message || error);
    }
  };
  $('#signin-button').addEventListener('click', submit);
  $('#token').addEventListener('keydown', (event) => event.key === 'Enter' && submit());
  window.addEventListener('hashchange', () => {
    if (state.token && location.hash.slice(1) !== currentHash) showTab(location.hash.slice(1) || 'overview');
  });

  const saved = getStored('admin.token');
  const repo = storage('local')?.getItem('admin.repo');
  if (saved && repo) {
    signIn(saved, repo, Boolean(storage('local')?.getItem('admin.token'))).catch(() => {
      storage('local')?.removeItem('admin.token');
      storage('session')?.removeItem('admin.token');
      $('#signin').hidden = false;
    });
    $('#signin').hidden = true;
  }
}

start();
