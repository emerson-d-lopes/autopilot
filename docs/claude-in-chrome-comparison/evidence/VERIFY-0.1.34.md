# Live verification of the second set of bug fixes

Branch `plan/integration2`. The pass started on extension 0.1.34 and ended on 0.1.37, because three fixes landed while it ran. Run 2026-09-04. This is the fourth live pass. The three before it are [VERIFY-0.1.11.md](VERIFY-0.1.11.md), [VERIFY-0.1.28.md](VERIFY-0.1.28.md) and [VERIFY-0.1.31.md](VERIFY-0.1.31.md).

The ten fixes merged from `plan/bugs2` close the ten bugs the second pass left open, and three more fixes close the three the third pass opened. This pass checks each one against a browser, re-runs a regression set from all three earlier passes, and records what it found.

## How this pass was driven

Same method as the three earlier passes. Every call went through `tools/mcp-client.js`, which spawns `host/mcp-server.js` from this working tree, so the code under test is the code on disk. This session's own `mcp__chrome-mcp__*` tools were never used.

```
node tools/mcp-client.js <tool> '<json args>' [--browser dev]
```

Most checks ran through a script holding one client open across a group of calls, with `CHROME_MCP_CLIENT_ID` pinned so a later script resumes the same session and its tabs. Calls that need extension internals went through the DevTools port on 9333, to the service worker target, the way `test/shortcuts.test.js` does.

The browser is Chrome for Testing 152.0.7977.75 launched by `node tools/browser.js --interferer --detach`, after killing the one already running so the script cache was dropped. Registry id `bwlhg5ra0`, profile `Default "Your Chromium"`, signed in to nothing. The interferer extension mounts a `chrome-extension://` iframe into every page, so `attach_recovered` appears in several results below.

The fixture server is `node test/fixtures/campaign/server.js 8765`.

`npm run doctor` at the start of the pass:

```
  ok   Chrome extension is attached
         extension v0.1.34, 19 handlers, 26 tools advertised
         profile Default "Your Chromium"  account not signed in  label none  local true  dev true
         sessions none detected
```

The browser was restarted for each fix and `npm run doctor` re-run, so every result below names the version it was measured on. Nothing in this pass activated a tab or focused a window. The user's own Chrome is connected as `bz04vrv3f` and was never driven.

`chrome.runtime.reload()` was not used: on this Chrome it disables an unpacked extension.

## The ten bugs2 fixes

### 1. A scaled screenshot uses the clip path and costs less

`/index.html` on a fresh tab, so the first scaled capture is the first capture the tab has produced.

```
=== 1a. scale 0.5, first on a fresh tab (158 ms wall) ===
[image image/jpeg, 11454 bytes]
screenshot 486x271 (~168 tokens) id: img_1
0.5-scale view; coordinate frame: 486x271. Coordinates are pixels in this image and are mapped back to the page for you. Full-resolution frame: 972x542.
[ok=true effects=none id=call_2_bbq5bc evidence={"capture":{"path":"canvas","format":"jpeg","quality":0.75,"scale":0.5}}]

=== 1b. scale 0.5, second (184 ms wall) ===
[image image/jpeg, 10440 bytes]
screenshot 486x271 (~168 tokens) id: img_2
[ok=true effects=none id=call_3_kdmxj7 evidence={"capture":{"path":"clip","format":"jpeg","quality":0.75,"scale":0.5}}]
```

Neither carries a warning, against the second pass where every scaled capture warned that the clip path had failed its size check. The first is `canvas`, because the plan is measured from a capture the tab has actually produced and there was none yet. The second is `clip`.

Five of each, interleaved, on the same tab:

```
=== 1c. five each, interleaved, wall ms ===
scale 0.5: 96, 107, 109, 107, 109  median 107
scale 1  : 110, 125, 126, 125, 125  median 125
```

486x271 at scale 0.5, and the scaled capture is now cheaper than the unscaled one, against the second pass's 216 ms against 133. **Pass.**

### 2. A cleared console buffer stays cleared

A fresh tab, arm the buffer with a message logged before the first read:

```
=== 2a. javascript console.log("pre-arm-unique-42") ===
=== 2b. first read on this tab ===
[info] --- navigated to http://127.0.0.1:8765/index.html ---
[log] cdp-trap Object (index.html:63)
[log] page loaded (index.html:64)
[warn] a warning (index.html:64)
[error] an error at load (index.html:64)
[log] pre-arm-unique-42

[6 entries]
warnings:
  - console capture started with this call. Chrome replayed the console history it had kept for this tab, so entries from before this call are included; anything older than that history is not. Set console capture to always in the extension options to capture live from the moment a tab joins the session, at the cost of leaving Runtime enabled, which is what a CDP detector reads.
```

The message logged before the first read is in it, and the warning says Chrome replayed the history. Then a clearing read and a plain one:

```
=== 2c. read with clear true ===
[6 entries]
warnings:
  - console capture was turned off again because this read cleared the buffer. The next read turns it back on and starts from that moment.

=== 2d. plain read after the clear ===
No console messages.
warnings:
  - console capture was re-armed by this call after an earlier read cleared the buffer. The history Chrome replayed from before that clear is filtered out, so this result holds output from after it.

=== 2e. log something new ===
=== 2f. read again ===
[log] post-clear-unique-77

[1 entries]
```

Zero entries after the clear with the warning naming the filter, and a message logged afterwards comes through on its own. Against the second pass, where the same six entries came back after the clear. **Pass.**

### 3. A ref click lands on a line box

The hover menu is 51 px wide, so `Hidden link` wraps and its bounding-box centre falls off the element.

```
3b. Hidden link ref: ref_28
3c. RESOLVE_REF geometry through the service worker:
{"x":39,"y":294,"width":51,"height":37,"centerX":64,"centerY":303,"pointSource":"clientRect","inViewport":true}
```

```
=== 3d. left_click Hidden link by ref (857 ms wall) ===
{
  "ok": true,
  "at": {"x": 64, "y": 266, "source": "ref"},
  "effects": "applied",
  "evidence": {"windowMs": 250, "watched": true, "mutations": 3, "focusChanged": true,
    "focusedAfter": "Hidden link", "valueChanged": false, "scrolled": true,
    "scrollDelta": {"pageX": 0, "pageY": 43, "containerX": 0, "containerY": 43}},
  "warnings": [],
  "durationMs": 854
}

3e. after the click:
{"hoverout":"hover link clicked","saw":[["down","A","hoverlink",64,266]]}
```

`geometry.pointSource` is `clientRect`, the pointerdown target is the `A` with id `hoverlink`, and the page's own handler ran. The second pass saw `["down","LI",...]` and an empty `hoverout`. **Pass.**

### 4. Gif frames without the acting indicator

`gif_creator start` with every overlay on, a click by ref, a type, a scroll and a screenshot, then `stop`. Six frames at 480x268, decoded through `test/fixtures/campaign/gifview.html` and sampled pixel by pixel in the page.

On 0.1.34:

```
{"frame": 0, "size": "480x268", "orangeEdgePixels": 3, "stopRedPixels": 0, "pillDarkPixels": 0,
 "watermarkColours": [["255,255,255", 1283], ["235,235,235", 13], ["248,248,248", 13], ["196,196,196", 11]]}
...
{"frame": 5, ..., "orangeEdgePixels": 8, "stopRedPixels": 0, "pillDarkPixels": 0,
 "watermarkColours": [["255,255,255", 1176], ["248,248,248", 63], ["209,209,209", 37], ["235,235,235", 14]]}
```

No Stop capsule and no indicator pill in any frame, and the only saturated orange on the edges is the gif's own progress bar, which is `#c96442` along the bottom and grows from 3 to 8 sampled pixels across the six frames. A border ring would put that colour on all four edges. The screenshots of frames 0 and 1 show the action label pill, the click ring, the progress bar and the drawn cursor, and no border.

The watermark box, 84 by 16 px at the bottom right, held white and the page's own greys and nothing else. The same recording with the page background set to `#111` held `144,144,144` there, which is `rgba(255,255,255,0.55)` over `#111`, so the mark was drawn both times and only the dark page showed it. That is a new bug, fixed in `8c39149` during this pass.

On 0.1.35, the same recording:

```
{"frame": 0, "size": "480x268", "orangeEdgePixels": 3, "stopRedPixels": 1, "pillDarkPixels": 0,
 "watermarkColours": [["255,255,255", 828], ["118,118,118", 92], ["235,235,235", 40], ["204,204,204", 39]]}
```

`118,118,118` is the stroke behind the glyphs, and the zoomed frame reads `chrome-mcp` plainly. **Pass after a fix in this pass.**

### 5. A missing required argument is refused

```
5a. before: {"url":"http://127.0.0.1:8765/index.html","title":"Bridge test page","scrollY":0}
5b. navigate {tabId} with no url, 1 ms wall
navigate needs url. The call was refused here, so nothing was sent to the browser.
hint: Add url and call again.
[ok=false code=bad_request effects=none retryable=false id=call_3_v55dhl]
5c. after:  {"url":"http://127.0.0.1:8765/index.html","title":"Bridge test page","scrollY":0}
```

```
=== 5d. computer left_click ref_1 with no tabId (0 ms wall) ===
computer needs tabId. The call was refused here, so nothing was sent to the browser.
hint: Add tabId and call again.
[ok=false code=bad_request effects=none retryable=false id=call_5_mc7h2t]
```

Both name the missing argument, both are refused in the host in about a millisecond, and the tab is on the same URL with the same scroll position afterwards. **Pass.**

### 6. Return is treated as a submit

`/composer.html`, click the box, type, then `computer key` with `text: "Return"`:

```
=== 6a. computer key "Return" (3821 ms wall) ===
{
  "ok": true, "keys": "Return", "repeat": 1, "effects": "applied",
  "evidence": {
    "windowMs": 3000, "watched": true, "mutations": 4, "valueChanged": true,
    "submit": {
      "fired": ["composer emptied", "a new node carries the text", "status region", "2xx from the site"],
      "composerEmptied": true, "newNode": {"tag": "li", "chars": 15},
      "status": {"role": "status", "text": "Message sent"}, "windowMs": 3075,
      "network": [{"method": "POST", "status": 200, "url": "http://127.0.0.1:8765/api/echo"}]
    }
  },
  "irreversible": true,
  "write": {"control": "Send", "origin": "http://127.0.0.1:8765", "before": "write_1_2gfw",
    "after": ["composer emptied", "a new node carries the text", "status region", "2xx from the site"],
    "undo": "none", "value": "return key 0135", "sensitive": false}
}

6b. page after: {"thread":["return key 0135"],"toast":"Message sent"}
```

`windowMs` 3000 and four submit signals, against the second pass where `Return` kept the 250 ms window and gathered no submit evidence. **Pass.**

### 7. A confirmation shows its screenshot id and the call that fetches it

`permissionPolicy.mode` set to `confirm` through `chrome.storage.local` from the service worker target, then a click on Send with the composer holding text.

```
=== 7a. click Send in confirm mode (834 ms wall) ===
Pressing "Send" on http://127.0.0.1:8765 is irreversible and needs confirmation first. Nothing was clicked.
hint: Show the user what is about to happen, then repeat this exact call with confirm set to cx_1_h9nup4sm within 120 seconds. The token works once, on this tab, origin and control.
details: token="cx_1_h9nup4sm" control="Send" origin="http://127.0.0.1:8765" screenshotId="write_3_40xc"
to see what this would submit: computer {"action":"screenshot","tabId":<tab>,"imageId":"write_3_40xc"}
[ok=false code=confirmation_required effects=none retryable=false id=call_6_su6qms]
```

The `details:` line carries all four fields and the call to fetch the image. Running that call:

```
7c. page before fetching the image: {"box":"confirm details 0135","thread":0}
=== 7d. computer screenshot with imageId (7 ms wall) ===
[image image/jpeg, 17622 bytes]
screenshot 988x551 (~695 tokens) id: img_1
[ok=true effects=none id=call_8_2wjutq evidence={"capture":{"path":"stored","imageId":"write_3_40xc"}}]
warnings:
  - this is the capture taken before the write, not the page as it is now
```

The image shows the composer holding `confirm details 0135` with an empty thread and Send still enabled, which is the page before the write. **Pass.**

The stored capture carries the acting indicator, the orange border and the Stop capsule, which the ordinary screenshot path hides. Recorded as an observation, not a check in this list.

### 8. An unanswered browser confirmation has its own deadline

`confirmNotifications: true` with `mode: confirm`, then a click on Send.

A person at this machine kept activating the real toast's Allow button while the check ran, so this was measured with `chrome.notifications.create` stubbed in the worker to record the call and show nothing, and `chrome.notifications.clear` wrapped to record the close. The deadline is what is under test. The stray activations are written up under open findings below.

```
8a. before: {"tabs":[{"id":369886070,"url":"about:blank"}],"windows":[{"id":369886069,"focused":false}]}
8b. notification asked at t+5s: [{"id":"chrome-mcp-confirm-ah0g89am","title":"Confirm an irreversible action",
    "message":"Press \"Send\" on http://127.0.0.1:8765?","buttons":["Allow","Deny"],"at":1788552583306}]
8c. during: {"tabs":[{"id":369886070,"url":"about:blank"}],"windows":[{"id":369886069,"focused":false}]}
8d. settled at t+60836 ms
```

```
The browser was asked to confirm pressing "Send" on http://127.0.0.1:8765 and nobody answered within 60 seconds. The notification was closed and nothing was clicked.
hint: Ask the user to answer the notification, or turn browser confirmations off in the extension options and confirm with a token instead. Repeating this call opens another notification and waits again.
details: control="Send" origin="http://127.0.0.1:8765" screenshotId="write_7_yy8r"
[ok=false code=confirmation_required effects=none retryable=false id=call_6_zmwobs]

8e. cleared: [{"id":"chrome-mcp-confirm-ah0g89am","at":1788552643317}]
8f. after: {"tabs":[{"id":369886070,"url":"about:blank"}],"windows":[{"id":369886069,"focused":false}]}
8g. page: {"box":"unanswered 0135","thread":0}
```

60.8 s, `confirmation_required`, `retryable: false`, and the message names the browser rather than the renderer. The notification was cleared 60011 ms after it was created. No tab was activated, no window focus changed, and the composer still holds its text with an empty thread. Against the second pass's 120 s `timeout` blaming the renderer with the notification left open. **Pass.**

### 9. The transition warning is on the navigate that causes it

```
=== 9a. a call on the fixture first ===
{"url": "http://127.0.0.1:8765/index.html", ...}

=== 9b. navigate to https://example.com (38 ms wall) ===
{
  "tabId": 369886132, "url": "https://example.com/", "status": "complete",
  "warnings": ["this call acts on https://example.com, and the session last acted on http://127.0.0.1:8765. Confirm the new origin is the one you meant before acting further."]
}

=== 9c. read_page on the tab that just moved ===
url: https://example.com/  |  title: Example Domain  |  nodes: 1
link "Learn more" [ref_1] href=https://iana.org/domains/example
[ok=true effects=none id=call_4_stx1l8 evidence={"filter":"interactive","nodes":1,...}]
```

The warning is on the navigate's own result and the next call on the tab it moved carries none. Coming back the other way behaves the same:

```
=== 9d. navigate back to the fixture (132 ms wall) ===
"warnings": [
  "this call acts on http://127.0.0.1:8765, and the session last acted on https://example.com. Confirm the new origin is the one you meant before acting further.",
  "attach_recovered: tab 369886132 refused the debugger, removed 1 extension iframe and re-attached after 1 attempt."
]

=== 9e. the next fixture call ===
"warnings": []
```

**Pass.**

### 10. Journal redaction covers a javascript return value

With `CHROME_MCP_JOURNAL_REDACT=1` in the browser's environment, so the native host it spawns writes the journal in redaction mode. `npm run doctor` reads it back from the host rather than from the shell:

```
  host for Chrome (bz04vrv3f): retention 14 days, redaction off, dir C:\Users\edfl\AppData\Local\Temp\chrome-mcp-logs
  host for Chrome (bwlhg5ra0): retention 14 days, redaction on, dir C:\Users\edfl\AppData\Local\Temp\chrome-mcp-logs
  this shell: retention 14 days (CHROME_MCP_JOURNAL_DAYS), redaction off (CHROME_MCP_JOURNAL_REDACT). The host writes the journal, so its line above is the one that counts.
```

A write on the composer, then a `javascript` returning the text the write submitted, then a `javascript` returning an unrelated string:

```
10a. the write: "control": "Send", "value": "journal-redact-0136",
--- jsonl rows for this run ---
{"tool":"computer","redacted":true}
{"tool":"computer","redacted":true}
{"tool":"computer","redacted":true,"write":{"control":"Send","origin":"http://127.0.0.1:8765","before":"write_1_l2b0",
  "after":["composer emptied","a new node carries the text","status region","2xx from the site"],"undo":"none","value":"[value redacted]"}}
{"tool":"javascript","redacted":true,"value":"[value redacted]"}
{"tool":"javascript","redacted":true,"value":"[value redacted]"}
--- the plaintext anywhere in either file? ---
jsonl: journal-redact-0136 absent, unrelated-plain-0136 absent
md: journal-redact-0136 absent, unrelated-plain-0136 absent
```

The markdown timeline says the same, with `args redacted` on every row and `value=[value redacted]` on both javascript rows.

With the switch off, a type into the password field of `/sensitive.html`, a `javascript` reading that field back, then the same pair on the ordinary Notes field:

```
--- journal rows for this run ---
{"tool":"computer","args":{"action":"left_click","ref":"ref_1"}}
{"tool":"computer","args":{"action":"type","text":"[value redacted]"}}
{"tool":"javascript","args":{"code":"document.getElementById('pw').value"},"value":"[value redacted]"}
{"tool":"computer","args":{"action":"left_click","ref":"ref_3"}}
{"tool":"computer","args":{"action":"type","text":"ordinary-note-0135"}}
{"tool":"javascript","args":{"code":"document.getElementById('notes').value"},"value":"\"ordinary-note-0135\""}
```

The password is redacted in the argument and again when it comes back through a return value, and the unrelated value is written in full. Against the second pass, where the same return value was written out. **Pass.**

## The three fixes for the bugs the third pass opened

### 11. A read behind a frozen renderer

A 50 s busy loop in `javascript`, and a screenshot on the same tab 300 ms later, both from one session on a tab that had already produced a capture.

On 0.1.34:

```
=== 50000 ms loop, one session: screenshot answered 40029 ms after it was issued ===
CDP Page.getLayoutMetrics waited 20000ms on tab 369886135 behind Runtime.evaluate, unanswered for 40330ms. The renderer is not answering.
cause: the renderer has not answered an earlier command
hint: the renderer did not respond, reload the tab with navigate
[ok=false code=timeout effects=none retryable=true id=call_4_sygqxe]
=== the javascript call answered at t+50008 ms ===
{"result": "busy done", "durationMs": 50003, "ok": true}
```

`ok: false`, `timeout`, `effects: none` and the reload hint all hold, against the third pass where the read retry turned the same timeout into a slow success at 49.8 s. The reply came at 40 s rather than 20, which is the second half of the check and did not hold. The cause is the swallowed `HIDE_FOR_TOOL_USE` before the capture, and it is fixed in `6eb9a03`.

On 0.1.37, the same pair:

```
=== 50000 ms loop, one session: screenshot answered 20014 ms after it was issued ===
CDP screenshot waited 20000ms on tab 369886839 behind Runtime.evaluate, unanswered for 20311ms. The renderer is not answering.
cause: the renderer has not answered an earlier command
hint: the renderer did not respond, reload the tab with navigate
[ok=false code=timeout effects=none retryable=true id=call_4_hhizwv]
=== the javascript call answered at t+50007 ms ===
{"result": "busy done", "durationMs": 50002, "ok": true}
```

20.0 s. A 2 s loop with the same script:

```
=== 2000 ms loop, one session: screenshot answered 1894 ms after it was issued ===
screenshot 972x542 (~672 tokens) id: img_2
[ok=true effects=none id=call_4_xaxhtg evidence={"capture":{"path":"canvas","format":"jpeg","quality":0.75,"scale":1}}]
```

The capture of that 2 s case was saved and read: no orange border and no Stop capsule, so the indicator was still hidden for it. **Pass after a fix in this pass.**

### 12. A capture after a submit carries paint evidence

`/composer.html`, `quick` with `C ref` / `T text` / `K Enter` / `SS`, on 0.1.37:

```
line 3 K ok
  [ok=true effects=applied evidence={"windowMs":3000,"watched":true,"mutations":4,"valueChanged":true,
    "submit":{"fired":["composer emptied","a new node carries the text","status region","2xx from the site"],
    "composerEmptied":true,"newNode":{"tag":"li","chars":16},"status":{"role":"status","text":"Message sent"},
    "windowMs":3074,"network":[{"method":"POST","status":200,"url":"http://127.0.0.1:8765/api/echo"}]}}]
line 4 SS ok
  [ok=true effects=none evidence={"paint":{"path":"screencastFrame","painted":true},
    "capture":{"path":"canvas","format":"jpeg","quality":0.75,"scale":1}}]

12a page: {"thread":1}
```

The same script without `K Enter`:

```
line 3 SS ok
  [ok=true effects=none evidence={"paint":{"path":"screencastFrame","painted":true},
    "capture":{"path":"canvas","format":"jpeg","quality":0.75,"scale":1}}]

12b page: {"thread":0}
```

`paint.painted: true` on the `SS` line with the submit and without it, against the third pass where the submit's own 3000 ms window outlasted the 2000 ms paint window and the `SS` line carried only the capture. **Pass.**

### 13. A session across a service worker restart

The check needs the worker stopped and started again. Two routes were tried.

Chrome's own idle timeout does not reach it. With two tabs in a session and nothing else running, the service worker target stayed in the DevTools list for the whole window, polled over HTTP so nothing kept it alive:

```
13c. waiting for Chrome to stop the idle worker, polling /json/list only
  t+5s worker present: true
  ...
  t+180s worker present: true
13c. worker stopped by Chrome: false after 180s
```

The extension holds a native messaging port to the host, and a connected port keeps the worker alive, so a browser with the bridge attached never reaches the 30 s idle path.

The route that does stop it is the Stop button on `chrome://serviceworker-internals`. The page is opened in a background tab through the extension's own `chrome.tabs.create({active: false})`, the button is a `cr-button` inside the registration whose scope is this extension, and it is pressed with a trusted click through `Input.dispatchMouseEvent` on that page's CDP target, since `element.click()` does not reach the WebUI handler.

```
13a. two tabs 369888112, 369888113 in group 1368769702, tabs_context lists 2
13a. page targets before: ["http://127.0.0.1:8765/composer.html","http://127.0.0.1:8765/index.html","about:blank"]
13b. worker target before the stop: true
13b. Stop pressed on chrome://serviceworker-internals: {"ok":true,"statusBefore":"RUNNING","x":66,"y":275}

=== 13c. read_page on tab 369888112 (63 ms wall) ===
No tab with id 369888112. It may have been closed. Call tabs_context to list current tabs.
hint: Call tabs_context to list the tabs this session owns, then retry on a live tab.
[ok=false code=tab_gone effects=unknown retryable=false id=call_4_4arq71]

13d. tabs_context after: group null, tabs listed 0, missingTabs false
13d. page targets after:  ["chrome://serviceworker-internals/","http://127.0.0.1:8765/composer.html","http://127.0.0.1:8765/index.html","about:blank"]
```

Both tabs are still open, which the DevTools page list shows before and after. The session lost them: `tab_gone` on a live tab, an empty `tabs_context`, `tabGroupId: null`, and no `missingTabs` to say anything went away. **Fail.** New open bug 1 below.

## Regression on the first pass

### 14a. First-pass checks 6, 7, 17, 24, 25, 28, 29

```
6a. ref for btn 2999: ref_5999
6b. click: {"ok":true,"at":{"x":109,"y":530,"source":"ref"},"effects":"applied",
     "evidence":{"windowMs":250,"watched":true,"mutations":0,"focusChanged":true,
                 "focusedAfter":"btn 2999","valueChanged":false,"scrolled":false}}
6c. window.__hit: true

7a. ref for a cell: ref_6052
7. inert click: {"ok":true,"effects":"none",
     "evidence":{"windowMs":250,"watched":true,"mutations":0,"focusChanged":false,
                 "focusedAfter":null,"valueChanged":false,"scrolled":false},
     "warnings":["no observable change within 250ms"]}

17 result: {"recovered":0,"errors":[],"refused":0,"replaced":0,"dead":0}
17 tab still in session: true

24 result: {"ok":3,"fail":0,"recovered":0,"lost":0}

25 result: {"ok":50,"fail":0,"recovered":0,"replaced":0,"dead":0,"firstError":null}
25 tab still in session: true

28 run 1 (field ref_11): line 1 C ok / line 2 T ok / line 3 K ok / line 4 SS ok
28 run 1 page text has the todo: true
28 run 2 page text has the todo: true
28 run 3 page text has the todo: true

29 run 1 (ref_34): {"value":"ja","menuItems":["Java","JavaScript"],"menuOpen":true}
29 run 2 (ref_34): {"value":"ja","menuItems":["Java","JavaScript"],"menuOpen":true}
29 run 3 (ref_34): {"value":"ja","menuItems":["Java","JavaScript"],"menuOpen":true}
```

All seven hold. Twenty calls on the iframe fixture with the interferer loaded produced no error and no recovery this time, three fresh x.com tabs and fifty consecutive calls on one of them all landed, the inert click keeps `effects: none`, and the autocomplete holds `ja` with the menu open on all three runs. **Pass.**

## Regression on the second pass

### 14b. Second-pass checks 1, 6, 10, 20

```
=== r2a (second pass 1). default screenshot (196 ms wall) ===
[image image/jpeg, 31326 bytes]
screenshot 972x542 (~672 tokens) id: img_1
[ok=true effects=none evidence={"capture":{"path":"canvas","format":"jpeg","quality":0.75,"scale":1}}]
=== r2a control, format png (121 ms wall) ===
[image image/png, 68586 bytes]
[ok=true effects=none evidence={"capture":{"path":"canvas","format":"png","scale":1}}]
```

JPEG by default, 2.2x smaller than the same frame as PNG.

```
r2b (second pass 6). tab 369888460, active=false
hidden-tab screenshot, 106 ms wall
[image image/jpeg, 31326 bytes]
screenshot 972x542 (~672 tokens) id: img_3
```

106 ms for a tab the session never activated, and the image is the page.

`chrome.debugger.sendCommand` and `chrome.debugger.attach` wrapped in the service worker, then one session opened a tab, navigated twice, clicked a field by ref, typed and took a screenshot, never reading the console:

```
=== r2c (second pass 10). CDP methods this session sent (56 calls) ===
    6  *attach
    6  Input.dispatchMouseEvent
    5  Runtime.evaluate
    5  Page.stopScreencast
    4  Emulation.setFocusEmulationEnabled
    4  Page.setWebLifecycleState
    3  Log.enable
    3  Network.enable
    3  Page.enable
    3  DOM.enable
    3  Network.setCacheDisabled
    3  Page.startScreencast
    3  Page.screencastFrameAck
    2  Page.navigate
    2  Page.getLayoutMetrics
    1  Input.insertText
Runtime.enable present: false
page trap: {"cdpTrap":"no","name":"hello"}
```

No `Runtime.enable`, the fixture's own getter trap did not fire, and the typed text landed.

The four detector pages, one run each, console capture left at `lazy`:

```
=== deviceandbrowserinfo (5389 chars) ===
"isBot": false | hasBotUserAgent": false | hasWebdriverTrue": false | isHeadlessChrome": false
| isAutomatedWithCDP": false | isAutomatedWithCDPInWebWorker": false

=== bot.sannysoft.com (12794 chars) ===
Chrome/152.0.0.0 | WebDriver (New) | WebDriver Advanced | Plugins is of type PluginArray passed
| PHANTOM_UA ok | PHANTOM_PROPERTIES ok | PHANTOM_ETSL ok | PHANTOM_LANGUAGE ok | PHANTOM_WEBSOCKET ok
| PHANTOM_OVERFLOW ok | PHANTOM_WINDOW_HEIGHT ok | HEADCHR_UA ok | HEADCHR_CHROME_OBJ ok
| HEADCHR_PERMISSIONS ok | HEADCHR_PLUGINS ok | HEADCHR_IFRAME ok

=== browserscan.net (8077 chars) ===
Test Results: | No bots detected - the visitor could be a human using a regular browser

=== creepjs (4858 chars) ===
19% like headless | 0% headless | 0% stealth
```

No page called this browser a bot, and every reading matches the second and third passes. **Pass.**

## Regression on the third pass

### 14c. Third-pass checks 1, 2, 3, 5, 6, 8

```
=== r3a (third pass 1). find btn 2999 on /big, 119 ms wall ===
20 match(es):
button "btn 2999" [ref_5999] (offscreen)
button "btn 0" [ref_1]
...
[ok=true effects=none evidence={"scope":"interactive","searched":6000}]

=== r3a. find 50.20 on the-internet/large, 49 ms wall ===
cell "50.20" [ref_2582] (offscreen)
cell "20.50" [ref_1082] (offscreen)
...
[ok=true effects=none evidence={"scope":"all","searched":2815,"widenedBecause":"no interactive node matched"}]
```

The exact label is match 0 on both, the whole interactive tree is searched with no truncation, and `50.20` still outranks `20.50`.

```
=== r3b (third pass 2). left_click "blank link" ===
{"ok": true, "effects": "applied", "newTabId": 369888469,
 "evidence": {"windowMs": 761, "watched": true, "opensTab": true, "waitedForTab": true,
   "mutations": 2, "focusChanged": true, "focusedAfter": "blank link", "newTabId": 369888469}}
```

```
r3c. attachRecovery off: {"attachRecovery":false}
=== r3c. tabs_create with attachRecovery off, 28 tabs before ===
Tab 369888473 could not be driven and was replaced by tab 369888474 on the same URL.
[ok=false code=tab_replaced effects=none retryable=true id=call_9_7k5s8j]

=== r3c. a second call on the same tab ===
Tab 369888474 was refused for the same reason as the tab it replaced, so it was not replaced again.
cause: Cannot access a chrome-extension:// URL of different extension
hint: Disable the extension holding a frame in this tab, or drive the page from a profile without it.
[ok=false code=attach_refused effects=none retryable=false id=call_10_3bum40]

=== r3c. tab counts: before 28, after create 30, after second 30, after third 30 ===
```

The count goes up by two for the tab and its one replacement and never moves again.

```
=== r3d (third pass 5). batch of 6, the fifth carries ref_99999 ===
Batch not run: item 5 (computer) names ref_99999, which is no longer on the page in tab 369888479.
hint: Read the page again to get current refs, then send the batch. Nothing ran.
[ok=false code=batch_invalid effects=none retryable=false id=call_4_sniuzd]
r3d. page state before: {"name":"","marks":[null,null,null]}
r3d. page state after:  {"name":"","marks":[null,null,null]}

=== r3d. a batch whose click uses a ref an earlier step produced ===
[0] read_page ok
  [ok=true effects=none evidence={"filter":"interactive","nodes":27,...}]
```

The item, the ref and the tab are named, the page is untouched, and a ref an earlier step produces is not pre-validated.

```
r3e. window before: {"state":"normal","left":0,"top":0,"width":1000,"height":700}
r3e. window maximized: {"state":"maximized","left":-6,"top":-6,"width":1720,"height":926}
=== r3e (third pass 6). resize_window 1000x700 ===
  "viewport": {"width": 988, "height": 551},
  "outerWidth": 1000,
r3e. window after: {"state":"normal","left":0,"top":0,"width":1000,"height":700}
```

```
=== r3f (third pass 8). a 4005-character console message ===
[log] LONG:zzzzzzzzzzzzzzzzzzzz<472 more z>...

[1 entries, 1 message clipped to 500 characters, the longest was 4005]
warnings:
  - 1 message(s) clipped to 500 characters, the longest was 4005.

=== r3f. read_network_requests on CNN with no filter ===
[35 requests, 3 URLs clipped to 300 characters, the longest was 1039]
warnings:
  - 3 URL(s) clipped to 300 characters, the longest was 1039.
```

**Pass** on all six.

## Tests and bench

### 15. node --test test/campaign.test.js, npm run bench, npm run bench:screenshot

```
campaign fixture: already-ahead table stays true (5533.8319ms)
tests 12
pass 12
fail 0
```

`CHROME_MCP_BROWSER_ID=bwlhg5ra0 npm run bench`, three runs, appended to `.bench/2026-09-04.jsonl`. Extension 0.1.37.

| Measurement | 0.1.7 median | 0.1.30 median wall | 0.1.32 median wall | This build, median wall | This build, median tool |
|---|---|---|---|---|---|
| 1a. 10 separate `javascript` 1+1 calls | 7927 ms | 43 ms | 47 ms | 47 ms | 23 ms |
| 1b. 10 1+1 calls in one `browser_batch` | 5614 ms | 14 ms | 16 ms | 16 ms | 12 ms |
| 1c. 10 1+1 lines in a `quick` script | 3464 ms | 15 ms | 16 ms | 16 ms | 12 ms |
| 2. 10 separate screenshots | 8829 ms | 1354 ms | 1392 ms | 1780 ms | n/a |
| 3. `read_page` all+interactive, two pages | 10350 ms | 442 ms | 447 ms | 472 ms | n/a |
| 4. `get_page_text`, two pages | 8781 ms | 383 ms | 386 ms | 394 ms | n/a |
| 5. `find`, two queries | 6104 ms | 535 ms | 544 ms | 554 ms | n/a |
| 6. `navigate`, four targets | 9054 ms | 4508 ms | 4528 ms | 4536 ms | 4521 ms |
| 7. realistic form flow as one batch | 17381 ms | 10312 ms | 11969 ms | 10271 ms | 1 ms |
| 8. type 500 chars, plain then perKey | 9521 ms | 44361 ms | 43542 ms | 42471 ms | 35881 ms |
| 9. `javascript 'x'.repeat(200000)` | 4642 ms | 7 ms | 8 ms | 7 ms | 4 ms |

Row 2 is 1780 ms against 1392, and rows 3, 4 and 5 are 5 to 6 percent higher than the third pass. The machine was running the fixture server, two Chromes and the pass's own scripts throughout. Row 7's three runs were 7839, 10271 and 11799 ms, the same wide spread the two earlier passes reported.

`npm run bench:screenshot`, extension 0.1.37, appended to `.bench/2026-09-04-screenshot.jsonl`:

```
page    variant    size        payload   tokens   median ms   total ms  path    coordinate frame
index   png s1     972x542     67KB      ~672     177         1737      canvas
index   png s0.5   486x271     26KB      ~168     195         1755      clip    486x271
index   jpeg s1    972x542     31KB      ~672     206         1972      canvas
index   jpeg s0.5  486x271     10KB      ~168     183         1688      clip    486x271
big     png s1     972x542     76KB      ~672     136         1588      canvas
big     png s0.5   486x271     31KB      ~168     182         1644      clip    486x271
big     jpeg s1    972x542     30KB      ~672     195         1795      canvas
big     jpeg s0.5  486x271     10KB      ~168     172         1541      clip    486x271

index page, JPEG against PNG at the same size: 31KB against 67KB, 2.2x smaller
10 screenshots, JPEG at scale 1: 1972 ms total, median 206 ms per capture (Phase 5 target: under 6000 ms for ten)
```

Every scaled row reads `clip` where the third pass read `canvas` on all eight, which closes the second pass's open bug 1. Three of the four scaled variants are cheaper than the unscaled one at the same format, against the third pass where all four were more expensive.

## Test files run

| File | Tests | Pass | Fail |
|---|---|---|---|
| a11y.test.js | 52 | 52 | 0 |
| aliases.test.js | 6 | 6 | 0 |
| batch.test.js | 16 | 16 | 0 |
| campaign-server.test.js | 15 | 15 | 0 |
| cdp.test.js | 67 | 67 | 0 |
| errors.test.js | 44 | 44 | 0 |
| find.test.js | 50 | 50 | 0 |
| gif.test.js | 34 | 34 | 0 |
| indicator.test.js | 10 | 10 | 0 |
| ipc.test.js | 18 | 18 | 0 |
| journal.test.js | 28 | 28 | 0 |
| parity.test.js | 12 | 12 | 0 |
| permissions.test.js | 34 | 34 | 0 |
| probe-detect.test.js | 8 | 8 | 0 |
| profile.test.js | 20 | 20 | 0 |
| protocol.test.js | 14 | 14 | 0 |
| recorder.test.js | 12 | 12 | 0 |
| redact.test.js | 22 | 22 | 0 |
| registry.test.js | 20 | 20 | 0 |
| screenshot.test.js | 52 | 52 | 0 |
| sensitive.test.js | 16 | 16 | 0 |
| sessions.test.js | 14 | 14 | 0 |
| tabs.test.js | 26 | 26 | 0 |
| verify.test.js | 50 | 50 | 0 |
| campaign.test.js | 12 | 12 | 0 |
| **Total** | **652** | **652** | **0** |

`node tools/check-errors-copy.js` reports the extension copy matches `host/errors.js`.

## Deferred to the user's Chrome

Recorded, not run. These need a signed-in profile, and this pass never drove `bz04vrv3f`. Several of them were run separately and are written up in [USER-CHROME-0.1.35.md](USER-CHROME-0.1.35.md).

| What | The call |
|---|---|
| LinkedIn `get_page_text` | `tabs_create {"url":"https://www.linkedin.com/feed/"}` then `get_page_text {"tabId":<id>}` on the user's Chrome, and compare the character count against the feed on screen |
| Notion `get_page_text` | the same on a Notion page the account can open |
| `list_connected_browsers` with real profiles | `list_connected_browsers {}` with the user's Chrome and a second signed-in profile connected, checking profile, name and account on both rows |
| Profile selection by site | `select_browser {"site":"linkedin.com"}`, then `{"site":"github.com"}`, and check each lands on the profile whose sessions list carries that site |
| Profile selection by account | `select_browser {"account":"emerson.fr.lopes@gmail.com"}` |
| W6 write rehearsal, confirm mode | with the extension in confirm mode, `computer left_click` on a real Send, read the `confirmation_required` token, send it back once, and check the second use is refused |
| W6 write rehearsal, ask in the browser | the same with ask-in-browser set, answering the prompt in the page |
| W6 write rehearsal, plan mode | `declare_plan` naming the origin, then a write inside it and a write outside it |

## Summary

| Check | Result |
|---|---|
| 1. A scaled screenshot uses the clip path | Pass |
| 2. A cleared console buffer stays cleared | Pass |
| 3. A ref click lands on a line box | Pass |
| 4. Gif frames without the acting indicator | Pass after a fix in this pass (`8c39149`) |
| 5. A missing required argument is refused | Pass |
| 6. Return is treated as a submit | Pass |
| 7. A confirmation shows its screenshot id | Pass |
| 8. An unanswered browser confirmation has its own deadline | Pass |
| 9. The transition warning is on the navigate that causes it | Pass |
| 10. Journal redaction covers a javascript return value | Pass |
| 11. A read behind a frozen renderer | Pass after a fix in this pass (`6eb9a03`) |
| 12. A capture after a submit carries paint evidence | Pass |
| 13. A session across a service worker restart | Fail, open bug 1 |
| 14a. First-pass 6, 7, 17, 24, 25, 28, 29 | Pass |
| 14b. Second-pass 1, 6, 10, 20 | Pass |
| 14c. Third-pass 1, 2, 3, 5, 6, 8 | Pass |
| 15. campaign.test.js, bench, bench:screenshot | Pass |

Twelve of the thirteen fixes hold, two of them after a fix landed during this pass. The session restore does not hold.

Commits made during the pass, on `plan/integration2`:

- `8c39149` The gif watermark was `rgba(255,255,255,0.55)` with nothing behind it. It was legible only while the acting indicator sat under it, and hiding the indicator in the frames left it white on a white page. The glyphs carry a dark stroke now. Extension 0.1.35.
- `3d27dbe` and `6eb9a03` A screenshot on a tab in a 50 s busy loop reported its 20 s timeout after 40 s, because the swallowed `HIDE_FOR_TOOL_USE` before the capture spent one deadline and the capture spent another. `hideForCapture` does the queue wait and lets its timeout out, and only the message to the content script stays best effort. Extension 0.1.36 then 0.1.37.

## New open bugs

### 1. A session loses its tabs when the service worker restarts

Reproduction, with the fixture server on 8765 and the development browser running:

1. Open an MCP client with a pinned `CHROME_MCP_CLIENT_ID` and create two tabs with `tabs_create`. `tabs_context` lists both and names the group.
2. Open `chrome://serviceworker-internals` in a background tab through the extension, find the registration whose scope is `chrome-extension://giagijohigincdlpkfolgcljkhmjdiaa/`, and press its Stop `cr-button` with a trusted click through `Input.dispatchMouseEvent` on that page's CDP target.
3. On the same client, call `read_page` on one of the two tabs.

```
No tab with id 369888112. It may have been closed. Call tabs_context to list current tabs.
[ok=false code=tab_gone effects=unknown retryable=false]

tabs_context after: group null, tabs listed 0, missingTabs false
page targets after:  ["chrome://serviceworker-internals/","http://127.0.0.1:8765/composer.html","http://127.0.0.1:8765/index.html","about:blank"]
```

Both tabs are still open, which the DevTools page list confirms, and they are still in their group. The session reports none of them and `tabGroupId` is null. `missingTabs` is empty, so the restore did not find them and decide they were gone, it found nothing at all.

The persisted table is rewritten empty by the restarted worker with no tool call involved. Seeded, stopped, and with no call made afterwards, the entry for that client read back after a browser restart is:

```
before the stop: {"session":{"at":1788554741436,"groupId":64928660,"tabIds":[369887794,369887795]},
                  "local":  {"at":1788554741436,"groupId":64928660,"tabIds":[369887794,369887795]}}
after:            {"at":1788554759221,"browserId":"bwlhg5ra0","groupId":null,"tabIds":[]}
```

The `at` stamp moved 18 s forward, so the restarted worker wrote it, and it wrote an empty tab list and a null group while both tabs were open. `restoreSessions` persists whatever it computed at the end of its run, so a restore that computes nothing destroys the record it was reading and no later call can recover it.

The same failure appears with the worker stopped through `Target.closeTarget` on the service worker target, so it is not an artefact of the WebUI button.

One variant does not fail: stopping the worker with the MCP client closed, then opening a new client with the same `CHROME_MCP_CLIENT_ID`, restored both tabs and kept the group id. A second attempt at that variant hit `browser_unknown` instead, so it depends on timing and is not a workaround.

### 2. Chrome's idle timeout is not a route to a worker restart

`STATUS.md` says the path left after `chrome.runtime.reload()` stopped being usable is Chrome stopping an idle worker after 30 s. Measured here, it is not: with a session holding two tabs and nothing else running, the worker target stayed in the DevTools list for 180 s. The extension holds a native messaging port for as long as the host is up, and a connected port keeps the worker alive, so a browser with the bridge attached never reaches that timeout. Anything relying on the idle path to exercise the restore, including the note in `STATUS.md`, needs the internals-page Stop instead.

### 3. The before-write capture carries the acting indicator

The image `computer {"action":"screenshot","imageId":"write_3_40xc"}` returns shows the orange border and the red Stop capsule, which the ordinary screenshot path and, since the bugs2 fix, the gif frames both hide. That image is what a caller is told to show the user before approving an irreversible action, so it carries browser chrome the page does not have. Cosmetic, and the capture is otherwise correct.

## Findings about the environment, not the code

A Chrome notification with an Allow button can be activated by whoever is at the machine. While check 8 ran, `chrome.notifications.onButtonClicked` fired with index 0 without anyone answering the prompt deliberately, at 2.6 s, 4.4 s, 8.4 s and 23.6 s in different runs, and once as a burst of fourteen activations between 13.6 s and 18.1 s. A confirmation toast appears at the bottom right of the screen over whatever is there, so an ordinary click can land on Allow and approve an irreversible write. That is a property of asking in an OS notification rather than a defect in this code, and it is worth saying next to the switch in the extension options.

## What was not run

- The rows in the deferred table above, except the ones covered by `USER-CHROME-0.1.35.md`.
- The five other browser-driven test files (`live`, `e2e`, `edge`, `resilience`, `shortcuts`). `campaign.test.js` was run.
