const state = { mode: 'login', user: null, events: [], stores: [], watchTab: 'events' };
const $ = (id) => document.getElementById(id);
const INTERVALS = [
  [5, 'Every 5 minutes'], [10, 'Every 10 minutes'], [15, 'Every 15 minutes'],
  [30, 'Every 30 minutes'], [60, 'Every hour'], [180, 'Every 3 hours'],
  [360, 'Every 6 hours'], [720, 'Every 12 hours'], [1440, 'Every day'],
];

const authView = $('authView');
const dashboardView = $('dashboardView');
const logoutButton = $('logoutButton');
const authForm = $('authForm');
const loginTab = $('loginTab');
const registerTab = $('registerTab');
const authSubmit = $('authSubmit');
const authError = $('authError');
const emailInput = $('emailInput');
const passwordInput = $('passwordInput');
const accountLine = $('accountLine');
const verificationBox = $('verificationBox');
const addForm = $('addForm');
const addError = $('addError');
const eventsEl = $('events');
const emptyState = $('emptyState');
const eventCount = $('eventCount');
const archivedEventsEl = $('archivedEvents');
const eventArchiveSection = $('eventArchiveSection');
const archivedEventCount = $('archivedEventCount');
const lgsAddForm = $('lgsAddForm');
const lgsAddError = $('lgsAddError');
const lgsStoresEl = $('lgsStores');
const lgsEmptyState = $('lgsEmptyState');
const lgsCount = $('lgsCount');
const archivedLgsStoresEl = $('archivedLgsStores');
const lgsArchiveSection = $('lgsArchiveSection');
const archivedLgsCount = $('archivedLgsCount');
const themeToggle = $('themeToggle');
const themeLabel = $('themeLabel');

loginTab.addEventListener('click', () => setAuthMode('login'));
registerTab.addEventListener('click', () => setAuthMode('register'));
authForm.addEventListener('submit', onAuthSubmit);
logoutButton.addEventListener('click', onLogout);
addForm.addEventListener('submit', onAddEvent);
lgsAddForm.addEventListener('submit', onAddLgs);
$('refreshButton').addEventListener('click', loadEvents);
$('lgsRefreshButton').addEventListener('click', loadStores);
$('resendVerification').addEventListener('click', resendVerification);
$('eventWatchTab').addEventListener('click', () => setWatchTab('events'));
$('lgsWatchTab').addEventListener('click', () => setWatchTab('lgs'));
themeToggle.addEventListener('click', toggleTheme);

fillIntervalSelect($('checkInterval'));
fillIntervalSelect($('lgsCheckInterval'));
init();

async function init() {
  syncThemeUi();
  if (new URL(location.href).searchParams.get('verified') === '1') history.replaceState({}, '', '/');

  const data = await api('/api/me').catch(() => ({ user: null }));
  state.user = data.user;
  renderSession();
  if (state.user) await Promise.all([loadEvents(), loadStores()]);
}

function toggleTheme() {
  const current = document.documentElement.dataset.theme || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('event-watch-theme', next);
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', next === 'dark' ? '#0c0d0f' : '#f4f4f1');
  syncThemeUi();
}

function syncThemeUi() {
  const current = document.documentElement.dataset.theme || 'dark';
  const nextLabel = current === 'dark' ? 'Light' : 'Dark';
  themeLabel.textContent = nextLabel;
  themeToggle.querySelector('.theme-icon').textContent = current === 'dark' ? '☀' : '☾';
  themeToggle.setAttribute('aria-label', `Switch to ${nextLabel.toLowerCase()} mode`);
}

function setAuthMode(mode) {
  state.mode = mode;
  loginTab.classList.toggle('active', mode === 'login');
  registerTab.classList.toggle('active', mode === 'register');
  authSubmit.textContent = mode === 'login' ? 'Sign in' : 'Create account';
  passwordInput.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  authError.textContent = '';
}

function setWatchTab(tab) {
  state.watchTab = tab;
  const eventsActive = tab === 'events';
  $('eventWatchTab').classList.toggle('active', eventsActive);
  $('lgsWatchTab').classList.toggle('active', !eventsActive);
  $('eventPane').classList.toggle('hidden', !eventsActive);
  $('lgsPane').classList.toggle('hidden', eventsActive);
}

async function onAuthSubmit(event) {
  event.preventDefault();
  authError.textContent = '';
  authSubmit.disabled = true;
  try {
    const endpoint = state.mode === 'login' ? '/api/auth/login' : '/api/auth/register';
    const data = await api(endpoint, {
      method: 'POST',
      body: { email: emailInput.value, password: passwordInput.value },
    });
    state.user = data.user;
    authForm.reset();
    renderSession();
    await Promise.all([loadEvents(), loadStores()]);
  } catch (error) {
    authError.textContent = error.message;
  } finally {
    authSubmit.disabled = false;
  }
}

async function onLogout() {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  state.user = null;
  state.events = [];
  state.stores = [];
  renderSession();
}

function renderSession() {
  const signedIn = Boolean(state.user);
  authView.classList.toggle('hidden', signedIn);
  dashboardView.classList.toggle('hidden', !signedIn);
  logoutButton.classList.toggle('hidden', !signedIn);
  if (!signedIn) return;
  accountLine.textContent = state.user.email;
  verificationBox.classList.toggle('hidden', state.user.emailVerified);
  setWatchTab(state.watchTab);
}

async function loadEvents() {
  if (!state.user) return;
  try {
    const data = await api('/api/events');
    state.events = data.events || [];
    renderEvents();
  } catch (error) {
    addError.textContent = error.message;
  }
}

async function loadStores() {
  if (!state.user) return;
  try {
    const data = await api('/api/lgs');
    state.stores = data.stores || [];
    renderStores();
  } catch (error) {
    lgsAddError.textContent = error.message;
  }
}

async function onAddEvent(event) {
  event.preventDefault();
  addError.textContent = '';
  const button = addForm.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    await api('/api/events', {
      method: 'POST',
      body: { url: $('eventUrl').value, checkIntervalMinutes: Number($('checkInterval').value) },
    });
    $('eventUrl').value = '';
    await loadEvents();
  } catch (error) {
    addError.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function onAddLgs(event) {
  event.preventDefault();
  lgsAddError.textContent = '';
  const button = lgsAddForm.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    await api('/api/lgs', {
      method: 'POST',
      body: { url: $('lgsUrl').value, checkIntervalMinutes: Number($('lgsCheckInterval').value) },
    });
    $('lgsUrl').value = '';
    await loadStores();
  } catch (error) {
    lgsAddError.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function updateRefreshRate(eventId, minutes, select) {
  select.disabled = true;
  try {
    await api(`/api/events/${encodeURIComponent(eventId)}`, {
      method: 'PATCH', body: { checkIntervalMinutes: Number(minutes) },
    });
    await loadEvents();
  } finally {
    select.disabled = false;
  }
}

async function updateLgsRefreshRate(storeId, minutes, select) {
  select.disabled = true;
  try {
    await api(`/api/lgs/${encodeURIComponent(storeId)}`, {
      method: 'PATCH', body: { checkIntervalMinutes: Number(minutes) },
    });
    await loadStores();
  } finally {
    select.disabled = false;
  }
}

async function archiveEvent(eventId) {
  await api(`/api/events/${encodeURIComponent(eventId)}`, { method: 'DELETE' });
  await loadEvents();
}

async function deleteEvent(eventId) {
  if (!window.confirm('Permanently delete this event watch? This cannot be undone.')) return;
  await api(`/api/events/${encodeURIComponent(eventId)}/permanent`, { method: 'DELETE' });
  await loadEvents();
}

async function restoreEvent(eventId, button) {
  button.disabled = true;
  try {
    await api(`/api/events/${encodeURIComponent(eventId)}/restore`, { method: 'POST' });
    await loadEvents();
  } finally {
    button.disabled = false;
  }
}

async function archiveLgs(storeId) {
  await api(`/api/lgs/${encodeURIComponent(storeId)}`, { method: 'DELETE' });
  await loadStores();
}

async function deleteLgs(storeId) {
  if (!window.confirm('Permanently delete this LGS watch? This cannot be undone.')) return;
  await api(`/api/lgs/${encodeURIComponent(storeId)}/permanent`, { method: 'DELETE' });
  await loadStores();
}

async function restoreLgs(storeId, button) {
  button.disabled = true;
  try {
    await api(`/api/lgs/${encodeURIComponent(storeId)}/restore`, { method: 'POST' });
    await loadStores();
  } finally {
    button.disabled = false;
  }
}

async function checkEvent(eventId, button) {
  button.disabled = true;
  try {
    await api(`/api/events/${encodeURIComponent(eventId)}/check`, { method: 'POST' });
    await loadEvents();
  } finally {
    button.disabled = false;
  }
}

async function checkLgs(storeId, button) {
  button.disabled = true;
  try {
    await api(`/api/lgs/${encodeURIComponent(storeId)}/check`, { method: 'POST' });
    await loadStores();
  } finally {
    button.disabled = false;
  }
}

async function resendVerification() {
  const button = $('resendVerification');
  button.disabled = true;
  const original = button.textContent;
  try {
    await api('/api/auth/resend-verification', { method: 'POST' });
    button.textContent = 'Sent';
  } catch (error) {
    button.textContent = error.message;
  } finally {
    setTimeout(() => { button.textContent = original; button.disabled = false; }, 2200);
  }
}

function renderEvents() {
  const activeEvents = state.events.filter((event) => Number(event.active) === 1);
  const archivedEvents = state.events.filter((event) => Number(event.active) !== 1);

  eventCount.textContent = `${activeEvents.length} event${activeEvents.length === 1 ? '' : 's'}`;
  emptyState.classList.toggle('hidden', activeEvents.length !== 0);
  eventArchiveSection.classList.toggle('hidden', archivedEvents.length === 0);
  archivedEventCount.textContent = archivedEvents.length;
  eventsEl.innerHTML = '';
  archivedEventsEl.innerHTML = '';

  for (const event of activeEvents) {
    eventsEl.appendChild(buildEventCard(event, false));
  }

  for (const event of archivedEvents) {
    archivedEventsEl.appendChild(buildEventCard(event, true));
  }
}

function buildEventCard(event, archived) {
  const card = document.createElement('article');
  card.className = `event-card panel${archived ? ' archived-card' : ''}`;
  const players = event.capacity != null && event.current_players != null
    ? `${event.current_players}/${event.capacity}`
    : (event.current_players != null ? String(event.current_players) : '—');
  const eventDate = event.event_date || '—';
  const hostLgs = event.host_lgs || '—';

  if (archived) {
    card.innerHTML = `
      <div class="event-main">
        <p class="event-title"></p>
        <div class="event-facts">
          ${eventFact('Date', eventDate)}
          ${eventFact('LGS', hostLgs)}
          ${eventStatusFact(event.status)}
          ${eventFact('Players', players)}
        </div>
        <div class="event-activity">
          <span class="archive-badge">Archived</span>
          <span>${escapeText(event.last_checked_at ? `Last checked ${timeAgo(event.last_checked_at)}` : 'Never checked')}</span>
          <a href="${escapeAttribute(event.event_url)}" target="_blank" rel="noopener noreferrer">Open event</a>
        </div>
        <p class="event-reason">Archived for record keeping. Scheduled checks are paused.</p>
      </div>
      <div class="card-controls archive-controls">
        <div class="card-actions">
          <button class="icon-button restore" type="button">Restore</button>
          <button class="icon-button delete danger-button" type="button">Delete</button>
        </div>
      </div>`;
    const title = event.title || event.source_host || 'Watched event';
    card.querySelector('.event-title').textContent = title;
    card.querySelector('.restore').addEventListener('click', (e) => restoreEvent(event.event_id, e.currentTarget));
    card.querySelector('.delete').addEventListener('click', () => deleteEvent(event.event_id));
    attachDetailNavigation(card, 'event', event.event_id, title);
    return card;
  }

  card.innerHTML = `
    <div class="event-main">
      <p class="event-title"></p>
      <div class="event-facts">
        ${eventFact('Date', eventDate)}
        ${eventFact('LGS', hostLgs)}
        ${eventStatusFact(event.status)}
        ${eventFact('Players', players)}
      </div>
      <div class="event-activity">
        <span>${escapeText(event.last_checked_at ? `Checked ${timeAgo(event.last_checked_at)}` : 'Not checked yet')}</span>
        <span>${escapeText(event.next_check_at ? `Next ${relativeFuture(event.next_check_at)}` : 'Check due')}</span>
        <a href="${escapeAttribute(event.event_url)}" target="_blank" rel="noopener noreferrer">Open event</a>
      </div>
      <p class="event-reason">${escapeText(event.status_reason || 'Waiting for the next check.')}</p>
      ${event.last_error ? `<p class="event-error">Last check error: ${escapeText(event.last_error)}</p>` : ''}
    </div>
    <div class="card-controls">
      <label class="interval-control"><span>Refresh</span><select class="event-interval">${intervalOptions(event.check_interval_minutes, true)}</select></label>
      <div class="card-actions">
        <button class="icon-button check" type="button">Check now</button>
        <button class="icon-button archive" type="button">Archive</button>
        <button class="icon-button delete danger-button" type="button">Delete</button>
      </div>
    </div>`;

  const title = event.title || event.source_host || 'Watched event';
  card.querySelector('.event-title').textContent = title;
  card.querySelector('.event-interval').addEventListener('change', (e) => updateRefreshRate(event.event_id, e.currentTarget.value, e.currentTarget));
  card.querySelector('.check').addEventListener('click', (e) => checkEvent(event.event_id, e.currentTarget));
  card.querySelector('.archive').addEventListener('click', () => archiveEvent(event.event_id));
  card.querySelector('.delete').addEventListener('click', () => deleteEvent(event.event_id));
  attachDetailNavigation(card, 'event', event.event_id, title);
  return card;
}

function eventFact(label, value) {
  return `
    <div class="event-fact">
      <span class="event-fact-label">${escapeText(label)}</span>
      <span class="event-fact-value" title="${escapeAttribute(value)}">${escapeText(value)}</span>
    </div>`;
}

function eventStatusFact(status) {
  return `
    <div class="event-fact">
      <span class="event-fact-label">Status</span>
      <span class="status ${statusClassName(status)} event-fact-value">
        <span class="status-dot"></span>${escapeText(formatStatus(status))}
      </span>
    </div>`;
}

function renderStores() {
  const activeStores = state.stores.filter((store) => Number(store.active) === 1);
  const archivedStores = state.stores.filter((store) => Number(store.active) !== 1);

  lgsCount.textContent = `${activeStores.length} LGS page${activeStores.length === 1 ? '' : 's'}`;
  lgsEmptyState.classList.toggle('hidden', activeStores.length !== 0);
  lgsArchiveSection.classList.toggle('hidden', archivedStores.length === 0);
  archivedLgsCount.textContent = archivedStores.length;
  lgsStoresEl.innerHTML = '';
  archivedLgsStoresEl.innerHTML = '';

  for (const store of activeStores) {
    lgsStoresEl.appendChild(buildLgsCard(store, false));
  }

  for (const store of archivedStores) {
    archivedLgsStoresEl.appendChild(buildLgsCard(store, true));
  }
}

function buildLgsCard(store, archived) {
  const card = document.createElement('article');
  card.className = `event-card panel${archived ? ' archived-card' : ''}`;
  const known = Number(store.known_event_count || 0);

  if (archived) {
    card.innerHTML = `
      <div class="event-main">
        <p class="event-title"></p>
        <div class="event-meta">
          <span class="archive-badge">Archived</span>
          <span>${known} known event${known === 1 ? '' : 's'}</span>
          <span>${escapeText(store.last_checked_at ? `Last checked ${timeAgo(store.last_checked_at)}` : 'Never checked')}</span>
          <a href="${escapeAttribute(store.store_url)}" target="_blank" rel="noopener noreferrer">Open LGS</a>
        </div>
        <p class="event-reason">Archived for record keeping. New event checks are paused.</p>
      </div>
      <div class="card-controls archive-controls">
        <div class="card-actions">
          <button class="icon-button restore" type="button">Restore</button>
          <button class="icon-button delete danger-button" type="button">Delete</button>
        </div>
      </div>`;
    const title = store.title || store.source_host || 'Watched LGS';
    card.querySelector('.event-title').textContent = title;
    card.querySelector('.restore').addEventListener('click', (e) => restoreLgs(store.store_id, e.currentTarget));
    card.querySelector('.delete').addEventListener('click', () => deleteLgs(store.store_id));
    attachDetailNavigation(card, 'lgs', store.store_id, title);
    return card;
  }

  const status = store.last_error ? 'Check error' : (store.initialized_at ? 'Watching' : 'Initializing');
  card.innerHTML = `
    <div class="event-main">
      <p class="event-title"></p>
      <div class="event-meta">
        <span class="store-status"><span class="status-dot"></span>${escapeText(status)}</span>
        <span>${known} known event${known === 1 ? '' : 's'}</span>
        <span>${escapeText(store.last_checked_at ? `Checked ${timeAgo(store.last_checked_at)}` : 'Not checked yet')}</span>
        <span>${escapeText(store.next_check_at ? `Next ${relativeFuture(store.next_check_at)}` : 'Check due')}</span>
        <a href="${escapeAttribute(store.store_url)}" target="_blank" rel="noopener noreferrer">Open LGS</a>
      </div>
      <p class="event-reason">New event listings on this page will trigger an alert.</p>
      ${store.last_error ? `<p class="event-error">Last check error: ${escapeText(store.last_error)}</p>` : ''}
    </div>
    <div class="card-controls">
      <label class="interval-control"><span>Refresh</span><select class="lgs-interval">${intervalOptions(store.check_interval_minutes, true)}</select></label>
      <div class="card-actions">
        <button class="icon-button check" type="button">Check now</button>
        <button class="icon-button archive" type="button">Archive</button>
        <button class="icon-button delete danger-button" type="button">Delete</button>
      </div>
    </div>`;

  const title = store.title || store.source_host || 'Watched LGS';
  card.querySelector('.event-title').textContent = title;
  card.querySelector('.lgs-interval').addEventListener('change', (e) => updateLgsRefreshRate(store.store_id, e.currentTarget.value, e.currentTarget));
  card.querySelector('.check').addEventListener('click', (e) => checkLgs(store.store_id, e.currentTarget));
  card.querySelector('.archive').addEventListener('click', () => archiveLgs(store.store_id));
  card.querySelector('.delete').addEventListener('click', () => deleteLgs(store.store_id));
  attachDetailNavigation(card, 'lgs', store.store_id, title);
  return card;
}

function attachDetailNavigation(card, kind, id, title) {
  const openDetail = () => {
    const params = new URLSearchParams({ kind, id });
    location.href = `/detail.html?${params.toString()}`;
  };

  card.classList.add('clickable-card');
  card.tabIndex = 0;
  card.setAttribute('role', 'link');
  card.setAttribute('aria-label', `Open details for ${title}`);

  card.addEventListener('click', (event) => {
    if (event.target.closest('a, button, select, input, label')) return;
    openDetail();
  });

  card.addEventListener('keydown', (event) => {
    if (event.target !== card || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    openDetail();
  });
}

function fillIntervalSelect(select) {
  select.innerHTML = intervalOptions(5, false);
}

function intervalOptions(selected, compact) {
  return INTERVALS.map(([value, label]) => {
    const text = compact ? label.replace(/^Every /, '') : label;
    return `<option value="${value}" ${Number(selected) === value ? 'selected' : ''}>${text}</option>`;
  }).join('');
}

function formatStatus(status) {
  return ({ AVAILABLE: 'Available', FULL: 'Full', NOT_OPEN: 'Not open', CLOSED: 'Closed', UNAVAILABLE: 'Unavailable', UNKNOWN: 'Unknown' })[status] || status;
}

function statusClassName(status) {
  if (status === 'AVAILABLE') return 'available';
  if (status === 'FULL' || status === 'CLOSED') return 'full';
  if (status === 'NOT_OPEN') return 'not-open';
  return '';
}

function timeAgo(value) {
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function relativeFuture(value) {
  const ms = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 30_000) return 'check due';
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.ceil(hours / 24)}d`;
}

async function api(url, options = {}) {
  const init = { method: options.method || 'GET', headers: { ...(options.headers || {}) } };
  if (options.body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function escapeText(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}
function escapeAttribute(value) { return escapeText(value); }


const EVENT_WATCH_BUILD = '2026-10-06-detail-pages';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const workerUrl = `/sw.js?build=${encodeURIComponent(EVENT_WATCH_BUILD)}`;
    navigator.serviceWorker
      .register(workerUrl, { scope: '/', updateViaCache: 'none' })
      .then((registration) => registration.update())
      .catch(() => {
        // PWA support is progressive enhancement; the web app remains usable
        // even if the browser has service workers disabled.
      });
  });
}
