// Service worker keepalive.
//
// An offscreen document is not subject to MV3's 30 second idle kill, so a
// message from here every 20 seconds resets the worker's idle timer and keeps
// the native port and its ping running under background throttling. The worker
// only has to receive the message; there is nothing to answer.

const KEEPALIVE_INTERVAL = 20000;

setInterval(() => {
  chrome.runtime.sendMessage({ type: 'SW_KEEPALIVE', at: Date.now() }).catch(() => {
    // The worker is starting or the extension is reloading. The next tick tries again.
  });
}, KEEPALIVE_INTERVAL);
