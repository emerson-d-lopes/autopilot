// Campaign fixture server. A plain Node http port of the campaign's server.py,
// no dependencies, plus the extra pages Phase 0 item 2 asks for.
//
// Routes:
//   /                 static files from this directory (index.html by default)
//   /api/ok           200 json {ok:true, t}
//   /api/missing      404
//   /api/echo         POST, echoes the body back as json
//   /slow             200 after a 4s delay
//   /big              a 3000-row table, one button and one link per row
//   /redirect         302 to /index.html#redirected
//   /spa              "loading", then a #go button after 2s that renders <p id=done>
//   /dialog           alert, confirm and prompt buttons, an ok button, and
//                     #answer carrying what the page received back
//   /sensitive.html   password input, cc-number input, normal input
//   /unload.html      beforeunload handler that arms after any input
//   /scroll.html      overflow:hidden body with an inner overflow:auto container
//   /composer.html    LinkedIn-shaped composer: contenteditable + Send button + thread
//
// Exports start(port) returning the http.Server, and runs as a CLI when
// invoked directly: node server.js 8765

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.txt': 'text/plain',
};

function send(res, code, body, ctype = 'text/html') {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(code, { 'content-type': ctype, 'content-length': String(buf.length) });
  res.end(buf);
}

function bigTable() {
  let rows = '';
  for (let i = 0; i < 3000; i++) {
    rows += `<tr><td>row ${i}</td><td><button id='b${i}'>btn ${i}</button></td><td><a href='#${i}'>link ${i}</a></td></tr>`;
  }
  return `<table>${rows}</table>`;
}

const SPA_BODY = `<div id='app'>loading</div><script>
setTimeout(()=>{document.getElementById('app').innerHTML='<button id=go onclick="document.getElementById(\\'app\\').innerHTML=\\'<p id=done>done</p>\\'">go</button>'},2000);
</script>`;

// Each dialog writes its answer into #answer, so a test can read what the page
// received rather than only what the tool reported.
const DIALOG_BODY = `<button id='al' onclick='alert(1)'>alert</button>
<button id='cf' onclick='document.getElementById("answer").textContent = "confirm:" + confirm("proceed?")'>confirm</button>
<button id='pr' onclick='document.getElementById("answer").textContent = "prompt:" + prompt("your name?", "default")'>prompt</button>
<button id='ok' onclick='this.textContent="clicked"'>ok</button>
<div id='answer'>no answer</div>`;

const SENSITIVE_BODY = `<!doctype html><html><head><meta charset="utf-8"><title>sensitive</title></head><body>
<h1>Sensitive fields</h1>
<form id="f">
<label>Password <input type="password" id="pw" name="pw" autocomplete="current-password"></label><br>
<label>Card number <input type="text" id="cc" name="cc" autocomplete="cc-number"></label><br>
<label>Notes <input type="text" id="notes" name="notes"></label>
</form>
</body></html>`;

const UNLOAD_BODY = `<!doctype html><html><head><meta charset="utf-8"><title>unload</title></head><body>
<h1>Unload test</h1>
<input type="text" id="notes">
<span id="armed">not armed</span>
<script>
let armed = false;
document.getElementById('notes').addEventListener('input', () => {
  armed = true;
  document.getElementById('armed').textContent = 'armed';
});
window.addEventListener('beforeunload', (e) => {
  if (armed) { e.preventDefault(); e.returnValue = ''; }
});
</script>
</body></html>`;

const SCROLL_BODY = `<!doctype html><html><head><meta charset="utf-8"><title>scroll</title>
<style>
html,body{overflow:hidden;margin:0;height:100%}
#container{overflow:auto;height:300px;width:400px;border:1px solid #333}
#inner{height:3000px;width:100%;background:linear-gradient(#fff,#369)}
#marker{position:absolute;top:2800px}
</style></head><body>
<h1 style="position:fixed;top:0;left:420px">scroll fixture</h1>
<div id="container"><div id="inner"><div id="marker">near the bottom</div></div></div>
</body></html>`;

const COMPOSER_BODY = `<!doctype html><html><head><meta charset="utf-8"><title>composer</title>
<style>
body{font-family:sans-serif;margin:20px}
#composer{border:1px solid #ccc;border-radius:8px;padding:10px;max-width:500px}
#box{min-height:60px;border:1px solid #ddd;padding:8px;outline:none}
#send[disabled]{opacity:0.4}
#thread li{margin:4px 0;padding:6px;background:#f2f2f2;border-radius:6px}
</style></head><body>
<h1>Message composer</h1>
<form id="composer" onsubmit="return false">
  <div id="box" contenteditable="true" role="textbox" aria-label="Message"></div>
  <button id="send" type="submit" disabled>Send</button>
  <button id="draft" type="button">Save draft</button>
</form>
<div id="toast" role="status"></div>
<ul id="thread"></ul>
<script>
const box = document.getElementById('box');
const send = document.getElementById('send');
const draft = document.getElementById('draft');
const toast = document.getElementById('toast');
const thread = document.getElementById('thread');
const form = document.getElementById('composer');
box.addEventListener('input', () => {
  send.disabled = box.textContent.trim().length === 0;
});
form.addEventListener('submit', () => {
  const text = box.textContent.trim();
  if (!text) return;
  const li = document.createElement('li');
  li.textContent = text;
  thread.appendChild(li);
  box.textContent = '';
  send.disabled = true;
  toast.textContent = 'Message sent';
  // A 2xx from this origin, which is the network half of the submit evidence.
  fetch('/api/echo', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sent: text }),
  }).catch(() => {});
});
// The reversible half: a save that leaves a control on the page undoing it.
draft.addEventListener('click', () => {
  const text = box.textContent.trim();
  if (!text) return;
  toast.textContent = 'Draft saved';
  if (!document.getElementById('discard')) {
    const undo = document.createElement('button');
    undo.id = 'discard';
    undo.type = 'button';
    undo.textContent = 'Discard draft';
    undo.addEventListener('click', () => {
      undo.remove();
      toast.textContent = 'Draft discarded';
    });
    form.appendChild(undo);
  }
});
send.addEventListener('click', (e) => {
  e.preventDefault();
  form.dispatchEvent(new Event('submit'));
});
</script>
</body></html>`;

async function serveStatic(req, res) {
  let path = decodeURIComponent(req.url.split('?')[0]);
  if (path === '/') path = '/index.html';
  const full = normalize(join(DIR, path));
  if (!full.startsWith(DIR) || !existsSync(full)) {
    send(res, 404, 'not found', 'text/plain');
    return;
  }
  try {
    const data = await readFile(full);
    const ext = path.slice(path.lastIndexOf('.'));
    send(res, 200, data, MIME[ext] || 'application/octet-stream');
  } catch {
    send(res, 404, 'not found', 'text/plain');
  }
}

function handler(req, res) {
  const path = req.url.split('?')[0];

  if (req.method === 'GET') {
    if (path === '/api/ok') return send(res, 200, JSON.stringify({ ok: true, t: Date.now() / 1000 }), 'application/json');
    if (path === '/api/missing') return send(res, 404, 'not found', 'text/plain');
    if (path === '/slow') return setTimeout(() => send(res, 200, "<h1 id='slow'>slow page</h1>"), 4000);
    if (path === '/big') return send(res, 200, bigTable());
    if (path === '/redirect') {
      res.writeHead(302, { location: '/index.html#redirected' });
      res.end();
      return;
    }
    if (path === '/spa') return send(res, 200, SPA_BODY);
    if (path === '/dialog') return send(res, 200, DIALOG_BODY);
    if (path === '/sensitive.html') return send(res, 200, SENSITIVE_BODY);
    if (path === '/unload.html') return send(res, 200, UNLOAD_BODY);
    if (path === '/scroll.html') return send(res, 200, SCROLL_BODY);
    if (path === '/composer.html') return send(res, 200, COMPOSER_BODY);
    return serveStatic(req, res);
  }

  if (req.method === 'POST' && path === '/api/echo') {
    let chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let parsed;
      try {
        parsed = JSON.parse(body || '{}');
      } catch {
        parsed = body;
      }
      send(res, 200, JSON.stringify({ echo: parsed, path }), 'application/json');
    });
    return;
  }

  send(res, 404, 'not found', 'text/plain');
}

export function start(port = 0) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// CLI: node server.js [port]
const isMain = process.argv[1] && normalize(fileURLToPath(import.meta.url)) === normalize(process.argv[1]);
if (isMain) {
  const port = Number(process.argv[2]) || 8765;
  start(port).then((server) => {
    const addr = server.address();
    console.log('campaign fixture server listening on http://127.0.0.1:' + addr.port);
  });
}
