// The popup: connection state, the sessions this browser holds, and the last
// few calls. Read from the worker on open and refreshed while it is visible.

const $ = (id) => document.getElementById(id);

function ask(type, extra = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...extra }, (response) => {
      void chrome.runtime.lastError;
      resolve(response || null);
    });
  });
}

function fmtAge(ms) {
  if (ms < 1000) return 'now';
  if (ms < 60000) return Math.round(ms / 1000) + 's';
  if (ms < 3600000) return Math.round(ms / 60000) + 'm';
  return Math.round(ms / 3600000) + 'h';
}

function renderState(state) {
  const dot = $('dot');
  const label = $('state');
  dot.className = 'dot';
  if (!state) {
    label.textContent = 'Worker is not answering';
    dot.classList.add('error');
    return;
  }
  $('version').textContent = 'v' + state.version;
  if (state.working) {
    dot.classList.add('working');
    label.textContent = 'Working';
  } else if (state.connected) {
    dot.classList.add('connected');
    label.textContent = state.clients ? 'Connected, ' + state.clients + ' client' + (state.clients === 1 ? '' : 's') : 'Connected, idle';
  } else {
    label.textContent = 'Host not connected. Run npm run doctor.';
  }
}

function renderSessions(sessions) {
  const list = $('sessions');
  list.textContent = '';
  if (!sessions || !sessions.length) {
    const li = document.createElement('li');
    li.className = 'faint';
    li.textContent = 'No tabs open';
    list.appendChild(li);
    return;
  }
  for (const s of sessions) {
    const li = document.createElement('li');
    li.className = 'session';
    li.title = 'Show this session\'s tabs';
    const mark = document.createElement('span');
    mark.textContent = s.mark || '·';
    const grow = document.createElement('span');
    grow.className = 'grow muted';
    grow.textContent = s.tabs + ' tab' + (s.tabs === 1 ? '' : 's') + (s.title ? ' · ' + s.title : '');
    li.append(mark, grow);

    // F4: Stop while a call is running for this session, Resume once the
    // user has stopped one. Neither reveals the tab, so both stop the click
    // from also triggering the row's own reveal-session handler.
    if (s.active || s.stopped) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-ghost';
      btn.textContent = s.stopped ? 'Resume' : 'Stop';
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        ask(s.stopped ? 'resume' : 'stop', { clientId: s.clientId }).then(refresh);
      });
      li.appendChild(btn);
    }

    // The user chooses when to look: this is the one place a tab is raised.
    li.addEventListener('click', () => ask('reveal_session', { clientId: s.clientId }).then(() => window.close()));
    list.appendChild(li);
  }
}

function renderRecent(recent) {
  const list = $('recent');
  list.textContent = '';
  if (!recent || !recent.length) {
    const li = document.createElement('li');
    li.className = 'faint';
    li.textContent = 'Nothing yet';
    list.appendChild(li);
    return;
  }
  const now = Date.now();
  for (const r of recent.slice().reverse().slice(0, 8)) {
    const li = document.createElement('li');
    const status = document.createElement('span');
    status.textContent = r.ok ? '✓' : '✕';
    status.className = r.ok ? 'muted' : '';
    const grow = document.createElement('span');
    grow.className = 'grow';
    grow.textContent = r.tool + (r.detail ? ' ' + r.detail : '');
    grow.title = r.error || r.detail || '';
    const age = document.createElement('span');
    age.className = 'faint';
    age.textContent = fmtAge(now - r.at);
    li.append(status, grow, age);
    list.appendChild(li);
  }
}

async function refresh() {
  const state = await ask('popup_state');
  renderState(state);
  renderSessions(state && state.sessions);
  renderRecent(state && state.recent);
}

$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('close-empty').addEventListener('click', async () => {
  await ask('close_empty_tabs');
  refresh();
});

refresh();
setInterval(refresh, 1500);
