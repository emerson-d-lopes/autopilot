#!/usr/bin/env node
// Small CDP client used by the integration harness to drive a test Chrome.
// Not part of the shipped bridge.

export async function listTargets(port = 9333) {
  const response = await fetch('http://127.0.0.1:' + port + '/json/list');
  return response.json();
}

export async function version(port = 9333) {
  const response = await fetch('http://127.0.0.1:' + port + '/json/version');
  return response.json();
}

export class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.waiters = new Map();
    this.events = [];
    this.listeners = [];
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.waiters.has(message.id)) {
        const { resolve, reject } = this.waiters.get(message.id);
        this.waiters.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
        return;
      }
      if (message.method) {
        this.events.push(message);
        for (const fn of this.listeners) fn(message);
      }
    });
  }

  static async open(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('cdp websocket failed: ' + wsUrl)), { once: true });
    });
    return new CdpSession(ws);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.waiters.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.waiters.has(id)) {
          this.waiters.delete(id);
          reject(new Error('cdp timeout: ' + method));
        }
      }, 180000);
      this.ws.send(JSON.stringify(payload));
    });
  }

  on(fn) {
    this.listeners.push(fn);
  }

  waitFor(method, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const existing = this.events.find((e) => e.method === method);
      if (existing) return resolve(existing);
      const timer = setTimeout(() => reject(new Error('timed out waiting for ' + method)), timeout);
      this.on((message) => {
        if (message.method === method) {
          clearTimeout(timer);
          resolve(message);
        }
      });
    });
  }

  async evaluate(expression, sessionId) {
    const result = await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId
    );
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result.value;
  }

  close() {
    this.ws.close();
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === 'file:///' + process.argv[1].replace(/\\/g, '/');
if (invokedDirectly) {
  const port = Number(process.env.CDP_PORT || 9333);
  const targets = await listTargets(port);
  for (const target of targets) {
    console.log([target.type, target.title, target.url].join(' | '));
  }
}
