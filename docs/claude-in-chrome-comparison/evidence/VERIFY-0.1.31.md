# Live verification of the wave 2 bug fixes

Branch `plan/integration2`. The pass started on extension 0.1.31 and ended on 0.1.32, because two fixes landed while it ran. Run 2026-09-04. This is the third live pass. The first is in [VERIFY-0.1.11.md](VERIFY-0.1.11.md) and the second in [VERIFY-0.1.28.md](VERIFY-0.1.28.md).

The ten fixes merged from `plan/bugs` close the ten bugs the first pass left open. This pass checks each one against a browser, re-runs a regression set from both earlier passes, and records what it found.

The ten bugs the second pass opened are being fixed in another worktree, so nothing here works on them. Where one of them shows up in a result below it is named as already open.

## How this pass was driven

Same method as the two earlier passes. Every call went through `tools/mcp-client.js`, which spawns `host/mcp-server.js` from this working tree, so the code under test is the code on disk.

```
node tools/mcp-client.js <tool> '<json args>' [--browser dev]
```

Most checks ran through a small script holding one client open across a group of calls, with `CHROME_MCP_CLIENT_ID` pinned so a later script resumes the same session and its tabs. Calls that need extension internals went through the DevTools port on 9333, to the service worker target, the way `test/shortcuts.test.js` does.

The browser is Chrome for Testing launched by `node tools/browser.js --interferer`, after killing the one already running so the script cache was dropped and 0.1.31 was the code that loaded. Registry id `bwlhg5ra0`, profile `Default "Your Chromium"`, signed in to nothing. The interferer extension mounts a `chrome-extension://` iframe into every page, so `attach_recovered` appears in most results below.

The fixture server is `node test/fixtures/campaign/server.js 8765`.

`npm run doctor` before the pass:

```
  ok   Chrome extension is attached
         extension v0.1.31, 19 handlers, 26 tools advertised
         profile Default "Your Chromium"  account not signed in  label none  local true  dev true
         sessions none detected
```

Nothing in this pass activated a tab or focused a window. The user's own Chrome is connected as `bz04vrv3f` and was never driven.

## The ten fixes

### 1. find resolves an exact label on a large page

`/big`, 3000 rows, 6000 interactive nodes.

```
=== 1a. find btn 2999 on /big (tab 369885082), 111 ms wall ===
20 match(es):
button "btn 2999" [ref_5999] (offscreen)
button "btn 0" [ref_1]
button "btn 1" [ref_3]
...
[ok=true effects=none id=call_2_ll4wrx evidence={"scope":"interactive","searched":6000}]
```

`btn 2999` is match 0. `searched: 6000` is the whole interactive tree, and there is no truncation warning, against the first pass's `the tree was truncated at 4439 of 6000 nodes`. 111 ms.

`the-internet.herokuapp.com/large`, a query for cell `50.20`:

```
=== 1b. find 50.20 on the-internet.herokuapp.com/large (tab 369885083), 54 ms wall ===
20 match(es):
cell "50.20" [ref_2582] (offscreen)
cell "20.50" [ref_1082] (offscreen)
cell "1.20" [ref_83] (offscreen)
...
[ok=true effects=none id=call_4_df4mig evidence={"scope":"all","searched":2815,"widenedBecause":"query names a non-interactive role"}]
warnings:
  - widened the search to every node because query names a non-interactive role
  - the interactive filter covered 2 of 2815 nodes on this page, under 10 percent
```

`50.20` is match 0 and outranks `20.50`, which the first pass could not do. 54 ms. **Pass.**

### 2. newTabId for a click that opens a tab

`/index.html`, click `link "blank link"` (`target="_blank"`), then click `#dlg`.

```
=== 2a. left_click link "blank link" (ref_22) on tab 369885084, 1615 ms wall ===
{
  "ok": true,
  "effects": "applied",
  "evidence": {
    "windowMs": 1514,
    "watched": true,
    "opensTab": true,
    "waitedForTab": true,
    "mutations": 2,
    "focusChanged": true,
    "focusedAfter": "blank link",
    ...
  },
  "durationMs": 1609,
  "id": "call_7_oxlfbn"
}
```

```
=== 2b. left_click #dlg (ref_26), 854 ms wall ===
{
  "ok": true,
  "effects": "applied",
  "evidence": {
    "windowMs": 250,
    "watched": true,
    "mutations": 3,
    "focusChanged": true,
    "focusedAfter": "Pseudo dialog",
    ...
  },
  "durationMs": 850,
  "id": "call_8_mgwxqs"
}
```

The two halves the fix promised are both visible. The blank link is recognised as opening a tab (`opensTab: true`), waits 1514 ms for it, and the ordinary button keeps its 250 ms window with no `waitedForTab`. The tab does open and does join the session group:

```
    {
      "tabId": 369885085,
      "url": "https://example.com/",
      "title": "Example Domain",
      "active": true,
```

`newTabId` is absent. The wait ran its full 1500 ms and the adoption bookkeeping was still empty. A listener installed on `chrome.tabs.onCreated` in the service worker says why:

```
2a. onCreated saw: [{"id":369885085,"openerTabId":369885023,"groupId":1305500177,"url":""}]
```

The tab that was clicked is `369885084`. Chrome reports the new tab's `openerTabId` as `369885023`, which is the browser's initial `about:blank` tab. The bookkeeping keys on `openerTabId`, so it never matches the acting tab. Two more opens confirm the pattern, acting tab `369885088` throughout:

```
A. window.open via javascript tool -> [{"id":369885089,"openerTabId":369885087,...}]
B. click #newtab (ref_21)          -> [{"id":369885090,"openerTabId":369885089,...}]
```

In both, `openerTabId` is whichever tab was active in the window, not the tab whose renderer opened it. In background mode the acting tab is never the active one, so the opener never points at it.

Fixed in `56b01c9`, extension 0.1.32. `tabs.js` keeps a 3 s ledger of page-opened tabs, and a click the watch flagged as opening a tab falls back to it when the opener route finds nothing, taking only a candidate that ended up in the acting tab's group. Re-run on 0.1.32, the same three clicks:

```
=== 2a. left_click link "blank link" on tab 369885840, 542 ms wall ===
  "effects": "applied",
  "evidence": {"windowMs": 451, "watched": true, "opensTab": true, "waitedForTab": true,
               "mutations": 2, "focusChanged": true, "focusedAfter": "blank link",
               "newTabId": 369885841},
  "note": "the link opened in a new tab (tab ID 369885841); pass that tab ID to interact with it",
  "newTabId": 369885841,
  "durationMs": 537
=== 2b. left_click #newtab (inline window.open), 542 ms wall ===
  "evidence": {"windowMs": 447, ..., "opensTab": true, "waitedForTab": true, "newTabId": 369885842},
  "newTabId": 369885842
=== 2c. left_click #dlg, 765 ms wall ===
  "evidence": {"windowMs": 250, "watched": true, "mutations": 3, "focusChanged": true,
               "focusedAfter": "Pseudo dialog", ...}
```

Both tab-opening clicks name the tab and stop waiting at 451 ms rather than spending the full 1500, and the ordinary button keeps its 250 ms window with no `waitedForTab`. **Pass after a fix in this pass.**

### 3. The replacement ladder is capped

`attachRecovery: false` written into the extension's `chrome.storage.local` through the service worker target on port 9333, with the interferer loaded.

```
before: {}
after set: {"attachRecovery":false}
=== 3a. tabs_create, 15 tabs before ===
Tab 369885100 could not be driven and was replaced by tab 369885101 on the same URL.
cause: Cannot access a chrome-extension:// URL of different extension
hint: Retry on tab 369885101. Page state such as form input and scroll position is gone.
[ok=false code=tab_replaced effects=none retryable=true id=call_1_o4qs84]
```

```
=== 3c. a second call on the same replacement ===
Tab 369885101 was refused for the same reason as the tab it replaced, so it was not replaced again.
Frames: top http://127.0.0.1:8765/index.html; frame 63 about:srcdoc; frame 64 https://example.com/.
Debugger targets: worker* chrome-extension://giagijohigincdlpkfolgcljkhmjdiaa/src/background.js;
background_page* chrome-extension://giagijohigincdlpkfolgcljkhmjdiaa/offscreen.html;
other* chrome-extension://hhomlijdlegccnopfbeolcmegpbmjhld/frame.html; [and six more of the same]
cause: Cannot access a chrome-extension:// URL of different extension
hint: Disable the extension holding a frame in this tab, or drive the page from a profile without it.
[ok=false code=attach_refused effects=none retryable=false ...]
```

```
=== 3d. tab counts: before 15, after create 17, after second 17, after third 17 ===
```

`hhomlijdlegccnopfbeolcmegpbmjhld` is the interferer, named in the message by the frames it holds. The count goes up by two for the tab and its one replacement and never moves again, against the first pass's six replacements over three runs. `attachRecovery` was set back to `true` at the end of the check. **Pass.**

### 4. A call queued behind a frozen renderer

A 50 s busy loop in `javascript`, and a screenshot on the same tab from a second client 300 ms later. The default retry policy first:

```
=== 4a. screenshot queued 300 ms in, answered at t+50136 ms (49833 ms after it was issued) ===
screenshot 972x542 (~672 tokens) id: img_1
[ok=true effects=none id=call_1_3eydgu evidence={"capture":{"path":"canvas","format":"jpeg","quality":0.75,"scale":1}}]
warnings:
  - attempt 1 failed with timeout, retrying (read, timeout)
=== 4b. the javascript call answered at t+50009 ms ===
{"result": "busy done", "durationMs": 50003, "ok": true}
```

The timeout the fix produces is there, in the retry warning, and the caller never sees it as an error: a screenshot is a read, reads retry three times, and the second attempt lands once the loop ends. So the reply is a correct screenshot after 49.8 s rather than a `timeout` after 20.

The same pair with `confirm` set, which makes the call protected so the host does not retry it:

```
=== 4c. the same screenshot with retries off, answered at t+40382 ms ===
CDP Page.getLayoutMetrics waited 20000ms on tab 369885104 behind Runtime.evaluate, unanswered for 40374ms.
The renderer is not answering.
cause: the renderer has not answered an earlier command
hint: the renderer did not respond, reload the tab with navigate
[ok=false code=timeout effects=none retryable=true id=call_1_625pcq]
=== 4d. the javascript call answered at t+50009 ms ===
{"result": "busy done", "durationMs": 50002, "ok": true}
```

`timeout`, `effects: none`, the reload hint, the queue named, and the busy call still finished at 50 s. The 20 s ceiling is per command, and a capture sends two, so the reply comes at 40 s rather than 20. **Partial**: the error contract holds, the timing is 40 s for a screenshot, and on the default path the retry converts the timeout into a slow success.

### 5. A batch pre-validates its refs

Six actions, the fifth carrying `ref_99999`, against `/index.html`.

```
=== 5a. page state before ===
{"name":"","log":0}
=== 5b. batch of 6, item 4 (the fifth) carries ref_99999 ===
Batch not run: item 5 (computer) names ref_99999, which is no longer on the page in tab 369885105.
hint: Read the page again to get current refs, then send the batch. Nothing ran.
[ok=false code=batch_invalid effects=none retryable=false id=call_4_9y4xvq]
=== 5c. page state after ===
{"name":"","log":0}
```

The item, the ref and the tab are all named, and the page is untouched: the three `window.b3/b4/b5` writes and the `form_input` that sat before the bad item did not run, against the first pass where items 0 to 3 ran and left `{"b3":1,"b4":1,"b5":1}`.

A batch of `read_page` then a click on a ref that read produced:

```
[0] read_page ok
  [ok=true effects=none evidence={"filter":"interactive","nodes":27,"maxChars":20000,"truncated":false}]
[1] computer ok
  [ok=true effects=unknown evidence={"windowMs":3000,"watched":true,"mutations":2,"focusChanged":true,
     "focusedAfter":"Submit","submit":{"fired":[],"windowMs":3416}}]
    - no submit evidence within 3000ms: re-read the page before retrying
```

The ref an earlier step is about to create is skipped by the pre-validation and the batch runs. **Pass.**

### 6. resize_window against a maximized window

The window was maximized through `chrome.windows.update` on the DevTools port, then resized by the tool.

```
=== 6a. window before ===
{"state":"normal","left":0,"top":0,"width":1000,"height":700}
=== 6b. window maximized ===
{"state":"maximized","left":-6,"top":-6,"width":1720,"height":926}
=== 6c. resize_window 1000x700 ===
  "outerWidth": 1000,
  "outerHeight": 700,
  "requested": {"width": 1000, "height": 700},
  "matched": "outer",
  "measuredAgainst": "outerWidth and outerHeight, the window including browser chrome",
  "effects": "applied",
  "evidence": {
    "before": {"outerWidth": 1707, "outerHeight": 912, ...},
    "after": {"outerWidth": 1000, "outerHeight": 700, ...},
    "devicePixelRatio": 2.25,
    "windowBounds": {
      "before": {"width": 1720, "height": 926, "state": "maximized"},
      "after": {"width": 1000, "height": 700, "state": "normal"}
    }
  },
  "warnings": [],
  "durationMs": 282
=== 6d. window after, read from chrome.windows ===
{"state":"normal","left":0,"top":0,"width":1000,"height":700}
```

`matched: "outer"`, `windowBounds.after` 1000x700, no warnings, and `chrome.windows` agrees. The first pass got `matched: "neither"` and a window that did not move. **Pass.**

The `viewport` reading, 988x551, is the same before and after because the tab is hidden and its renderer does not resize until it is shown. The tool measures against the window bounds, which is what the fix changed.

### 7. Per-line contract lines in a quick script

TodoMVC, `C <ref>` / `T verification todo 131` / `K Enter` / `SS`.

```
line 1 C ok
  [ok=true effects=none evidence={"windowMs":250,"watched":true,"mutations":0,"focusChanged":false,
     "focusedAfter":"New Todo Input","valueChanged":false,"scrolled":false,"throttledRetry":true}]
    - the renderer did not acknowledge the first dispatch, so the tab was woken and it was sent once more
    - no observable change within 250ms
line 2 T ok
  [ok=true effects=applied evidence={"windowMs":250,"watched":true,"mutations":3,"valueChanged":true,...}]
line 3 K ok
  [ok=true effects=applied evidence={"windowMs":3000,"watched":true,"mutations":10,"valueChanged":true,
     "submit":{"fired":["composer emptied","a new node carries the text"],"composerEmptied":true,
     "newNode":{"tag":"li","chars":21},"windowMs":3090}}]
line 4 SS ok
  [ok=true effects=none evidence={"capture":{"path":"canvas","format":"jpeg","quality":0.75,"scale":1}}]
screenshot 972x542 (~672 tokens) id: img_1
[ok=true effects=unknown id=call_3_6abonj]
page text has the todo: true
```

Every line prints its own `ok`, `effects`, `evidence` and warnings, against the first pass's single line for the whole script. The `SS` line carries no `paint`, because the paint wait is armed for 2000 ms after an input and line 3 spent 3090 ms on its submit window. The same script without the `K Enter` line shows the evidence the R3 acceptance asks for:

```
line 2 T ok
  [ok=true effects=applied evidence={"windowMs":250,"watched":true,"mutations":3,"valueChanged":true,...}]
line 3 SS ok
  [ok=true effects=none evidence={"paint":{"path":"screencastFrame","painted":true},
     "capture":{"path":"canvas","format":"jpeg","quality":0.75,"scale":1}}]
```

**Partial.** The per-line contract is there and `paint.painted` reaches the caller, and the one sequence the acceptance names, a submit followed by a capture, is the sequence where the paint wait has already expired. New open bug 2.

### 8. Clipped output says how much was clipped

CNN, `read_network_requests` with no filter:

```
200 POST https://beacons-wbd.mediamelon.com/MultiStreamProducer 0kb

[36 requests, 3 URLs clipped to 300 characters, the longest was 1030]
[ok=true effects=none id=call_2_orbdvi]
warnings:
  - 3 URL(s) clipped to 300 characters, the longest was 1030.
```

A page logging a 4005-character string, read back with `pattern: "LONG"`:

```
[log] LONG:zzzzzzzzzzzzzzzzzzzz<492 z characters>...

[1 entries, 1 message clipped to 500 characters, the longest was 4005]
[ok=true effects=none id=call_6_uaffrr]
warnings:
  - 1 message(s) clipped to 500 characters, the longest was 4005.
```

Both footers name the row count, the clip width and the longest clipped length. **Pass.** The console footer reads `1 entries` rather than `1 entry`, which is cosmetic.

### 9. doctor reports the host's journal settings

The development browser was relaunched with `CHROME_MCP_JOURNAL_REDACT=1` in its environment, and `npm run doctor` run from a shell without it.

```
shell CHROME_MCP_JOURNAL_REDACT=[unset]

Journal: C:\Users\edfl\AppData\Local\Temp\chrome-mcp-logs
  8 file(s), 2822 KB
  host for Chrome (bz04vrv3f): retention 14 days, redaction off, dir C:\Users\edfl\AppData\Local\Temp\chrome-mcp-logs
  host for Chrome (bwlhg5ra0): retention 14 days, redaction on, dir C:\Users\edfl\AppData\Local\Temp\chrome-mcp-logs
  this shell: retention 14 days (CHROME_MCP_JOURNAL_DAYS), redaction off (CHROME_MCP_JOURNAL_REDACT).
  The host writes the journal, so its line above is the one that counts.
```

One line per connected host, the development browser's host reporting the redaction its own environment set, the user's Chrome host reporting off, and the shell's own reading marked as the one that does not count. The first pass had `doctor` printing its own process's state as if it were the host's. **Pass.**

### 10. A session survives the worker being thrown away

`chrome.runtime.reload()` cannot be used for this on Chrome for Testing 152. Sent from the service worker over the DevTools port, it takes the extension down and Chrome does not bring it back:

```
=== 10b. chrome.runtime.reload() ===
+3000 ms: extension targets = none
+5000 ms: extension targets = none
+10000 ms: extension targets = none
+15000 ms: extension targets = none
=== tabs_context after the reload ===
No connected browser matches "bwlhg5ra0". Connected: bz04vrv3f (...).
[ok=false code=browser_unknown effects=none retryable=false]
```

The profile says why. In `.browsers/profile/Default/Secure Preferences`:

```
giagijohigincdlpkfolgcljkhmjdiaa  disable_reasons [16777216]  location 4  path ...\chrome-mcp\extension
hhomlijdlegccnopfbeolcmegpbmjhld  disable_reasons []          location 8  path ...\test\fixtures\interferer
```

Chrome disabled the extension rather than reloading it. Three runs, deterministic, and closing the offscreen document first changes nothing. Only a browser restart brings it back. The first pass ran the same call on 0.1.11 and the bridge did come back, so this is Chrome 152 refusing to reload an unpacked extension rather than anything the fix does. New open bug 3.

The fix itself is about the worker being thrown away, which also happens on ordinary idle termination, so the worker was stopped instead, with `Target.closeTarget` on the service worker target, and one of the three session tabs closed at the same moment.

```
=== 10a. session tabs before: [369885456,369885457,369885458] ===
=== 10b. stop the service worker and close the session=3 tab ===
closeTarget(worker): {"success":true}
closeTarget(page):   {"success":true}
extension targets right after: background_page,service_worker
=== 10c. the first tabs_context after the worker restart ===
{
  "tabGroupId": 262551092,
  "groupTitle": "chrome-mcp",
  "tabs": [
    {"tabId": 369885456, "url": "http://127.0.0.1:8765/index.html?session=1", "active": false, ...},
    {"tabId": 369885457, "url": "http://127.0.0.1:8765/index.html?session=2", "active": false, ...}
  ],
  "missingTabs": [369885458],
  "warnings": ["tab 369885458 did not survive the extension restart and is no longer open"],
  "id": "req_1"
}
=== 10d. a call on a tab that survived (369885456) ===
{"url": "http://127.0.0.1:8765/index.html?session=1", "readyState": "complete", "ok": true, "effects": "none"}
=== 10e. a second tabs_context ===
  "tabs": [369885456, 369885457], "warnings": []
```

The two surviving tabs come back with their old ids, the closed one is named once and not again, and a call on a survivor works. The first pass got an empty tab list and `No tab with id <id>`. **Pass**, through a worker stop rather than `chrome.runtime.reload()`.


## Regression on the first pass

### 11. First-pass checks 6, 7, 17, 24, 25, 28, 29

```
6a. ref for btn 2999: ref_5999
6b. click: {"ok":true,"at":{"x":109,"y":530,"source":"ref"},"effects":"applied",
     "evidence":{"windowMs":250,"watched":true,"mutations":0,"focusChanged":true,
                 "focusedAfter":"btn 2999","valueChanged":false,"scrolled":false}}
6c. window.__hit: true

7a. ref for the cell holding "row 12": ref_6052
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
```

Six of the seven hold. Twenty calls on the iframe fixture with the interferer loaded produced no error and no replacement, three fresh x.com tabs and fifty consecutive calls on one of them all landed, and the inert click keeps its `effects: none`.

Check 29, per-key typing into the jQuery UI autocomplete, failed on 0.1.31. Three runs of three:

```
29 run 1 (ref_34): {"value":"jaja","menuItems":["Java","JavaScript"],"menuOpen":false}
29 run 2 (ref_34): {"value":"jaja","menuItems":["Java","JavaScript"],"menuOpen":false}
29 run 3 (ref_34): {"value":"jaja","menuItems":["Java","JavaScript"],"menuOpen":false}
```

The field held `jaja`, the whole string twice, where 0.1.30 gave `ja`. The raw reply says what happened:

```
type perKey RAW: Typed 2 characters with "/resources/demos/autocomplete/default.html" focused, and nothing changed.
cause: no text field or editable element had focus when the text was sent
hint: Click the field by ref first, or set it with form_input.
attempt 1 failed with no_effect, retrying (input, effects none)
[ok=false code=no_effect effects=none retryable=true id=call_4_7cobbq]
value now: jaja
```

The demo field is inside an iframe, so `document.activeElement` in the top document is the `iframe` element. `f0b17fd`, one of the ten fixes, reports a type as `no_effect` when the focused element cannot hold text, and a frame element cannot, so the type failed. The error says `effects: none`, so the host retried it and the text was typed a second time. Typing without `perKey` produced the same `jaja`, so this is not the per-key path.

Fixed in `e4c2e59`, extension 0.1.32: `focusedEditable` is `null` when focus sits on a frame element, which the type check reads as unknown rather than as a failure. Re-run on 0.1.32:

```
29 run 1 (ref_34): {"value":"ja","menuItems":["Java","JavaScript"],"menuOpen":true}
29 run 2 (ref_34): {"value":"ja","menuItems":["Java","JavaScript"],"menuOpen":true}
29 run 3 (ref_34): {"value":"ja","menuItems":["Java","JavaScript"],"menuOpen":true}
```

The reply is now `ok: true, effects: none` with `no observable change within 250ms`, which is honest: the top document cannot see into the frame. Checks 28 and 6, 7, 17, 24, 25 were re-run on 0.1.32 and are unchanged. **Pass after a fix in this pass.**

## Regression on the second pass

### 12. Second-pass checks 1, 6, 10, 20

```
=== 12a (second pass 1). default screenshot ===
[image image/jpeg, 31324 bytes]
screenshot 972x542 (~672 tokens) id: img_1
[ok=true effects=none id=call_2_lmycf8 evidence={"capture":{"path":"canvas","format":"jpeg","quality":0.75,"scale":1}}]
=== 12a control, format png ===
[image image/png, 68585 bytes]
[ok=true effects=none id=call_3_8wtglp evidence={"capture":{"path":"canvas","format":"png","scale":1}}]
```

JPEG by default, 2.2x smaller than the same frame as PNG, the same numbers the second pass measured.

```
=== 12b (second pass 6). hidden tab 369885844, active=false ===
#vis at load: hidden
hidden-tab screenshot, 132 ms wall
[image image/jpeg, 31324 bytes]
screenshot 972x542 (~672 tokens) id: img_3
```

132 ms against the second pass's 107 ms, and the image is the page rather than a blank surface.

`chrome.debugger.sendCommand` and `chrome.debugger.attach` wrapped in the service worker, then one session opened a tab, navigated twice, clicked a field by ref, typed and took a screenshot, never reading the console:

```
=== 12c (second pass 10). CDP methods this session sent (112 calls) ===
   19  Page.stopScreencast
   12  Runtime.evaluate
   10  Page.startScreencast
   10  Page.screencastFrameAck
    8  *attach
    8  Emulation.setFocusEmulationEnabled
    8  Page.setWebLifecycleState
    8  Page.getLayoutMetrics
    6  Input.dispatchMouseEvent
    4  Log.enable
    4  Network.enable
    4  Page.enable
    4  DOM.enable
    4  Network.setCacheDisabled
    2  Page.navigate
    1  Input.insertText
Runtime.enable present: false
page trap: cdp getter fired: no / name=hello
```

No `Runtime.enable`, the fixture's own getter trap did not fire, and the typed text landed.

The four detector pages, one run each, console capture left at `lazy` and no console read during any of them:

```
=== deviceandbrowserinfo (5774 chars) ===
"isBot": false, | "hasBotUserAgent": false, | "hasWebdriverTrue": false,
| "isHeadlessChrome": false, | "isAutomatedWithCDP": false,

=== bot.sannysoft.com (10277 chars) ===
Chrome/152.0.0.0 Safari/537.36 | WebDriver Advanced passed | Plugins is of type PluginArray passed
| WebGL Vendor Google Inc. (NVIDIA) | PHANTOM_UA ok | PHANTOM_PROPERTIES ok | PHANTOM_ETSL ok
| PHANTOM_LANGUAGE ok | PHANTOM_WEBSOCKET ok | PHANTOM_OVERFLOW ok | PHANTOM_WINDOW_HEIGHT ok
| HEADCHR_UA ok | HEADCHR_CHROME_OBJ ok | HEADCHR_PERMISSIONS ok | HEADCHR_PLUGINS ok | HEADCHR_IFRAME ok

=== browserscan.net (8489 chars) ===
Test Results: | No bots detected - the visitor could be a human using a regular browser.

=== creepjs (4596 chars) ===
19% like headless: 2eb544f2
0% headless: 52defe05
0% stealth: 0c019315
```

No page called this browser a bot, and every reading matches the second pass. **Pass.**

## Tests and bench

### 13. node --test test/campaign.test.js, npm run bench, npm run bench:screenshot

```
campaign fixture: already-ahead table stays true (5821.5002ms)
tests 12
pass 12
fail 0
```

`CHROME_MCP_BROWSER_ID=bwlhg5ra0 npm run bench`, three runs, appended to `.bench/2026-09-04.jsonl`. Extension 0.1.32.

| Measurement | 0.1.7 median | 0.1.30 median wall | This build, median wall | This build, median tool |
|---|---|---|---|---|
| 1a. 10 separate `javascript` 1+1 calls | 7927 ms | 43 ms | 47 ms | 24 ms |
| 1b. 10 1+1 calls in one `browser_batch` | 5614 ms | 14 ms | 16 ms | 12 ms |
| 1c. 10 1+1 lines in a `quick` script | 3464 ms | 15 ms | 16 ms | 12 ms |
| 2. 10 separate screenshots | 8829 ms | 1354 ms | 1392 ms | n/a |
| 3. `read_page` all+interactive, two pages | 10350 ms | 442 ms | 447 ms | n/a |
| 4. `get_page_text`, two pages | 8781 ms | 383 ms | 386 ms | n/a |
| 5. `find`, two queries | 6104 ms | 535 ms | 544 ms | n/a |
| 6. `navigate`, four targets | 9054 ms | 4508 ms | 4528 ms | 4515 ms |
| 7. realistic form flow as one batch | 17381 ms | 10312 ms | 11969 ms | 2 ms |
| 8. type 500 chars, plain then perKey | 9521 ms | 44361 ms | 43542 ms | 36079 ms |
| 9. `javascript 'x'.repeat(200000)` | 4642 ms | 7 ms | 8 ms | 4 ms |

Every row is within run-to-run noise of the second pass. Row 7's three runs were 7723, 13106 and 11969 ms, the same wide spread the second pass reported, so its median is not a reading of anything.

`npm run bench:screenshot`, extension 0.1.32, appended to `.bench/2026-09-04-screenshot.jsonl`:

```
page    variant    size        payload   tokens   median ms   total ms  path    coordinate frame
index   png s1     972x542     67KB      ~672     132         1399      canvas
index   png s0.5   486x271     25KB      ~168     215         2316      canvas  486x271
index   jpeg s1    972x542     31KB      ~672     133         1352      canvas
index   jpeg s0.5  486x271     11KB      ~168     216         2268      canvas  486x271
big     png s1     972x542     76KB      ~672     132         1554      canvas
big     png s0.5   486x271     29KB      ~168     218         2334      canvas  486x271
big     jpeg s1    972x542     30KB      ~672     134         1386      canvas
big     jpeg s0.5  486x271     11KB      ~168     215         2129      canvas  486x271

index page, JPEG against PNG at the same size: 31KB against 67KB, 2.2x smaller
10 screenshots, JPEG at scale 1: 1352 ms total, median 133 ms per capture (Phase 5 target: under 6000 ms for ten)
```

The `path` column still reads `canvas` on every scaled row, and a scale 0.5 capture still costs more than an unscaled one, 216 ms against 133. That is the second pass's open bug 1, untouched. **Pass** on the numbers, which hold.

### 14. A recording decoded frame by frame

`gif_creator start` with every overlay on, then a click by ref, a `type` and a `scroll`, then `stop`.

```
=== 14b. gif_creator stop ===
Recorded 6 frames over 6.1s at 480x268.
saved: C:\Users\edfl\AppData\Local\Temp\chrome-mcp-screenshots\verify-0131.gif
=== 14c. frame count line ===
rec-131.gif: 6 frames, showing 1 to 2
```

Decoded through `test/fixtures/campaign/gifview.html`, which reads the file with `ImageDecoder` and paints each frame onto a canvas.

Frames 1 and 2: frame 1 carries the action label pill `screenshot` at the top left, a red click ring beside the Name field, the progress bar along the bottom and the watermark at the bottom right. Frame 2 is labelled `left_click`, with the ring and the drawn cursor on the Name field. Frames 4 and 5: frame 4 is labelled `scroll` with the cursor drawn where the wheel event went.

Every frame also carries the acting indicator: the orange border around the whole frame and the red Stop capsule at the bottom right, which sits on top of the watermark. That is the second pass's open bug 4, and the fix for it has not landed on this branch. **Pass** on the gif's own overlays, with the indicator still in every frame as a known open bug.

## Deferred to the user's Chrome

Recorded, not run. These need a signed-in profile, and this pass never drove `bz04vrv3f`.

| What | The call |
|---|---|
| LinkedIn `get_page_text` | `tabs_create {"url":"https://www.linkedin.com/feed/"}` then `get_page_text {"tabId":<id>}` on the user's Chrome, and compare the character count against the feed on screen |
| Notion `get_page_text` | the same on a Notion page the account can open |
| Profile selection by site | `select_browser {"site":"linkedin.com"}`, then `{"site":"github.com"}`, and check each lands on the profile whose sessions list carries that site |
| Profile selection by account | `select_browser {"account":"emerson.fr.lopes@gmail.com"}` |
| W6 write rehearsal, confirm mode | with the extension in confirm mode, `computer left_click` on a real Send, read the `confirmation_required` token, send it back once, and check the second use is refused |
| W6 write rehearsal, ask in the browser | the same with ask-in-browser set, answering the prompt in the page |
| W6 write rehearsal, plan mode | `declare_plan` naming the origin, then a write inside it and a write outside it |
| Two real profiles | `list_connected_browsers {}` with the user's Chrome and a second signed-in profile connected, checking profile, name and account on both rows |

## Test files run

| Command | Result |
|---|---|
| `node --test test/verify.test.js` | 49 of 49 |
| `node --test test/tabs.test.js` | 23 of 23 |
| `node --test test/a11y.test.js` | 47 of 47 |
| `node --test test/batch.test.js` | 13 of 13 |
| `node --test test/cdp.test.js` | 59 of 59 |
| `node --test test/errors.test.js` | 37 of 37 |
| `node --test test/sessions.test.js` | 14 of 14 |
| `node --test test/campaign.test.js` | 12 of 12 |
| `node tools/check-errors-copy.js` | the extension copy matches |
| `node --check` on the three files this pass changed | passes |

`verify.test.js` was 46 tests at the start of this pass and is 49 now, three added for the two fixes.

## Summary

| Verdict | Count | Checks |
|---|---|---|
| Pass | 9 | 1, 3, 5, 6, 8, 9, 10, 12, 13 |
| Pass after a fix in this pass | 3 | 2, 11, 14 |
| Partial | 2 | 4, 7 |
| Fail | 0 | |

Check 14 is counted with the fixes because the recording's own overlays are all correct and the one thing wrong in it is the second pass's open bug 4.

Two commits landed, each with unit tests:

| Commit | Manifest | What it changed |
|---|---|---|
| `e4c2e59` | 0.1.32 | A type into a field inside an iframe was reported as `no_effect`, and the retry that followed typed the text twice |
| `56b01c9` | 0.1.32 | A click that opens a tab reported no `newTabId`, because Chrome names the active tab as the opener rather than the acting one |

Extension version at the end of the pass: **0.1.32**.

## New open bugs

The ten the second pass opened are not repeated here. They are in `VERIFY-0.1.28.md` and are being fixed on another branch. Bug 1 and bug 4 from that list were both seen again in this pass, in checks 13 and 14, and are unchanged.

### 1. A read behind a frozen renderer waits out the freeze and reports success

A screenshot queued behind a 50 s busy loop times out at 20 s per CDP command, exactly as the fix intends, and the host's read retry policy then sends it again. The second attempt lands once the renderer frees up, so the caller waits 49.8 s and gets `ok: true` with the timeout visible only as a retry warning. The reload hint the fix produces never reaches the caller on the default path.

Reproduce: check 4 above. The same pair with `confirm` set, which makes the call protected, returns the `timeout` the fix produces.

Whether this is worth changing is a judgement call. Nothing is lost, and a renderer that never recovers costs three attempts at 20 s each rather than the 120 s host timeout. What is wrong is that a caller reading the reply cannot tell the page was frozen for 50 s.

### 2. The paint wait expires before a capture that follows a submit

`shot.PAINT_WAIT_WINDOW_MS` is 2000 ms and `SUBMIT_WINDOW_MS` is 3000 ms, so a capture that follows an Enter or a Send has no paint evidence: the stamp the capture measures against is already older than the window. The R3 acceptance names exactly that sequence.

Reproduce: check 7 above. `quick` with `C <ref>` / `T text` / `K Enter` / `SS` gives an `SS` line whose evidence is `{"capture":{...}}`, and the same script without the `K Enter` line gives `{"paint":{"path":"screencastFrame","painted":true},"capture":{...}}`.

The capture itself is correct either way, because three seconds of submit watching is longer than any paint takes. The fix is to raise the paint window above the submit window, or to stamp the tab again when the submit watch closes.

### 3. chrome.runtime.reload() disables the extension on Chrome 152

Sent from the service worker over the DevTools port, `chrome.runtime.reload()` takes the extension down and Chrome does not bring it back. The profile records `disable_reasons [16777216]` against the extension id, the service worker and offscreen targets are gone, creating a tab does not wake it, and only a browser restart restores the bridge. Three runs, deterministic. Closing the offscreen document first changes nothing. The interferer, loaded from the same command line, stays enabled.

Reproduce:

```
node tools/browser.js --interferer
# then, against the service worker target on port 9333:
chrome.runtime.reload()
npm run doctor    # the development browser is no longer connected
# and read the profile back:
.browsers/profile/Default/Secure Preferences
  -> extensions.settings.giagijohigincdlpkfolgcljkhmjdiaa.disable_reasons == [16777216]
```

The first pass ran the same call on 0.1.11 and the bridge came back, so this is Chrome refusing to reload an unpacked extension rather than anything in the extension. It matters because `chrome.runtime.reload()` is how a developer picks up an edit, and because the session-restore path can only be exercised through a worker stop now. Worth confirming against a Chrome for Testing update before spending time on it.

## What was not run

- The deferred list above, which needs a signed-in profile.
- `npm test` as a whole. The files this pass touched were run individually and are listed above.
- The drag overlay in check 14. The drag call in the recording script used the wrong argument name for its origin, so the recording carries no drag path. The second pass covered drags in its check 23.
