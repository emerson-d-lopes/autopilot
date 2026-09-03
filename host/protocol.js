// Chrome native messaging framing and chunk reassembly.
//
// Wire format is a uint32 little-endian byte length followed by UTF-8 JSON.
// Chrome caps a single message at 1MB, so the extension splits large payloads
// (screenshots, mostly) into ordered chunks that are rejoined here.

import { EventEmitter } from 'node:events';

export const MAX_MESSAGE = 1024 * 1024;

export class NativeMessaging extends EventEmitter {
  constructor(input, output) {
    super();
    this.input = input;
    this.output = output;
    this.buffer = Buffer.alloc(0);
    this.chunks = new Map();

    this.input.on('data', (data) => this._onData(data));
    this.input.on('end', () => this.emit('end'));
    this.input.on('error', (err) => this.emit('error', err));
  }

  _onData(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > 512 * 1024 * 1024) {
        this.emit('error', new Error('native message length out of range: ' + length));
        this.buffer = Buffer.alloc(0);
        return;
      }
      if (this.buffer.length < 4 + length) return;
      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      let message;
      try {
        message = JSON.parse(body.toString('utf8'));
      } catch (err) {
        this.emit('error', new Error('malformed native message: ' + err.message));
        continue;
      }
      this._dispatch(message);
    }
  }

  _dispatch(message) {
    if (message && message.type === 'chunk') {
      const { id, index, total, data } = message;
      let entry = this.chunks.get(id);
      if (!entry) {
        entry = { parts: new Array(total), received: 0, total };
        this.chunks.set(id, entry);
      }
      if (entry.parts[index] === undefined) {
        entry.parts[index] = data;
        entry.received++;
      }
      if (entry.received === entry.total) {
        this.chunks.delete(id);
        try {
          this.emit('message', JSON.parse(entry.parts.join('')));
        } catch (err) {
          this.emit('error', new Error('malformed chunked message: ' + err.message));
        }
      }
      return;
    }
    this.emit('message', message);
  }

  send(message) {
    const json = Buffer.from(JSON.stringify(message), 'utf8');
    if (json.length > MAX_MESSAGE) {
      throw new Error('message too large for native messaging: ' + json.length + ' bytes');
    }
    const header = Buffer.alloc(4);
    header.writeUInt32LE(json.length, 0);
    this.output.write(Buffer.concat([header, json]));
  }
}
