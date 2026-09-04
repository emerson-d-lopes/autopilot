const STORAGE_KEY = 'permissionPolicy';

const DEFAULT_BLOCKED = [
  '*.chase.com', '*.bankofamerica.com', '*.wellsfargo.com', '*.citi.com', '*.paypal.com',
  '*.coinbase.com', '*.binance.com', '*.robinhood.com', '*.fidelity.com', '*.schwab.com',
  '*.vanguard.com', '*.itau.com.br', '*.bb.com.br', '*.nubank.com.br', '*.santander.com.br',
  '*.bradesco.com.br', '*.caixa.gov.br',
];

const DEFAULTS = { mode: 'allow', blockedHosts: DEFAULT_BLOCKED, allowedHosts: [], grants: {} };

const $ = (id) => document.getElementById(id);
const lines = (value) => value.split('\n').map((s) => s.trim()).filter(Boolean);

async function load() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return { ...DEFAULTS, ...(stored[STORAGE_KEY] || {}) };
}

function renderGrants(policy) {
  const list = $('grants');
  list.textContent = '';
  const origins = Object.keys(policy.grants || {});

  if (!origins.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No sites have been granted access.';
    list.appendChild(empty);
    return;
  }

  for (const origin of origins.sort()) {
    const grant = policy.grants[origin];
    const item = document.createElement('li');

    const left = document.createElement('span');
    const code = document.createElement('code');
    code.textContent = origin;
    left.appendChild(code);

    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent =
      grant.duration === 'once'
        ? 'single use'
        : 'always, since ' + new Date(grant.createdAt || Date.now()).toLocaleDateString();
    left.appendChild(meta);

    const revoke = document.createElement('button');
    revoke.textContent = 'Revoke';
    revoke.addEventListener('click', async () => {
      const current = await load();
      delete current.grants[origin];
      await chrome.storage.local.set({ [STORAGE_KEY]: current });
      render();
    });

    item.append(left, revoke);
    list.appendChild(item);
  }
}

const SHORTCUT_KEY = 'shortcuts';
// Whether the Runtime domain is enabled on the first console read (lazy) or
// when the tab joins the session (always). See recorder.js.
const CONSOLE_CAPTURE_KEY = 'consoleCapture';
// The label the extension sends in its hello frame, so the host can name this
// browser in list_connected_browsers instead of showing a random id.
const LABEL_KEY = 'browserLabel';

/** Text form of the shortcut list, so it can be edited as one block. */
function shortcutsToText(list) {
  return (list || [])
    .map((s) => [s.id, s.name, s.description].filter(Boolean).join(' | ') + '\n' + (s.script || ''))
    .join('\n\n');
}

function textToShortcuts(text) {
  return String(text || '')
    .split(/\n\s*\n/)
    .map((block) => block.split('\n').filter((l) => l.trim().length))
    .filter((lines) => lines.length >= 2)
    .map((lines, index) => {
      const [id, name, description] = lines[0].split('|').map((p) => p.trim());
      return {
        id: id || 'sc' + (index + 1),
        name: name || id || 'shortcut ' + (index + 1),
        description: description || '',
        script: lines.slice(1).join('\n'),
      };
    });
}

document.getElementById('version').textContent = 'v' + chrome.runtime.getManifest().version;

async function render() {
  const policy = await load();
  const stored = await chrome.storage.local.get([SHORTCUT_KEY, LABEL_KEY, CONSOLE_CAPTURE_KEY]);
  $('shortcuts').value = shortcutsToText(stored[SHORTCUT_KEY]);
  $('label').value = stored[LABEL_KEY] || '';
  const capture = stored[CONSOLE_CAPTURE_KEY] === 'always' ? 'always' : 'lazy';
  for (const input of document.querySelectorAll('input[name=consoleCapture]')) {
    input.checked = input.value === capture;
  }
  for (const input of document.querySelectorAll('input[name=mode]')) {
    input.checked = input.value === policy.mode;
  }
  $('blocked').value = (policy.blockedHosts || []).join('\n');
  $('allowed').value = (policy.allowedHosts || []).join('\n');
  renderGrants(policy);
}

$('save').addEventListener('click', async () => {
  const current = await load();
  const selected = document.querySelector('input[name=mode]:checked');
  await chrome.storage.local.set({
    [STORAGE_KEY]: {
      ...current,
      mode: selected ? selected.value : 'allow',
      blockedHosts: lines($('blocked').value),
      allowedHosts: lines($('allowed').value),
    },
  });
  await chrome.storage.local.set({ [SHORTCUT_KEY]: textToShortcuts($('shortcuts').value) });
  const capture = document.querySelector('input[name=consoleCapture]:checked');
  await chrome.storage.local.set({ [CONSOLE_CAPTURE_KEY]: capture && capture.value === 'always' ? 'always' : 'lazy' });
  // The hello frame is sent once at connect time, so a new label reaches the
  // host on the next reconnect rather than straight away.
  await chrome.storage.local.set({ [LABEL_KEY]: $('label').value.trim() });
  const saved = $('saved');
  saved.classList.add('show');
  setTimeout(() => saved.classList.remove('show'), 1400);
});

$('reset').addEventListener('click', async () => {
  await chrome.storage.local.set({ [STORAGE_KEY]: { ...DEFAULTS }, [CONSOLE_CAPTURE_KEY]: 'lazy' });
  render();
});

render();
