// Loads the content script into a jsdom window and returns a message caller.
//
// The agent reads bare globals (document, getComputedStyle, Node), so it is
// evaluated inside the window realm rather than called from outside it. Layout
// is faked, since jsdom lays nothing out and every rect would otherwise be zero.

import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const AGENT_SOURCE = readFileSync(new URL('../extension/src/content/agent.js', import.meta.url), 'utf8');

export function loadPage(html, options = {}) {
  const {
    width = 1024,
    height = 768,
    url = 'https://example.test/page',
    // Simulates Chrome's checkVisibility, which reports false for a subtree the
    // renderer is skipping under content-visibility.
    contentVisibilitySkips = false,
  } = options;

  const dom = new JSDOM(html, { pretendToBeVisual: true, url, runScripts: 'outside-only' });
  const { window } = dom;

  window.innerWidth = width;
  window.innerHeight = height;
  window.outerWidth = width + 16;
  window.outerHeight = height + 88;

  window.Element.prototype.getBoundingClientRect = function () {
    const style = window.getComputedStyle(this);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
    }
    const offscreen = this.hasAttribute('data-offscreen');
    const top = offscreen ? 5000 : 100;
    return { left: 50, top, right: 250, bottom: top + 30, width: 200, height: 30, x: 50, y: top };
  };

  window.Element.prototype.scrollIntoView = function () {};

  if (contentVisibilitySkips) {
    window.Element.prototype.checkVisibility = function () {
      for (let el = this; el; el = el.parentElement) {
        const cv = el.getAttribute && el.getAttribute('data-content-visibility');
        if (cv === 'auto' || cv === 'hidden') return false;
      }
      const style = window.getComputedStyle(this);
      return style.display !== 'none' && style.visibility !== 'hidden';
    };
  }

  let listener = null;
  window.chrome = { runtime: { onMessage: { addListener: (fn) => (listener = fn) } } };

  window.eval(AGENT_SOURCE);
  if (!listener) throw new Error('content script did not register a message listener');

  const call = (message) =>
    new Promise((resolve) => {
      listener(message, {}, resolve);
    });

  return { window, call, dom, agent: window.__chromeMcpAgent };
}
