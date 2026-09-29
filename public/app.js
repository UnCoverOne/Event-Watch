const state = { mode: 'login', user: null, events: [] };
const $ = (id) => document.getElementById(id);

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

loginTab.addEventListener('click', () => setAuthMode('login'));
registerTab.addEventListener('click', () => setAuthMode('register'));
authForm.addEventListener('submit', onAuthSubmit);
logoutButton.addEventListener('click', onLogout);
addForm.addEventListener('submit', onAddEvent);
$('refreshButton').addEventListener('click', loadEvents);
$('resendVerification').addEventListener('click', resendVerification);

init();

async function init() {
  if (new URL(location.href).searchParams.get('verified') === '1') {
    history.replaceState({}, '', '/');
  }
  const data = await api('/api/me').catch(() => ({ user: null }));
  state.user = data.user;
  renderSession();
  if (state.user) await loadEvents();
}

function setAuthMode(mode) {
  state.mode = mode;
  loginTab.classList.toggle('active', mode === 'login');
  registerTab.classList.toggle('active', mode === 'register');
  authSubmit.textContent = mode === 'login' ? 'Sign in' : 'Create account';
  passwordInput.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  authError.textContent = '';
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
    await loadEvents();
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

async function onAddEvent(event) {
  event.preventDefault();
  const input = $('eventUrl');
  addError.textContent = '';
  const button = addForm.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    await api('/api/events', { method: 'POST', body: { url: input.value } });
    input.value = '';
    await loadEvents();
  } catch (error) {
    addError.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function removeEvent(eventId) {
  await api(`/api/events/${encodeURIComponent(eventId)}`, { method: 'DELETE' });
  await loadEvents();
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
  eventCount.textContent = `${state.events.length} event${state.events.length === 1 ? '' : 's'}`;
  emptyState.classList.toggle('hidden', state.events.length !== 0);
  eventsEl.innerHTML = '';

  for (const event of state.events) {
    const card = document.createElement('article');
    card.className = 'event-card panel';
    const statusClass = statusClassName(event.status);
    const capacity = event.capacity != null && event.current_players != null
      ? `${event.current_players}/${event.capacity} players`
      : null;
    const checked = event.last_checked_at ? `Checked ${timeAgo(event.last_checked_at)}` : 'Not checked yet';
    card.innerHTML = `
      <div>
        <p class="event-title"></p>
        <div class="event-meta">
          <span class="status ${statusClass}"><span class="status-dot"></span>${escapeText(formatStatus(event.status))}</span>
          ${capacity ? `<span>${escapeText(capacity)}</span>` : ''}
          <span>${escapeText(checked)}</span>
          <a href="${escapeAttribute(event.event_url)}" target="_blank" rel="noopener noreferrer">Open event</a>
        </div>
        <p class="event-reason">${escapeText(event.status_reason || 'Waiting for the next check.')}</p>
        ${event.last_error ? `<p class="event-error">Last check error: ${escapeText(event.last_error)}</p>` : ''}
      </div>
      <div class="card-actions">
        <button class="icon-button check" type="button">Check now</button>
        <button class="icon-button remove" type="button">Remove</button>
      </div>`;
    card.querySelector('.event-title').textContent = event.title || event.source_host || 'Watched event';
    card.querySelector('.check').addEventListener('click', (e) => checkEvent(event.event_id, e.currentTarget));
    card.querySelector('.remove').addEventListener('click', () => removeEvent(event.event_id));
    eventsEl.appendChild(card);
  }
}

function formatStatus(status) {
  return ({
    AVAILABLE: 'Available',
    FULL: 'Full',
    NOT_OPEN: 'Not open',
    CLOSED: 'Closed',
    UNAVAILABLE: 'Unavailable',
    UNKNOWN: 'Unknown',
  })[status] || status;
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
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
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
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttribute(value) {
  return escapeText(value);
}
