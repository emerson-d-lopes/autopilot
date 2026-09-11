#!/usr/bin/env node
// Renders extension/src/ui/icon.svg to the PNG sizes the manifest needs.
//
// Chrome wants PNG icons, and Node has no rasterizer, so the development
// browser does the drawing over its DevTools port: the SVG is loaded as a
// page and captured at each size. Run `npm run browser` first.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpSession, version } from './cdp.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SIZES = [16, 32, 48, 128];
const svg = readFileSync(join(ROOT, 'extension', 'src', 'ui', 'icon.svg'), 'utf8');
const outDir = join(ROOT, 'extension', 'icons');
mkdirSync(outDir, { recursive: true });

const v = await version().catch(() => null);
if (!v) {
  console.error('The development browser is not running. Start it with: npm run browser');
  process.exit(1);
}
const browser = await CdpSession.open(v.webSocketDebuggerUrl);
const html =
  '<!doctype html><html style="overflow:hidden"><body style="margin:0;overflow:hidden;background:transparent">' +
  svg.replace('<svg ', '<svg style="display:block" ') +
  '</body></html>';
const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank', newWindow: false });
const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
const send = (m, p) => browser.send(m, p, sessionId);
await send('Page.enable');
await send('Page.navigate', { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(html) });
await new Promise((r) => setTimeout(r, 800));
await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });

for (const size of SIZES) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: 128,
    height: 128,
    deviceScaleFactor: size / 128,
    mobile: false,
  });
  await new Promise((r) => setTimeout(r, 150));
  const { data } = await send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    clip: { x: 0, y: 0, width: 128, height: 128, scale: size / 128 },
  });
  const file = join(outDir, 'icon-' + size + '.png');
  writeFileSync(file, Buffer.from(data, 'base64'));
  console.log('wrote ' + file);
}
await browser.send('Target.closeTarget', { targetId });
process.exit(0);
