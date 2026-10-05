const $ = (id) => document.getElementById(id);
const INTERVALS = [
  [5, 'Every 5 minutes'], [10, 'Every 10 minutes'], [15, 'Every 15 minutes'],
  [30, 'Every 30 minutes'], [60, 'Every hour'], [180, 'Every 3 hours'],
  [360, 'Every 6 hours'], [720, 'Every 12 hours'], [1440, 'Every day'],
];
const BUILD_ID = '2026-10-06-detail-pages';

const params = new URL(location.href).searchParams;
const kind = params.get('kind');
const id = params.get('id');

$('themeToggle').addEventListener('click', toggleTheme);
$('logoutButton').addEventListener('click', logout);
syncThemeUi();
init();

async function init() {
  const me = await api('/api/me').catch(() => ({ user: null }));
  if (!me.user) {
    location.replace('/');
    return;
  }

  if (!['event', 'lgs'].includes(kind) || !id) {
    renderMissing('Invalid detail link.');
    return;
  }

  try {
    if (kind === 'event') {
      const data = await api('/api/events');
      const item = (data.events || []).find((entry) => entry.event_id === id);
      if (!item) return renderMissing('This event watch could not be found.');
      renderEvent(item);
    } else {
      const data = await api('/api/lgs');
      const item = (data.stores || []).find((entry) => entry.store_id === id);
      if (!item) return renderMissing('This LGS watch could not be found.');
      renderLgs(item);
    }
  } catch (error) {
    renderMissing(error.message || 'Unable to load this watch.');
  }

  registerServiceWorker();
}

function renderEvent(item) {
  const archived = Number(item.active) !== 1;
  const title = item.title || item.source_host || 'Watched event';
  const players = item.capacity != null && item.current_players != null
    ? `${item.current_players}/${item.capacity}`
    : (item.current_players != null ? String(item.current_players) : '—');

  document.title = `${title} | Event Watch`;
  $('detailLoading').classList.add('hidden');
  const view = $('detailView');
  view.classList.remove('hidden');
  view.innerHTML = `
    <div class="detail-hero">
      <p class="eyebrow">${archived ? 'Archived event watch' : 'Event watch'}</p>
      <div class="detail-hero-row">
        <h1 class="detail-title">${escapeText(title)}</h1>
        <a class="detail-source-link" href="${escapeAttribute(item.event_url)}" target="_blank" rel="noopener noreferrer">Open source ↗</a>
      </div>
    </div>

    <div class="detail-grid">
      <section class="panel detail-section">
        <h2>Overview</h2>
        <div class="detail-facts">
          ${fact('Status', statusMarkup(item.status), true)}
          ${fact('Event date', item.event_date || '—')}
          ${fact('Host LGS', item.host_lgs || '—')}
          ${fact('Players', players)}
          ${fact('Last checked', formatDateTime(item.last_checked_at))}
          ${fact('Next check', archived ? 'Paused' : formatDateTime(item.next_check_at))}
          ${fact('Last changed', formatDateTime(item.last_changed_at))}
          ${fact('Refresh rate', intervalLabel(item.check_interval_minutes))}
        </div>
        <h2 style="margin-top:20px">Latest result</h2>
        <p class="detail-copy">${escapeText(item.status_reason || 'Waiting for the next check.')}</p>
        ${item.last_error ? `<p class="detail-error">Last check error: ${escapeText(item.last_error)}</p>` : ''}
      </section>

      <aside class="panel detail-section">
        <h2>Controls</h2>
        <div class="detail-actions">
          ${archived ? archivedControls('event') : activeControls('event', item.check_interval_minutes)}
        </div>
      </aside>
    </div>

    <section class="panel detail-section detail-technical">
      <h2>Watch details</h2>
      <div class="detail-facts">
        ${fact('Source host', item.source_host || '—')}
        ${fact('Adapter', item.adapter || '—')}
        ${fact('Consecutive failures', String(item.consecutive_failures ?? 0))}
        ${fact('Watch created', formatDateTime(item.created_at))}
        ${fact('Event ID', item.event_id || '—')}
        ${fact('Subscription ID', item.subscription_id || '—')}
        ${fact('Event key', item.event_key || '—')}
        ${fact('Source URL', item.event_url || '—')}
      </div>
    </section>`;

  bindActions('event', item, archived);
}

function renderLgs(item) {
  const archived = Number(item.active) !== 1;
  const title = item.title || item.source_host || 'Watched LGS';
  const status = item.last_error ? 'Check error' : (item.initialized_at ? 'Watching' : 'Initializing');

  document.title = `${title} | Event Watch`;
  $('detailLoading').classList.add('hidden');
  const view = $('detailView');
  view.classList.remove('hidden');
  view.innerHTML = `
    <div class="detail-hero">
      <p class="eyebrow">${archived ? 'Archived LGS watch' : 'LGS watch'}</p>
      <div class="detail-hero-row">
        <h1 class="detail-title">${escapeText(title)}</h1>
        <a class="detail-source-link" href="${escapeAttribute(item.store_url)}" target="_blank" rel="noopener noreferrer">Open source ↗</a>
      </div>
    </div>

    <div class="detail-grid">
      <section class="panel detail-section">
        <h2>Overview</h2>
        <div class="detail-facts">
          ${fact('Status', `<span class="store-status"><span class="status-dot"></span>${escapeText(archived ? 'Archived' : status)}</span>`, true)}
          ${fact('Known events', String(item.known_event_count ?? 0))}
          ${fact('Last checked', formatDateTime(item.last_checked_at))}
          ${fact('Next check', archived ? 'Paused' : formatDateTime(item.next_check_at))}
          ${fact('Initialized', formatDateTime(item.initialized_at))}
          ${fact('Refresh rate', intervalLabel(item.check_interval_minutes))}
        </div>
        <h2 style="margin-top:20px">Monitoring behavior</h2>
        <p class="detail-copy">Event Watch keeps the current store listing as a baseline and alerts you when a new event appears later.</p>
        ${item.last_error ? `<p class="detail-error">Last check error: ${escapeText(item.last_error)}</p>` : ''}
      </section>

      <aside class="panel detail-section">
        <h2>Controls</h2>
        <div class="detail-actions">
          ${archived ? archivedControls('lgs') : activeControls('lgs', item.check_interval_minutes)}
        </div>
      </aside>
    </div>

    <section class="panel detail-section detail-technical">
      <h2>Watch details</h2>
      <div class="detail-facts">
        ${fact('Source host', item.source_host || '—')}
        ${fact('Adapter', item.adapter || '—')}
        ${fact('Consecutive failures', String(item.consecutive_failures ?? 0))}
        ${fact('Watch created', formatDateTime(item.created_at))}
        ${fact('Store ID', item.store_id || '—')}
        ${fact('Subscription ID', item.subscription_id || '—')}
        ${fact('Store key', item.store_key || '—')}
        ${fact('Source URL', item.store_url || '—')}
      </div>
    </section>`;

  bindActions('lgs', item, archived);
}

function activeControls(type, selected) {
  return `
    <label class="interval-control">
      <span>Refresh rate</span>
      <select id="detailInterval">${intervalOptions(selected)}</select>
    </label>
    <div class="card-actions">
      <button id="detailCheck" class="icon-button" type="button">Check now</button>
      <button id="detailArchive" class="icon-button" type="button">Archive</button>
      <button id="detailDelete" class="icon-button danger-button" type="button">Delete</button>
    </div>`;
}

function archivedControls() {
  return `
    <p class="detail-copy">Scheduled checks are paused while this watch is archived.</p>
    <div class="card-actions">
      <button id="detailRestore" class="icon-button" type="button">Restore</button>
      <button id="detailDelete" class="icon-button danger-button" type="button">Delete permanently</button>
    </div>`;
}

function bindActions(type, item, archived) {
  const itemId = type === 'event' ? item.event_id : item.store_id;
  const base = type === 'event' ? '/api/events' : '/api/lgs';

  if (archived) {
    $('detailRestore').addEventListener('click', async (event) => {
      await withBusy(event.currentTarget, async () => {
        await api(`${base}/${encodeURIComponent(itemId)}/restore`, { method: 'POST' });
        await reloadDetail();
      });
    });
  } else {
    $('detailInterval').addEventListener('change', async (event) => {
      await withBusy(event.currentTarget, async () => {
        await api(`${base}/${encodeURIComponent(itemId)}`, {
          method: 'PATCH',
          body: { checkIntervalMinutes: Number(event.currentTarget.value) },
        });
        await reloadDetail();
      });
    });

    $('detailCheck').addEventListener('click', async (event) => {
      await withBusy(event.currentTarget, async () => {
        await api(`${base}/${encodeURIComponent(itemId)}/check`, { method: 'POST' });
        await reloadDetail();
      });
    });

    $('detailArchive').addEventListener('click', async (event) => {
      await withBusy(event.currentTarget, async () => {
        await api(`${base}/${encodeURIComponent(itemId)}`, { method: 'DELETE' });
        await reloadDetail();
      });
    });
  }

  $('detailDelete').addEventListener('click', async (event) => {
    if (!window.confirm(`Permanently delete this ${type === 'event' ? 'event' : 'LGS'} watch? This cannot be undone.`)) return;
    await withBusy(event.currentTarget, async () => {
      await api(`${base}/${encodeURIComponent(itemId)}/permanent`, { method: 'DELETE' });
      location.replace('/');
    });
  });
}

async function reloadDetail() {
  $('detailView').classList.add('hidden');
  $('detailLoading').classList.remove('hidden');
  $('detailLoading').textContent = 'Refreshing details…';
  await init();
}

function renderMissing(message) {
  $('detailLoading').classList.add('hidden');
  const view = $('detailView');
  view.classList.remove('hidden');
  view.innerHTML = `
    <div class="panel detail-empty">
      <h1>Watch not found</h1>
      <p>${escapeText(message)}</p>
      <p><a href="/">Return to your watches</a></p>
    </div>`;
}

function fact(label, value, raw = false) {
  return `
    <div class="detail-fact">
      <span class="detail-fact-label">${escapeText(label)}</span>
      <span class="detail-fact-value">${raw ? value : escapeText(value)}</span>
    </div>`;
}

function statusMarkup(status) {
  return `<span class="status ${statusClassName(status)} detail-status-line"><span class="status-dot"></span>${escapeText(formatStatus(status))}</span>`;
}

function intervalOptions(selected) {
  return INTERVALS.map(([value, label]) =>
    `<option value="${value}" ${Number(selected) === value ? 'selected' : ''}>${escapeText(label)}</option>`
  ).join('');
}

function intervalLabel(value) {
  return INTERVALS.find(([minutes]) => Number(value) === minutes)?.[1] || `${value || '—'} minutes`;
}

function formatStatus(status) {
  return ({ AVAILABLE: 'Available', FULL: 'Full', NOT_OPEN: 'Not open', CLOSED: 'Closed', UNAVAILABLE: 'Unavailable', UNKNOWN: 'Unknown' })[status] || status || 'Unknown';
}

function statusClassName(status) {
  if (status === 'AVAILABLE') return 'available';
  if (status === 'FULL' || status === 'CLOSED') return 'full';
  if (status === 'NOT_OPEN') return 'not-open';
  return '';
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

async function withBusy(control, task) {
  control.disabled = true;
  try {
    await task();
  } catch (error) {
    alert(error.message || 'Something went wrong.');
  } finally {
    control.disabled = false;
  }
}

async function logout() {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  location.replace('/');
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
  $('themeLabel').textContent = nextLabel;
  $('themeToggle').querySelector('.theme-icon').textContent = current === 'dark' ? '☀' : '☾';
  $('themeToggle').setAttribute('aria-label', `Switch to ${nextLabel.toLowerCase()} mode`);
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

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const workerUrl = `/sw.js?build=${encodeURIComponent(BUILD_ID)}`;
  navigator.serviceWorker.register(workerUrl, { scope: '/', updateViaCache: 'none' })
    .then((registration) => registration.update())
    .catch(() => {});
}
