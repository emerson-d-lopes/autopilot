// Saved shortcuts.
//
// A shortcut is a named quick script for a flow that gets repeated, saved from
// the options page. It is the same execution path as `quick`, so a shortcut
// behaves exactly like the script it holds.

const STORAGE_KEY = 'shortcuts';

function normalize(entry, index) {
  return {
    id: entry.id || 'sc' + (index + 1),
    name: entry.name || entry.id || 'shortcut ' + (index + 1),
    description: entry.description || '',
    script: entry.script || '',
  };
}

export async function list() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const raw = Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
  return raw.map(normalize).filter((s) => s.script.trim());
}

export async function find(idOrName) {
  const wanted = String(idOrName || '').trim().toLowerCase();
  if (!wanted) return null;
  const all = await list();
  return (
    all.find((s) => s.id.toLowerCase() === wanted) ||
    all.find((s) => s.name.toLowerCase() === wanted) ||
    null
  );
}

export async function save(shortcuts) {
  await chrome.storage.local.set({ [STORAGE_KEY]: shortcuts });
}
