// Local IPC between the Chrome-spawned native host and MCP server processes.
//
// Windows uses a named pipe, POSIX a unix domain socket. The native host is the
// listener and MCP servers are clients, so several Claude Code sessions can
// share one browser connection instead of competing to bind the same path.

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { envVar } from './env.js';

const NAME = 'autopilot';

/**
 * Pipe for one browser.
 *
 * Every connected browser gets its own path. A single shared name meant the
 * second browser lost the race to bind it and became invisible, so Chrome and
 * Edge could not both be driven.
 */
export function socketPathFor(browserId) {
  // Lets a test run a private bridge without colliding with the user's live one.
  const override = envVar('SOCKET');
  if (override) return override;
  const suffix = String(browserId || 'default').replace(/[^\w-]/g, '').slice(0, 32);
  if (process.platform === 'win32') {
    const user = (process.env.USERNAME || 'user').replace(/[^\w-]/g, '');
    return '\\\\.\\pipe\\' + NAME + '-' + user + '-' + suffix;
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'u';
  return path.join(os.tmpdir(), NAME + '-' + uid + '-' + suffix + '.sock');
}

/** Newline-delimited JSON over the socket. JSON.stringify never emits a raw newline. */
export class JsonSocket extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = '';
    // Set once the peer is gone, so a caller holding this socket can tell a
    // failed write from a write it must not attempt. The native host uses it to
    // decide whether a tool response has anywhere to go.
    this.closed = false;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      this.buffer += chunk;
      let index;
      while ((index = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (!line.trim()) continue;
        try {
          this.emit('message', JSON.parse(line));
        } catch (err) {
          this.emit('error', new Error('malformed IPC message: ' + err.message));
        }
      }
    });
    socket.on('close', () => {
      this.closed = true;
      this.emit('close');
    });
    socket.on('error', (err) => this.emit('error', err));
  }

  /** True while a write can still reach the peer. */
  get alive() {
    return !this.closed && !this.socket.destroyed && this.socket.writable;
  }

  send(message) {
    if (!this.alive) return false;
    try {
      this.socket.write(JSON.stringify(message) + '\n');
    } catch {
      return false;
    }
    return true;
  }

  end() {
    try {
      this.socket.end();
    } catch {
      /* already closed */
    }
  }
}

/** Probes whether something is already listening, to tell a live server from a stale socket file. */
export function probe(pathname, timeout = 400) {
  return new Promise((resolve) => {
    const socket = net.connect(pathname);
    const done = (alive) => {
      socket.removeAllListeners();
      // end() rather than destroy(), so the listener sees a clean close instead
      // of logging an EPIPE for every probe.
      try {
        socket.end();
      } catch {
        /* already gone */
      }
      socket.destroy();
      resolve(alive);
    };
    socket.setTimeout(timeout, () => done(false));
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
  });
}

export async function listen(pathname, onConnection) {
  if (process.platform !== 'win32' && fs.existsSync(pathname)) {
    // A leftover socket file from a killed process blocks bind. Remove it only
    // after confirming nothing answers on it.
    if (!(await probe(pathname))) {
      try {
        fs.unlinkSync(pathname);
      } catch {
        /* raced with another host */
      }
    }
  }

  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => onConnection(new JsonSocket(socket)));
    server.on('error', reject);
    server.listen(pathname, () => resolve(server));
  });
}

export function connect(pathname, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pathname);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timed out connecting to ' + pathname));
    }, timeout);
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve(new JsonSocket(socket));
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
