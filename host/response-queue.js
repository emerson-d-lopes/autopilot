// R11. A tool response whose requesting socket has closed is parked here.
//
// The window between dispatching a tool call and the reply coming back is long
// enough for an MCP server to restart, and without this the work is simply
// lost: the socket is gone, the response has nowhere to go, and the caller sees
// a disconnect instead of the result it paid for. Parking it and replaying on
// the next connection that presents the same session id turns a lost call into
// a late one.
//
// Bounded at 8 entries with a 120 s TTL, which is what the official extension
// uses for the same problem. An entry that expires is dropped with a journal
// line rather than silently.

export const MAX_ENTRIES = 8;
export const TTL_MS = 120000;

export class ResponseQueue {
  constructor({ max = MAX_ENTRIES, ttlMs = TTL_MS, now = () => Date.now() } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.now = now;
    /** @type {Array<{sessionId: string, message: object, tool: string|null, parkedAt: number}>} */
    this.entries = [];
  }

  get size() {
    return this.entries.length;
  }

  /**
   * Removes entries past their TTL.
   *
   * @returns {Array<object>} the dropped entries, so the caller can journal them
   */
  prune() {
    const cutoff = this.now() - this.ttlMs;
    const dropped = [];
    this.entries = this.entries.filter((entry) => {
      if (entry.parkedAt <= cutoff) {
        dropped.push({ ...entry, reason: 'expired' });
        return false;
      }
      return true;
    });
    return dropped;
  }

  /**
   * Parks one undeliverable response.
   *
   * @returns {{parked: boolean, dropped: Array<object>}} entries removed to make room or by TTL
   */
  park(sessionId, message, { tool = null } = {}) {
    const dropped = this.prune();
    if (!sessionId) return { parked: false, dropped };

    this.entries.push({ sessionId: String(sessionId), message, tool, parkedAt: this.now() });
    while (this.entries.length > this.max) {
      dropped.push({ ...this.entries.shift(), reason: 'evicted, queue full' });
    }
    return { parked: true, dropped };
  }

  /**
   * Hands back every live response parked for one session, oldest first, and
   * removes them from the queue.
   *
   * @returns {{messages: Array<object>, dropped: Array<object>}}
   */
  takeFor(sessionId) {
    const dropped = this.prune();
    if (!sessionId) return { messages: [], dropped };

    const wanted = String(sessionId);
    const messages = [];
    this.entries = this.entries.filter((entry) => {
      if (entry.sessionId !== wanted) return true;
      messages.push(entry.message);
      return false;
    });
    return { messages, dropped };
  }

  clear() {
    this.entries = [];
  }
}
