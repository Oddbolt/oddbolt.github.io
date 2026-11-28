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
 * <id>/ on the tool-reports branch; `branch` is the pull request branch they open.
 * `sections`: the lists in their report, in display order, each with a title, a plain
 * explanation (`help`), `fold: true` for lists that are only for information, and `key`
 * (for the `main` list) to compare a run with the one before it. `brief(counts)` is the
 * one-line result for run lists; `explain(report)` gives the headline and what to check.
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
    main: 'added',
    sections: {
      added: { title: 'New amiibo', help: 'Not in the catalogue yet. Merging the pull request adds them.', key: (item) => `${item.name}|${item.amiiboSeries}` },
      promoted: { title: 'Real ids found', help: 'AmiiboAPI now has the real id of an amiibo we added with a temporary one. Merging switches to the real id; the app moves copies and wishlist entries over by itself.' },
      ambiguous: { title: 'Same name as more than one (not added)', help: 'The name matches several amiibo we have, so the tool can’t tell whether it’s new. If one is really missing, add it in Catalogue.', fold: true },
      unmatched: { title: 'Not added', help: 'A source lists these, but they weren’t added. Almost all are older amiibo we already have under a slightly different name: nothing to do. Act only on lines that say “add by hand”, or if one is really missing.', fold: true },
      filled: { title: 'Filled', help: 'Empty fields on amiibo we already have, filled from a source.' },
      conflicts: { title: 'Sources disagree (not applied)', help: 'The sources gave different values, so nothing was changed.', fold: true },
      skipped: { title: 'Skipped by you', help: 'You dropped these from an earlier pull request, so they were left out. Allow one again on this tool’s page.', fold: true },
    },
    brief: (counts) => (counts.added || counts.promoted
      ? [counts.added ? `${counts.added} new amiibo` : '', counts.promoted ? `${counts.promoted} real id${counts.promoted === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ')
      : 'No new amiibo'),
    explain: explainSnm,
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
    main: 'changes',
    sections: {
      changes: { title: 'Changes', help: 'What merging changes. Each one fills an empty field or picture, replaces a value a tool guessed, or corrects a release date AmiiboAPI and amiibo life agree on.', key: (item) => `${item.id}|${item.field}|${item.to}` },
      disagreements: { title: 'A source disagrees (not changed)', help: 'Ours stays as it is. Usually ours is right (sources mix up re-releases and bundles). If the source is right, fix it with Edit; the tools never overwrite your edits.', fold: true },
      kept: { title: 'Your edits kept', help: 'You set these by hand, so the tool left them alone even though a source says otherwise.', fold: true },
      notMatched: { title: 'Same name, different amiibo (not used)', help: 'A source has an amiibo with the same name as one of ours, but in another series and with no release date in common, so it was ignored (Monster Hunter’s Rudy isn’t the Animal Crossing card; amiibo life’s Series 4 Timmy isn’t our Series 1 Timmy).', fold: true },
      skipped: { title: 'Skipped by you', help: 'You dropped these from an earlier pull request, so they were left out. Allow one again on this tool’s page.', fold: true },
    },
    brief: (counts) => (counts.changes ? `${counts.changes} change${counts.changes === 1 ? '' : 's'}` : 'Nothing to change'),
    explain: explainDbUpdate,
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
  for (const child of children.flat(Infinity)) {
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
    if (response.status === 401) message = 'GitHub rejected the token: it has expired or was deleted. Sign out and sign in with a new one.';
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

/** An image straight from the repo at a ref (for amiibo not published yet); loads in the background. */
function repoImage(path, ref, alt) {
  const img = h('img', { class: 'thumb', alt });
  gh(repoPath(`/contents/${path}?ref=${encodeURIComponent(ref)}`), { accept: 'application/vnd.github.raw+json', as: 'blob' })
    .then((blob) => { img.src = URL.createObjectURL(blob); })
    .catch(() => { img.alt = ''; img.title = 'No picture yet'; });
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

// The token's expiry date. GitHub sends it in a response header that browsers aren't allowed
// to read (not in Access-Control-Expose-Headers), so you type it once from GitHub's token page.
const EXPIRY_KEY = 'admin.tokenExpires';
const EXPIRY_WARN_DAYS = 14;
const TOKEN_PAGE = 'https://github.com/settings/personal-access-tokens';

function tokenExpiry() {
  const value = storage('local')?.getItem(EXPIRY_KEY) || '';
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function setTokenExpiry(value) {
  if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) storage('local')?.setItem(EXPIRY_KEY, value);
  else storage('local')?.removeItem(EXPIRY_KEY);
}

function daysUntil(date) {
  const today = new Date();
  const start = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const [y, m, d] = date.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - start) / 86400000);
}

/** Home's token card: a warning in the last 14 days, a prompt when the date isn't set, else nothing. */
function tokenExpiryCard() {
  const date = tokenExpiry();
  const input = h('input', { type: 'date', value: date || '', class: 'inline-date' });
  const save = h('button', { type: 'button', class: 'ghost small', onclick: () => { setTokenExpiry(input.value); showTab('home'); } }, 'Save');
  const how = h('span', { class: 'small muted' }, 'GitHub: your avatar > Settings > Developer settings > Personal access tokens > Fine-grained tokens shows “Expires on”. ', link('Open', TOKEN_PAGE));
  if (!date) {
    return h('div', { class: 'banner is-warn' }, h('strong', {}, 'When does your token expire?'), ' Set the date so Home can warn you two weeks ahead.',
      h('div', { class: 'row' }, input, save), how);
  }
  const days = daysUntil(date);
  if (days > EXPIRY_WARN_DAYS) return null;
  const title = days < 0 ? 'Your token has expired.' : days === 0 ? 'Your token expires today.' : `Your token expires in ${plural(days, 'day')}.`;
  return h('div', { class: `banner is-${days <= 3 ? 'error' : 'warn'}` }, h('strong', {}, title),
    ' Make a new one with the same repository and permissions (Actions, Contents, Issues, Pull requests: read and write; 90 days), sign out here, sign in with it and set the new date. Then delete the old token on GitHub.',
    h('div', { class: 'row' }, input, save), how);
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
  setTokenExpiry(null);
  state.token = '';
  state.catalogue = null;
  location.hash = '';
  location.reload();
}

// ─── Tabs ───────────────────────────────────────────────────────────

const TABS = { home: showHome, tools: showTools, review: showReview, catalogue: showCatalogue, links: showLinks, news: showNews, banner: showBanner, history: showHistory };

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
  if (run.status !== 'completed') return pill(['queued', 'waiting', 'pending', 'requested'].includes(run.status) ? 'waiting' : 'running', 'warn');
  const words = { success: 'succeeded', failure: 'failed', cancelled: 'cancelled', skipped: 'skipped', timed_out: 'timed out', action_required: 'needs approval' };
  return pill(words[run.conclusion] || run.conclusion, run.conclusion === 'success' ? 'ok' : ['failure', 'timed_out'].includes(run.conclusion) ? 'error' : 'warn');
}

/** "dry run" or "pull request run": from the report, else from the run's title (see run-name in the workflows). */
function runKind(run, report) {
  if (report) return report.dryRun ? 'dry run' : 'pull request run';
  const title = run?.display_title || '';
  if (/dry run/i.test(title)) return 'dry run';
  if (/pull request run|weekly/i.test(title)) return 'pull request run';
  return 'run';
}

/** A run's name for lists: tool runs say which kind ("SNM dry run"); others use the workflow name. */
function runLabel(run) {
  const title = run.display_title || '';
  return title.startsWith(run.name) && title.length < 60 ? title : run.name;
}

function reportCounts(report) {
  return Object.fromEntries(Object.entries(report.sections || {}).map(([key, list]) => [key, list.length]));
}

function guardPill(outcome) {
  if (!outcome) return pill('Guard: no result', 'warn');
  if (outcome === 'success') return pill('Guard passed', 'ok');
  if (outcome === 'failure') return pill('Guard blocked', 'error');
  return pill(`Guard ${outcome === 'skipped' ? 'didn’t run' : outcome}`, 'warn');
}

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** "a, b and c". */
function joinAnd(parts) {
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** Up to `max` names, then "and N more". */
function someNames(names, max = 5) {
  const unique = [...new Set(names)];
  return unique.length <= max ? joinAnd(unique) : `${unique.slice(0, max).join(', ')} and ${unique.length - max} more`;
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
    const waiting = tool.branch ? pulls.find((pr) => pr.head.ref === tool.branch) : null;
    const running = run && run.status !== 'completed';
    const lastLine = running
      ? `Running now (${runKind(run, null)}, started ${when(run.run_started_at || run.created_at)})`
      : report
        ? `Last run, ${report.dryRun ? 'dry run' : 'pull request run'} (${when(report.startedAt)}): ${tool.brief(reportCounts(report))}${report.guard?.outcome && report.guard.outcome !== 'success' ? ' · Guard blocked it' : ''}`
        : run ? `Last run ${when(run.created_at)}` : 'Not run yet';
    return h('div', { class: `card tool${tool.planned ? ' planned' : ''}` },
      h('div', { class: 'row spread' }, h('h2', {}, tool.title), tool.planned ? pill('planned') : runPill(run)),
      h('p', { class: 'small muted' }, tool.description),
      tool.planned ? null : h('p', { class: 'small' }, lastLine, tool.schedule ? ` · ${tool.schedule}` : ''),
      waiting ? h('p', { class: 'small warn' }, `Pull request #${waiting.number} is waiting for review`) : null,
      tool.planned ? null : h('div', { class: 'row' },
        tool.reports
          ? [h('button', { type: 'button', onclick: () => showTab(`tools/${tool.id}`) }, 'Open'),
             h('button', { type: 'button', class: 'ghost', onclick: () => runTool(tool, true) }, 'Dry run')]
          : h('button', { type: 'button', class: 'ghost', onclick: () => runTool(tool, false) }, `Run ${tool.name.toLowerCase()}`),
        run ? link('Last log', run.html_url) : null));
  };

  view(
    tokenExpiryCard(),
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
      h('tr', {}, h('td', {}, runLabel(run)), h('td', {}, runPill(run)), h('td', { class: 'small muted' }, when(run.created_at)), h('td', {}, link('Log', run.html_url)))))));
}

/** Starts a tool's workflow. Report tools ask dry run vs pull request; options as chosen. */
async function runTool(tool, dryRun, options = {}) {
  const body = tool.reports
    ? dryRun
      ? 'It reads the sources and saves a report of what it would do. Nothing in the data changes and no pull request is opened.'
      : 'If it finds anything, it opens (or updates) its pull request for you to review. Nothing changes until you merge it.'
    : 'It runs on GitHub with its usual checks.';
  const title = tool.reports ? `${tool.name}: ${dryRun ? 'dry run' : 'run and open a pull request'}?` : `Run ${tool.name}?`;
  if (!(await confirmDialog(title, body, 'Run'))) return;
  const inputs = tool.reports ? { dry_run: dryRun ? 'true' : 'false', ...options } : {};
  try {
    // The newest run before this one: run ids only go up, so a higher one is the new run.
    const before = tool.reports ? await gh(repoPath(`/actions/workflows/${tool.workflow}/runs?per_page=1`)).catch(() => null) : null;
    await dispatch(tool.workflow, inputs);
    if (tool.reports) {
      // Its page shows the run as it starts, follows it and shows the result when it's done.
      state.started = { toolId: tool.id, at: Date.now(), afterId: before?.workflow_runs?.[0]?.id ?? 0, kind: dryRun ? 'dry run' : 'pull request run' };
      toast(`${tool.name} started. This page follows it and shows the result when it’s done.`);
      showTab(`tools/${tool.id}`);
    } else {
      toast(`${tool.name} started.`);
    }
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
  const selects = {};
  const optionControls = (tool.options || []).map((option) => {
    selects[option.key] = h('select', {}, option.values.map((value) => h('option', { value }, value)));
    return h('label', {}, `${option.label} (${option.help})`, selects[option.key]);
  });
  const chosen = () => Object.fromEntries(Object.entries(selects).map(([key, select]) => [key, select.value]));
  const live = h('div', {}, h('p', { class: 'muted' }, 'Loading…'));
  view(
    h('div', { class: 'card stack' },
      h('div', { class: 'row spread' }, h('h2', {}, tool.title), h('button', { type: 'button', class: 'ghost', onclick: () => showTab('tools') }, 'All tools')),
      h('p', { class: 'small muted' }, tool.description),
      optionControls.length ? h('div', { class: 'fields' }, optionControls) : null,
      h('div', { class: 'row' },
        h('button', { type: 'button', onclick: () => runTool(tool, true, chosen()) }, 'Dry run'),
        h('button', { type: 'button', class: 'ghost', onclick: () => runTool(tool, false, chosen()) }, 'Run and open PR')),
      h('p', { class: 'small muted' }, 'Dry run: shows what it would do; nothing changes. Run and open PR: the same search, then a pull request you look over and merge in Review.')),
    live,
  );
  await refreshToolLive(tool, live, currentHash);
}

/**
 * The changing part of a tool's page: its pull request, latest result and runs. While a
 * run is starting or running it refreshes itself every few seconds (only this part, so
 * the options above keep their values) and says when the run is done.
 */
async function refreshToolLive(tool, live, hash) {
  clearTimeout(state.pollTimer);
  const [index, runs, latest, pulls, skipList, editList] = await Promise.all([
    fileJson(`${tool.id}/index.json`, REPORTS_BRANCH).catch(() => null),
    gh(repoPath(`/actions/workflows/${tool.workflow}/runs?per_page=15`)).catch(() => ({ workflow_runs: [] })),
    fileJson(`${tool.id}/latest.json`, REPORTS_BRANCH).catch(() => null),
    gh(repoPath('/pulls?state=open&per_page=30')).catch(() => []),
    readSkipList().catch(() => ({ data: {} })),
    readMetaList(EDITS).catch(() => ({ data: {} })),
  ]);
  if (currentHash !== hash || !live.isConnected) return;
  const list = index || [];
  const rows = mergeRuns(list, runs.workflow_runs);
  const started = state.started?.toolId === tool.id && Date.now() - state.started.at < 120000 ? state.started : null;
  if (started && rows.some((row) => row.run && row.run.id > started.afterId)) state.started = null;
  else if (started) rows.unshift({ id: 'starting', startedAt: new Date(started.at).toISOString(), kind: started.kind, active: true, starting: true });

  // Say so when a run this page was following has finished.
  const watched = state.watching?.toolId === tool.id ? state.watching.ids : new Set();
  for (const row of rows) {
    if (!watched.has(row.id) || row.active) continue;
    const failed = row.run && row.run.conclusion !== 'success';
    toast(`${tool.name} ${row.kind} finished: ${row.report ? tool.brief(row.report.counts || {}) : failed ? 'it failed, see the log' : 'done'}.`, failed);
  }
  state.watching = { toolId: tool.id, ids: new Set(rows.filter((row) => row.active).map((row) => row.id)) };

  const waiting = pulls.find((pr) => pr.head.ref === tool.branch);
  const latestRun = latest ? runs.workflow_runs.find((run) => String(run.id) === String(latest.runId)) : null;
  live.replaceChildren(...[
    waiting
      ? h('div', { class: 'banner is-warn row spread' },
          h('span', {}, h('strong', {}, `Pull request #${waiting.number} is waiting for your review.`), ' Look it over, then merge or close it.'),
          h('button', { type: 'button', onclick: () => showTab('review') }, 'Review it'))
      : null,
    latest
      ? h('div', { class: 'card stack' },
          h('div', { class: 'row spread' },
            h('h2', {}, 'Latest result'),
            h('button', { type: 'button', class: 'ghost', onclick: () => showTab(`tools/${tool.id}/run/${latest.runId}`) }, 'Full report')),
          runSummary(tool, latest, { run: latestRun, pr: !latest.dryRun ? waiting : null, compact: true }))
      : null,
    h('div', { class: 'card stack' },
      h('div', { class: 'row spread' },
        h('h2', {}, 'Runs'),
        list.length ? h('button', { type: 'button', class: 'ghost', onclick: () => exportRuns(tool, list) }, 'Export recent runs') : null),
      h('p', { class: 'small muted' }, 'Tap a run for its full report.'),
      runList(tool, rows)),
    skippedCard(tool, Array.isArray(skipList.data[tool.id]) ? skipList.data[tool.id] : []),
    editsCard(tool, Array.isArray(editList.data[tool.id]) ? editList.data[tool.id] : []),
  ].filter(Boolean));

  if (rows.some((row) => row.active)) {
    const poll = () => {
      if (currentHash !== hash || !live.isConnected || !state.token) return;
      if (document.hidden) {
        state.pollTimer = setTimeout(poll, 10000);
        return;
      }
      refreshToolLive(tool, live, hash).catch(() => (state.pollTimer = setTimeout(poll, 20000)));
    };
    state.pollTimer = setTimeout(poll, started ? 5000 : 10000);
  }
}

/** GitHub runs and saved reports, joined by run id, newest first. */
function mergeRuns(index, runs) {
  const rows = new Map();
  for (const entry of index) {
    rows.set(String(entry.runId), { id: String(entry.runId), startedAt: entry.startedAt, report: entry, kind: entry.dryRun ? 'dry run' : 'pull request run', active: false });
  }
  for (const run of runs) {
    const id = String(run.id);
    const row = rows.get(id) || { id, startedAt: run.run_started_at || run.created_at, report: null };
    row.run = run;
    row.kind = row.report ? row.kind : runKind(run, null);
    row.active = run.status !== 'completed';
    rows.set(id, row);
  }
  return [...rows.values()].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)).slice(0, 20);
}

function minutesSince(iso) {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return minutes < 1 ? 'under a minute' : plural(minutes, 'minute');
}

/** A link that doesn't also trigger the clickable row it sits in. */
function rowLink(text, href) {
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer', onclick: (event) => event.stopPropagation() }, text);
}

function runList(tool, rows) {
  if (!rows.length) return h('p', { class: 'muted' }, 'No runs yet. Start with a dry run.');
  const result = (row) => {
    const report = row.report;
    if (row.starting) return [pill('starting', 'warn'), ' Waiting for GitHub to start it…'];
    if (row.active && !report) {
      return ['queued', 'waiting', 'pending', 'requested'].includes(row.run.status)
        ? [pill('waiting', 'warn'), ' Starts when the other tool run is done']
        : [pill('running', 'warn'), ` for ${minutesSince(row.run.run_started_at || row.run.created_at)}`];
    }
    if (report) {
      return [tool.brief(report.counts || {}),
        report.errors ? [' ', pill(plural(report.errors, 'error'), 'warn')] : null,
        row.active ? [' ', pill('finishing', 'warn')] : row.run && row.run.conclusion !== 'success' ? [' ', pill('run failed', 'error')] : null];
    }
    if (row.run?.conclusion === 'cancelled') return pill('cancelled', 'warn');
    if (row.run && row.run.conclusion !== 'success') return [pill('failed', 'error'), ' No report: it stopped before finishing. The log says why.'];
    return h('span', { class: 'muted' }, 'No report');
  };
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, ...['Started', 'Kind', 'Result', 'Guard', ''].map((title) => h('th', {}, title)))),
    h('tbody', {}, rows.map((row) =>
      h('tr', { class: row.report ? 'clickable' : '', onclick: row.report ? () => showTab(`tools/${tool.id}/run/${row.id}`) : null },
        h('td', { class: 'small' }, when(row.startedAt)),
        h('td', {}, row.kind === 'dry run' ? pill('dry run') : row.kind === 'pull request run' ? pill('PR', 'ok') : pill(row.kind)),
        h('td', {}, result(row)),
        h('td', {}, row.report ? guardPill(row.report.guard) : ''),
        h('td', {}, row.run ? rowLink('Log', row.run.html_url) : row.report?.runUrl ? rowLink('Log', row.report.runUrl) : ''))))));
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
  const tool = toolForBranch(pr.head.ref);
  const runId = tool?.reports ? (pr.body || '').match(/\brun (\d+|local-\d+)/)?.[1] : null;
  const [checks, guardRun, files, report, headCommit] = await Promise.all([
    gh(repoPath(`/commits/${pr.head.sha}/check-runs`)).catch(() => ({ check_runs: [] })),
    latestGuardRun(pr.head.sha).catch(() => null),
    gh(repoPath(`/pulls/${pr.number}/files?per_page=100`)),
    runId ? fileJson(`${tool.id}/reports/${runId}.json`, REPORTS_BRANCH).catch(() => null) : null,
    gh(repoPath(`/git/commits/${pr.head.sha}`)).catch(() => null),
  ]);
  const data = files.some((file) => file.filename === 'data/catalogue.json') ? await prChanges(pr).catch((error) => ({ error })) : null;
  // Still exactly what the tool made? Once you've dropped something it's an ordinary pull
  // request again: its new commit needs its own Guard run.
  const toolCommit = !tool?.reports || headCommit?.author?.name === 'github-actions[bot]';
  const guardOutcome = report?.guard?.outcome ?? null;
  const guard = guardState({ tool, toolOutcome: guardOutcome, toolCommit, guardRun, files });
  const blocked = guard === 'failed' || guard === 'no report';
  const failing = checks.check_runs.filter((run) => run.conclusion === 'failure' && !/guard/i.test(run.name));
  const status = mergeStatus(guard, failing);
  const checkPills = checks.check_runs.map((run) =>
    pill(`${run.name}: ${run.conclusion || run.status}`, run.conclusion === 'success' ? 'ok' : run.conclusion === 'failure' ? 'error' : 'warn'));

  card.append(
    h('div', { class: 'row spread' },
      h('h2', {}, `#${pr.number} ${pr.title}`),
      link('Open on GitHub', pr.html_url)),
    h('div', { class: 'row small muted' },
      `${tool ? `Opened by ${tool.name}` : 'Your change'} · updated ${when(pr.updated_at)}`,
      ...pr.labels.map((label) => pill(label.name)),
      ...checkPills),
    h('div', { class: `banner is-${status.kind}` }, h('strong', {}, status.title), ' ', status.text),
  );
  if (tool?.reports && report) {
    card.append(h('h3', {}, 'What the run found'), runSummary(tool, report, { review: true }));
    if (!toolCommit) card.append(h('p', { class: 'small warn' }, 'You’ve dropped some of this since the run, so “Changes” below (what’s in it now) differs from the run’s numbers.'));
  } else if (tool?.reports) {
    card.append(h('p', { class: 'warn' }, 'Couldn’t find the report for this run. Its description from GitHub:'), h('pre', {}, pr.body || ''));
  } else {
    card.append(h('h3', {}, 'Description'), h('pre', {}, pr.body || '(no description)'));
  }

  const mergeButton = h('button', { type: 'button', disabled: blocked, onclick: () => mergePr(pr, files, guardOutcome) }, 'Merge');
  const mergeHint = h('span', { class: 'small warn', hidden: true }, 'Drop the unticked changes first, or tick them again.');
  if (data && !data.error && data.items.length) {
    const dropInfo = h('span', { class: 'small' });
    const remember = tool?.reports ? h('input', { type: 'checkbox', checked: true }) : null;
    const dropButton = h('button', { type: 'button', class: 'danger', disabled: true }, 'Drop unticked');
    const onlyCatalogue = data.files.every((file) => /^(data\/catalogue\.json|meta\/provenance\.json|images\/)/.test(file.filename))
      && !data.items.some((item) => item.kind === 'removed');
    let changes;
    const update = () => {
      const dropped = changes.dropped();
      const count = droppedCount(dropped);
      const everything = count > 0 && count === changes.total && onlyCatalogue;
      card.dataset.dirty = count ? 'yes' : '';
      mergeButton.disabled = blocked || count > 0;
      mergeHint.hidden = count === 0;
      dropButton.disabled = count === 0;
      dropButton.textContent = everything ? 'Drop all and close' : count ? `Drop ${count}` : 'Drop unticked';
      dropInfo.textContent = count
        ? `Dropping ${count} of ${changes.total}: ${someNames(dropped.map(describeDropped), 3)}.`
        : `Keeping all ${plural(changes.total, 'change')}. Untick anything you don’t want, then Drop.`;
      dropButton.onclick = () => dropFromPr({ pr, tool, data, dropped: changes.dropped(), remember: Boolean(remember?.checked), closeInstead: everything });
    };
    changes = changesView({
      data,
      report,
      ref: pr.head.sha,
      onChange: update,
      onEdit: (item, fields) => (card.dataset.dirty
        ? toast('Tick everything again (or Drop the unticked ones) before editing.', true)
        : editInPr({ pr, tool, data, item, fields, card })),
    });
    const counts = ['added', 'promoted', 'changed', 'removed'].map((kind) => [kind, data.items.filter((item) => item.kind === kind).length]).filter(([, n]) => n);
    const words = { added: 'new', promoted: 'real ids', changed: 'changed', removed: 'removed' };
    card.append(
      h('h3', {}, `Changes: ${counts.map(([kind, n]) => `${n} ${words[kind]}`).join(', ')}`),
      h('p', { class: 'small muted' }, 'Each amiibo as it is now next to how it will be after merging (only what changes; “All details” shows the rest). Everything ticked gets merged. Edit sets your own value instead.'),
      changes.node,
      h('div', { class: 'dropbar stack' },
        dropInfo,
        h('div', { class: 'row' },
          dropButton,
          remember ? h('label', { class: 'check' }, remember, `Don’t let ${tool.name} propose dropped ones again`) : null)));
    update();
  } else if (data?.error) {
    card.append(h('p', { class: 'warn' }, `Couldn’t compare the changes: ${data.error.message}`));
  }
  if (files.some((file) => file.filename === LINKS_FILE)) {
    try {
      const rows = await prLinkChanges(pr);
      const n = (kind) => rows.filter((row) => row.kind === kind).length;
      const parts = [['added', 'new'], ['changed', 'changed'], ['removed', 'removed']].filter(([kind]) => n(kind)).map(([kind, word]) => `${n(kind)} ${word}`);
      card.append(h('h3', {}, `Store links: ${parts.join(', ') || 'no link changes'}`));
      if (rows.length) {
        card.append(
          h('p', { class: 'small muted' }, 'Open each link to check it’s the official Nintendo product at that store, then merge.'),
          linkChangesView(rows));
      }
    } catch (error) {
      card.append(h('p', { class: 'warn' }, `Couldn’t compare the store links: ${error.message}`));
    }
  }
  if (tool?.reports && report) {
    const omit = data && !data.error ? [tool.main, 'promoted', 'filled'] : [];
    card.append(h('h3', {}, 'More from the run'), reportSections(tool, report, pr.head.ref, { omit }));
  }
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
    card.append(h('h3', {}, 'Preview'), h('p', { class: 'small muted' }, 'See the new and changed amiibo the way the app shows them.'), button, holder);
  }
  card.append(
    details(`Files changed (${files.length})`,
      h('ul', { class: 'list small' }, files.slice(0, 30).map((file) =>
        h('li', {}, `${file.status} ${file.filename} (+${file.additions} −${file.deletions})`)))),
    h('div', { class: 'row' },
      mergeButton,
      h('button', { type: 'button', class: 'ghost', onclick: () => closePr(pr) }, 'Close without merging'),
      mergeHint),
  );
  // While the Guard runs, check again every 15 s (not while you're ticking boxes).
  if (guard === 'running' || guard === 'not started') {
    const again = async () => {
      if (!card.isConnected || card.dataset.dirty) return;
      if (document.hidden) {
        setTimeout(again, 15000);
        return;
      }
      try {
        const fresh = await gh(repoPath(`/pulls/${pr.number}`));
        if (fresh.state !== 'open') return;
        const next = await reviewCard(fresh);
        if (card.isConnected && !card.dataset.dirty) swapCard(card, next);
      } catch {
        setTimeout(again, 30000);
      }
    };
    setTimeout(again, 15000);
  }
  return card;
}

/**
 * Replaces a review card with a newer one without moving the page: the amiibo you were at
 * (`itemId`, else the first one on screen) stays where it was on screen.
 */
function swapCard(card, next, itemId) {
  const items = [...card.querySelectorAll('.change[data-item]')];
  const anchor = (itemId && items.find((el) => el.dataset.item === itemId))
    || items.find((el) => el.getBoundingClientRect().bottom > 0)
    || card;
  const top = anchor.getBoundingClientRect().top;
  const id = anchor.dataset.item;
  card.replaceWith(next);
  const again = (id && [...next.querySelectorAll('.change[data-item]')].find((el) => el.dataset.item === id)) || next;
  window.scrollBy(0, again.getBoundingClientRect().top - top);
}

/** Reloads one pull request's card in place after a change (falls back to reloading Review). */
async function refreshReviewCard(card, number, itemId, sha) {
  if (!card?.isConnected) return showTab('review');
  try {
    let fresh = await gh(repoPath(`/pulls/${number}`));
    // GitHub can take a moment to show the commit just made on the pull request.
    for (let tries = 0; sha && fresh.head.sha !== sha && tries < 8; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      fresh = await gh(repoPath(`/pulls/${number}`));
    }
    if (fresh.state !== 'open') return showTab('review');
    swapCard(card, await reviewCard(fresh), itemId);
  } catch {
    showTab('review');
  }
}

/** Files the Guard protects: a pull request touching any of them must pass it to be merged here. */
const GUARDED_PATH = /^(data|images|meta)\//;

/**
 * Newest Guard workflow run for a commit, or null if none has started. Read through the
 * Actions API, which the dashboard token can use (the checks API needs a Checks permission).
 * Adding a label re-runs the Guard, so the newest run is the one that counts.
 */
/**
 * Guard runs that never checked anything: GitHub held them for approval (it does this for
 * pull requests opened by github-actions[bot]), or they were cancelled or skipped. They are
 * neither a pass nor a fail.
 */
const GUARD_NEVER_RAN = new Set(['action_required', 'waiting', 'requested', 'cancelled', 'skipped', 'stale', 'neutral']);

/** The newest Guard run on a commit that actually ran (or is running). */
async function latestGuardRun(sha) {
  const data = await gh(repoPath(`/actions/workflows/guard.yml/runs?head_sha=${encodeURIComponent(sha)}&per_page=20`));
  return data.workflow_runs
    .filter((run) => !GUARD_NEVER_RAN.has(run.status) && !GUARD_NEVER_RAN.has(run.conclusion))
    .sort((a, b) => b.id - a.id)[0] || null;
}

/**
 * The Guard's verdict on a pull request: passed, failed, running, not started, no report
 * (a tool's report is missing) or not needed (no data files). Fails closed: a data pull
 * request counts as passed only with a passing result.
 */
function guardState({ tool, toolOutcome, toolCommit = true, guardRun, files }) {
  // 100 = the most the files list returns, so there may be data files beyond it.
  const touchesData = files.length >= 100 || files.some((file) => GUARDED_PATH.test(file.filename));
  // The tools open their pull requests as GitHub Actions, which doesn't start the Guard
  // workflow, so they run the Guard themselves and their report has the result.
  const results = [];
  if (tool?.reports && toolCommit) results.push(toolOutcome || 'no report');
  if (guardRun) results.push(guardRun.status === 'completed' ? guardRun.conclusion : 'running');
  if (touchesData && results.length === 0) results.push('not started');
  if (results.includes('no report')) return 'no report';
  if (results.some((result) => !['success', 'running', 'not started'].includes(result))) return 'failed';
  if (results.includes('running')) return 'running';
  if (results.includes('not started')) return 'not started';
  return results.length ? 'passed' : 'not needed';
}

const AFTER_MERGE = 'Merging puts it on main; Publish checks it and puts it online, and phones get it within about a day (the app checks daily and applies it on the next launch).';

function mergeStatus(guard, failing) {
  if (guard === 'failed') return { kind: 'error', title: 'Can’t merge here.', text: 'The Guard blocked it: it changes or removes something it isn’t allowed to. See Guard below, or review it on GitHub.' };
  if (guard === 'no report') return { kind: 'error', title: 'Can’t merge here.', text: 'The report for this run is missing, so the Guard result is unknown. Run the tool again, or review it on GitHub.' };
  if (guard === 'running' || guard === 'not started') {
    return { kind: 'warn', title: 'Not ready yet.', text: `The Guard check ${guard === 'running' ? 'is still running' : 'hasn’t started yet'}. Open Review again in a minute.` };
  }
  if (failing.length) return { kind: 'warn', title: 'Ready, with a warning.', text: `Failing checks: ${failing.map((run) => run.name).join(', ')}. GitHub may refuse the merge.` };
  return { kind: 'ok', title: 'Ready to merge.', text: `${guard === 'not needed' ? 'No data files change, so the Guard isn’t needed.' : 'The Guard passed.'} ${AFTER_MERGE}` };
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
  const headCommit = await gh(repoPath(`/git/commits/${pr.head.sha}`)).catch(() => null);
  const toolCommit = !tool?.reports || headCommit?.author?.name === 'github-actions[bot]';
  const guard = guardState({ tool, toolOutcome: toolGuardOutcome, toolCommit, guardRun, files });
  if (guard === 'no report') {
    return toast('Couldn’t find the report for this run, so the Guard result is unknown. Review it on GitHub.', true);
  }
  if (guard === 'failed') {
    return toast('The Guard check failed for this pull request, so the dashboard won’t merge it. Review it on GitHub.', true);
  }
  if (guard === 'running' || guard === 'not started') {
    return toast(`The Guard check ${guard === 'running' ? 'is still running' : 'hasn’t started yet'}. Try again in a minute.`, true);
  }
  const failing = checkRuns.filter((run) => run.conclusion === 'failure');
  const pending = checkRuns.filter((run) => !run.conclusion);
  const notes = [AFTER_MERGE];
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

// ─── Changes in a pull request: compare, keep or drop ──────────────

/** Fields in the order people read them; anything else follows. Never shown: ids, aliases. */
const FIELD_ORDER = ['name', 'character', 'amiiboSeries', 'gameSeries', 'type', 'release.na', 'release.eu', 'release.jp', 'release.au', 'image', 'imageFallback', 'source'];
const HIDDEN_FIELDS = new Set(['id', 'head', 'tail', 'aliases', 'release']);
const SKIPPED = 'meta/skipped.json';
const EDITS = 'meta/edits.json';
/** Fields you can set on a pull request before merging (pictures are the tools' job). */
const PR_EDITABLE = ['name', 'character', 'amiiboSeries', 'gameSeries', 'type', 'release.na', 'release.eu', 'release.jp', 'release.au'];
const ANNOUNCEMENTS = 'meta/announcements.json';

const ABOUT = {
  [ANNOUNCEMENTS]: 'Official announcements shown in the app’s News tab, written in Remote Admin. The News workflow folds the active ones into data/news.json.',
  [SKIPPED]: 'What you dropped in Remote Admin. The tools don’t propose these again. To undo one, use Allow again on the tool’s page in Remote Admin.',
  [EDITS]: 'Values you set in Remote Admin on a tool’s pull request before merging. The tools apply them each time they rebuild it. Forget them on the tool’s page in Remote Admin.',
};

const fieldGet = (entry, path) => (path.startsWith('release.') ? entry.release?.[path.slice(8)] : entry[path]) ?? null;
const orderOf = (path) => (FIELD_ORDER.includes(path) ? FIELD_ORDER.indexOf(path) : FIELD_ORDER.length);

function entryFields(entry) {
  return [...Object.keys(entry).filter((key) => !HIDDEN_FIELDS.has(key)), ...Object.keys(entry.release || {}).map((region) => `release.${region}`)];
}

/** Puts a field back the way it was in `old` (removing it if `old` didn't have it). */
function restoreField(entry, old, path) {
  if (path.startsWith('release.')) {
    entry.release[path.slice(8)] = old.release?.[path.slice(8)] ?? null;
  } else if (Object.hasOwn(old, path)) {
    entry[path] = structuredClone(old[path]);
  } else {
    delete entry[path];
  }
}

function restoreProvenance(provenance, baseProvenance, id, path) {
  const before = baseProvenance?.[id]?.[path];
  if (before) {
    provenance[id] ??= {};
    provenance[id][path] = structuredClone(before);
  } else if (provenance[id]) {
    delete provenance[id][path];
    if (!Object.keys(provenance[id]).length) delete provenance[id];
  }
}

/** Every file a pull request touches (the list comes 100 at a time). */
async function allPrFiles(number) {
  const files = [];
  for (let page = 1; page <= 30; page++) {
    const batch = await gh(repoPath(`/pulls/${number}/files?per_page=100&page=${page}`));
    files.push(...batch);
    if (batch.length < 100) break;
  }
  return files;
}

/**
 * What a pull request does to the catalogue, per amiibo, against the commit it started
 * from: added, removed, a real id for a temporary one (promoted), or changed fields. A
 * picture is one row even when its backup URL changes with it, or when only its file is new.
 */
async function prChanges(pr) {
  const compare = await gh(repoPath(`/compare/main...${pr.head.sha}?per_page=1`));
  const baseSha = compare.merge_base_commit.sha;
  const [base, head, files, headProvenance] = await Promise.all([
    fileJson('data/catalogue.json', baseSha),
    fileJson('data/catalogue.json', pr.head.sha),
    allPrFiles(pr.number),
    fileJson(PROVENANCE, pr.head.sha).catch(() => null),
  ]);
  const newFiles = new Set(files.filter((file) => file.status === 'added').map((file) => file.filename));
  return { baseSha, base, head, files, newFiles, headProvenance, items: diffCatalogues(base, head, newFiles) };
}

function diffCatalogues(base, head, newFiles) {
  const baseById = new Map(base.amiibo.map((entry) => [entry.id, entry]));
  const headIds = new Set(head.amiibo.map((entry) => entry.id));
  const items = [];
  for (const entry of head.amiibo) {
    let old = baseById.get(entry.id);
    const from = old ? null : (entry.aliases || []).find((alias) => baseById.has(alias) && !headIds.has(alias)) || null;
    if (from) old = baseById.get(from);
    if (!old) {
      items.push({ kind: 'added', key: `amiibo:${entry.id}`, id: entry.id, entry });
      continue;
    }
    const paths = [...new Set([...entryFields(old), ...entryFields(entry)])]
      .filter((path) => JSON.stringify(fieldGet(old, path)) !== JSON.stringify(fieldGet(entry, path)))
      .sort((a, b) => orderOf(a) - orderOf(b));
    const pictureFileOnly = !paths.includes('image') && entry.image && entry.image !== PLACEHOLDER_IMAGE && newFiles.has(entry.image);
    if (!from && !paths.length && !pictureFileOnly) continue;
    const rows = [];
    const picture = paths.includes('image') || pictureFileOnly;
    for (const path of paths) {
      if (path === 'imageFallback' && picture) continue;
      if (path === 'image') continue;
      rows.push({ key: `field:${entry.id}:${path}`, label: fieldLabel(path), paths: [path], before: fieldGet(old, path), after: fieldGet(entry, path), skipField: path, skipValue: fieldGet(entry, path) });
    }
    if (picture) {
      rows.push({
        key: `field:${entry.id}:image`,
        label: 'Picture',
        paths: ['image', ...(paths.includes('imageFallback') ? ['imageFallback'] : [])],
        before: pictureFileOnly ? null : fieldGet(old, 'image'),
        after: entry.image,
        file: newFiles.has(entry.image) ? entry.image : null,
        picture: true,
        skipField: 'image',
        skipValue: null,
      });
      rows.sort((a, b) => orderOf(a.paths[0]) - orderOf(b.paths[0]));
    }
    items.push(from
      ? { kind: 'promoted', key: `amiibo:${entry.id}`, id: entry.id, from, old, entry, rows }
      : { kind: 'changed', key: `amiibo:${entry.id}`, id: entry.id, old, entry, rows });
  }
  const promotedFrom = new Set(items.filter((item) => item.kind === 'promoted').map((item) => item.from));
  for (const entry of base.amiibo) {
    if (!headIds.has(entry.id) && !promotedFrom.has(entry.id)) items.push({ kind: 'removed', key: `amiibo:${entry.id}`, id: entry.id, old: entry, entry });
  }
  const rank = { added: 0, promoted: 1, changed: 2, removed: 3 };
  return items.sort((a, b) => rank[a.kind] - rank[b.kind] || a.entry.name.localeCompare(b.entry.name));
}

/** What the tool's report says about each change: why, from where, what was guessed. */
function reportInfo(report) {
  const sections = report?.sections || {};
  return {
    added: new Map((sections.added || []).map((item) => [item.id, item])),
    changes: new Map([...(sections.changes || []), ...(sections.filled || [])].map((item) => [`${item.id}|${item.field}`, item])),
    promoted: new Map((sections.promoted || []).map((item) => [item.to, item])),
  };
}

/** SNM's note for one field of a new amiibo ("guessed", "series' launch date"…). */
function guessNote(guessed, path) {
  const find = (pattern) => guessed.find((text) => pattern.test(text));
  if (path === 'amiiboSeries') return find(/amiibo series/);
  if (path === 'gameSeries') return find(/^game series/);
  if (path === 'character') return find(/^character/) ? 'taken from the name' : null;
  if (path === 'type') return find(/^type assumed/) ? 'assumed' : null;
  if (path.startsWith('release.')) {
    const text = find(/launch date/);
    return text && text.split(' ')[0].split('/').includes(path.slice(8).toUpperCase()) ? 'series’ launch date' : null;
  }
  return null;
}

/** A picture cell: the published one for "now", the pull request's own file for "after". */
function pictureCell(path, ref) {
  if (!path) return h('span', { class: 'muted' }, 'none');
  if (path === PLACEHOLDER_IMAGE) return h('span', { class: 'muted' }, 'our icon (no picture)');
  if (/^https:/.test(path)) return link('picture', path);
  if (!ref) return amiiboImage({ name: '', image: path, imageFallback: null });
  return repoImage(path, ref, '');
}

const KIND_PILL = { added: ['New', 'ok'], promoted: ['Real id', 'ok'], changed: ['Changed', 'warn'], removed: ['Removed', 'error'] };

/**
 * The changes, one card per amiibo, "Now" next to "After merge", with a tick box on every
 * change (a whole new amiibo, a real id, or one field). onChange runs when a box changes.
 * Returns { node, dropped(), total, describe(dropped) }.
 */
function changesView({ data, report, ref, onChange, onEdit }) {
  const info = reportInfo(report);
  const keep = new Map();
  const boxes = [];
  const cards = [];
  const LIMIT = 20;

  const box = (key, label, onToggle) => {
    keep.set(key, true);
    const input = h('input', { type: 'checkbox', checked: true });
    input.addEventListener('change', () => {
      keep.set(key, input.checked);
      onToggle?.();
      onChange();
    });
    boxes.push(input);
    return h('label', { class: 'keep' }, input, label);
  };

  for (const item of data.items) {
    const { entry } = item;
    const [kindText, kindClass] = KIND_PILL[item.kind];
    const card = h('div', { class: 'change', 'data-item': item.id });
    const loaders = [];
    const later = (make) => {
      const slot = h('span');
      loaders.push(() => slot.replaceWith(make()));
      return slot;
    };
    // Set by you in Remote Admin (marked "manual" in the pull request's provenance).
    const yours = (path) => data.headProvenance?.[item.id]?.[path]?.source === 'manual';
    const editable = item.kind === 'added' ? PR_EDITABLE : item.kind === 'changed' ? item.rows.filter((row) => !row.picture && PR_EDITABLE.includes(row.paths[0])).map((row) => row.paths[0]) : [];
    const editButton = onEdit && editable.length ? h('button', { type: 'button', class: 'ghost small edit', onclick: () => onEdit(item, editable) }, 'Edit') : null;
    const head = h('div', { class: 'change-head' },
      later(() => (item.kind === 'added' || item.kind === 'promoted' ? pictureCell(entry.image, ref) : amiiboImage(entry))),
      h('div', { class: 'grow' },
        h('div', {}, h('strong', {}, entry.name), h('span', { class: 'muted' }, ` · ${entry.amiiboSeries}`)),
        h('div', { class: 'small muted row' }, pill(kindText, kindClass), h('code', {}, item.kind === 'promoted' ? `${item.from} → ${item.id}` : item.id))));

    if (item.kind === 'added') {
      const about = info.added.get(item.id);
      const guessed = about?.guessed || [];
      const update = () => card.classList.toggle('dropped', !keep.get(item.key));
      head.append(...[editButton, box(item.key, 'Keep', update)].filter(Boolean));
      const rows = ['amiiboSeries', 'gameSeries', 'character', 'type'].map((path) => {
        const note = yours(path) ? null : guessNote(guessed, path);
        return [fieldLabel(path), String(fieldGet(entry, path) ?? ''),
          yours(path) ? h('span', { class: 'ok' }, 'your value') : note ? h('span', { class: path === 'character' ? 'muted' : 'warn' }, note) : ''];
      });
      if (yours('name')) rows.unshift([fieldLabel('name'), entry.name, h('span', { class: 'ok' }, 'your value')]);
      const dates = REGIONS.map((region) => {
        const value = entry.release?.[region];
        const note = yours(`release.${region}`) ? 'your value' : guessNote(guessed, `release.${region}`);
        return `${region.toUpperCase()} ${value ? appDate(value) : '—'}${note ? ` (${note})` : ''}`;
      }).join(' · ');
      card.append(head,
        h('div', { class: 'change-grid new' },
          rows.flatMap(([label, value, note]) => [h('span', { class: 'muted' }, label), h('span', {}, value), h('span', { class: 'small' }, note)]),
          h('span', { class: 'muted' }, 'Released'), h('span', { class: 'span' }, dates)),
        ...wholeNotes(guessed).map((text) => h('div', { class: 'small warn' }, text.replace(/^./, (c) => c.toUpperCase()))),
        about && (about.sources?.length || about.url)
          ? h('div', { class: 'small muted' }, about.sources?.length ? `From ${joinAnd(about.sources)}` : 'Source', about.url ? [about.sources?.length ? ' · ' : ': ', link('page', about.url)] : null)
          : null);
    } else if (item.kind === 'promoted') {
      const update = () => card.classList.toggle('dropped', !keep.get(item.key));
      head.append(box(item.key, 'Keep', update));
      card.append(head,
        h('p', { class: 'small muted' }, 'AmiiboAPI now lists this amiibo with its real id. Merging switches to it; the app moves copies and wishlist entries over by itself.'),
        item.rows.length ? h('div', { class: 'change-grid' }, gridHeader(), item.rows.flatMap((row) => changeRow(row, null, ref))) : null);
    } else if (item.kind === 'changed') {
      const all = item.rows.length > 1 ? h('input', { type: 'checkbox', checked: true }) : null;
      const rowNodes = [];
      const update = () => {
        const kept = item.rows.filter((row) => keep.get(row.key)).length;
        card.classList.toggle('dropped', kept === 0);
        item.rows.forEach((row, index) => rowNodes[index].forEach((node) => node.classList.toggle('off', !keep.get(row.key))));
        if (all) {
          all.checked = kept === item.rows.length;
          all.indeterminate = kept > 0 && kept < item.rows.length;
        }
      };
      if (all) {
        all.addEventListener('change', () => {
          for (const row of item.rows) keep.set(row.key, all.checked);
          for (const input of card.querySelectorAll('.change-grid input')) input.checked = all.checked;
          update();
          onChange();
        });
        head.append(h('label', { class: 'keep' }, all, 'Keep all'));
      }
      if (editButton) head.insertBefore(editButton, head.querySelector('label.keep'));
      const grid = h('div', { class: 'change-grid' }, gridHeader());
      for (const row of item.rows) {
        const about = info.changes.get(`${item.id}|${row.paths[0]}`);
        const nodes = changeRow(row, box(row.key, row.label, update), ref, about, yours(row.paths[0]));
        rowNodes.push(nodes);
        grid.append(...nodes);
      }
      card.append(head, grid,
        details('All details',
          h('div', { class: 'change-grid all' }, gridHeader(true),
            [...new Set([...entryFields(item.old), ...entryFields(entry)])].sort((a, b) => orderOf(a) - orderOf(b)).flatMap((path) => {
              const same = JSON.stringify(fieldGet(item.old, path)) === JSON.stringify(fieldGet(entry, path));
              return [h('span', { class: 'muted' }, fieldLabel(path)), h('span', { class: same ? 'muted' : '' }, fieldValue(path, fieldGet(item.old, path))), h('span', { class: same ? 'muted' : '' }, fieldValue(path, fieldGet(entry, path)))];
            }))));
    } else {
      card.classList.add('removed');
      card.append(head, h('p', { class: 'small' }, 'This pull request removes it. To keep it, close the pull request instead of merging.'));
    }
    card.load = () => {
      for (const load of loaders.splice(0)) load();
    };
    cards.push({ card, text: `${entry.name} ${entry.amiiboSeries} ${item.id} ${item.from || ''}`.toLowerCase() });
  }

  // Long lists: the first 20, "Show all", and a filter.
  let showAll = cards.length <= LIMIT;
  let query = '';
  const list = h('div', { class: 'changes' }, cards.map(({ card }) => card));
  const more = h('button', { type: 'button', class: 'ghost small', onclick: () => { showAll = true; render(); } }, `Show all ${cards.length}`);
  const render = () => {
    let shown = 0;
    for (const { card, text } of cards) {
      const visible = query ? text.includes(query) : showAll || shown < LIMIT;
      card.hidden = !visible;
      if (visible) {
        shown++;
        card.load();
      }
    }
    more.hidden = showAll || Boolean(query);
  };
  const setAll = (value) => {
    for (const input of boxes) {
      if (input.checked !== value) {
        input.checked = value;
        input.dispatchEvent(new Event('change'));
      }
    }
  };
  render();

  const units = () => data.items.flatMap((item) => (item.kind === 'changed' ? item.rows.map((row) => ({ item, row })) : item.kind === 'removed' ? [] : [{ item }]));
  return {
    node: h('div', { class: 'stack' },
      h('div', { class: 'row' },
        cards.length > LIMIT ? h('input', { type: 'search', class: 'filter', placeholder: 'Filter by name, series or id', autocomplete: 'off', oninput: (event) => { query = event.target.value.trim().toLowerCase(); render(); } }) : null,
        h('button', { type: 'button', class: 'ghost small', onclick: () => setAll(true) }, 'Tick all'),
        h('button', { type: 'button', class: 'ghost small', onclick: () => setAll(false) }, 'Untick all')),
      list,
      more),
    total: units().length,
    /** Unticked changes: { item } for a whole amiibo, { item, rows } for fields. */
    dropped: () => {
      const out = [];
      for (const item of data.items) {
        if (item.kind === 'changed') {
          const rows = item.rows.filter((row) => !keep.get(row.key));
          if (rows.length) out.push({ item, rows });
        } else if (item.kind !== 'removed' && !keep.get(item.key)) {
          out.push({ item });
        }
      }
      return out;
    },
  };
}

function gridHeader(compact = false) {
  return [h('span', { class: 'head' }, compact ? '' : 'Change'), h('span', { class: 'head' }, 'Now'), h('span', { class: 'head' }, 'After merge'), ...(compact ? [] : [h('span', { class: 'head' }, '')])];
}

/** One changed field: [label or tick box, now, after merge, why]. */
function changeRow(row, label, ref, about, isYours = false) {
  const before = row.picture ? pictureCell(row.before, null) : fieldValue(row.paths[0], row.before);
  const after = row.picture ? pictureCell(row.after, ref) : fieldValue(row.paths[0], row.after);
  const why = isYours
    ? h('span', { class: 'small ok' }, 'Your value')
    : about
    ? h('span', { class: 'small muted' }, WHY_TEXT[about.why] ? WHY_TEXT[about.why].replace(/^./, (c) => c.toUpperCase()) : about.why || '', about.source ? ` · ${about.source}` : '', about.url ? [' · ', link('page', about.url)] : null)
    : h('span');
  return [label || h('span', { class: 'muted' }, row.label), h('span', {}, before), h('span', {}, after), why];
}

/** "Big Man (new amiibo)", "Rudy: Release date, Europe". */
function describeDropped({ item, rows }) {
  if (item.kind === 'added') return `${item.entry.name} (new amiibo)`;
  if (item.kind === 'promoted') return `${item.entry.name} (real id ${item.id})`;
  return `${item.entry.name}: ${rows.map((row) => row.label).join(', ')}`;
}

function droppedCount(dropped) {
  return dropped.reduce((sum, { rows }) => sum + (rows ? rows.length : 1), 0);
}

/**
 * The name and amiibo series SNM itself gives a new amiibo, which your values may have
 * changed since: what the skip list and your values match it by.
 */
function snmIdentity(entry, edits) {
  const norm = (text) => String(text || '').trim().toLowerCase();
  const groups = new Map();
  for (const item of Array.isArray(edits) ? edits : []) {
    if (!item.match) continue;
    const key = JSON.stringify(item.match);
    groups.set(key, [...(groups.get(key) || []), item]);
  }
  for (const items of groups.values()) {
    const { match } = items[0];
    const latest = (field) => [...items].reverse().find((item) => item.field === field)?.value;
    if (norm(latest('name') ?? match.name) === norm(entry.name) && norm(latest('amiiboSeries') ?? match.amiiboSeries) === norm(entry.amiiboSeries)) return match;
  }
  return { name: entry.name, amiiboSeries: entry.amiiboSeries };
}

/** What goes on the skip list for each dropped change. */
function skipEntries({ item, rows }, edits = []) {
  const stamp = { at: new Date().toISOString(), by: state.user.login };
  if (item.kind === 'added') {
    const { name, amiiboSeries } = snmIdentity(item.entry, edits);
    return [{ name, amiiboSeries, ...stamp }];
  }
  if (item.kind === 'promoted') return [{ name: item.entry.name, from: item.from, to: item.id, ...stamp }];
  return rows.map((row) => ({ name: `${item.entry.name}: ${row.label}`, id: item.id, field: row.skipField, value: row.skipValue, ...stamp }));
}

function base64ToUtf8(base64) {
  const binary = atob(base64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

/** A list file on main (skip list, your values), with its sha (null if it doesn't exist yet). */
async function readMetaList(path) {
  try {
    const meta = await gh(repoPath(`/contents/${path}?ref=main`));
    return { sha: meta.sha, data: JSON.parse(base64ToUtf8(meta.content)) };
  } catch (error) {
    if (error.status === 404) return { sha: null, data: {} };
    throw error;
  }
}

const readSkipList = () => readMetaList(SKIPPED);

/**
 * Changes a list file straight on main: it isn't published data, and a tool run must see
 * it before the pull request is merged. Retries once if it changed meanwhile.
 */
async function writeMetaList(path, mutate, message) {
  for (let attempt = 0; ; attempt++) {
    const { sha, data } = await readMetaList(path);
    data.about = ABOUT[path];
    mutate(data);
    try {
      await gh(repoPath(`/contents/${path}`), {
        method: 'PUT',
        body: { message, content: utf8ToBase64(`${JSON.stringify(data, null, 2)}\n`), branch: 'main', ...(sha ? { sha } : {}) },
      });
      return;
    } catch (error) {
      if (attempt >= 1 || ![409, 422].includes(error.status)) throw error;
    }
  }
}

/** One commit on a branch: these files written, these deleted. Fails if the branch moved. */
async function commitToBranch(branch, parentSha, { files, deletions = [], message }) {
  const parent = await gh(repoPath(`/git/commits/${parentSha}`));
  const tree = [];
  for (const file of files) {
    const blob = await gh(repoPath('/git/blobs'), { method: 'POST', body: { content: utf8ToBase64(file.text), encoding: 'base64' } });
    tree.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  for (const path of deletions) tree.push({ path, mode: '100644', type: 'blob', sha: null });
  const newTree = await gh(repoPath('/git/trees'), { method: 'POST', body: { base_tree: parent.tree.sha, tree } });
  const commit = await gh(repoPath('/git/commits'), { method: 'POST', body: { message, tree: newTree.sha, parents: [parentSha] } });
  await gh(repoPath(`/git/refs/heads/${branch}`), { method: 'PATCH', body: { sha: commit.sha, force: false } });
  return commit;
}

/**
 * Takes the unticked changes out of a pull request with one commit on its branch (or
 * closes it when nothing would be left), notes it on the pull request, and for a tool's
 * pull request puts them on the skip list so the tool doesn't propose them again.
 */
async function dropFromPr({ pr, tool, data, dropped, remember, closeInstead }) {
  const lines = dropped.map(describeDropped);
  const count = droppedCount(dropped);
  const body = [
    h('ul', {}, lines.slice(0, 15).map((line) => h('li', {}, line)), lines.length > 15 ? h('li', {}, `…and ${lines.length - 15} more`) : null),
    closeInstead
      ? 'Nothing would be left, so this closes the pull request without merging. The data doesn’t change.'
      : 'They come out of this pull request as one new commit. The Guard then checks it again (about a minute) before you can merge the rest.',
    tool?.reports
      ? remember
        ? `${tool.name} won’t propose ${count === 1 ? 'it' : 'them'} again. To undo: Tools > ${tool.name} > Skipped by you > Allow again.`
        : `The next ${tool.name} run may propose ${count === 1 ? 'it' : 'them'} again.`
      : null,
  ].filter(Boolean);
  const title = closeInstead ? `Drop everything and close #${pr.number}?` : `Drop ${plural(count, 'change')} from #${pr.number}?`;
  if (!(await confirmDialog(title, body, closeInstead ? 'Close pull request' : 'Drop', true))) return;
  const note = `Dropped in Remote Admin by ${state.user.login}:\n\n${lines.map((line) => `- ${line}`).join('\n')}${remember ? `\n\nSaved to ${SKIPPED}, so ${tool.name} won't propose ${count === 1 ? 'it' : 'them'} again.` : ''}`;
  try {
    if (closeInstead) {
      await gh(repoPath(`/pulls/${pr.number}`), { method: 'PATCH', body: { state: 'closed' } });
    } else {
      const ref = await gh(repoPath(`/git/ref/heads/${pr.head.ref}`));
      if (ref.object.sha !== pr.head.sha) {
        return toast('This pull request changed since the page loaded (a new run?). Open Review again and redo your ticks.', true);
      }
      const [headProvenance, baseProvenance] = await Promise.all([
        fileJson(PROVENANCE, pr.head.sha).catch(() => null),
        fileJson(PROVENANCE, data.baseSha).catch(() => null),
      ]);
      const catalogue = structuredClone(data.head);
      const provenance = headProvenance ? structuredClone(headProvenance) : null;
      const position = new Map(catalogue.amiibo.map((entry, index) => [entry.id, index]));
      const freedImages = new Set();
      for (const { item, rows } of dropped) {
        const index = position.get(item.id);
        if (item.kind === 'added') {
          catalogue.amiibo[index] = null;
          freedImages.add(item.entry.image);
          if (provenance) delete provenance[item.id];
        } else if (item.kind === 'promoted') {
          catalogue.amiibo[index] = structuredClone(item.old);
          freedImages.add(item.entry.image);
          if (provenance) {
            delete provenance[item.id];
            if (baseProvenance?.[item.from]) provenance[item.from] = structuredClone(baseProvenance[item.from]);
          }
        } else {
          const entry = catalogue.amiibo[index];
          for (const row of rows) {
            if (row.file) freedImages.add(row.file);
            for (const path of row.paths) {
              restoreField(entry, item.old, path);
              if (provenance) restoreProvenance(provenance, baseProvenance, item.id, path);
            }
          }
        }
      }
      catalogue.amiibo = catalogue.amiibo.filter(Boolean).sort((a, b) => a.id.localeCompare(b.id));
      catalogue.count = catalogue.amiibo.length;
      // A picture file this pull request added goes too, unless an amiibo still uses it (a
      // picture row whose file was all that changed keeps its path, so it's deleted anyway).
      const fileOnly = new Set(dropped.flatMap(({ rows }) => (rows || []).filter((row) => row.file && row.before === null).map((row) => row.file)));
      const inUse = new Set(catalogue.amiibo.map((entry) => entry.image));
      const deletions = [...freedImages].filter((path) => path && data.newFiles.has(path) && (!inUse.has(path) || fileOnly.has(path)));
      const files = [{ path: 'data/catalogue.json', text: catalogueText(catalogue) }];
      if (provenance) files.push({ path: PROVENANCE, text: `${JSON.stringify(provenance, null, 2)}\n` });
      await commitToBranch(pr.head.ref, pr.head.sha, {
        files,
        deletions,
        message: `Drop ${plural(count, 'change')} (Remote Admin)\n\n${lines.map((line) => `- ${line}`).join('\n')}`,
      });
    }
    await gh(repoPath(`/issues/${pr.number}/comments`), { method: 'POST', body: { body: note } }).catch(() => null);
  } catch (error) {
    return toast(`Couldn’t drop them: ${error.message}`, true);
  }
  if (remember) {
    try {
      const edits = (await readMetaList(EDITS).catch(() => ({ data: {} }))).data[tool.id];
      await writeMetaList(SKIPPED, (list) => {
        list[tool.id] = [...(Array.isArray(list[tool.id]) ? list[tool.id] : []), ...dropped.flatMap((drop) => skipEntries(drop, edits))];
      }, `Skip list: ${count} from ${tool.name} (Remote Admin)`);
    } catch (error) {
      toast(`Dropped, but couldn’t save the skip list (${error.message}), so ${tool.name} may propose ${count === 1 ? 'it' : 'them'} again.`, true);
      return showTab('review');
    }
  }
  toast(closeInstead ? `Closed #${pr.number}.` : `Dropped ${plural(count, 'change')}. The Guard is checking #${pr.number} again; merge when it says Ready.`);
  showTab('review');
}

/**
 * Sets values on one amiibo in a pull request before it's merged: one commit on its
 * branch, the fields marked yours ("manual", so the tools never change them), a note on
 * the pull request, and for a tool's pull request the values saved to meta/edits.json, so
 * the tool keeps them when it rebuilds the pull request.
 */
async function editInPr({ pr, tool, data, item, fields, card }) {
  const { entry } = item;
  const suggestions = new Map(['amiiboSeries', 'gameSeries', 'character', 'type'].map((key) =>
    [key, [...new Set(data.head.amiibo.map((other) => other[key]).filter(Boolean))].sort()]));
  const inputs = {};
  const body = [h('p', { class: 'small muted' }, item.kind === 'added'
    ? 'Change anything that’s wrong. Your values are marked as yours, so the tools never change them.'
    : 'Set the value you want instead of the proposed one. It’s marked as yours, so the tools never change it.')];
  for (const path of fields) {
    const isDate = path.startsWith('release.');
    const listId = suggestions.has(path) ? `values-${path}` : null;
    const input = h('input', { value: fieldGet(entry, path) ?? '', placeholder: isDate ? 'YYYY-MM-DD, or empty' : '', autocomplete: 'off', spellcheck: 'false', ...(listId ? { list: listId } : {}) });
    inputs[path] = input;
    const now = item.kind === 'changed' ? fieldGet(item.old, path) : undefined;
    body.push(h('label', {},
      fieldLabel(path),
      item.kind === 'changed' ? h('span', { class: 'muted' }, ` (now: ${now === null ? 'empty' : isDate ? appDate(now) : now})`) : null,
      input));
    if (listId) body.push(h('datalist', { id: listId }, suggestions.get(path).map((value) => h('option', { value }))));
  }
  if (tool?.reports) body.push(h('p', { class: 'small muted' }, `Saved so ${tool.name} keeps them when it rebuilds this pull request. The Guard then checks it again (about a minute).`));
  if (!(await confirmDialog(`Edit ${entry.name}`, body, 'Save'))) return;

  const changes = [];
  const problems = [];
  for (const path of fields) {
    const raw = inputs[path].value.trim();
    const isDate = path.startsWith('release.');
    if (isDate && raw && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) problems.push(`${fieldLabel(path)} must be YYYY-MM-DD.`);
    if (!isDate && !raw) problems.push(`${fieldLabel(path)} can’t be empty.`);
    const value = raw || null;
    if (value !== fieldGet(entry, path)) changes.push([path, value]);
  }
  if (problems.length) return toast(problems.join(' '), true);
  if (!changes.length) return toast('Nothing changed.');
  let newSha = null;
  const lines = changes.map(([path, value]) => `${fieldLabel(path)}: ${value ?? '(empty)'}`);
  try {
    const ref = await gh(repoPath(`/git/ref/heads/${pr.head.ref}`));
    if (ref.object.sha !== pr.head.sha) {
      return toast('This pull request changed since the page loaded (a new run?). Open Review again and redo your edit.', true);
    }
    const catalogue = structuredClone(data.head);
    const target = catalogue.amiibo.find((other) => other.id === item.id);
    for (const [path, value] of changes) {
      if (path.startsWith('release.')) target.release[path.slice(8)] = value;
      else target[path] = value;
    }
    const provenance = structuredClone(data.headProvenance || {});
    provenance[item.id] ??= {};
    for (const [path] of changes) {
      provenance[item.id][path] = { source: 'manual', url: null, retrievedAt: new Date().toISOString(), run: `dashboard:${state.user.login}` };
    }
    newSha = (await commitToBranch(pr.head.ref, pr.head.sha, {
      files: [
        { path: 'data/catalogue.json', text: catalogueText(catalogue) },
        { path: PROVENANCE, text: `${JSON.stringify(provenance, null, 2)}\n` },
      ],
      message: `Your values for ${entry.name} (Remote Admin)\n\n${lines.map((line) => `- ${line}`).join('\n')}`,
    })).sha;
    const note = `Edited in Remote Admin by ${state.user.login}: ${entry.name}\n\n${lines.map((line) => `- ${line}`).join('\n')}${tool?.reports ? `\n\nSaved to ${EDITS}, so ${tool.name} keeps these when it rebuilds this pull request.` : ''}`;
    await gh(repoPath(`/issues/${pr.number}/comments`), { method: 'POST', body: { body: note } }).catch(() => null);
  } catch (error) {
    return toast(`Couldn’t save: ${error.message}`, true);
  }
  if (tool?.reports) {
    try {
      await writeMetaList(EDITS, (list) => {
        const current = Array.isArray(list[tool.id]) ? list[tool.id] : [];
        // A new amiibo by the name and series SNM gives it; an existing one by id.
        const target = item.kind === 'added' ? { match: snmIdentity(entry, current) } : { id: item.id };
        const same = (other) => (target.match ? JSON.stringify(other.match) === JSON.stringify(target.match) : other.id === target.id);
        const name = changes.find(([path]) => path === 'name')?.[1] ?? entry.name;
        const stamp = { at: new Date().toISOString(), by: state.user.login };
        list[tool.id] = [
          ...current.filter((other) => !(same(other) && changes.some(([path]) => path === other.field))),
          ...changes.map(([field, value]) => ({ name, ...target, field, value, ...stamp })),
        ];
      }, `Your values: ${entry.name} (Remote Admin)`);
    } catch (error) {
      toast(`Saved in the pull request, but couldn’t save your values for ${tool.name} (${error.message}), so its next run may undo them.`, true);
      return refreshReviewCard(card, pr.number, item.id, newSha);
    }
  }
  toast(`Saved. The Guard is checking #${pr.number} again; merge when it says Ready.`);
  await refreshReviewCard(card, pr.number, item.id, newSha);
}

/** A tool's saved values on its page, with Forget. */
function editsCard(tool, list) {
  if (!list.length) return null;
  const valueText = (item) => (item.value === null ? 'empty' : /^release\./.test(item.field) ? appDate(item.value) : item.value);
  return h('div', { class: 'card stack' },
    details(`Your values (${list.length})`,
      h('p', { class: 'small muted' }, `Values you set on ${tool.name}’s pull requests before merging. ${tool.name} applies them whenever it rebuilds its pull request. Once merged they’re in the data, marked as yours, so forgetting them then changes nothing.`),
      h('ul', { class: 'list' }, list.map((item) =>
        h('li', { class: 'row spread' },
          h('div', {}, h('div', {}, `${item.name}: ${fieldLabel(item.field)} = ${valueText(item)}`), h('div', { class: 'small muted' }, `Set ${when(item.at)}${item.by ? ` by ${item.by}` : ''}`)),
          h('button', {
            type: 'button',
            class: 'ghost small',
            onclick: async () => {
              try {
                await writeMetaList(EDITS, (data) => {
                  const same = JSON.stringify(item);
                  data[tool.id] = (Array.isArray(data[tool.id]) ? data[tool.id] : []).filter((other) => JSON.stringify(other) !== same);
                }, `Your values: forget ${item.name} ${item.field} (Remote Admin)`);
                toast(`Forgotten. If it isn’t merged yet, ${tool.name}’s next run uses its own value again.`);
                showTab(`tools/${tool.id}`);
              } catch (error) {
                toast(`Couldn’t change your values: ${error.message}`, true);
              }
            },
          }, 'Forget'))))));
}

/** A tool's skip list on its page: what it leaves out, with Allow again. */
function skippedCard(tool, list) {
  if (!list.length) return null;
  const describe = (item) => {
    if (item.from) return `${item.name}: real id ${item.to}`;
    if (!item.field) return `${item.name} (new amiibo, ${item.amiiboSeries})`;
    if (item.value === null || item.value === undefined) return `${item.name} (any value)`;
    return `${item.name} = ${/^release\./.test(item.field) ? appDate(item.value) : item.value}`;
  };
  return h('div', { class: 'card stack' },
    details(`Skipped by you (${list.length})`,
      h('p', { class: 'small muted' }, `You dropped these from ${tool.name}’s pull requests, so it leaves them out. Allow one again and the next run can propose it.`),
      h('ul', { class: 'list' }, list.map((item) =>
        h('li', { class: 'row spread' },
          h('div', {}, h('div', {}, describe(item)), h('div', { class: 'small muted' }, `Dropped ${when(item.at)}${item.by ? ` by ${item.by}` : ''}`)),
          h('button', {
            type: 'button',
            class: 'ghost small',
            onclick: async () => {
              try {
                await writeMetaList(SKIPPED, (data) => {
                  const same = JSON.stringify(item);
                  data[tool.id] = (Array.isArray(data[tool.id]) ? data[tool.id] : []).filter((entry) => JSON.stringify(entry) !== same);
                }, `Skip list: allow ${item.name} again (Remote Admin)`);
                toast(`${tool.name} can propose ${item.name} again.`);
                showTab(`tools/${tool.id}`);
              } catch (error) {
                toast(`Couldn’t change the skip list: ${error.message}`, true);
              }
            },
          }, 'Allow again'))))));
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
  const [report, index, run] = await Promise.all([
    fileJson(`${tool.id}/reports/${runId}.json`, REPORTS_BRANCH),
    fileJson(`${tool.id}/index.json`, REPORTS_BRANCH).catch(() => null),
    /^\d+$/.test(runId) ? gh(repoPath(`/actions/runs/${runId}`)).catch(() => null) : null,
  ]);
  if (!report) throw new Error('Report not found.');
  // The index is newest first: the run before this one is the next entry.
  const list = index || [];
  const position = list.findIndex((entry) => String(entry.runId) === String(runId));
  const previousEntry = position >= 0 ? list[position + 1] : list.find((entry) => Date.parse(entry.startedAt) < Date.parse(report.startedAt));
  const [previous, pr] = await Promise.all([
    previousEntry ? fileJson(`${tool.id}/reports/${previousEntry.runId}.json`, REPORTS_BRANCH).catch(() => null) : null,
    !report.dryRun && tool.branch ? findRunPr(tool, report).catch(() => null) : null,
  ]);
  view(
    h('div', { class: 'card stack' },
      h('div', { class: 'row spread' },
        h('h2', {}, `${tool.name} · ${report.dryRun ? 'dry run' : 'pull request run'}`),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'ghost', onclick: () => showTab(`tools/${tool.id}`) }, `All ${tool.name} runs`),
          report.runUrl ? link('Log on GitHub', report.runUrl) : null)),
      runSummary(tool, report, { run, pr, previous })),
    h('div', { class: 'card stack' }, h('h2', {}, 'Details'), reportSections(tool, report, null)),
    h('div', { class: 'card stack' },
      h('h2', {}, 'Share this report'),
      h('p', { class: 'small muted' }, 'To ask about a run, copy it as text and paste it into the chat.'),
      h('div', { class: 'row' },
        h('button', { type: 'button', onclick: () => copyText(reportToText(tool, report)) }, 'Copy as text'),
        h('button', { type: 'button', class: 'ghost', onclick: () => download(`${tool.id}-run-${report.runId}.txt`, reportToText(tool, report), 'text/plain') }, 'Download .txt'),
        h('button', { type: 'button', class: 'ghost', onclick: () => download(`${tool.id}-run-${report.runId}.json`, JSON.stringify(report, null, 2), 'application/json') }, 'Download .json'))),
  );
}

/** The pull request a run opened or updated: its body names the run, else the one open at the time. */
async function findRunPr(tool, report) {
  const owner = state.repo.split('/')[0];
  const pulls = await gh(repoPath(`/pulls?state=all&head=${encodeURIComponent(`${owner}:${tool.branch}`)}&per_page=10`));
  const start = Date.parse(report.startedAt);
  const end = Date.parse(report.finishedAt || report.startedAt) + 15 * 60000;
  return pulls.find((pr) => (pr.body || '').includes(`run ${report.runId}`))
    || pulls.find((pr) => Date.parse(pr.created_at) <= end && (pr.closed_at ? Date.parse(pr.closed_at) : Date.now()) >= start)
    || null;
}

// What each kind of guess in an SNM report is about, most important first.
const GUESS_KINDS = [
  [/is new to the catalogue/, 'new amiibo series'],
  [/^amiibo series taken from/, 'amiibo series'],
  [/^game series/, 'game series'],
  [/^type assumed/, 'type'],
  [/^character/, 'character'],
];

/** A new amiibo's guesses worth a look: a character taken from the name hardly ever is. */
function importantGuesses(item) {
  return (item.guessed || []).filter((text) => !/^character /.test(text));
}

/** Notes about the whole amiibo rather than one field ("released before our newest amiibo…"). */
function wholeNotes(guessed) {
  return (guessed || []).filter((text) => /before our newest amiibo|placeholder icon/.test(text));
}

/** SNM: new amiibo, real ids, and what a person should look at. */
function explainSnm(report) {
  const sections = report.sections || {};
  const added = sections.added || [];
  const promoted = sections.promoted || [];
  const found = [];
  if (added.length) found.push(`${added.length} new amiibo`);
  if (promoted.length) found.push(`the real id of ${plural(promoted.length, 'amiibo', 'amiibo')} we added with a temporary one`);

  const check = [];
  const info = [];
  const counts = new Map();
  let guessed = 0;
  let characters = 0;
  const missed = added.filter((item) => (item.guessed || []).some((text) => /before our newest amiibo/.test(text)));
  if (missed.length) check.push(`${someNames(missed.map((item) => item.name))} came out before our newest amiibo but ${missed.length === 1 ? 'isn’t' : 'aren’t'} in the catalogue (AmiiboAPI missed ${missed.length === 1 ? 'it' : 'them'}). Check ${missed.length === 1 ? 'it’s' : 'they’re'} really missing.`);
  for (const item of added) {
    const important = importantGuesses(item).filter((text) => !/before our newest amiibo/.test(text));
    if (important.length) guessed++;
    if (important.length < (item.guessed?.length || 0)) characters++;
    for (const text of important) {
      const kind = GUESS_KINDS.find(([pattern]) => pattern.test(text))?.[1] || 'other';
      counts.set(kind, (counts.get(kind) || 0) + 1);
    }
  }
  if (guessed) {
    const order = [...GUESS_KINDS.map(([, kind]) => kind), 'other'];
    const kinds = [...counts].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([kind, n]) => `${kind} ${n}`);
    check.push(`${guessed === added.length ? 'All of them have' : `${guessed} of them have`} guessed details (${kinds.join(', ')}). They’re marked in orange in the list; untick any you don’t want, or fix them in Catalogue after merging.`);
  }
  if (characters) info.push(`Characters were taken from the names (${characters === added.length ? 'all' : characters}); fine for most, fix any odd one in Catalogue.`);
  const placeholder = added.filter((item) => item.image === 'placeholder').length;
  if (placeholder) check.push(`${plural(placeholder, 'has', 'have')} no picture yet: the app shows our icon until Update Database finds one.`);
  const byHand = (sections.unmatched || []).filter((item) => /add by hand/.test(item.reason || '')).length;
  if (byHand) check.push(`${plural(byHand, 'amiibo looks', 'amiibo look')} new, but no source gave a series, so ${byHand === 1 ? 'it wasn’t' : 'they weren’t'} added. Add ${byHand === 1 ? 'it' : 'them'} in Catalogue if real (see “Not added”).`);
  if (sections.ambiguous?.length) check.push(`${plural(sections.ambiguous.length, 'name matches', 'names match')} more than one amiibo we have, so the tool couldn’t tell if ${sections.ambiguous.length === 1 ? 'it’s' : 'they’re'} new (see “Same name as more than one”).`);

  if (sections.skipped?.length) info.push(`${plural(sections.skipped.length, 'item')} you dropped before left out (see “Skipped by you”).`);
  if (sections.unmatched?.length) info.push(`${plural(sections.unmatched.length, 'listing')} from the sources weren’t added; almost all are amiibo we already have (see “Not added”).`);
  return { found: found.length > 0, headline: found.length ? `Found ${joinAnd(found)}.` : 'No new amiibo found.', check, info };
}

const WHY_TEXT = {
  'was empty': 'fill an empty field',
  'replaces a guess': 'replace a value a tool guessed',
  'had no picture': 'add a missing picture',
  'AmiiboAPI and amiibo life agree': 'correct a release date both sources agree on',
  'your value': 'set to your value',
};

/** Update Database: how many fields on how many amiibo, and why. */
function explainDbUpdate(report) {
  const sections = report.sections || {};
  const changes = sections.changes || [];
  const amiibo = new Set(changes.map((change) => change.id)).size;
  const tally = (list, keyOf) => list.reduce((map, item) => map.set(keyOf(item), (map.get(keyOf(item)) || 0) + 1), new Map());
  const what = [...tally(changes, (change) => (change.field === 'image' ? 'picture' : /^release\./.test(change.field) ? 'release date' : 'detail'))]
    .map(([kind, n]) => plural(n, kind));
  const why = [...tally(changes, (change) => change.why)].map(([reason, n]) => `${n} ${WHY_TEXT[reason] || reason}`);

  const info = [];
  if (why.length === 1 && changes.length > 1) info.push(`All of them ${WHY_TEXT[changes[0].why] || changes[0].why}.`);
  else if (why.length) info.push(`${joinAnd(why)}.`);
  if (sections.disagreements?.length) info.push(`${plural(sections.disagreements.length, 'value')} where a source disagrees with ours: left as they are (see “A source disagrees”).`);
  if (sections.kept?.length) info.push(`${plural(sections.kept.length, 'edit')} you made by hand kept.`);
  if (sections.skipped?.length) info.push(`${plural(sections.skipped.length, 'change')} you dropped before left out (see “Skipped by you”).`);
  if (sections.notMatched?.length) info.push(`${plural(sections.notMatched.length, 'same-name amiibo', 'same-name amiibo')} from another series ignored.`);

  const check = [];
  const corrected = changes.filter((change) => change.why === 'AmiiboAPI and amiibo life agree').length;
  if (corrected) check.push(`${plural(corrected, 'release date')} that we already had ${corrected === 1 ? 'is' : 'are'} corrected because both sources agree. Worth a quick look in Changes.`);
  return {
    found: changes.length > 0,
    headline: changes.length ? `${plural(changes.length, 'change')} to ${plural(amiibo, 'amiibo', 'amiibo')}: ${joinAnd(what)}.` : 'Nothing to change.',
    check,
    info,
  };
}

/** For tools without their own explain(): the size of each list. */
function explainGeneric(report, tool) {
  const parts = Object.entries(report.sections || {}).filter(([, items]) => items.length)
    .map(([key, items]) => `${tool.sections?.[key]?.title || key}: ${items.length}`);
  return { found: parts.length > 0, headline: parts.length ? `${parts.join(' · ')}.` : 'Nothing found.', check: [], info: [] };
}

function duration(report) {
  const ms = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
  if (!(ms > 0)) return '';
  return ms < 60000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60000)} min`;
}

/**
 * A run in plain words: what it found, what happened to it, what to check and what to do
 * next. ctx: run (its GitHub run), pr (the pull request it opened), previous (the report
 * before it), review (on a pull request card: no outcome or next step), compact (tool page).
 */
function runSummary(tool, report, ctx = {}) {
  const explained = (tool.explain || explainGeneric)(report, tool);
  const guard = report.guard?.outcome || null;
  const errors = report.errors || [];
  const runFailed = ctx.run?.status === 'completed' && ctx.run.conclusion !== 'success';
  const box = h('div', { class: 'summary stack' },
    h('div', { class: 'row small' },
      ctx.review ? null : pill(report.dryRun ? 'Dry run' : 'Pull request run', report.dryRun ? '' : 'ok'),
      guardPill(guard),
      errors.length ? pill(plural(errors.length, 'error'), 'warn') : pill('no errors', 'ok'),
      h('span', { class: 'muted' }, `${ctx.review ? 'Run ' : ''}${when(report.startedAt)}${duration(report) ? ` · took ${duration(report)}` : ''}`)),
    h('p', { class: 'headline' }, explained.headline));

  if (!ctx.review) {
    const outcome = outcomeLine(report, explained, ctx, runFailed);
    box.append(h('p', { class: outcome.kind }, outcome.text));
  }
  const check = [
    ...(errors.length ? [`${plural(errors.length, 'error')} while reading the sources, so this run may have missed some. See Errors in the full report.`] : []),
    ...explained.check,
  ];
  if (check.length) {
    box.append(h('div', { class: 'to-check' },
      h('strong', {}, ctx.review ? 'Check before merging' : 'Worth checking'),
      h('ul', {}, check.map((line) => h('li', {}, line)))));
  }
  if (explained.info?.length) box.append(h('ul', { class: 'info small muted' }, explained.info.map((line) => h('li', {}, line))));
  const sources = sourcesLine(report);
  if (sources) box.append(sources);
  const compared = ctx.previous ? compareLine(tool, report, ctx.previous) : null;
  if (compared) box.append(h('p', { class: 'small' }, compared));
  if (!ctx.review) {
    const next = nextStep(tool, report, explained, ctx, runFailed);
    if (next) box.append(next);
  }
  return box;
}

/** What became of the run's results: dry run, pull request (and its state), or blocked. */
function outcomeLine(report, explained, ctx, runFailed) {
  const guard = report.guard?.outcome;
  const where = ctx.compact ? 'in the full report' : 'below';
  if (guard === 'failure') {
    return {
      kind: 'error',
      text: report.dryRun
        ? `The Guard would block these results (they change or remove something), so a pull request run wouldn’t open a pull request. See Guard ${where}.`
        : `The Guard blocked these results (they change or remove something), so no pull request was opened. See Guard ${where}.`,
    };
  }
  if (runFailed || (guard && guard !== 'success')) return { kind: 'error', text: 'The run failed after the search, so nothing was proposed. The log says why.' };
  if (report.dryRun) return { kind: 'muted', text: 'Dry run: nothing was changed and no pull request was opened.' };
  if (!explained.found) return { kind: 'muted', text: 'Nothing to propose, so no pull request was opened.' };
  const pr = ctx.pr;
  if (!pr) return { kind: 'muted', text: 'Proposed as a pull request.' };
  if (pr.merged_at) return { kind: 'ok', text: `Proposed in pull request #${pr.number}, merged ${when(pr.merged_at)}.` };
  if (pr.state === 'closed') return { kind: 'muted', text: `Proposed in pull request #${pr.number}, closed without merging.` };
  return { kind: 'warn', text: `Proposed in pull request #${pr.number}, waiting for your review.` };
}

function nextStep(tool, report, explained, ctx, runFailed) {
  const logUrl = ctx.run?.html_url || report.runUrl;
  if (report.guard?.outcome === 'failure' || runFailed) {
    return logUrl ? h('div', { class: 'row next' }, h('span', { class: 'small' }, 'Next: open the log to see why.'), link('Open the log', logUrl)) : null;
  }
  if (report.dryRun && explained.found) {
    return h('div', { class: 'next stack' },
      h('p', { class: 'small' }, 'Next: if these look right, Run and open PR proposes them as a pull request. It searches again, so the result can differ slightly. Nothing changes until you merge.'),
      h('div', {}, h('button', { type: 'button', onclick: () => runTool(tool, false, report.options || {}) }, 'Run and open PR')));
  }
  if (!report.dryRun && explained.found && ctx.pr?.state === 'open') {
    return h('div', { class: 'next stack' },
      h('p', { class: 'small' }, 'Next: look it over in Review (it has a preview of how it looks in the app), then merge.'),
      h('div', {}, h('button', { type: 'button', onclick: () => showTab('review') }, `Review #${ctx.pr.number}`)));
  }
  if (!explained.found) return h('p', { class: 'small muted' }, 'Nothing to do.');
  return null;
}

/** "Read: AmiiboAPI 932 · amiibo life 964 · …", with failures called out. */
function sourcesLine(report) {
  const entries = Object.entries(report.sources || {});
  if (!entries.length) return null;
  const failed = entries.filter(([, source]) => source.failed > 0);
  const parts = entries.map(([name, source]) =>
    !source.read && !source.failed ? `${name}: ${source.note || 'not read'}` : `${name} ${source.read}${source.failed ? ` (${source.failed} failed)` : ''}${source.note ? ` (${source.note})` : ''}`);
  return h('p', { class: `small ${failed.length ? 'warn' : 'muted'}` },
    `Read: ${parts.join(' · ')}. ${failed.length ? `Some pages from ${joinAnd(failed.map(([name]) => name))} couldn’t be read, so the results may be incomplete.` : 'Nothing failed.'}`);
}

/** How this run's main list differs from the run before it. */
function compareLine(tool, report, previous) {
  const meta = tool.sections?.[tool.main];
  if (!meta?.key) return null;
  const now = report.sections?.[tool.main] || [];
  const before = previous.sections?.[tool.main] || [];
  const beforeKeys = new Set(before.map(meta.key));
  const nowKeys = new Set(now.map(meta.key));
  const fresh = now.filter((item) => !beforeKeys.has(meta.key(item)));
  const gone = before.filter((item) => !nowKeys.has(meta.key(item)));
  const since = `the previous run (${when(previous.startedAt)})`;
  if (!fresh.length && !gone.length) return now.length ? `Same ${meta.title.toLowerCase()} as ${since}.` : null;
  const parts = [];
  if (fresh.length) parts.push(`${fresh.length} not in ${since}: ${someNames(fresh.map((item) => item.name))}`);
  if (gone.length) parts.push(`${gone.length} from ${fresh.length ? 'it' : since} ${gone.length === 1 ? 'is' : 'are'} gone (merged since, or a source changed)`);
  return `Compared with before: ${parts.join('; ')}.`;
}

// ─── Report lists ───────────────────────────────────────────────────

const FIELD_LABELS = {
  'release.na': 'Release date, North America',
  'release.eu': 'Release date, Europe',
  'release.jp': 'Release date, Japan',
  'release.au': 'Release date, Australia',
  image: 'Picture',
  imageFallback: 'Backup picture',
  character: 'Character',
  gameSeries: 'Game series',
  amiiboSeries: 'amiibo series',
  series: 'amiibo series',
  type: 'Type',
  name: 'Name',
  source: 'Data source',
};
const fieldLabel = (field) => FIELD_LABELS[field] || field;

function fieldValue(field, value) {
  if (value === null || value === undefined || value === '') return h('span', { class: 'muted' }, 'empty');
  if (field === 'image') {
    if (value === 'placeholder') return 'our icon (no picture)';
    if (value === 'missing') return h('span', { class: 'muted' }, 'none');
    return /^https:/.test(value) ? link('new picture', value) : 'picture';
  }
  if (/^release\./.test(field) && /^\d{4}-\d\d-\d\d$/.test(value)) return appDate(value);
  return String(value);
}

function amiiboCell(item) {
  return h('div', {}, h('strong', {}, item.name), h('div', { class: 'small muted' }, h('code', {}, item.id)));
}

function sourceNote(item) {
  return h('div', { class: 'small muted' }, item.source || '', item.url ? [item.source ? ' · ' : '', link('page', item.url)] : null);
}

function details(summary, ...children) {
  return h('details', {}, h('summary', {}, summary), ...children);
}

/** Readable reasons for SNM's "Not added" lines; anything else is shown as written. */
function reasonText(reason) {
  const older = reason.match(/^not in the catalogue under this name \(released before (\d{4}-\d\d-\d\d)\)/);
  if (older) return `Older than our newest amiibo (${appDate(older[1])}), so not treated as new. Probably one we have under another name.`;
  if (/add by hand/.test(reason)) return h('span', { class: 'warn' }, 'Looks new, but no source gave its series. Add it in Catalogue if it’s real.');
  if (/same name as more than one/.test(reason)) return 'Same name as more than one amiibo we have.';
  return reason.charAt(0).toUpperCase() + reason.slice(1);
}

/**
 * A table that stays short: the first 30 rows, "Show all", and a filter box once it's
 * long. rows: { cells: [...], text: what the filter searches }.
 */
function bigTable(headers, rows) {
  const LIMIT = 30;
  const tbody = h('tbody');
  let showAll = rows.length <= LIMIT;
  let query = '';
  const more = h('button', { type: 'button', class: 'ghost small', onclick: () => { showAll = true; render(); } }, `Show all ${rows.length}`);
  const empty = h('p', { class: 'small muted', hidden: true }, 'Nothing matches.');
  const render = () => {
    const matching = query ? rows.filter((row) => row.text.includes(query)) : rows;
    const shown = showAll || query ? matching : matching.slice(0, LIMIT);
    tbody.replaceChildren(...shown.map((row) => h('tr', {}, row.cells.map((cell) => h('td', {}, cell)))));
    more.hidden = showAll || Boolean(query) || matching.length <= LIMIT;
    empty.hidden = matching.length > 0;
  };
  const filter = rows.length > LIMIT
    ? h('input', { type: 'search', class: 'filter', placeholder: 'Filter this list', autocomplete: 'off', oninput: (event) => { query = event.target.value.trim().toLowerCase(); render(); } })
    : null;
  render();
  return h('div', { class: 'stack' },
    filter,
    h('div', { class: 'table-wrap' }, h('table', { class: 'compact' }, h('thead', {}, h('tr', {}, headers.map((title) => h('th', {}, title)))), tbody)),
    empty,
    more);
}

/** Path of a new amiibo's picture in the repo (the placeholder icon when it has none). */
function addedImagePath(item) {
  if (item.image === 'placeholder') return PLACEHOLDER_IMAGE;
  return item.id.startsWith('ob-') ? `images/amiibo/${item.id}.webp` : `images/amiibo/${item.id.slice(0, 8)}-${item.id.slice(8)}.webp`;
}

function addedList(items, prBranch) {
  const today = new Date().toISOString().slice(0, 10);
  return h('ul', { class: 'list' }, items.map((item) => {
    const facts = [
      item.releaseDate ? `${item.releaseDate > today ? 'Releases' : 'Released'} ${appDate(item.releaseDate)}` : 'No release date yet',
      item.image === 'placeholder' ? 'no picture yet (our icon)' : 'has a picture',
      item.sources?.length ? `from ${joinAnd(item.sources)}` : null,
      item.id.startsWith('ob-') ? `temporary id ${item.id}` : `id ${item.id}`,
      item.yours?.length ? `your values: ${item.yours.map(fieldLabel).join(', ')}` : null,
    ].filter(Boolean);
    return h('li', { class: 'row top' },
      prBranch ? repoImage(addedImagePath(item), prBranch, item.name) : null,
      h('div', { class: 'grow' },
        h('div', {}, h('strong', {}, item.name), h('span', { class: 'muted' }, ` · ${item.amiiboSeries}`)),
        h('div', { class: 'small muted' }, facts.join(' · '), item.url ? [' · ', link('page', item.url)] : null),
        importantGuesses(item).length ? h('div', { class: 'small warn' }, `Check: ${importantGuesses(item).join('; ')}`) : null));
  }));
}

/** A report list drawn to fit what's in it: new amiibo, changes, disagreements, ids or listings. */
function sectionBody(key, items) {
  const first = items[0];
  const text = (...parts) => parts.filter(Boolean).join(' ').toLowerCase();
  if (key === 'skipped') {
    return bigTable(['amiibo', 'Left out'], items.map((item) => ({
      text: text(item.name, item.amiiboSeries, item.id),
      cells: [item.id ? amiiboCell(item) : [h('strong', {}, item.name), item.amiiboSeries ? h('div', { class: 'small muted' }, item.amiiboSeries) : null],
        item.what || (item.value ? [fieldLabel(item.field), ': ', fieldValue(item.field, item.value)] : `${fieldLabel(item.field)} (any value)`)],
    })));
  }
  if (first.field && 'from' in first && 'to' in first) {
    return bigTable(['amiibo', 'What', 'Was', 'Now', 'Why'], items.map((item) => ({
      text: text(item.name, item.id, fieldLabel(item.field)),
      cells: [amiiboCell(item), fieldLabel(item.field), fieldValue(item.field, item.from), fieldValue(item.field, item.to),
        [WHY_TEXT[item.why] ? WHY_TEXT[item.why].replace(/^./, (c) => c.toUpperCase()) : item.why, sourceNote(item)]],
    })));
  }
  if (first.field && 'ours' in first) {
    return bigTable(['amiibo', 'What', 'Ours', 'Source says', ''], items.map((item) => ({
      text: text(item.name, item.id, fieldLabel(item.field)),
      cells: [amiiboCell(item), fieldLabel(item.field), fieldValue(item.field, item.ours), [fieldValue(item.field, item.theirs), sourceNote(item)],
        h('button', { type: 'button', class: 'ghost small', onclick: () => showTab(`catalogue/${encodeURIComponent(item.id)}`) }, 'Edit')],
    })));
  }
  if (first.field && 'value' in first) {
    return bigTable(['amiibo', 'What', 'Now', 'From'], items.map((item) => ({
      text: text(item.name, item.id, fieldLabel(item.field)),
      cells: [amiiboCell(item), fieldLabel(item.field), fieldValue(item.field, item.value), sourceNote(item)],
    })));
  }
  if (first.from && first.to && !first.field) {
    return bigTable(['amiibo', 'Temporary id', 'Real id'], items.map((item) => ({
      text: text(item.name, item.from, item.to),
      cells: [h('strong', {}, item.name), h('code', {}, item.from), h('code', {}, item.to)],
    })));
  }
  if ('reason' in first) {
    // Lines that need a person first.
    const sorted = [...items].sort((a, b) => Number(/add by hand/.test(b.reason)) - Number(/add by hand/.test(a.reason)));
    return bigTable(['Name', 'Series', 'Released', 'Why'], sorted.map((item) => {
      const [source, ...rest] = item.reason.split(': ');
      const reason = rest.length ? rest.join(': ') : item.reason;
      return {
        text: text(item.name, item.series),
        cells: [item.url ? link(item.name, item.url) : item.name, item.series || '—', item.releaseDate ? appDate(item.releaseDate) : '—',
          [reasonText(reason), rest.length ? h('div', { class: 'small muted' }, `from ${source}`) : null]],
      };
    }));
  }
  return h('ul', { class: 'list small' }, items.slice(0, 400).map((item) =>
    h('li', {}, itemText(item).replace(/ \| https:\S+$/, ''), item.url ? [' ', link('page', item.url)] : null)));
}

/** The Guard's verdict in a sentence, its reasons when it blocked, the rest folded away. */
function guardBlock(report) {
  const text = report.guard?.report;
  if (!text) return null;
  const clean = (value) => value.replace(/\*\*/g, '').replace(/`/g, '').replace(/^#+\s*/gm, '');
  const blocks = text.trim().split(/\n\n+/);
  const blocked = report.guard.outcome === 'failure';
  return h('div', { class: 'stack' },
    h('h3', {}, 'Guard'),
    h('p', { class: blocked ? 'error' : '' }, clean(blocks[0])),
    h('p', { class: 'small muted' }, 'The Guard makes sure a pull request only adds amiibo and fills empty fields. Changed values, removals and very large changes are blocked unless the pull request has a label that allows them.'),
    blocked && blocks[1] ? h('ul', { class: 'small error' }, blocks[1].split('\n').map((line) => h('li', {}, clean(line.replace(/^- /, ''))))) : null,
    blocks.length > 1 ? details('Full Guard report', h('pre', {}, clean(blocks.slice(1).join('\n\n')))) : null);
}

/** Each list in the report with what it means, then errors, the Guard and the run log. */
function reportSections(tool, report, prBranch, { omit = [] } = {}) {
  const wrap = h('div', { class: 'stack' });
  const sections = report.sections || {};
  const order = [...Object.keys(tool.sections), ...Object.keys(sections).filter((key) => !(key in tool.sections))]
    .filter((key) => !omit.includes(key));
  for (const key of order) {
    const items = sections[key] || [];
    if (!items.length) continue;
    const meta = tool.sections[key] || { title: key };
    const help = meta.help ? h('p', { class: 'small muted' }, meta.help) : null;
    const body = key === tool.main && items[0].amiiboSeries !== undefined && items[0].id ? addedList(items, prBranch) : sectionBody(key, items);
    if (meta.fold) wrap.append(details(`${meta.title} (${items.length})`, help, body));
    else wrap.append(h('h3', {}, `${meta.title} (${items.length})`), ...[help, body].filter(Boolean));
  }
  if (!wrap.childNodes.length) wrap.append(h('p', { class: 'muted' }, 'Nothing listed in this run.'));
  if (report.errors?.length) {
    wrap.append(h('h3', {}, `Errors (${report.errors.length})`), h('ul', { class: 'list small' }, report.errors.map((error) => h('li', { class: 'error' }, error))));
  }
  const guard = guardBlock(report);
  if (guard) wrap.append(guard);
  if (report.log?.length) {
    wrap.append(details('Run log (technical)', h('pre', {}, report.log.map((line) => (line.length > 300 ? `${line.slice(0, 300)}…` : line)).join('\n'))));
  }
  return wrap;
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

/** The whole report as plain text: the summary, every item, the guard result and the run log. */
function reportToText(tool, report) {
  const explained = (tool.explain || explainGeneric)(report, tool);
  const lines = [
    `${tool.title} run ${report.runId}`,
    `Started: ${report.startedAt}  Finished: ${report.finishedAt || '?'}`,
    `Kind: ${report.dryRun ? 'dry run' : 'pull request run'}  Guard: ${report.guard?.outcome || '?'}${report.options ? `  Options: ${Object.entries(report.options).map(([key, value]) => `${key}=${value}`).join(', ')}` : ''}`,
    report.runUrl ? `Log: ${report.runUrl}` : '',
    '',
    `RESULT: ${explained.headline}`,
    ...explained.check.map((line) => `CHECK: ${line}`),
    ...(explained.info || []).map((line) => `NOTE: ${line}`),
    '',
    'SOURCES',
    ...Object.entries(report.sources || {}).map(([name, s]) => `  ${name}: ${s.read} read, ${s.failed} failed${s.note ? ` (${s.note})` : ''}`),
  ];
  for (const [key, items] of Object.entries(report.sections || {})) {
    lines.push('', `${(tool.sections[key]?.title || key).toUpperCase()} (${items.length})`);
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
      if ($('#token-expires').value) setTokenExpiry($('#token-expires').value);
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
      const expires = tokenExpiry();
      if (expires && daysUntil(expires) <= EXPIRY_WARN_DAYS) toast(daysUntil(expires) < 0 ? 'Your token has expired: see Home.' : `Your token expires in ${plural(daysUntil(expires), 'day')}: see Home.`, true);
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


// ─── News (announcements in the app's News tab) ────────────────────

const NEWS_TITLE_MAX = 200;
const NEWS_BODY_MAX = 2000;

/**
 * When the News workflow next runs at or after `time` (it runs every 3 hours at :41 UTC, and
 * when you save here). A scheduled announcement appears, and one with an end date leaves, then.
 */
function nextNewsUpdate(time) {
  const at = new Date(time);
  const next = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), Math.floor(at.getUTCHours() / 3) * 3, 41));
  while (next.getTime() < at.getTime()) next.setUTCHours(next.getUTCHours() + 3);
  return next.toISOString();
}

function announcementState(item, now = Date.now()) {
  if (item.expiresAt && Date.parse(item.expiresAt) <= now) return ['ended', ''];
  if (Date.parse(item.publishedAt) > now) return ['scheduled', 'warn'];
  return ['showing', 'ok'];
}

/**
 * The News tab: your announcements (add, end, remove) and the headlines the app shows now.
 * Saving changes meta/announcements.json on main, which starts the News workflow: the app
 * has it within about 5 minutes of the next time it checks.
 */
async function showNews() {
  loading('Loading news…');
  const [{ data }, published] = await Promise.all([
    readMetaList(ANNOUNCEMENTS),
    fileJson('data/news.json', 'main').catch(() => null),
  ]);
  const items = Array.isArray(data.items) ? data.items : [];
  const save = async (mutate, message, done) => {
    try {
      await writeMetaList(ANNOUNCEMENTS, (file) => {
        file.items = Array.isArray(file.items) ? file.items : [];
        mutate(file.items);
      }, message);
      toast(`${done} The app shows it after the News update runs (a few minutes).`);
      showTab('news');
    } catch (error) {
      toast(`Couldn’t save: ${error.message}`, true);
    }
  };

  const title = h('input', { maxlength: NEWS_TITLE_MAX, placeholder: 'e.g. Data updates paused tonight', autocomplete: 'off' });
  const body = h('textarea', { rows: 4, maxlength: NEWS_BODY_MAX, placeholder: 'What people should know. Plain text.' });
  const url = h('input', { placeholder: 'https://… (optional)', autocomplete: 'off', spellcheck: 'false' });
  const from = h('input', { type: 'datetime-local' });
  const until = h('input', { type: 'date' });
  const pinned = h('input', { type: 'checkbox' });
  const counter = h('span', { class: 'small muted' }, `0 / ${NEWS_BODY_MAX}`);
  body.addEventListener('input', () => { counter.textContent = `${body.value.length} / ${NEWS_BODY_MAX}`; });
  const post = async () => {
    const problems = [];
    if (!title.value.trim()) problems.push('Add a title.');
    if (!body.value.trim()) problems.push('Add some text.');
    if (url.value.trim() && !/^https:\/\/\S+$/.test(url.value.trim())) problems.push('The link must start with https://.');
    const expiresAt = until.value ? new Date(`${until.value}T23:59:59`).toISOString() : null;
    const startsAt = from.value ? new Date(from.value).toISOString() : null;
    if (startsAt && Date.parse(startsAt) <= Date.now()) problems.push('“Show from” must be in the future (leave it empty to post now).');
    if (expiresAt && Date.parse(expiresAt) <= Date.now()) problems.push('“Show until” must be in the future.');
    if (startsAt && expiresAt && Date.parse(expiresAt) <= Date.parse(startsAt)) problems.push('“Show until” must be after “Show from”.');
    if (problems.length) return toast(problems.join(' '), true);
    const item = {
      id: `${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}`,
      title: title.value.trim(),
      body: body.value.trim(),
      url: url.value.trim() || null,
      publishedAt: startsAt || new Date().toISOString(),
      expiresAt,
      pinned: pinned.checked,
    };
    const timing = startsAt
      ? `Scheduled: it appears in the app at the first News update after ${when(startsAt)}, around ${when(nextNewsUpdate(startsAt))}.`
      : 'It appears in the app within a few minutes.';
    if (!(await confirmDialog(startsAt ? 'Schedule this announcement?' : 'Post this announcement?', [h('strong', {}, item.title), item.body, item.url ? link(item.url, item.url) : null, h('p', { class: 'small muted' }, timing)].filter(Boolean), startsAt ? 'Schedule' : 'Post'))) return;
    await save((list) => list.push(item), `News: ${startsAt ? 'schedule' : ''}${startsAt ? ' ' : ''}${item.title} (Remote Admin)`, startsAt ? 'Scheduled.' : 'Posted.');
  };

  const rows = [...items].sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt))).map((item) => {
    const [state, kind] = announcementState(item);
    return h('li', { class: 'stack' },
      h('div', { class: 'row spread' },
        h('div', {},
          h('strong', {}, item.title), ' ', pill(state, kind), item.pinned ? pill('pinned') : null,
          h('div', { class: 'small muted' }, state === 'scheduled'
            ? `Starts ${when(item.publishedAt)} (in the app around ${when(nextNewsUpdate(item.publishedAt))})${item.expiresAt ? ` · shows until ${when(item.expiresAt)}` : ''}`
            : `Posted ${when(item.publishedAt)}${item.expiresAt ? ` · shows until ${when(item.expiresAt)}` : ''}`)),
        h('div', { class: 'row' },
          state === 'showing' ? h('button', {
            type: 'button',
            class: 'ghost small',
            onclick: async () => {
              if (!(await confirmDialog('End this announcement?', 'It disappears from the app at the next News update. It stays listed here.', 'End it'))) return;
              save((list) => { const target = list.find((other) => other.id === item.id); if (target) target.expiresAt = new Date().toISOString(); }, `News: end ${item.title} (Remote Admin)`, 'Ended.');
            },
          }, 'End now') : null,
          h('button', {
            type: 'button',
            class: 'ghost small danger',
            onclick: async () => {
              if (!(await confirmDialog('Remove this announcement?', 'It’s deleted from the list and disappears from the app at the next News update.', 'Remove', true))) return;
              save((list) => { const at = list.findIndex((other) => other.id === item.id); if (at >= 0) list.splice(at, 1); }, `News: remove ${item.title} (Remote Admin)`, 'Removed.');
            },
          }, 'Remove'))),
      h('p', { class: 'small' }, item.body),
      item.url ? h('div', { class: 'small' }, link(item.url, item.url)) : null);
  });

  const headlines = (published?.items || []).filter((item) => item.kind === 'article');
  view(
    h('div', { class: 'card stack' },
      h('h2', {}, 'Post an announcement'),
      h('p', { class: 'small muted' }, 'Shown in the app’s News tab as “From Amiibo Companion”: maintenance, changes, disclosures. Plain text only. Pinned ones stay at the top.'),
      h('label', {}, 'Title', title),
      h('label', {}, 'Text', body, counter),
      h('label', {}, 'Link (optional)', url),
      h('div', { class: 'row' },
        h('label', {}, 'Show from (optional, your time)', from),
        h('label', {}, 'Show until (optional)', until),
        h('label', { class: 'check' }, pinned, 'Pin to the top')),
      h('p', { class: 'small muted' }, 'Leave “Show from” empty to post now. A scheduled one appears at the first News update after that time: updates run every 3 hours, so it can be up to 3 hours late. Ends work the same way.'),
      h('div', { class: 'row' }, h('button', { type: 'button', onclick: post }, 'Post'))),
    h('div', { class: 'card stack' },
      h('h2', {}, `Your announcements (${items.length})`),
      items.length ? h('ul', { class: 'list' }, rows) : h('p', { class: 'muted' }, 'None yet.')),
    h('div', { class: 'card stack' },
      h('h2', {}, `Headlines in the app (${headlines.length})`),
      h('p', { class: 'small muted' }, 'amiibo stories from Nintendo Life and Nintendo’s UK news feed, checked every 3 hours. The app shows the title, site and date, and opens the story on the site.'),
      headlines.length
        ? h('ul', { class: 'list small' }, headlines.slice(0, 30).map((item) => h('li', {}, link(item.title, item.url), h('span', { class: 'muted' }, ` · ${item.source} · ${when(item.publishedAt)}`))))
        : h('p', { class: 'muted' }, 'None yet.')),
  );
}

// ─── Banner (the message banner at the top of the app) ────────────────

const BANNER_FILE = 'data/banner.json';
const LIVE_BANNER_URL = 'https://oddbolt.github.io/amiibo-cdn/data/banner.json';
const BANNER_LIMITS = { title: 60, message: 280, linkLabel: 24 };
/** The icon's ray colours, plus your own with Custom. */
const BANNER_COLORS = [
  ['Blue', '#009FE3'],
  ['Green', '#00965E'],
  ['Lime', '#8CC63F'],
  ['Yellow', '#F5A800'],
  ['Red', '#E4002B'],
  ['Grey', '#3A3F4B'],
];
const HEX = /^#[0-9a-fA-F]{6}$/;

/** WCAG contrast between two #RRGGBB colours, same maths as the app (src/banner/color.ts). */
function contrastRatio(a, b) {
  const lum = (hex) => {
    const c = (i) => {
      const v = parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * c(1) + 0.7152 * c(3) + 0.0722 * c(5);
  };
  const [light, dark] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** Black or white text, whichever the app will use on this colour. */
const bannerTextColor = (hex) => (contrastRatio(hex, '#0E1014') >= contrastRatio(hex, '#FFFFFF') ? '#0E1014' : '#FFFFFF');

function bannerState(banner, now = Date.now()) {
  if (banner.endsAt && Date.parse(banner.endsAt) <= now) return ['ended', ''];
  if (banner.startsAt && Date.parse(banner.startsAt) > now) return ['scheduled', 'warn'];
  return ['showing', 'ok'];
}

/** The banner as the app draws it (colour, black or white text, link, close button). */
function bannerPreview(banner) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'bp-icon');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02z');
  path.setAttribute('fill', 'currentColor');
  svg.append(path);
  const el = h('div', { class: 'banner-preview' },
    svg,
    h('div', { class: 'bp-text' },
      h('strong', {}, banner.title || 'Title'),
      banner.message ? h('p', {}, banner.message) : null,
      banner.link ? h('span', { class: 'bp-link' }, `${banner.linkLabel || 'Learn more'} ›`) : null),
    banner.dismissible ? h('span', { class: 'bp-close', 'aria-label': 'Close button' }, '×') : null);
  const color = HEX.test(banner.color) ? banner.color : '#3A3F4B';
  el.style.backgroundColor = color;
  el.style.color = bannerTextColor(color);
  return el;
}

/** "2026-11-28T21:30" for a datetime-local field, in this computer's time zone. */
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function readBannerFile() {
  try {
    const meta = await gh(repoPath(`/contents/${BANNER_FILE}?ref=main`));
    return { sha: meta.sha, data: JSON.parse(base64ToUtf8(meta.content)) };
  } catch (error) {
    if (error.status === 404) return { sha: null, data: { banner: null } };
    throw error;
  }
}

/**
 * Writes data/banner.json straight on main (one notice, nothing to review); the push starts
 * Publish, which checks it and puts it online. Retries once if it changed meanwhile.
 */
async function writeBannerFile(banner, message) {
  for (let attempt = 0; ; attempt++) {
    const { sha } = await readBannerFile();
    try {
      await gh(repoPath(`/contents/${BANNER_FILE}`), {
        method: 'PUT',
        body: { message, content: utf8ToBase64(`${JSON.stringify({ banner }, null, 2)}\n`), branch: 'main', ...(sha ? { sha } : {}) },
      });
      return;
    } catch (error) {
      if (attempt >= 1 || ![409, 422].includes(error.status)) throw error;
    }
  }
}

/**
 * The Banner tab: the short notice at the top of every app screen except Settings
 * (maintenance, warnings). Not news: longer posts go in the News tab.
 */
async function showBanner() {
  loading('Loading banner…');
  const [{ data }, live] = await Promise.all([
    readBannerFile(),
    fetch(LIVE_BANNER_URL, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  const saved = data.banner ?? null;
  const online = live?.banner ?? null;
  const start = saved ?? { title: '', message: '', color: BANNER_COLORS[0][1], link: null, linkLabel: null, dismissible: true, startsAt: null, endsAt: null };

  const title = h('input', { maxlength: BANNER_LIMITS.title, value: start.title, placeholder: 'e.g. Maintenance tonight', autocomplete: 'off' });
  const message = h('textarea', { rows: 3, maxlength: BANNER_LIMITS.message, placeholder: 'One or two short sentences (optional).' });
  message.value = start.message;
  const linkInput = h('input', { value: start.link ?? '', placeholder: 'https://… (optional)', autocomplete: 'off', spellcheck: 'false' });
  const linkLabel = h('input', { maxlength: BANNER_LIMITS.linkLabel, value: start.linkLabel ?? '', placeholder: 'Learn more', autocomplete: 'off' });
  const dismissible = h('input', { type: 'checkbox' });
  dismissible.checked = start.dismissible;
  const startsAt = h('input', { type: 'datetime-local', value: toLocalInput(start.startsAt) });
  const endsAt = h('input', { type: 'datetime-local', value: toLocalInput(start.endsAt) });
  let color = start.color;
  const picker = h('input', { type: 'color', value: color.toLowerCase(), 'aria-label': 'Custom colour' });
  const hex = h('input', { value: color.toUpperCase(), maxlength: 7, class: 'hex', spellcheck: 'false', 'aria-label': 'Colour code' });
  const titleCount = h('span', { class: 'small muted' });
  const messageCount = h('span', { class: 'small muted' });
  const previewBox = h('div', {});
  const readability = h('p', { class: 'small' });

  const swatches = BANNER_COLORS.map(([name, value]) => {
    const swatch = h('button', { type: 'button', class: 'swatch', title: name, 'aria-label': name, onclick: () => setColor(value) });
    swatch.style.backgroundColor = value;
    swatch.dataset.color = value;
    return swatch;
  });

  const current = () => ({
    title: title.value.trim(),
    message: message.value.trim(),
    color,
    link: linkInput.value.trim() || null,
    linkLabel: linkInput.value.trim() && linkLabel.value.trim() ? linkLabel.value.trim() : null,
    dismissible: dismissible.checked,
    startsAt: startsAt.value ? new Date(startsAt.value).toISOString() : null,
    endsAt: endsAt.value ? new Date(endsAt.value).toISOString() : null,
  });

  const refresh = () => {
    titleCount.textContent = `${title.value.length} / ${BANNER_LIMITS.title}`;
    messageCount.textContent = `${message.value.length} / ${BANNER_LIMITS.message}`;
    for (const swatch of swatches) swatch.classList.toggle('selected', swatch.dataset.color.toLowerCase() === color.toLowerCase());
    previewBox.replaceChildren(bannerPreview(current()));
    const ratio = contrastRatio(color, bannerTextColor(color));
    readability.textContent = ratio >= 4.5
      ? `Easy to read (contrast ${ratio.toFixed(1)}:1).`
      : `Hard to read on this colour (contrast ${ratio.toFixed(1)}:1, aim for 4.5). Pick a darker or lighter shade.`;
    readability.className = `small ${ratio >= 4.5 ? 'muted' : 'error'}`;
  };
  function setColor(value) {
    color = value.toUpperCase();
    picker.value = color.toLowerCase();
    hex.value = color;
    refresh();
  }
  picker.addEventListener('input', () => setColor(picker.value));
  hex.addEventListener('input', () => {
    const value = hex.value.trim().startsWith('#') ? hex.value.trim() : `#${hex.value.trim()}`;
    if (HEX.test(value)) setColor(value);
  });
  for (const field of [title, message, linkInput, linkLabel, dismissible, startsAt, endsAt]) field.addEventListener('input', refresh);
  refresh();

  const post = async () => {
    const banner = current();
    const problems = [];
    if (!banner.title) problems.push('Add a title.');
    if (!HEX.test(banner.color)) problems.push('Pick a colour.');
    if (banner.link && !/^https:\/\/\S+$/.test(banner.link)) problems.push('The link must start with https://.');
    if (banner.endsAt && Date.parse(banner.endsAt) <= Date.now()) problems.push('“Ends” must be in the future.');
    if (banner.startsAt && banner.endsAt && Date.parse(banner.endsAt) <= Date.parse(banner.startsAt)) problems.push('“Ends” must be after “Starts”.');
    if (problems.length) return toast(problems.join(' '), true);
    // A new id every time: everyone sees it, even people who closed the previous banner.
    const posted = { id: `b-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}`, ...banner };
    const when_ = [posted.startsAt ? `Starts ${when(posted.startsAt)}.` : 'Shows right away.', posted.endsAt ? `Ends ${when(posted.endsAt)}.` : 'Stays until you remove it.'].join(' ');
    if (!(await confirmDialog(saved ? 'Replace the banner?' : 'Post this banner?', [bannerPreview(posted), when_, 'Everyone sees it, including people who closed the previous banner.'], saved ? 'Replace' : 'Post'))) return;
    try {
      await writeBannerFile(posted, `Banner: ${posted.title} (Remote Admin)`);
      toast('Saved. It’s online in about a minute; phones pick it up within 10–20 minutes.');
      showTab('banner');
    } catch (error) {
      toast(`Couldn’t save: ${error.message}`, true);
    }
  };

  const remove = async () => {
    if (!(await confirmDialog('Remove the banner?', 'It disappears from the app the next time phones check (within 10–20 minutes).', 'Remove', true))) return;
    try {
      await writeBannerFile(null, 'Banner: removed (Remote Admin)');
      toast('Removed. Phones drop it within 10–20 minutes.');
      showTab('banner');
    } catch (error) {
      toast(`Couldn’t save: ${error.message}`, true);
    }
  };

  let status;
  if (!saved) status = h('p', { class: 'muted' }, 'No banner. The app shows nothing.');
  else {
    const [stateText, kind] = bannerState(saved);
    const isOnline = online?.id === saved.id;
    status = h('div', { class: 'stack' },
      h('div', { class: 'row' }, pill(stateText, kind), pill(isOnline ? 'online' : 'publishing…', isOnline ? 'ok' : 'warn'),
        h('span', { class: 'small muted' }, [saved.startsAt ? `from ${when(saved.startsAt)}` : null, saved.endsAt ? `until ${when(saved.endsAt)}` : 'until you remove it'].filter(Boolean).join(' · '))),
      bannerPreview(saved),
      isOnline ? null : h('p', { class: 'small muted' }, 'Saved, not online yet: Publish takes about a minute, and the site caches files for up to 10 minutes. Reload this tab to check again.'),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'ghost danger', onclick: remove }, 'Remove banner')));
  }

  view(
    h('div', { class: 'card stack' },
      h('h2', {}, 'Current banner'),
      h('p', { class: 'small muted' }, 'Shown at the top of every screen in the app except Settings. For short notices (maintenance, warnings); longer posts belong in News.'),
      status),
    h('div', { class: 'card stack' },
      h('h2', {}, saved ? 'Change the banner' : 'Post a banner'),
      h('label', {}, 'Title', title, titleCount),
      h('label', {}, 'Message', message, messageCount),
      h('div', { class: 'stack' },
        h('span', { class: 'label' }, 'Colour'),
        h('div', { class: 'swatches' }, swatches, h('span', { class: 'small muted' }, 'Custom'), picker, hex),
        readability),
      h('div', { class: 'pair' },
        h('label', {}, 'Link (optional)', linkInput),
        h('label', {}, 'Link text', linkLabel)),
      h('div', { class: 'pair' },
        h('label', {}, 'Starts (optional, your time)', startsAt),
        h('label', {}, 'Ends (optional, your time)', endsAt)),
      h('label', { class: 'check' }, dismissible, 'People can close it (turn off for notices everyone must see)'),
      h('span', { class: 'label' }, 'Preview'),
      previewBox,
      h('div', { class: 'row' }, h('button', { type: 'button', onclick: post }, saved ? 'Replace banner' : 'Post banner'))),
  );
}

// ─── Links (store links: data/links.json) ───────────────────────────

const LINKS_FILE = 'data/links.json';
/** Same lists as RETAILER_HOSTS in amiibo-data's data-schema.mts and the app's links.ts. */
const RETAILER_HOSTS = { amazon: ['amazon.com', 'amzn.to'], bestbuy: ['bestbuy.com'], walmart: ['walmart.com'] };
const LINK_STATUS = {
  ok: ['checked ok', 'ok'],
  unverified: ['not checked', ''],
  suspect: ['suspect', 'warn'],
  broken: ['broken (hidden)', 'error'],
};
const TRACKING_PARAM = /^(utm_|ref$|ref_$|tag$|linkCode$|linkId$|psc$|th$|pd_rd|pf_rd|content-id$|irclickid$|irgwc$|wmlspartner$|affiliates_ad_id$|campaign_id$|clickid$|sourceid$|veh$|sharedid$|acampid$|afsrc$|loc$|mpid$)/i;

function isStoreUrl(url, retailer) {
  if (typeof url !== 'string' || !/^https:\/\/[a-z0-9.-]+(:\d+)?([/?#]|$)/i.test(url)) return false;
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  const allowed = RETAILER_HOSTS[retailer.id] ?? [String(retailer.domain).toLowerCase()];
  return allowed.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/**
 * A pasted store address → the product id and a clean direct link (no tracking, no
 * reviews/sku tails). Returns { error } when it isn't a product page of that store.
 */
function parseStoreUrl(raw, retailer) {
  const text = String(raw || '').trim();
  if (!text) return { error: 'Paste the product page address.' };
  let url;
  try {
    url = new URL(text);
  } catch {
    return { error: 'That isn’t a web address.' };
  }
  if (url.protocol !== 'https:') return { error: 'The address must start with https://.' };
  if (!isStoreUrl(url.href, retailer)) return { error: `That address isn’t on ${retailer.name}’s site.` };
  const path = url.pathname;
  if (retailer.id === 'amazon') {
    if (/(^|\.)amzn\.to$/i.test(url.hostname)) return { error: 'Short amzn.to links can’t be read: open it and paste the full amazon.com address.' };
    const asin = path.match(/\/(?:dp|gp\/product|gp\/aw\/d|clp|product)\/([A-Z0-9]{10})(?:[/?]|$)/i)?.[1];
    if (!asin) return { error: 'Couldn’t find the product id (ASIN) in that Amazon address.' };
    return { productId: asin.toUpperCase(), directUrl: `https://www.amazon.com/dp/${asin.toUpperCase()}` };
  }
  if (retailer.id === 'walmart') {
    const id = path.match(/\/ip\/(?:[^/]+\/)?(\d{5,})(?:[/?]|$)/)?.[1];
    if (!id) return { error: 'Couldn’t find the item number in that Walmart address (…/ip/…/123456789).' };
    return { productId: id, directUrl: `https://www.walmart.com/ip/${id}` };
  }
  if (retailer.id === 'bestbuy') {
    const modern = path.match(/^\/product\/([^/]+)\/([A-Z0-9]{8,})(?:\/|$)/i);
    if (modern) return { productId: modern[2].toUpperCase(), directUrl: `https://www.bestbuy.com/product/${modern[1]}/${modern[2].toUpperCase()}` };
    const sku = url.searchParams.get('skuId') || path.match(/\/(\d{7,})\.p$/)?.[1];
    if (sku && /^\d{6,}$/.test(sku)) return { productId: sku, directUrl: `https://www.bestbuy.com/site/${sku}.p?skuId=${sku}` };
    return { error: 'Couldn’t find the product id in that Best Buy address.' };
  }
  // Another store: keep the page, drop tracking parameters.
  for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
  url.hash = '';
  const last = path.split('/').filter(Boolean).pop();
  if (!last) return { error: 'Paste a product page, not the store’s home page.' };
  return { productId: last, directUrl: url.href };
}

/** An affiliate address: kept exactly as pasted (it carries the tracking), but it must be https and on the store's hosts. */
function checkAffiliateUrl(raw, retailer) {
  const text = String(raw || '').trim();
  if (!text) return { url: null };
  if (!isStoreUrl(text, retailer)) {
    return { error: `The affiliate link for ${retailer.name} must be https and on ${(RETAILER_HOSTS[retailer.id] || [retailer.domain]).join(' or ')}. Add a new tracking host to RETAILER_HOSTS (app and data) first.` };
  }
  return { url: text };
}

function aliasOwners(catalogue) {
  const map = new Map();
  for (const entry of catalogue.amiibo) for (const alias of entry.aliases || []) map.set(alias, entry.id);
  return map;
}

/** Links grouped by the amiibo's current id (a link added under a temporary id follows its alias). */
function linksByAmiibo(file, catalogue) {
  const aliases = aliasOwners(catalogue);
  const map = new Map();
  for (const item of file.links) {
    const id = aliases.get(item.amiiboId) ?? item.amiiboId;
    if (!map.has(id)) map.set(id, new Map());
    map.get(id).set(item.retailerId, item);
  }
  return map;
}

async function loadLinks() {
  const file = await fileJson(LINKS_FILE);
  if (!file || !Array.isArray(file.links) || !Array.isArray(file.retailers)) throw new Error(`${LINKS_FILE} is missing or unreadable.`);
  return file;
}

function linkStatusPill(item) {
  if (!item) return pill('—');
  const [text, kind] = LINK_STATUS[item.directStatus] || [item.directStatus, ''];
  return pill(text, kind);
}

function linksText(file) {
  return `${JSON.stringify(file, null, 2)}\n`;
}

async function showLinks(id) {
  loading('Loading store links…');
  const [catalogue, file] = await Promise.all([loadCatalogue(), loadLinks()]);
  if (id) return showLinkEntry(decodeURIComponent(id), catalogue, file);
  const byAmiibo = linksByAmiibo(file, catalogue);
  const retailers = file.retailers;
  const search = h('input', { type: 'search', placeholder: 'Search name, id, series…', autocomplete: 'off' });
  const filter = h('select', {},
    h('option', { value: 'recent' }, 'Figures from the last 2 years'),
    h('option', { value: 'linked' }, 'With links'),
    h('option', { value: 'gaps' }, 'With links, missing a store'),
    h('option', { value: 'none' }, 'No links'),
    h('option', { value: 'trouble' }, 'Suspect or broken'),
    h('option', { value: 'all' }, 'All amiibo'));
  const body = h('tbody');
  const count = h('span', { class: 'muted small' });
  const since = new Date(Date.now() - 2 * 365 * 86400000).toISOString().slice(0, 10);
  const newest = (entry) => REGIONS.map((r) => entry.release[r]).filter(Boolean).sort()[0] || '';
  const render = () => {
    const q = search.value.trim().toLowerCase();
    const matches = catalogue.amiibo.filter((entry) => {
      const links = byAmiibo.get(entry.id);
      const n = links ? links.size : 0;
      if (filter.value === 'recent' && !(entry.type === 'Figure' && (entry.id.startsWith('ob-') || newest(entry) >= since))) return false;
      if (filter.value === 'linked' && !n) return false;
      if (filter.value === 'gaps' && !(n && n < retailers.length)) return false;
      if (filter.value === 'none' && n) return false;
      if (filter.value === 'trouble' && ![...(links?.values() || [])].some((item) => item.directStatus === 'suspect' || item.directStatus === 'broken')) return false;
      if (!q) return true;
      return `${entry.name} ${entry.id} ${entry.amiiboSeries} ${entry.gameSeries}`.toLowerCase().includes(q);
    }).sort((a, b) => newest(b).localeCompare(newest(a)) || a.name.localeCompare(b.name));
    const total = [...byAmiibo.values()].reduce((sum, links) => sum + links.size, 0);
    count.textContent = `${matches.length} amiibo shown · ${total} links for ${byAmiibo.size} amiibo in all`;
    body.replaceChildren(...matches.slice(0, 200).map((entry) => {
      const links = byAmiibo.get(entry.id) || new Map();
      return h('tr', { class: 'clickable', onclick: () => showTab(`links/${encodeURIComponent(entry.id)}`, entry.id) },
        h('td', {}, amiiboImage(entry)),
        h('td', {}, h('strong', {}, entry.name), h('div', { class: 'small muted' }, `${entry.amiiboSeries} · ${newest(entry) || 'no date'}`)),
        ...retailers.map((retailer) => h('td', {}, h('div', { class: 'small muted' }, retailer.name), linkStatusPill(links.get(retailer.id)))));
    }));
  };
  search.addEventListener('input', render);
  filter.addEventListener('change', render);
  view(
    h('div', { class: 'card stack' },
      h('h2', {}, 'Store links'),
      h('p', { class: 'small muted' }, 'The “Where to buy” buttons in the app. Pick an amiibo to add, change or remove its links; every change opens a pull request you merge in Review. The weekly check marks a link suspect after one failed check and broken (hidden in the app) after two; stores often block the check, which changes nothing.'),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, search), h('div', {}, filter)),
      h('div', { class: 'row spread' }, count,
        h('button', { type: 'button', class: 'ghost', onclick: () => { state.catalogue = null; showTab('links'); } }, 'Reload'))),
    h('div', { class: 'card table-wrap' }, h('table', {}, body)),
  );
  render();
  search.focus();
}

function showLinkEntry(id, catalogue, file) {
  const entry = catalogue.amiibo.find((item) => item.id === id);
  if (!entry) throw new Error(`No amiibo with id ${id}.`);
  const current = linksByAmiibo(file, catalogue).get(entry.id) || new Map();
  const forms = file.retailers.map((retailer) => {
    const item = current.get(retailer.id) || null;
    const direct = h('input', { value: item?.directUrl || '', placeholder: `Paste the ${retailer.name} product page`, autocomplete: 'off', spellcheck: 'false' });
    const affiliate = h('input', { value: item?.affiliateUrl || '', placeholder: 'Affiliate link (optional, once the program approves)', autocomplete: 'off', spellcheck: 'false' });
    const remove = item ? h('input', { type: 'checkbox' }) : null;
    const parsed = h('div', { class: 'small muted' });
    const showParsed = () => {
      if (!direct.value.trim()) return (parsed.textContent = item ? 'Empty: tick “Remove” to delete this link.' : '');
      const result = parseStoreUrl(direct.value, retailer);
      parsed.replaceChildren(result.error ? h('span', { class: 'error' }, result.error) : h('span', {}, 'Saves as ', link(result.directUrl, result.directUrl), ` · product id ${result.productId}`));
    };
    direct.addEventListener('input', showParsed);
    showParsed();
    const node = h('div', { class: 'card stack' },
      h('div', { class: 'row spread' },
        h('h3', {}, retailer.name),
        item ? h('div', { class: 'row small' }, linkStatusPill(item), item.verifiedAt ? h('span', { class: 'muted' }, `last ok ${item.verifiedAt}`) : null) : pill('no link')),
      item ? h('div', { class: 'small' }, 'Now: ', link(item.directUrl, item.directUrl), item.affiliateUrl ? h('div', {}, 'Affiliate: ', link(item.affiliateUrl, item.affiliateUrl), ' ', linkStatusPill({ directStatus: item.affiliateStatus })) : null) : null,
      h('label', {}, 'Product page', direct), parsed,
      h('label', {}, 'Affiliate link', affiliate),
      remove ? h('label', { class: 'check' }, remove, `Remove the ${retailer.name} link`) : null);
    return { retailer, item, direct, affiliate, remove, node };
  });

  const propose = async () => {
    const problems = [];
    const changes = [];
    for (const form of forms) {
      const { retailer, item } = form;
      if (form.remove?.checked) {
        changes.push({ retailer, kind: 'removed', before: item, after: null });
        continue;
      }
      const directText = form.direct.value.trim();
      const affiliateText = form.affiliate.value.trim();
      if (!directText) {
        if (affiliateText) problems.push(`${retailer.name}: add the product page too.`);
        continue;
      }
      const parsed = parseStoreUrl(directText, retailer);
      if (parsed.error) { problems.push(`${retailer.name}: ${parsed.error}`); continue; }
      const aff = checkAffiliateUrl(affiliateText, retailer);
      if (aff.error) { problems.push(`${retailer.name}: ${aff.error}`); continue; }
      if (item && item.directUrl === parsed.directUrl && (item.affiliateUrl || null) === aff.url) continue;
      const after = {
        amiiboId: item?.amiiboId || entry.id,
        retailerId: retailer.id,
        productId: parsed.productId,
        directUrl: parsed.directUrl,
        affiliateUrl: aff.url,
        directStatus: item && item.directUrl === parsed.directUrl ? item.directStatus : 'unverified',
        affiliateStatus: item && item.affiliateUrl === aff.url ? item.affiliateStatus : 'unverified',
        verifiedAt: item && item.directUrl === parsed.directUrl ? item.verifiedAt : null,
        method: 'manual',
      };
      changes.push({ retailer, kind: item ? 'changed' : 'added', before: item, after });
    }
    if (problems.length) return toast(problems.join(' '), true);
    if (!changes.length) return toast('Nothing changed.');
    const lines = changes.map(({ retailer, kind, before, after }) => (kind === 'added'
      ? `${retailer.name}: new ${after.directUrl}${after.affiliateUrl ? ` (affiliate ${after.affiliateUrl})` : ''}`
      : kind === 'removed'
        ? `${retailer.name}: remove ${before.directUrl}`
        : `${retailer.name}: ${before.directUrl === after.directUrl ? '' : `${before.directUrl} → ${after.directUrl}`}${(before.affiliateUrl || null) !== after.affiliateUrl ? `${before.directUrl === after.directUrl ? '' : '; '}affiliate ${before.affiliateUrl || '(none)'} → ${after.affiliateUrl || '(none)'}` : ''}`));
    const changesExisting = changes.some((change) => change.kind === 'changed'
      && (change.before.directUrl !== change.after.directUrl || (change.before.affiliateUrl && change.before.affiliateUrl !== change.after.affiliateUrl)));
    const removes = changes.some((change) => change.kind === 'removed');
    const labels = [changesExisting && 'allow-changes', removes && 'allow-removals'].filter(Boolean);
    if (!(await confirmDialog(`Propose store links for ${entry.name}?`, [h('pre', {}, lines.join('\n')), labels.length ? `Labels so the Guard accepts it: ${labels.join(', ')}.` : 'Only adds links.'], 'Open pull request'))) return;
    try {
      const fresh = await loadLinks(); // edit the latest main, not the copy loaded earlier
      const freshById = linksByAmiibo(fresh, catalogue).get(entry.id) || new Map();
      for (const change of changes) {
        const existing = freshById.get(change.retailer.id);
        if (change.kind === 'added' && existing) throw new Error(`${change.retailer.name} already has a link now. Reload and try again.`);
        if (change.kind !== 'added' && (!existing || existing.directUrl !== change.before.directUrl)) throw new Error(`The ${change.retailer.name} link changed since you opened this page. Reload and try again.`);
        if (change.kind === 'removed') fresh.links.splice(fresh.links.indexOf(existing), 1);
        else if (change.kind === 'changed') fresh.links[fresh.links.indexOf(existing)] = change.after;
        else fresh.links.push(change.after);
      }
      const pr = await proposeChange({
        branch: `admin/links-${entry.id}-${stamp()}`,
        title: `Store links for ${entry.name}`,
        body: `Edited in the dashboard by @${state.user.login}.\n\n${lines.map((line) => `- ${line}`).join('\n')}`,
        files: [{ path: LINKS_FILE, text: linksText(fresh) }],
        labels,
      });
      toast(`Opened #${pr.number}. Merge it in Review.`);
      showTab('review');
    } catch (error) {
      toast(`Couldn’t open the pull request: ${error.message}`, true);
    }
  };

  view(
    h('div', { class: 'card' },
      h('div', { class: 'row spread' },
        h('div', { class: 'row' }, amiiboImage(entry, 'big-thumb'),
          h('div', {}, h('h2', {}, entry.name), h('code', {}, entry.id),
            h('div', { class: 'small muted' }, `${entry.amiiboSeries} · ${entry.type}`))),
        h('button', { type: 'button', class: 'ghost', onclick: () => showTab('links') }, 'Back')),
      h('p', { class: 'small muted' }, 'Paste the store’s own product page for the official Nintendo product (not a reseller or import listing). Tracking and review tails are removed; the product id is read from the address.')),
    ...forms.map((form) => form.node),
    h('div', { class: 'card row' },
      h('button', { type: 'button', onclick: propose }, 'Propose these changes'),
      h('span', { class: 'small muted' }, 'Opens a pull request. Nothing goes live until you merge it in Review.')),
  );
}

/** What a pull request does to the store links: added, changed and removed, per amiibo and store. */
async function prLinkChanges(pr) {
  const compare = await gh(repoPath(`/compare/main...${pr.head.sha}?per_page=1`));
  const baseSha = compare.merge_base_commit.sha;
  const [base, head, catalogue] = await Promise.all([
    fileJson(LINKS_FILE, baseSha),
    fileJson(LINKS_FILE, pr.head.sha),
    fileJson('data/catalogue.json', pr.head.sha),
  ]);
  return diffLinks(base || { links: [] }, head || { links: [] }, catalogue || { amiibo: [] });
}

function diffLinks(base, head, catalogue) {
  const key = (item) => `${item.amiiboId}/${item.retailerId}`;
  const before = new Map(base.links.map((item) => [key(item), item]));
  const after = new Map(head.links.map((item) => [key(item), item]));
  const aliases = aliasOwners(catalogue);
  const byId = new Map(catalogue.amiibo.map((entry) => [entry.id, entry]));
  const stores = new Map([...(base.retailers || []), ...(head.retailers || [])].map((retailer) => [retailer.id, retailer.name]));
  const rows = [];
  for (const [k, item] of after) {
    const old = before.get(k);
    if (!old) rows.push({ kind: 'added', item, old: null });
    else if (old.directUrl !== item.directUrl || (old.affiliateUrl || null) !== (item.affiliateUrl || null)) rows.push({ kind: 'changed', item, old });
  }
  for (const [k, old] of before) if (!after.has(k)) rows.push({ kind: 'removed', item: null, old });
  for (const row of rows) {
    const id = (row.item || row.old).amiiboId;
    row.entry = byId.get(aliases.get(id) ?? id) || null;
    row.store = stores.get((row.item || row.old).retailerId) || (row.item || row.old).retailerId;
  }
  rows.sort((a, b) => (a.entry?.name || '').localeCompare(b.entry?.name || '') || a.store.localeCompare(b.store));
  return rows;
}

function linkChangesView(rows) {
  const kinds = { added: ['New', 'ok'], changed: ['Changed', 'warn'], removed: ['Removed', 'error'] };
  const urls = (item) => (item
    ? h('div', { class: 'small' }, link(item.directUrl, item.directUrl), item.affiliateUrl ? h('div', {}, 'affiliate: ', link(item.affiliateUrl, item.affiliateUrl)) : null)
    : h('span', { class: 'muted small' }, '—'));
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Amiibo'), h('th', {}, 'Store'), h('th', {}, 'Now'), h('th', {}, 'After merge'))),
    h('tbody', {}, rows.map((row) => h('tr', {},
      h('td', {}, pill(...kinds[row.kind])),
      h('td', {}, row.entry ? h('div', { class: 'row' }, amiiboImage(row.entry), h('div', {}, h('strong', {}, row.entry.name), h('div', { class: 'small muted' }, row.entry.amiiboSeries))) : h('code', {}, (row.item || row.old).amiiboId)),
      h('td', {}, row.store),
      h('td', {}, urls(row.old)),
      h('td', {}, urls(row.item)))))));
}
