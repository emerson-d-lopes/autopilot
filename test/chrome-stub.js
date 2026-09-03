// Minimal chrome API stub so extension modules can be imported under node --test.

const listeners = [];
const storage = new Map();

export const chromeStub = {
  runtime: {
    lastError: null,
    getManifest: () => ({ version: '0.1.0' }),
    connectNative: () => ({
      postMessage() {},
      onMessage: { addListener() {} },
      onDisconnect: { addListener() {} },
    }),
    onMessage: { addListener: (fn) => listeners.push(fn) },
  },
  storage: {
    local: {
      async get(key) {
        if (typeof key === 'string') return storage.has(key) ? { [key]: storage.get(key) } : {};
        return Object.fromEntries(storage);
      },
      async set(obj) {
        for (const [k, v] of Object.entries(obj)) storage.set(k, v);
      },
      async clear() {
        storage.clear();
      },
    },
    onChanged: { addListener() {} },
  },
  tabs: {
    async get() {
      return { id: 1, url: 'https://example.com/', groupId: 7, windowId: 1, status: 'complete' };
    },
    async query() {
      return [];
    },
    async update() {},
    async create() {
      return { id: 1, windowId: 1 };
    },
    async group() {
      return 7;
    },
    async remove() {},
    async sendMessage() {
      return {};
    },
    onUpdated: { addListener() {} },
    onRemoved: { addListener() {} },
  },
  tabGroups: {
    TAB_GROUP_ID_NONE: -1,
    async get() {
      return { id: 7 };
    },
    async update() {},
  },
  windows: {
    async create() {
      return { tabs: [{ id: 1, windowId: 1 }] };
    },
    async update() {},
  },
  scripting: { async executeScript() {} },
  debugger: {
    attach(_t, _v, cb) {
      cb && cb();
    },
    detach(_t, cb) {
      cb && cb();
    },
    sendCommand(_t, _m, _p, cb) {
      cb && cb({});
    },
    onEvent: { addListener() {} },
    onDetach: { addListener() {} },
  },
  alarms: {
    create() {},
    onAlarm: { addListener() {} },
  },
};

export function installChromeStub() {
  globalThis.chrome = chromeStub;
  return chromeStub;
}

export function resetStorage() {
  storage.clear();
}
