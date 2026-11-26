// Remote Admin (Amiibo Companion), served at /amiibo-companion/admin/: runs and monitors the data tools, reviews their pull
// requests, and edits the catalogue, always through pull requests (merging stays a
// separate, deliberate step). Talks to api.github.com with the token you enter; it holds
// no data or secrets of its own.
//
// Tools are listed in TOOLS below; a new tool (a GitHub workflow that saves its report on
// the tool-reports branch) only needs an entry there.
'use strict';

const API = 'https://api.github.com';
const CDN = 'https://oddbolt.github.io/amiibo-cdn';
const REPORTS_BRANCH = 'tool-reports';
const PROVENANCE = 'meta/provenance.json';
const PLACEHOLDER_IMAGE = 'images/placeholder.webp';

/**
 * The tools this dashboard runs. `reports: true` tools save a report per run under
 * <id>/ on the tool-reports branch; `branch` is the pull request branch they open;
 * `sections` names the lists in their report, in display order.
 */
const TOOLS = [
  {
    id: 'snm',
    name: 'SNM',
    title: 'SNM · Search New Model',
    description: 'Finds amiibo we don’t have yet: AmiiboAPI and amiibo life first, Nintendo’s sites when those aren’t enough. Opens a pull request with the new amiibo.',
    workflow: 'snm.yml',
    reports: true,
    branch: 'snm/update',
    schedule: 'Runs Tuesdays',
    options: [{ key: 'nintendo', label: 'Nintendo sites', values: ['auto', 'always', 'never'], help: 'auto = only when the databases aren’t enough' }],
    sections: { added: 'New amiibo', promoted: 'Temporary ids replaced', ambiguous: 'Same name as more than one (not added)', unmatched: 'Not added', filled: 'Filled', conflicts: 'Sources disagree (not applied)' },
    summary: (counts) => `${counts.added ?? 0} new`,
  },
  {
    id: 'db-update',
    name: 'Update Database',
    title: 'Update Database',
    description: 'Improves amiibo we already have from AmiiboAPI and amiibo life: fills empty fields and missing pictures, replaces guesses, fixes release dates both agree on. Never touches your edits.',
    workflow: 'update-db.yml',
    reports: true,
    branch: 'db-update/update',
    schedule: 'Runs when you start it',
    options: [],
    sections: { changes: 'Changes', disagreements: 'One source disagrees (not changed)', kept: 'Your edits kept', notMatched: 'Same name, different series (not used)' },
    summary: (counts) => `${counts.changes ?? 0} changes`,
  },
  {
    id: 'weekly',
    name: 'Weekly update',
    title: 'Weekly update',
    description: 'Checks every store link, saves the results, then publishes.',
    workflow: 'update-data.yml',
    schedule: 'Runs Mondays',
  },
  {
    id: 'publish',
    name: 'Publish',
    title: 'Publish',
    description: 'Checks the data and puts it online for the app. Runs by itself after every merge.',
    workflow: 'publish.yml',
    schedule: 'Runs after every change',
  },
  {
    id: 'links',
    name: 'Store links model',
    title: 'Store links model',
    description: 'Planned: finds, checks and updates store and affiliate links, as pull requests.',
    planned: true,
  },
];
const toolById = (id) => TOOLS.find((tool) => tool.id === id);
const toolForBranch = (ref) => TOOLS.find((tool) => tool.branch && ref === tool.branch);
const EDITABLE = ['name', 'character', 'gameSeries', 'amiiboSeries', 'type', 'imageFallback'];
const REGIONS = ['na', 'eu', 'jp', 'au'];

const state = { token: '', repo: '', user: null, catalogue: null, provenance: null, tab: 'home' };
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

function pill(text, kind) {
  return h('span', { class: `pill ${kind || ''}` }, text);
}

function link(text, href) {
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
}

function view(...children) {
  const el = $('#view');
  el.replaceChildren(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
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
    let sha;
    try {
      sha = (await gh(repoPath(`/contents/${file.path}?ref=${encodeURIComponent(branch)}`))).sha;
    } catch (error) {
      if (error.status !== 404) throw error; // a new file
    }
    await gh(repoPath(`/contents/${file.path}`), {
      method: 'PUT',
      body: { message: title, content: utf8ToBase64(file.text), branch, ...(sha ? { sha } : {}) },
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
    fileJson(PROVENANCE).catch(() => null),
  ]);
  state.catalogue = catalogue;
  state.provenance = provenance || {};
  return catalogue;
}

/**
 * Provenance with these fields marked as set by hand, so the tools leave them alone.
 * Returns the file to add to a pull request.
 */
async function manualProvenanceFile(id, fields, previousId = null) {
  const provenance = (await fileJson(PROVENANCE).catch(() => null)) || {};
  if (previousId && provenance[previousId]) {
    provenance[id] = { ...provenance[previousId], ...(provenance[id] || {}) };
    delete provenance[previousId];
  }
  provenance[id] ??= {};
  for (const field of fields) {
    provenance[id][field] = { source: 'manual', url: null, retrievedAt: new Date().toISOString(), run: `dashboard:${state.user.login}` };
  }
  return { path: PROVENANCE, text: `${JSON.stringify(provenance, null, 2)}\n` };
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

// The token lives in memory only. "Remember" saves it encrypted (AES-GCM, key from your
// passphrase via PBKDF2), so other pages on this site, which share its storage, can't use it.
const VAULT_KEY = 'admin.vault';
const IDLE_LOCK_MS = 30 * 60 * 1000;

const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function vaultKey(passphrase, salt) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function saveVault(token, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await vaultKey(passphrase, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(token));
  storage('local')?.setItem(VAULT_KEY, JSON.stringify({ v: 1, salt: b64(salt), iv: b64(iv), ct: b64(ct) }));
}

async function openVault(passphrase) {
  const vault = JSON.parse(storage('local')?.getItem(VAULT_KEY) || 'null');
  if (!vault) throw new Error('Nothing saved on this device.');
  const key = await vaultKey(passphrase, unb64(vault.salt));
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(vault.iv) }, key, unb64(vault.ct));
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error('Wrong passphrase.');
  }
}

function forgetVault() {
  storage('local')?.removeItem(VAULT_KEY);
}

async function signIn(token, repo) {
  state.token = token;
  state.repo = repo;
  const [user, info] = await Promise.all([gh('/user'), gh(repoPath())]);
  if (!info.private) throw new Error('That repository is public. This dashboard is for the private data repository.');
  if (!info.permissions?.push) throw new Error('This token cannot write to the repository.');
  state.user = user;
  storage('local')?.setItem('admin.repo', repo);
  $('#signin').hidden = true;
  $('#unlock').hidden = true;
  $('#tabs').hidden = false;
  $('#signout').hidden = false;
  startIdleLock();
  showTab(location.hash.slice(1) || 'home');
}

/** Forgets the token in memory after 30 minutes without use; the saved, encrypted copy stays. */
function startIdleLock() {
  let timer;
  const reset = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.token = '';
      location.reload();
    }, IDLE_LOCK_MS);
  };
  for (const event of ['pointerdown', 'keydown', 'scroll']) window.addEventListener(event, reset, { passive: true });
  reset();
}

function signOut() {
  forgetVault();
  state.token = '';
  state.catalogue = null;
  location.hash = '';
  location.reload();
}

// ─── Tabs ───────────────────────────────────────────────────────────

const TABS = { home: showHome, tools: showTools, review: showReview, catalogue: showCatalogue, history: showHistory };

function showTab(name, ...args) {
  const [tab, ...rest] = name.split('/');
  if (args.length === 0 && rest.length) args = rest.map((part) => decodeURIComponent(part));
  if (!TABS[tab]) return showTab('home');
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

const stat = (label, value, note) =>
  h('div', { class: 'card stat' }, h('div', { class: 'muted small' }, label), h('div', { class: 'value' }, value), note ? h('div', { class: 'small muted' }, note) : null);

function runPill(run) {
  if (!run) return pill('never run');
  const result = run.conclusion || run.status;
  return pill(result, result === 'success' ? 'ok' : result === 'failure' ? 'error' : 'warn');
}

/** Latest GitHub run of each tool's workflow. */
function lastRuns(runs) {
  const byFile = new Map();
  for (const run of runs) {
    const file = run.path?.split('/').pop();
    if (file && !byFile.has(file)) byFile.set(file, run);
  }
  return byFile;
}

// ─── Home ───────────────────────────────────────────────────────────

async function showHome() {
  loading();
  const reportTools = TOOLS.filter((tool) => tool.reports);
  const [pulls, runs, issues, published, ...latest] = await Promise.all([
    gh(repoPath('/pulls?state=open&per_page=30')),
    gh(repoPath('/actions/runs?per_page=40')),
    gh(repoPath('/issues?state=open&per_page=30')),
    fetch(`${CDN}/data/catalogue.json`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ...reportTools.map((tool) => fileJson(`${tool.id}/latest.json`, REPORTS_BRANCH).catch(() => null)),
  ]);
  const latestById = Object.fromEntries(reportTools.map((tool, index) => [tool.id, latest[index]]));
  const openIssues = issues.filter((issue) => !issue.pull_request);
  const byFile = lastRuns(runs.workflow_runs);

  const toolCard = (tool) => {
    const run = tool.workflow ? byFile.get(tool.workflow) : null;
    const report = latestById[tool.id];
    const counts = report ? Object.fromEntries(Object.entries(report.sections || {}).map(([key, list]) => [key, list.length])) : {};
    const waiting = tool.branch ? pulls.find((pr) => pr.head.ref === tool.branch) : null;
    return h('div', { class: `card tool${tool.planned ? ' planned' : ''}` },
      h('div', { class: 'row spread' }, h('h2', {}, tool.title), tool.planned ? pill('planned') : runPill(run)),
      h('p', { class: 'small muted' }, tool.description),
      tool.planned ? null : h('p', { class: 'small' },
        report ? `Last report: ${tool.summary(counts)} · ${when(report.startedAt)}${report.dryRun ? ' · dry run' : ''}` : run ? `Last run ${when(run.created_at)}` : 'Not run yet',
        tool.schedule ? ` · ${tool.schedule}` : ''),
      waiting ? h('p', { class: 'small warn' }, `Pull request #${waiting.number} is waiting for review`) : null,
      tool.planned ? null : h('div', { class: 'row' },
        tool.reports
          ? [h('button', { type: 'button', onclick: () => showTab(`tools/${tool.id}`) }, 'Open'),
             h('button', { type: 'button', class: 'ghost', onclick: () => runTool(tool, true) }, 'Dry run')]
          : h('button', { type: 'button', class: 'ghost', onclick: () => runTool(tool, false) }, `Run ${tool.name.toLowerCase()}`),
        run ? link('Last log', run.html_url) : null));
  };

  view(
    h('div', { class: 'grid' },
      stat('Published amiibo', published ? String(published.amiibo.length) : '?', published ? `Data from ${when(published.generatedAt)}` : 'Couldn’t read the public data'),
      stat('Waiting for review', String(pulls.length), pulls.length ? 'See Review' : 'Nothing to merge'),
      stat('Open issues', String(openIssues.length), openIssues.length ? 'Listed below' : 'All clear'),
    ),
    h('h3', {}, 'Tools'),
    h('div', { class: 'tool-grid' }, TOOLS.map(toolCard)),
    openIssues.length
      ? h('div', { class: 'card' }, h('h2', {}, 'Open issues'),
          h('ul', { class: 'list' }, openIssues.map((issue) =>
            h('li', { class: 'row spread' }, h('span', {}, `#${issue.number} ${issue.title}`), link('Open', issue.html_url)))))
      : null,
    h('div', { class: 'card' }, h('h2', {}, 'Recent workflow runs'), runsTable(runs.workflow_runs.slice(0, 12))),
  );
}

function runsTable(runs) {
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Workflow'), h('th', {}, 'Result'), h('th', {}, 'Started'), h('th', {}, ''))),
    h('tbody', {}, runs.map((run) =>
      h('tr', {}, h('td', {}, run.name), h('td', {}, runPill(run)), h('td', { class: 'small muted' }, when(run.created_at)), h('td', {}, link('Log', run.html_url)))))));
}

/** Starts a tool's workflow. Report tools ask dry run vs pull request; options as chosen. */
async function runTool(tool, dryRun, options = {}) {
  const body = tool.reports
    ? dryRun
      ? 'It reads the sources and saves a report. Nothing in the data changes.'
      : 'If it finds anything, it opens or updates its pull request. Nothing changes until you merge it.'
    : 'It runs on GitHub with its usual checks.';
  const title = tool.reports ? `${tool.name}: ${dryRun ? 'dry run' : 'run and open a pull request'}?` : `Run ${tool.name}?`;
  if (!(await confirmDialog(title, body, 'Run'))) return;
  const inputs = tool.reports ? { dry_run: dryRun ? 'true' : 'false', ...options } : {};
  try {
    await dispatch(tool.workflow, inputs);
    toast(`${tool.name} started.${tool.reports ? ' Its report appears under Tools when it finishes.' : ''}`);
  } catch (error) {
    toast(`Couldn’t start ${tool.name}: ${error.message}`, true);
  }
}

// ─── Tools ──────────────────────────────────────────────────────────

async function showTools(toolId, kind, runId) {
  if (!toolId) {
    view(h('div', { class: 'tool-grid' }, TOOLS.map((tool) =>
      h('div', { class: `card tool${tool.planned ? ' planned' : ''}` },
        h('div', { class: 'row spread' }, h('h2', {}, tool.title), tool.planned ? pill('planned') : null),
        h('p', { class: 'small muted' }, tool.description),
        tool.planned ? null : h('button', { type: 'button', onclick: () => (tool.reports ? showTab(`tools/${tool.id}`) : runTool(tool, false)) }, tool.reports ? 'Open' : `Run ${tool.name.toLowerCase()}`)))));
    return;
  }
  const tool = toolById(toolId);
  if (!tool || !tool.reports) return showTab('tools');
  if (kind === 'run' && runId) return showRun(tool, runId);
  loading();
  const [index, runs] = await Promise.all([
    fileJson(`${tool.id}/index.json`, REPORTS_BRANCH).catch(() => null),
    gh(repoPath(`/actions/workflows/${tool.workflow}/runs?per_page=5`)).catch(() => ({ workflow_runs: [] })),
  ]);
  const list = index || [];
  const selects = {};
  const optionControls = (tool.options || []).map((option) => {
    selects[option.key] = h('select', {}, option.values.map((value) => h('option', { value }, value)));
    return h('label', {}, `${option.label} (${option.help})`, selects[option.key]);
  });
  const chosen = () => Object.fromEntries(Object.entries(selects).map(([key, select]) => [key, select.value]));
  const sectionKeys = Object.keys(tool.sections);
  const usedKeys = sectionKeys.filter((key) => list.some((run) => (run.counts?.[key] ?? 0) > 0) || ['added', 'changes'].includes(key));
  view(
    h('div', { class: 'card stack' },
      h('div', { class: 'row spread' }, h('h2', {}, tool.title), h('button', { type: 'button', class: 'ghost', onclick: () => showTab('tools') }, 'All tools')),
      h('p', { class: 'small muted' }, tool.description),
      optionControls.length ? h('div', { class: 'fields' }, optionControls) : null,
      h('div', { class: 'row' },
        h('button', { type: 'button', onclick: () => runTool(tool, true, chosen()) }, 'Dry run'),
        h('button', { type: 'button', class: 'ghost', onclick: () => runTool(tool, false, chosen()) }, 'Run and open PR'),
        list.length ? h('button', { type: 'button', class: 'ghost', onclick: () => exportRuns(tool, list) }, 'Export recent runs') : null)),
    runs.workflow_runs.length ? h('div', { class: 'card' }, h('h2', {}, 'On GitHub'), runsTable(runs.workflow_runs)) : null,
    h('div', { class: 'card table-wrap' },
      h('h2', {}, 'Reports'),
      list.length === 0
        ? h('p', { class: 'muted' }, 'No runs yet.')
        : h('table', {},
            h('thead', {}, h('tr', {}, h('th', {}, 'Started'), h('th', {}, 'Kind'), ...usedKeys.map((key) => h('th', {}, tool.sections[key])), h('th', {}, 'Errors'), h('th', {}, 'Guard'))),
            h('tbody', {}, list.map((run) =>
              h('tr', { class: 'clickable', onclick: () => showTab(`tools/${tool.id}/run/${run.runId}`) },
                h('td', {}, when(run.startedAt)),
                h('td', {}, run.dryRun ? pill('dry run') : pill('PR', 'ok')),
                ...usedKeys.map((key) => h('td', {}, String(run.counts?.[key] ?? 0))),
                h('td', {}, run.errors ? pill(String(run.errors), 'warn') : '0'),
                h('td', {}, pill(run.guard, run.guard === 'success' ? 'ok' : 'error'))))))),
  );
}

// ─── Review (open pull requests) ───────────────────────────────────

async function showReview() {
  loading();
  const pulls = await gh(repoPath('/pulls?state=open&per_page=30'));
  if (pulls.length === 0) {
    view(h('div', { class: 'card' }, h('h2', {}, 'Nothing to review'), h('p', { class: 'muted' }, 'The tools and your own catalogue edits open pull requests here.')));
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
  const guardRun = await latestGuardRun(pr.head.sha).catch(() => null);
  if (guardRun && !checks.check_runs.some((run) => /guard/i.test(run.name))) {
    const result = guardRun.status === 'completed' ? guardRun.conclusion : guardRun.status;
    checkPills.unshift(pill(`Guard: ${result}`, result === 'success' ? 'ok' : result === 'failure' ? 'error' : 'warn'));
  }
  const tool = toolForBranch(pr.head.ref);
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
  if (tool?.reports) {
    const runId = (pr.body || '').match(/\brun (\d+|local-\d+)/)?.[1];
    const report = runId ? await fileJson(`${tool.id}/reports/${runId}.json`, REPORTS_BRANCH).catch(() => null) : null;
    guardOutcome = report?.guard?.outcome ?? null;
    if (report) card.append(await reportDetails(tool, report, pr.head.ref));
    else card.append(h('pre', {}, pr.body || ''));
  } else {
    card.append(h('pre', {}, pr.body || '(no description)'));
  }
  const files = await gh(repoPath(`/pulls/${pr.number}/files?per_page=100`));
  if (files.some((file) => file.filename === 'data/catalogue.json')) {
    const holder = h('div');
    const button = h('button', {
      type: 'button',
      class: 'ghost',
      onclick: async () => {
        button.disabled = true;
        button.textContent = 'Loading preview…';
        try {
          holder.replaceChildren(await appPreview(pr.head.ref));
          button.remove();
        } catch (error) {
          button.disabled = false;
          button.textContent = 'Preview in the app';
          toast(`Couldn’t build the preview: ${error.message}`, true);
        }
      },
    }, 'Preview in the app');
    card.append(h('h3', {}, 'Preview'), button, holder);
  }
  card.append(
    h('h3', {}, `Files (${files.length})`),
    h('ul', { class: 'list small' }, files.slice(0, 30).map((file) =>
      h('li', {}, `${file.status} ${file.filename} (+${file.additions} −${file.deletions})`))),
    h('div', { class: 'row' },
      h('button', { type: 'button', onclick: () => mergePr(pr, files, guardOutcome) }, 'Merge'),
      h('button', { type: 'button', class: 'ghost', onclick: () => closePr(pr) }, 'Close without merging')),
  );
  return card;
}

/** Files the Guard protects: a pull request touching any of them must pass it to be merged here. */
const GUARDED_PATH = /^(data|images|meta)\//;

/**
 * Newest Guard workflow run for a commit, or null if none has started. Read through the
 * Actions API, which the dashboard token can use (the checks API needs a Checks permission).
 * Adding a label re-runs the Guard, so the newest run is the one that counts.
 */
async function latestGuardRun(sha) {
  const data = await gh(repoPath(`/actions/workflows/guard.yml/runs?head_sha=${encodeURIComponent(sha)}&per_page=20`));
  return data.workflow_runs.sort((a, b) => b.id - a.id)[0] || null;
}

/**
 * Merges only when the Guard has passed. Fails closed: a data pull request with no Guard
 * result yet (the check hasn't started, or a tool's report is missing) isn't merged.
 */
async function mergePr(pr, files, toolGuardOutcome) {
  // Read now, not when the card was drawn: the Guard may have finished (or re-run) since.
  let guardRun;
  try {
    guardRun = await latestGuardRun(pr.head.sha);
  } catch (error) {
    return toast(`Couldn’t read the Guard check: ${error.message}`, true);
  }
  const checkRuns = (await gh(repoPath(`/commits/${pr.head.sha}/check-runs?per_page=100`)).catch(() => null))?.check_runs || [];
  const tool = toolForBranch(pr.head.ref);
  // 100 = the most the files list returns, so there may be data files beyond it.
  const touchesData = files.length >= 100 || files.some((file) => GUARDED_PATH.test(file.filename));

  // The tools open their pull requests as GitHub Actions, which doesn't start the Guard
  // workflow, so they run the Guard themselves and their report has the result.
  const results = [];
  if (tool?.reports) results.push(toolGuardOutcome || 'no report');
  if (guardRun) results.push(guardRun.status === 'completed' ? guardRun.conclusion : 'running');
  if (touchesData && results.length === 0) results.push('not started');

  if (results.includes('no report')) {
    return toast('Couldn’t find the report for this run, so the Guard result is unknown. Review it on GitHub.', true);
  }
  if (results.some((result) => !['success', 'running', 'not started'].includes(result))) {
    return toast('The Guard check failed for this pull request, so the dashboard won’t merge it. Review it on GitHub.', true);
  }
  if (results.includes('running') || results.includes('not started')) {
    return toast(`The Guard check ${results.includes('running') ? 'is still running' : 'hasn’t started yet'}. Try again in a minute.`, true);
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

// ─── App preview ────────────────────────────────────────────────────

const APP_REGIONS = [['na', 'North America'], ['eu', 'Europe'], ['jp', 'Japan'], ['au', 'Australia']];

/** Formats YYYY-MM-DD like the app does ("Dec 4, 2025"), or "Not released". */
function appDate(date) {
  if (!date) return 'Not released';
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/**
 * How the amiibo a pull request adds or changes will look in the app: Discover-style
 * tiles, and the detail page when one is tapped. Uses the PR's own data and images.
 */
async function appPreview(ref) {
  const [proposed, current] = await Promise.all([fileJson('data/catalogue.json', ref), loadCatalogue(true)]);
  const before = new Map(current.amiibo.map((entry) => [entry.id, entry]));
  const aliasOf = new Map();
  for (const entry of current.amiibo) for (const alias of entry.aliases || []) aliasOf.set(alias, entry.id);
  const items = [];
  for (const entry of proposed.amiibo) {
    const old = before.get(entry.id) || (entry.aliases || []).map((alias) => before.get(alias)).find(Boolean);
    if (!old) items.push({ entry, kind: 'New', changes: [] });
    else {
      const changes = describeDiff(old, entry);
      if (old.id !== entry.id) changes.unshift(`id: ${old.id} → ${entry.id}`);
      if (changes.length) items.push({ entry, kind: 'Changed', changes });
    }
  }
  const removed = current.amiibo.filter((entry) => !proposed.amiibo.some((p) => p.id === entry.id || (p.aliases || []).includes(entry.id)));
  if (!items.length && !removed.length) return h('p', { class: 'muted small' }, 'No amiibo are added or changed by this pull request.');

  // Images: the PR's own file first (not published yet), then its fallback URL.
  const imageFor = async (entry) => {
    const img = h('img', { class: 'app-image', alt: entry.name });
    try {
      const blob = await gh(repoPath(`/contents/${entry.image}?ref=${encodeURIComponent(ref)}`), { accept: 'application/vnd.github.raw+json', as: 'blob' });
      img.src = URL.createObjectURL(blob);
    } catch {
      if (entry.imageFallback) img.src = entry.imageFallback;
      else img.alt = 'No image';
    }
    return img;
  };
  const images = new Map(await Promise.all(items.map(async (item) => [item.entry.id, await imageFor(item.entry)])));

  const phone = h('div', { class: 'phone' });
  const showGrid = () => {
    phone.replaceChildren(
      h('div', { class: 'app-title' }, 'Discover'),
      h('div', { class: 'app-sub' }, `${items.length} amiibo in this pull request${removed.length ? ` · ${removed.length} removed` : ''}`),
      h('div', { class: 'app-grid' }, items.map((item) =>
        h('button', { type: 'button', class: 'app-tile', onclick: () => showDetail(item) },
          h('div', { class: 'app-tile-image' }, images.get(item.entry.id).cloneNode(), h('span', { class: `app-badge ${item.kind === 'New' ? 'new' : 'changed'}` }, item.kind), h('span', { class: 'app-add' }, '+')),
          h('div', { class: 'app-tile-name' }, item.entry.name),
          h('div', { class: 'app-tile-series' }, item.entry.amiiboSeries)))),
      ...(removed.length ? [h('div', { class: 'app-removed' }, `Removed: ${removed.map((entry) => entry.name).join(', ')}`)] : []),
    );
  };
  const row = (label, value) => h('div', { class: 'app-row' }, h('span', {}, label), h('span', {}, value));
  const showDetail = (item) => {
    const { entry } = item;
    phone.replaceChildren(
      h('button', { type: 'button', class: 'app-back', onclick: showGrid }, '‹ Discover'),
      h('div', { class: 'app-hero' }, images.get(entry.id).cloneNode()),
      h('div', { class: 'app-name' }, entry.name),
      h('div', { class: 'app-sub' }, `${entry.amiiboSeries} · ${entry.type}`),
      h('div', { class: 'app-actions' }, h('span', { class: 'app-primary' }, 'Add to collection'), h('span', { class: 'app-heart' }, '♡')),
      h('div', { class: 'app-section' }, 'DETAILS'),
      h('div', { class: 'app-card' },
        row('Character', entry.character), row('amiibo series', entry.amiiboSeries), row('Game series', entry.gameSeries), row('Type', entry.type)),
      h('div', { class: 'app-section' }, 'RELEASE DATES'),
      h('div', { class: 'app-card' }, APP_REGIONS.map(([key, label]) => row(label, appDate(entry.release[key])))),
      h('div', { class: 'app-note' },
        entry.id.startsWith('ob-') ? `Temporary id ${entry.id} (real id not known yet)` : `id ${entry.id}`,
        item.changes.length ? h('div', {}, `Changes: ${item.changes.join('; ')}`) : null),
    );
  };
  showGrid();
  return h('div', { class: 'stack' },
    h('p', { class: 'small muted' }, 'Roughly how these look in the app (dark theme). Tap a tile for its page. Nothing is live until you merge.'),
    phone);
}

// ─── Reports ────────────────────────────────────────────────────────

async function showRun(tool, runId) {
  loading();
  const report = await fileJson(`${tool.id}/reports/${runId}.json`, REPORTS_BRANCH);
  if (!report) throw new Error('Report not found.');
  view(
    h('div', { class: 'card stack' },
      h('div', { class: 'row spread' },
        h('h2', {}, `${tool.name} run · ${when(report.startedAt)}`),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'ghost', onclick: () => showTab(`tools/${tool.id}`) }, `All ${tool.name} runs`),
          report.runUrl ? link('Log on GitHub', report.runUrl) : null)),
      h('div', { class: 'row' },
        h('button', { type: 'button', onclick: () => copyText(reportToText(tool, report)) }, 'Copy as text'),
        h('button', { type: 'button', class: 'ghost', onclick: () => download(`${tool.id}-run-${report.runId}.txt`, reportToText(tool, report), 'text/plain') }, 'Download .txt'),
        h('button', { type: 'button', class: 'ghost', onclick: () => download(`${tool.id}-run-${report.runId}.json`, JSON.stringify(report, null, 2), 'application/json') }, 'Download .json')),
      h('p', { class: 'muted small' }, `${report.dryRun ? 'Dry run' : 'Pull request run'} · guard ${report.guard?.outcome || '?'}`),
      await reportDetails(tool, report, null)),
  );
}

/** One line of text for any report item (new amiibo, change, disagreement, …). */
function itemText(item) {
  if (typeof item === 'string') return item;
  if (item.from !== undefined && item.to !== undefined && item.field) return `${item.name} | ${item.id} | ${item.field}: ${item.from ?? '(empty)'} → ${item.to} | ${item.source}${item.why ? `; ${item.why}` : ''}`;
  if (item.from && item.to) return `${item.name}: ${item.from} → ${item.to}`;
  if (item.ours !== undefined) return `${item.name} | ${item.id} | ${item.field}: ours ${item.ours}, ${item.source} says ${item.theirs}${item.url ? ` | ${item.url}` : ''}`;
  if (item.value !== undefined && item.field) return `${item.name} | ${item.id} | ${item.field} = ${item.value} | ${item.source}`;
  if (item.amiiboSeries && item.id) return `${item.name} | ${item.amiiboSeries} | ${item.id} | ${item.releaseDate || 'no date'} | ${item.image === 'placeholder' ? 'placeholder picture' : 'picture'}${item.sources ? ` | from ${item.sources.join(', ')}` : ''}${item.url ? ` | ${item.url}` : ''}${item.guessed?.length ? ` | check: ${item.guessed.join('; ')}` : ''}`;
  return `${item.name}${item.series ? ` | ${item.series}` : ''}${item.releaseDate ? ` | ${item.releaseDate}` : ''} | ${item.reason || ''}${item.url ? ` | ${item.url}` : ''}`;
}

/** The whole report as plain text: every item, the guard result and the run log. */
function reportToText(tool, report) {
  const lines = [
    `${tool.title} run ${report.runId}`,
    `Started: ${report.startedAt}  Finished: ${report.finishedAt || '?'}`,
    `Kind: ${report.dryRun ? 'dry run' : 'pull request run'}  Guard: ${report.guard?.outcome || '?'}`,
    report.runUrl ? `Log: ${report.runUrl}` : '',
    '',
    'SOURCES',
    ...Object.entries(report.sources || {}).map(([name, s]) => `  ${name}: ${s.read} read, ${s.failed} failed${s.note ? ` (${s.note})` : ''}`),
  ];
  for (const [key, items] of Object.entries(report.sections || {})) {
    lines.push('', `${(tool.sections[key] || key).toUpperCase()} (${items.length})`);
    for (const item of items) lines.push(`  - ${itemText(item)}`);
  }
  lines.push('', `ERRORS (${(report.errors || []).length})`, ...(report.errors || []).map((e) => `  - ${e}`));
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

async function exportRuns(tool, index) {
  const recent = index.slice(0, 10);
  toast(`Collecting ${recent.length} reports…`);
  try {
    const reports = await Promise.all(recent.map((run) => fileJson(`${tool.id}/reports/${run.runId}.json`, REPORTS_BRANCH).catch(() => null)));
    const text = reports.filter(Boolean).map((report) => reportToText(tool, report)).join(`\n${'='.repeat(72)}\n\n`);
    download(`${tool.id}-runs-${new Date().toISOString().slice(0, 10)}.txt`, text, 'text/plain');
  } catch (error) {
    toast(`Couldn’t export: ${error.message}`, true);
  }
}

/** Sources table, then each section of the report, errors, guard and log. */
async function reportDetails(tool, report, prBranch) {
  const wrap = h('div', { class: 'stack' });
  wrap.append(h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, ...['Source', 'Read', 'Failed', 'Note'].map((t) => h('th', {}, t)))),
    h('tbody', {}, Object.entries(report.sources || {}).map(([name, s]) =>
      h('tr', {}, h('td', {}, name), h('td', {}, String(s.read)), h('td', {}, s.failed ? pill(String(s.failed), 'warn') : '0'), h('td', { class: 'small muted' }, s.note || '')))))));

  const sections = report.sections || {};
  const order = [...Object.keys(tool.sections), ...Object.keys(sections).filter((key) => !(key in tool.sections))];
  for (const key of order) {
    const items = sections[key] || [];
    if (!items.length) continue;
    const title = `${tool.sections[key] || key} (${items.length})`;
    if (key === 'added') {
      wrap.append(h('h3', {}, title));
      const list = h('ul', { class: 'list' });
      for (const item of items) {
        const img = prBranch
          ? await repoImage(item.image === 'placeholder' ? PLACEHOLDER_IMAGE : item.id.startsWith('ob-') ? `images/amiibo/${item.id}.webp` : `images/amiibo/${item.id.slice(0, 8)}-${item.id.slice(8)}.webp`, prBranch, item.name)
          : h('span', {});
        list.append(h('li', { class: 'row' }, img,
          h('div', {},
            h('strong', {}, item.name), ` (${item.amiiboSeries}) `, h('code', {}, item.id),
            h('div', { class: 'small muted' }, `${item.releaseDate || 'no date'} · ${item.image === 'placeholder' ? 'placeholder picture' : 'picture'}${item.sources ? ` · from ${item.sources.join(', ')}` : ''} `, item.url ? link('page', item.url) : null),
            item.guessed?.length ? h('div', { class: 'small warn' }, `Check: ${item.guessed.join('; ')}`) : null)));
      }
      wrap.append(list);
    } else {
      wrap.append(h('h3', {}, title), h('ul', { class: 'list small' }, items.slice(0, 400).map((item) =>
        h('li', {}, itemText(item).replace(/ \| https:\S+$/, ''), item.url ? [' ', link('page', item.url)] : null))));
    }
  }
  if (report.errors?.length) wrap.append(h('h3', {}, `Errors (${report.errors.length})`), h('ul', { class: 'list small' }, report.errors.map((e) => h('li', { class: 'error' }, e))));
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
        field('imageFallback', 'Image URL (optional, https; otherwise the placeholder until Update Database finds one)'),
        ...REGIONS.map((r) => field(`release.${r}`, `Release ${r.toUpperCase()} (YYYY-MM-DD)`))),
      h('button', { type: 'button', onclick: () => addEntry(inputs, type.value) }, 'Propose this amiibo')),
  );
}

async function addEntry(inputs, type) {
  const value = (key) => inputs[key].value.trim();
  const problems = [];
  for (const key of ['name', 'character', 'amiiboSeries', 'gameSeries']) if (!value(key)) problems.push(`${key} is required.`);
  if (value('imageFallback') && !/^https:\/\/\S+$/.test(value('imageFallback'))) problems.push('Image URL must start with https://.');
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
        image: PLACEHOLDER_IMAGE, imageFallback: value('imageFallback') || null, release, source: 'oddbolt',
      });
      copy.amiibo.sort((a, b) => a.id.localeCompare(b.id));
    });
    const pr = await proposeChange({
      branch: `admin/add-${id}-${stamp()}`,
      title: `Add ${name}`,
      body: `Added in the dashboard by @${state.user.login} as \`${id}\`. It shows the placeholder picture until Update Database downloads ${value('imageFallback') ? 'the image URL given' : 'one from AmiiboAPI or amiibo life'}.`,
      files: [
        { path: 'data/catalogue.json', text: catalogueText(catalogue) },
        await manualProvenanceFile(id, ['name', 'character', 'gameSeries', 'amiiboSeries', 'type', ...REGIONS.filter((r) => release[r]).map((r) => `release.${r}`)]),
      ],
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
      body: `Edited in the dashboard by @${state.user.login}.\n\n${diff.map((line) => `- ${line}`).join('\n')}\n\nThese fields are marked as yours, so the tools won't change them.`,
      files: [
        { path: 'data/catalogue.json', text: catalogueText(catalogue) },
        await manualProvenanceFile(entry.id, diff.map((line) => line.split(':')[0])),
      ],
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
      files: [{ path: 'data/catalogue.json', text: catalogueText(catalogue) }, await manualProvenanceFile(realId, ['id'], entry.id)],
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

/** Shorter passphrases can be guessed offline from a copied vault, even with PBKDF2. */
const MIN_PASSPHRASE = 12;

function start() {
  // Refuse to run inside a frame (another site could trick clicks such as Merge) or in a
  // window another page opened: that page keeps a handle on this one and, if it's on
  // oddbolt.github.io too, could read the token after you unlock. Links opened in a new
  // tab don't count (browsers open them without that handle).
  if (window.top !== window.self || window.opener) {
    $('#framed').hidden = false;
    return;
  }
  // Older versions saved the token in plain text; remove it.
  for (const kind of ['local', 'session']) storage(kind)?.removeItem('admin.token');

  $('#repo').value = storage('local')?.getItem('admin.repo') || '';
  for (const button of document.querySelectorAll('#tabs button')) {
    button.addEventListener('click', () => showTab(button.dataset.tab));
  }
  $('#signout').addEventListener('click', signOut);
  $('#remember').addEventListener('change', () => ($('#new-passphrase-row').hidden = !$('#remember').checked));

  const submit = async () => {
    const token = $('#token').value.trim();
    const repo = $('#repo').value.trim();
    const remember = $('#remember').checked;
    const passphrase = $('#new-passphrase').value;
    $('#signin-error').textContent = '';
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return ($('#signin-error').textContent = 'Enter the repository as owner/name.');
    if (!token) return ($('#signin-error').textContent = 'Enter a token.');
    if (remember && passphrase.length < MIN_PASSPHRASE) return ($('#signin-error').textContent = `Choose a passphrase of at least ${MIN_PASSPHRASE} characters (a few words works well).`);
    try {
      await signIn(token, repo);
      if (remember) await saveVault(token, passphrase);
      $('#token').value = '';
      $('#new-passphrase').value = '';
    } catch (error) {
      state.token = '';
      $('#signin-error').textContent = error.status === 401 ? 'GitHub rejected the token.' : error.status === 404 ? 'Repository not found, or the token can’t see it.' : String(error.message || error);
    }
  };
  $('#signin-button').addEventListener('click', submit);
  $('#token').addEventListener('keydown', (event) => event.key === 'Enter' && submit());

  const unlock = async () => {
    $('#unlock-error').textContent = '';
    $('#unlock-button').disabled = true;
    try {
      const passphrase = $('#passphrase').value;
      const token = await openVault(passphrase);
      $('#passphrase').value = '';
      await signIn(token, storage('local')?.getItem('admin.repo') || '');
      if (passphrase.length < MIN_PASSPHRASE) {
        toast(`Your passphrase is under ${MIN_PASSPHRASE} characters, which can be guessed offline. Sign out, then sign in with “Remember” and a longer one.`, true);
      }
    } catch (error) {
      state.token = '';
      $('#unlock-error').textContent = error.status === 401 ? 'GitHub rejected the saved token (expired?). Use a different token.' : String(error.message || error);
    } finally {
      $('#unlock-button').disabled = false;
    }
  };
  $('#unlock-button').addEventListener('click', unlock);
  $('#passphrase').addEventListener('keydown', (event) => event.key === 'Enter' && unlock());
  $('#forget-button').addEventListener('click', () => {
    forgetVault();
    $('#unlock').hidden = true;
    $('#signin').hidden = false;
  });

  window.addEventListener('hashchange', () => {
    if (state.token && location.hash.slice(1) !== currentHash) showTab(location.hash.slice(1) || 'home');
  });

  const hasVault = Boolean(storage('local')?.getItem(VAULT_KEY)) && Boolean(storage('local')?.getItem('admin.repo'));
  $(hasVault ? '#unlock' : '#signin').hidden = false;
  if (hasVault) $('#passphrase').focus();
}
start();
