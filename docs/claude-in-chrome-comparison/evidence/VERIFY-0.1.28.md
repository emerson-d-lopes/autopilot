# Live verification of wave 2

Branch `plan/integration2`. The pass started on extension 0.1.28 and ended on 0.1.30, because two fixes landed while it ran. Run 2026-09-04. This is the second live pass. The first one is in [VERIFY-0.1.11.md](VERIFY-0.1.11.md), and its ten open bugs are being fixed in another worktree, so nothing here works on them.

## How this pass was driven

Same method as the first pass. Every call went through `tools/mcp-client.js`, which spawns `host/mcp-server.js` from this working tree, so the code under test is the code on disk rather than whatever server process this session started.

```
node tools/mcp-client.js <tool> '<json args>' [--browser dev]
```

Most checks ran through a small script that holds one client open across a group of calls, with `CHROME_MCP_CLIENT_ID` pinned so a later script resumes the same session and its tabs.

The browser is Chrome for Testing launched by `node tools/browser.js --interferer` in a shell left open, after killing the one that was already running so the script cache was dropped and 0.1.28 was the code that loaded. Registry id `bwlhg5ra0`, profile `Default "Your Chromium"`, signed in to nothing. The interferer extension mounts a `chrome-extension://` iframe into every page, so `attach_recovered` appears in most results below and the recovery ladder is exercised throughout.

The fixture server is `node test/fixtures/campaign/server.js 8765`.

`npm run doctor` before the pass:

```
  ok   Chrome extension is attached
         extension v0.1.28, 19 handlers, 26 tools advertised
         profile Default "Your Chromium"  account not signed in  label none  local true  dev true
         sessions none detected
```

Nothing in this pass activated a tab or focused a window. The user's own Chrome is connected as `bz04vrv3f` and was never driven.

## Screenshots

### 1. JPEG by default

`computer screenshot` on `/index.html`.

```
screenshot 972x542 (~672 tokens) id: img_1
url: http://127.0.0.1:8765/index.html
scroll: 0

[ok=true effects=none id=call_2_7mstya evidence={"capture":{"path":"canvas","format":"jpeg","quality":0.75,"scale":1}}]
[image image/jpeg, 31341 bytes]
```

972x542 is the same frame the first pass reported (VERIFY-0.1.11 check 28, `screenshot 972x542 (~672 tokens)`). The payload is 31341 bytes of JPEG against 68583 bytes for the same frame as PNG, a 2.2x reduction. The first pass's own PNG capture measured 68253 bytes for a comparable frame. **Pass.**

### 2. format png

Same call with `format: "png"`.

```
screenshot 972x542 (~672 tokens) id: img_2
[ok=true effects=none id=call_3_y1yx87 evidence={"capture":{"path":"canvas","format":"png","scale":1}}]
[image image/png, 68583 bytes]
```

**Pass.**

### 3. cnn.com at scale 0.85

```
screenshot 826x461 (~486 tokens) id: img_1
0.85-scale view; coordinate frame: 826x461. Coordinates are pixels in this image and are mapped back to the page for you. Full-resolution frame: 972x542.
url: https://edition.cnn.com/
[ok=true effects=none id=call_3_rixndj evidence={"capture":{"path":"canvas","format":"jpeg","quality":0.75,"scale":0.85}}]
[image image/jpeg, 45261 bytes]
```

486 tokens against a target of under 1100. The unscaled control on the same page is 672 tokens and 58293 bytes. **Pass.**

### 4. npm run bench:screenshot

```
page    variant    size        payload   tokens   median ms   total ms  path    coordinate frame
index   png s1     972x542     67KB      ~672     134         1461      canvas
index   png s0.5   486x271     25KB      ~168     216         2240      canvas  486x271
index   jpeg s1    972x542     31KB      ~672     134         1415      canvas
index   jpeg s0.5  486x271     11KB      ~168     219         2249      canvas  486x271
big     png s1     972x542     76KB      ~672     207         1930      canvas
big     png s0.5   486x271     29KB      ~168     211         2189      canvas  486x271
big     jpeg s1    972x542     30KB      ~672     203         1936      canvas
big     jpeg s0.5  486x271     11KB      ~168     278         2618      canvas  486x271

index page, JPEG against PNG at the same size: 31KB against 67KB, 2.2x smaller
10 screenshots, JPEG at scale 1: 1415 ms total, median 134 ms per capture (Phase 5 target: under 6000 ms for ten)
```

Ten captures in 1415 ms against a 6000 ms target. The byte ratio is 2.2x on `/index` and 2.5x on `/big`, which is smaller than "several times". **Partial**, on the byte ratio only.

The `path` column reads `canvas` in every row, including the scaled ones, so the clip fast path never engaged. That is bug 1 below.

### 5. A click read off a 0.5-scale image

The fixture logs every event into `#log`, which sits above the form, so each logged event reflows the page under the pointer. The first attempt showed exactly that: a click read off the image reported `pointerdown submit` and then `click f`, because the page moved down by one log line between press and release. Pinning the log to zero height removes the fixture's own interference.

```
screenshot 486x271 (~168 tokens) id: img_1
0.5-scale view; coordinate frame: 486x271. ... Full-resolution frame: 972x542.
```

Reading the Submit button off that image at (247, 203) and clicking it:

```
"at": {"x": 494, "y": 406, "source": "screenshot"},
"effects": "applied",
"evidence": {"windowMs": 250, "watched": true, "mutations": 3, "focusedAfter": "Submit", ...}
```

```
pointerdown submit trusted=true ptr=mouse | click submit trusted=true ptr=mouse
out={"name":"","email":"","country":"","notes":"","ro":"y","kd":"","ctl":""}
```

The event log shows both the press and the click on `#submit`, and the form submitted. **Pass.**

### 6. A screenshot of a hidden tab

The tab was created unselected and never activated. `tabs_context` reports `"active": false`, and the fixture's own `#vis` span, which records `document.visibilityState` at load, reads `hidden`.

```
=== 6b. hidden-tab screenshot, 107 ms wall ===
screenshot 972x542 (~672 tokens) id: img_1
[ok=true effects=none id=call_2_r15xr9 evidence={"capture":{"path":"canvas","format":"jpeg","quality":0.75,"scale":1}}]
[image image/jpeg, 31341 bytes]
```

107 ms, and the image is the page rather than a blank surface. The bench measures the same thing ten times over at a 134 ms median. **Pass.**

### 7. zoom on a region after scrolling

Scrolled to `scrollY` 1000, then `computer zoom` on `[0, 100, 500, 400]`.

```
screenshot 500x300 (~192 tokens) id: img_4
saved: ...\shot-2026-09-04T14-30-40-978Z.jpg
[ok=true effects=none id=call_7_qfce47 evidence={"paint":{"path":"screencastFrame","painted":true},"capture":{"path":"canvas","format":"jpeg","quality":0.75,"scale":1}}]
```

At that scroll the sections on screen are Drag and drop at viewport y 38, Upload at 232 and Dynamic at 424. The returned crop shows the drag boxes A and B with the range slider, then the Upload heading and its file input, which is exactly viewport y 100 to 400. **Pass.**

### 8. A batch whose click was written against the pre-batch frame

A screenshot at scale 1 first, so the coordinate (494, 406) is in the 972x542 frame. Then a batch whose own screenshot is at scale 0.5, which would remap that coordinate against a 486x271 image if the new frame were committed mid-batch.

```
node tools/mcp-client.js browser_batch '{"actions":[
  {"name":"computer","input":{"action":"screenshot","tabId":<id>,"scale":0.5}},
  {"name":"computer","input":{"action":"left_click","tabId":<id>,"coordinate":[494,406]}}]}'
```

```
[0] computer ok
screenshot 486x271 (~168 tokens) id: img_2
0.5-scale view; coordinate frame: 486x271. ...
[1] computer ok
[ok=true effects=unknown id=call_3_llgnku]
```

```
pointerdown submit trusted=true ptr=mouse | click submit trusted=true ptr=mouse
out={"name":"","email":"",...}
```

The click landed on `#submit`. **Pass.**

### 9. quality 0.10 and the budget floor

On the fixture, `quality: 0.10` returns 11517 bytes against 31341 at the default, and raises no warning:

```
[ok=true effects=none id=call_3_qcjvr0 evidence={"capture":{"path":"canvas","format":"jpeg","quality":0.1,"scale":1}}]
[image image/jpeg, 11517 bytes]
```

That is correct. The floor warning fires only when a payload is still over `MAX_BASE64_CHARS` (1398100) at the 0.1 floor, and a viewport-sized JPEG never reaches it, because `maxTokens` already caps the pixel area. To reach the budget at all, a full-viewport random-noise canvas was painted into the page. There the PNG branch warns and the JPEG branch does not:

```
=== 9d. noise, png ===
[image image/png, 1355346 bytes]
warnings:
  - the image is 1807128 base64 characters, over the 1398100 budget, and a png payload cannot be reduced by quality. Ask for format "jpeg" or a smaller scale.

=== 9e. noise, quality 0.10 ===
[image image/jpeg, 26361 bytes]     (no warning)

=== 9f. noise, default quality ===
[image image/jpeg, 172446 bytes]    (no warning)
```

The over-budget warning appears where a payload is over budget and nowhere else. The quality-floor warning itself is not reachable through `computer screenshot` on any page tried, since `quality: 0.1` on the worst payload this display can produce is 26 KB against a 1 MB budget. It is covered by `test/screenshot.test.js`, "the loop stops at the quality floor and warns". **Partial**, with the floor branch proven by unit test rather than live.

## Detectability

### 10. A CDP trace with no Runtime.enable

`chrome.debugger.sendCommand` and `chrome.debugger.attach` were wrapped in the extension's service worker through the development browser's DevTools port 9333, recording every method name. Then one session opened a tab, navigated twice, clicked a field by ref, typed, and took a screenshot, never reading the console.

```
10h. CDP methods this session sent (56 calls):
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
```

The fixture's own trap, a getter on an object passed to `console.log` that fires when a debugger inspects it, agrees:

```
"result": "no / name=hello"
```

`cdp getter fired: no`, and the typed text landed. **Pass.**

### 11. javascript and wait with Runtime off

Both work with only `Runtime.evaluate` in the trace and no `Runtime.enable`.

```
=== 11a. javascript 1+1 ===
{"result": 2, "type": "number", "durationMs": 2, "ok": true}
=== 11b. computer wait ===
{"ok": true, "waited": 1, "effects": "none", "evidence": {"waitedMs": 1000}}
   trace[after 11]: Runtime.evaluate, Runtime.evaluate
```

**Pass.**

### 12. The first console read

```
[info] --- navigated to http://127.0.0.1:8765/index.html ---
[log] cdp-trap Object (index.html:61)
[log] page loaded (index.html:62)
[warn] a warning (index.html:62)
[error] an error at load (index.html:62)
[error] Error: uncaught boom
    at http://127.0.0.1:8765/index.html:63:23 (index.html:63)

[ok=true effects=none id=call_4_jigs7m]
warnings:
  - console capture started with this call, so console output and uncaught exceptions from before it were not recorded. Set console capture to always in the extension options to capture from the moment a tab joins the session, at the cost of leaving Runtime enabled, which is what a CDP detector reads.
   trace[after first read]: Runtime.enable
```

The warning is there and `Runtime.enable` went out on that call and no earlier. **Pass** on what the check asks. The warning's claim about lost output is wrong, which is bug 2 below.

### 13. clear:true turns it off again

```
[ok=true effects=none id=call_7_ypqvwo]
warnings:
  - console capture was turned off again because this read cleared the buffer. The next read turns it back on and starts from that moment.
   trace[after clearing read]: Runtime.disable
```

**Pass.** The next read re-enables it, which the trace confirms, and returns the same messages again, which is bug 2.

### 14. The always setting

`chrome.storage.local.set({consoleCapture: "always"})` through the service worker target, then a fresh tab.

```
   trace[after the tab joined with always]: Runtime.* = Runtime.enable
=== 14a. first read with always ===
[info] --- navigated to http://127.0.0.1:8765/index.html ---
[log] cdp-trap Object (index.html:61)
[log] page loaded (index.html:62)
[warn] a warning (index.html:62)
[error] an error at load (index.html:62)

[ok=true effects=none id=call_6_eblp04]
   trace[after the first read]: Runtime.* = none
```

Runtime goes on when the tab joins, the first read carries no warning and sends no CDP command, and a `clear: true` read does not turn it off (`trace[after a clearing read under always]: Runtime.* = none`), which is what the setting asks for. Restored to `lazy` afterwards. **Pass.**

### 15. A batch that reads the console after writing to it

```
node tools/mcp-client.js browser_batch '{"actions":[
  {"name":"javascript","input":{"tabId":<id>,"code":"console.log(\"early\"); \"logged\""}},
  {"name":"read_console_messages","input":{"tabId":<id>,"pattern":"early"}}]}'
```

```
   trace[after the tab joined under lazy]: Runtime.* = none
[0] javascript ok
{"result": "logged", "type": "string", "durationMs": 1}
[1] read_console_messages ok
[log] early
[ok=true effects=unknown id=call_10_njq6xt]
   trace[after the batch]: Runtime.* = Runtime.enable, Runtime.evaluate
```

`Runtime.enable` came before `Runtime.evaluate`, so the pre-arm ran before the step that logged. `early` was captured. **Pass.**

### 16. node tools/probe-detect.js

The probe printed "no keydown events were recorded" and "no mousemove events were recorded" on this build, because it read the `javascript` result envelope as the recording. Fixed in `7091092`, which also wires it to `tools/mcp-client.js` rather than its own fallback client. After the fix:

```
probe-detect
client: tools/mcp-client.js

D3  typing cadence
    text: "the quick brown fox jumps over" (30 characters)
    requested mean: 60 (default) ms
    intervals: 52, 63.4, 79, 79.4, 61.8, 62.8, 62, 62.3, 79, 93.1, 62.4, 64.1, 93.5, 63.9, 60.7, 79, 78.3, 77.8, 63.7, 94.1, 77.5, 77, 78.6, 79.7, 62.3, 93.8, 78.7, 77.2, 62.4
    n=29  min=52  max=94.1  mean=73.1  sd=11.4  cv=15.7%
    the campaign measured 0.1.7 at a 62 to 64 ms band, a cv of about 1 percent

D4  mouse path into a click
    target: ref_12
    points: 5
      (219, 276)  +0 ms  280 px from the last point
      (331, 278)  +17 ms  168 px from the last point
      (387, 278)  +55 ms  112 px from the last point
      (443, 277)  +73 ms  56 px from the last point
      (499, 276)  +479 ms  0 px from the last point
    the campaign measured 0.1.7 at 2 samples, a straight jump with no path

every keydown isTrusted: true
```

Cadence has a 15.7 percent coefficient of variation against the 1 percent band 0.1.7 produced, and the path is drawn. The point count a page observes varies between runs: three runs printed 2, 5 and 5 points, because Chrome coalesces mousemove events that arrive inside one frame and the intermediate points are dispatched without waiting for an acknowledgement. A direct measurement of one click, recording every `mousemove` the page received, showed the full path:

```
16b. moves during a coordinate click from (100,100) to (700,450):
{"moves":[[307,204,5082],[507,321,5162],[700,450,5571]],"scroll":0}

16. moves during one ref click:
{"moves":[[275,290,782],[331,293,817],[387,291,834],[443,285,851],[499,276,1263]],...}
```

**Pass, after a fix in this pass** (`7091092`).

### 17. Per-key typing into the jQuery UI autocomplete

Three runs, `computer type` with `perKey: true` and `replace: true` typing "ja" into the Tags field.

```
17 run 1: {"value":"ja","menuItems":["Java","JavaScript"],"menuOpen":true}
17 run 2: {"value":"ja","menuItems":["Java","JavaScript"],"menuOpen":true}
17 run 3: {"value":"ja","menuItems":["Java","JavaScript"],"menuOpen":true}
```

R5 did not regress after the cadence rewrite. **Pass.**

### 18. 500 characters with perKey

```
18. 500 chars perKey: wall 36017 ms
{"ok": true, "typed": 500, "field": "Notes", "sensitive": false, "effects": "applied"}
   notes length: 500
```

36.0 s against a 46 s target, and the field holds all 500 characters. **Pass.**

### 19. The hover menu

The Menu button is below the fold, so `computer hover` on its ref scrolls it in (scrollY 0 to 731) and the CSS `:hover` rule reveals the list. A second `read_page` then finds `link "Hidden link"`, so the reveal works.

The click on that link does not fire its handler:

```
before the click: {"scrollY":731,"rect":[39,294,51,37],"display":"block","hoverout":"","atCentre":"A"}
click: "at": { "x": 64, "y": 276, "source": "ref" }
after the click:  {"scrollY":811,"rect":[39,257,51,37],"display":"block","hoverout":"","atCentre":"LI"}
```

What the page saw:

```
page saw: [["mv",57,276],["mv",59,276],["mv",60,276],["mv",64,276],["down","LI",64,276]]
hoverout: ""
```

A click by coordinate at the same visual place does fire it:

```
19i. coordinate click at (64,312): "at": { "x": 64, "y": 312, "source": "raw" }
   hoverout: "hover link clicked"
```

The link is an inline `<a>` in a 51 px wide menu, so its text wraps onto two lines and the centre of its bounding box falls in the second line, past the end of the short word that line holds. The click therefore lands on the wrapping `<li>`. The original campaign recorded the same shape for the other product (`A-local-site.md`: "first attempt landed on the `<li>` wrapper ... a 7px-adjusted coordinate then hit the `<a>` directly"), and recorded chrome-mcp hitting it by coordinate, which is what still works. **Partial**, and bug 3 below.

### 20. The four detector pages

Three runs each, console capture on `lazy`, and no `read_console_messages` during any run, so `Runtime.enable` never went out. Each page was opened in a background tab, given time to finish its probes, read through `document.body.innerText`, then closed.

`deviceandbrowserinfo.com/are_you_a_bot`, identical on all three runs:

```
Are you a bot? | "isBot": false, | "hasBotUserAgent": false, | "hasWebdriverTrue": false,
| "hasWebdriverInFrameTrue": false, | "isPlaywright": false, | "hasInconsistentChromeObject": false,
| "isPhantom": false, | "isNightmare": false, | "isSequentum": false, | "isSeleniumChromeDefault": false,
| "isHeadlessChrome": false, | "isWebGLInconsistent": false, | "hasInconsistentWebGLShaderLang": false,
| "hasInconsistentTimingResolution": false, | "isAutomatedWithCDP": false,
| "isAutomatedWithCDPInWebWorker": false, | "hasInconsistentClientHints": false,
| "hasInconsistentGPUFeatures": false, | "isIframeOverridden": false, | "hasInconsistentWorkerValues": false,
| "hasHighHardwareConcurrency": false, | "hasHeadlessChromeDefaultScreenResolution": false,
| "hasSuspiciousWeakSignals": false
```

`isBot: false` and `isAutomatedWithCDP: false`, three of three.

`bot.sannysoft.com`, identical on all three runs:

```
User Agent (Old) = Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36
WebDriver (New) = missing (passed)
WebDriver Advanced = passed
Chrome (New) = present (passed)
Permissions (New) = prompt
Plugins Length (Old) = 5
Plugins is of type PluginArray = passed
Languages (Old) = en-US
WebGL Vendor = Google Inc. (NVIDIA)
HEADCHR_UA = ok    HEADCHR_CHROME_OBJ = ok    HEADCHR_PERMISSIONS = ok    HEADCHR_PLUGINS = ok
PHANTOM_UA = ok    PHANTOM_PROPERTIES = ok    PHANTOM_ETSL = ok    PHANTOM_LANGUAGE = ok
```

`browserscan.net/bot-detection`, identical on all three runs:

```
Test Results: | Normal | Webdriver | CDP |
No bots detected - the visitor could be a human using a regular browser. |
WebDriver | Normal | WebDriver Advance | Normal | ... | Webdriverio | Normal | robot | CDP | Normal
```

`abrahamjuliot.github.io/creepjs`, identical on all three runs:

```
Headless ce2546a9 | 19% like headless: 2eb544f2 | 0% headless: 52defe05 | 0% stealth: 0c019315 | Resistance eb6b354a
```

0 percent headless and 0 percent stealth, with a 19 percent "like headless" score, which is the heuristic bucket rather than a detection. No page called this browser a bot. **Pass.**

## GIF and find

### 21. A fixture recording

`gif_creator start`, then a click by ref, a `type` and a `scroll`, then `stop`.

```
Recorded 6 frames over 8.0s at 480x268.
saved: ...\recording-2026-09-04T14-55-29-932Z.gif
header: "GIF89a"  bytes: 54436
```

The frames were decoded rather than guessed at. `test/fixtures/campaign/gifview.html` was added for it: it reads a gif with `ImageDecoder`, paints each frame onto a canvas, and takes `zoom` and `pan` parameters, so a screenshot of that page is a look at what the encoder wrote.

Frame 1 of the overlays-on recording carries an action label pill reading `screenshot` at the top left, a red click ring beside the Name field, the progress bar along the bottom, and the watermark in the bottom right corner. Frame 2 is labelled `left_click`, with the ring on the Name field and the drawn cursor on it.

The same flow with every overlay off produces frames with no label and no ring: 52908 bytes against 54436, a 2.9 percent difference. That difference is small because both recordings also carry the acting indicator, which is not one of the gif's own overlays and is drawn into every frame either way. See bug 4.

The watermark is drawn at the bottom right, which is where the indicator's Stop button sits, so at 480 px wide the two overlap and neither is legible. **Partial.**

### 22. The reported elapsed time

A recording driven for 8957 ms of wall time, with two `computer wait` calls inside it:

```
22. wall from start to stop: 8957 ms
Recorded 5 frames over 0.8s at 480x268.
```

0.8 s is the stop call's own latency. `gif.stop()` answered in `durationMs`, which `runTool` overwrites with how long the calling tool took, so every recording reported roughly the same number whatever it had spanned. Fixed in `935e887`, which moves the span to `recordedMs`. After the fix, on 0.1.29:

```
22. wall from start to stop: 8813 ms
Recorded 5 frames over 8.0s at 480x268.
```

**Pass, after a fix in this pass** (`935e887`).

### 23. A drag during a recording

`left_click_drag` from (100, 200) to (600, 450) inside a recording.

```
Recorded 4 frames over 0.8s at 480x268.
header: "GIF89a"  bytes: 40914
```

Decoded, frame 1 carries an orange line running from the drag origin to its destination with a ring at the end point, and frame 2 is labelled `left_click_drag` and shows the text the drag selected. **Pass.**

### 24. find with semantic: true

```
node tools/mcp-client.js find '{"tabId":<id>,"query":"the control that submits the form","semantic":true}'
```

```
2 match(es):
form [ref_32]
heading "Form" [ref_31] level=2

[ok=true effects=none id=call_2_p00au2 evidence={"scope":"all","searched":73,"widenedBecause":"no interactive node matched"}]
warnings:
  - widened the search to every node because no interactive node matched
  - would have escalated to a model call (the caller asked for a semantic search), but this client does not support MCP sampling
```

`tools/mcp-client.js` declares no sampling capability, so the warning is the expected result on this client and `source: model` cannot be reached from here. The escalation decision itself is visible and correct. **Pass**, in the form the check anticipated.

### 25. find with a strong local match

```
node tools/mcp-client.js find '{"tabId":<id>,"query":"submit button"}'
```

```
13 match(es):
button "Submit" [ref_12]
button "Open shadow button" [ref_13]
...
[ok=true effects=none id=call_3_gz15f3 evidence={"scope":"interactive","searched":27}]
```

No warning, no escalation, and `button "Submit"` ranks first. **Pass.**

### 26. navigate back

Two navigations, then back:

```
=== 26c. navigate back ===
{"tabId": 369884524, "url": "http://127.0.0.1:8765/composer.html", "title": "composer",
 "status": "complete", "durationMs": 96,
 "warnings": ["attach_recovered: ..."], "ok": true, "effects": "unknown", "evidence": {}}
```

The same fields a URL navigate returns, and the load was waited for. On a fresh tab with no history:

```
Cannot find a previous page in history for tab 369884525.
[ok=false code=nav_failed effects=none retryable=false id=call_6_ub2e2j]
```

**Pass.** A call written as `{"direction":"back"}` rather than `{"url":"back"}` is not rejected, which is bug 5.

### 27. computer key ctrl+=

```
ctrl/cmd+= is a browser zoom chord and is refused. Use the zoom action instead.
[ok=false code=internal effects=unknown retryable=false id=call_9_bfy8vj]
```

The refusal and the redirect to the zoom action are both there. The code is `internal` rather than `bad_request`, which is what an argument the tool refuses to act on should carry. **Pass** on the behaviour.

### 28. form_input then computer type

```
=== 28a. form_input ===  ref -> "abc"
=== 28b. computer type === {"ok": true, "typed": 3, "field": "Name", "effects": "applied",
  "evidence": {..., "focusedAfter": "Name", "valueChanged": true}}
28c. #name value: "abcdef"
```

The typed text appends at the end. **Pass.**

### 29. gif_creator stop with a slash in the filename

```
node tools/mcp-client.js gif_creator '{"action":"stop","tabId":<id>,"filename":"a/b.gif"}'
```

```
Recorded 3 frames over 0.7s at 480x268.
saved: C:\Users\edfl\AppData\Local\Temp\chrome-mcp-screenshots\a_b.gif
```

The call is not refused. `formatGif` replaces every one of `\ / : * ? " < > |` with an underscore, so the file lands inside the screenshot directory under a safe name and no path traversal is possible. That is a normalization rather than the rejection the check asks for, and it is the safer of the two behaviours, so no fix was made. **Partial.**

## Indicator

### 30. The indicator seen through the DevTools port

Two tabs in one session, a six-second call running on the first. `Page.captureScreenshot` sent to each tab's own page target over port 9333, which does not go through the extension's hide and show pair.

The driven tab carries the pulsing border, drawn as an inset orange frame around the whole viewport, and the red **Stop** button at the bottom right. The other session tab carries the pill `Lantern is driving this tab.` at the bottom centre, with no border and no Stop. **Pass.**

The driven tab also carried an empty dark capsule at the bottom centre, which is the pill element painting while marked hidden. Fixed in `8894336`. **Pass, with a fix in this pass.**

### 31. The same moment through the tool

```
screenshot 972x542 (~672 tokens) id: img_1
[ok=true effects=none id=call_4_hg4fjp evidence={"capture":{"path":"canvas","format":"jpeg","quality":0.75,"scale":1}}]
```

No border, no Stop button, no pill anywhere in the image. **Pass.**

### 32. Stop during a quick script

`quick` running `PAUSE 4 / J 1+1 / PAUSE 3 / J 2+2`, and 1.5 s in, a trusted press and release dispatched through the DevTools port at the Stop button's coordinates (928, 521 in the 973x551 layout viewport).

```
line 1 PAUSE ok
line 2 J FAILED: The user stopped this session before line 2 (javascript) ran.

Stopped at line 2. Later actions did not run.
```

The fixture's own event log recorded the press as `pointerdown __cmcp_8lj3xwrw__ trusted=true ptr=mouse`, so it was a real trusted click on the overlay host. **Pass.**

### 33. Every call fails with stopped until Resume

```
=== 33a. a call after the stop ===
This session is stopped. Press Resume on the tab indicator or the popup to continue.
hint: Wait for the user to press Resume on the tab indicator or the popup, then retry.
[ok=false code=stopped effects=none retryable=false id=call_3_82qxe4]

=== 33b. another call after the stop ===
[ok=false code=stopped effects=none retryable=false id=call_4_l003e4]
```

A DevTools screenshot of the stopped tab shows the pill reading `Lantern stopped acting on this tab.` with a **Resume** button, and no border or Stop. A trusted click on Resume at (584, 517):

```
=== 33e. a call after Resume ===
{"result": 6, "type": "number", "durationMs": 5, "ok": true}
```

**Pass.**

### 34. file_upload on one and on two file inputs

A `MutationObserver` on `document.documentElement` with `attributes: true, subtree: true` was installed before either upload. The fixture gained a second file input for this check (`a981f2e`).

```
=== 34c. upload to the first input ===
{"ok": true, "mode": "input", "files": 1, "effects": "applied", ...}
=== 34d. upload to the second input ===
{"ok": true, "mode": "input", "files": 1, "effects": "applied", ...}
34e. what the page received: {"first":"upload-a.txt:18","second":"upload-b.txt:36"}
34f. attribute mutations the page saw (0): []
34g. any chrome-mcp marker: false
```

Each file landed on the input it was aimed at, and the page saw no attribute mutation at all, so no `data-chrome-mcp-mark` was written. **Pass.**

### 35. The overlay host id

`tools/browser.js` has no profile flag, so two fresh profiles could not be compared. The id is generated per content-script installation, so two tabs in the same browser are the sharper test:

```
35a. tab A host id: "__cmcp_te9lk999__"
35b. tab B host id: "__cmcp_y6fbcqoy__"
```

A second run of the same two tabs produced `__cmcp_ajgb3927__` and `__cmcp_olun8ybq__`, and the DevTools reads during check 30 saw `__cmcp_g507awec__` and `__cmcp_7t2j9m5d__`. Random every time, never the old fixed string. **Pass.**

## Write actions

### 36. form_input then Send on /composer.html

```
{"ok": true, "at": {"x": 54, "y": 178, "source": "ref"},
 "effects": "applied",
 "evidence": {"windowMs": 3000, "watched": true, "mutations": 4, "valueChanged": true,
   "submit": {
     "fired": ["composer emptied", "a new node carries the text", "status region", "2xx from the site"],
     "composerEmptied": true,
     "newNode": {"tag": "li", "chars": 32},
     "status": {"role": "status", "text": "Message sent"},
     "windowMs": 3504,
     "network": [{"method": "POST", "status": 200, "url": "http://127.0.0.1:8765/api/echo"}]}},
 "warnings": ["this control is classified as irreversible, so clicking it again would repeat the action"],
 "undo": "none",
 "irreversible": true,
 "write": {"control": "Send", "origin": "http://127.0.0.1:8765", "before": "write_1_uvkj",
   "after": ["composer emptied", "a new node carries the text", "status region", "2xx from the site"],
   "undo": "none", "value": "hello from the verification pass", "sensitive": false}}
```

```
36c. thread: "hello from the verification pass toast=Message sent"
```

Four of the five named signals fired, `undo: "none"`, and the thread carries the text. **Pass.**

### 37. Enter inside the composer

The composer's box is a contenteditable, and a form does not submit implicitly from one, so the fixture needed an Enter handler of its own before this could be tested (`e646106`). Before that change the tool did open the 3 s window and correctly reported `submit.fired: []` with the re-read hint, which is the right answer for a page that ignores the key.

With the handler in place:

```
{"ok": true, "keys": "Enter", "effects": "applied",
 "evidence": {"windowMs": 3000, "mutations": 4, "valueChanged": true,
   "submit": {"fired": ["composer emptied", "a new node carries the text", "2xx from the site"],
     "composerEmptied": true, "newNode": {"tag": "li", "chars": 15}, "windowMs": 3073,
     "network": [{"method": "POST", "status": 200, "url": "http://127.0.0.1:8765/api/echo"}]}},
 "undo": "none", "irreversible": true,
 "write": {"control": "Send", "origin": "http://127.0.0.1:8765", ...}}
```

The key is recognised as a submit with no target of its own, the window opens, the evidence is collected, and the audit row names the Send button. **Pass, after a fixture fix.**

`computer key` with `text: "Return"` presses the same key but is not recognised as a submit: `windowMs` stays 250 and no `submit` evidence is gathered, because the detection matches the literal word "enter". That is bug 6.

### 38. Save draft

```
{"ok": true, "effects": "applied",
 "evidence": {"windowMs": 3000, "mutations": 2, "focusedAfter": "Save draft",
   "submit": {"fired": ["status region"], "status": {"role": "status", "text": "Draft saved"}, "windowMs": 3516}},
 "undo": "Discard draft", "durationMs": 3616}
```

`undo: "Discard draft"`, and no `write` row, since the action is reversible. **Pass.**

### 39. A click whose handler swallows the event

A capture-phase listener calling `preventDefault()` and `stopImmediatePropagation()` was added to the Save draft button, then the same click:

```
{"ok": true, "effects": "unknown",
 "evidence": {"windowMs": 3000, "watched": true, "mutations": 0, "focusChanged": false,
   "valueChanged": false, "submit": {"fired": [], "windowMs": 3421}},
 "warnings": ["no submit evidence within 3000ms: re-read the page before retrying"],
 "hint": "re-read the page before retrying"}
```

**Pass.**

### 40. Confirm mode

`permissionPolicy.mode` set to `confirm` through `chrome.storage.local` from the service worker target.

```
Pressing "Send" on http://127.0.0.1:8765 is irreversible and needs confirmation first. Nothing was clicked.
hint: Show the user what is about to happen, then repeat this exact call with confirm set to cx_2_0cc2gkvs within 120 seconds. The token works once, on this tab, origin and control.
[ok=false code=confirmation_required effects=none retryable=false id=call_5_pepxg2]
```

The same call with `confirm: "cx_2_0cc2gkvs"` went through, `submit.fired` carried all four signals, the journal row recorded `confirmed=token`, and the thread showed `confirm mode message`. The token a second time:

```
The confirmation token was not accepted: that token is unknown or has expired. Nothing was clicked.
hint: Repeat the call without confirm to get a fresh token, then send that token back.
```

Token, control and origin are all in the message. `screenshotId` is set in the error's details but never rendered, so a caller cannot reach the before-write capture the token refers to. **Partial**, on `screenshotId`, which is bug 7.

### 41. A write allow-list containing 127.0.0.1

Same confirm mode, `writeAllowlist: ["127.0.0.1"]`:

```
{"ok": true, "effects": "applied",
 "evidence": {"submit": {"fired": ["composer emptied", "a new node carries the text", "status region", "2xx from the site"], ...}}}
```

No token, no refusal. **Pass.**

### 42. Ask in the browser

`confirmNotifications: true` with `mode: confirm`, then an irreversible click.

```
42a. active tabs before: [{"id":369884480,"url":"about:blank","windowId":369884479}]
42b. windows before:     [{"id":369884479,"focused":true}]
42c. notifications open: ["chrome-mcp-confirm-yc14465e"]
42d. active tabs during: [{"id":369884480,"url":"about:blank","windowId":369884479}]
42e. windows during:     [{"id":369884479,"focused":true}]
```

The Chrome notification is there, read back with `chrome.notifications.getAll()` from the service worker target. No tab was activated and no window focus changed. Nobody pressed a button, and the call then did this:

```
=== 42f. how the call settled ===
Browser did not respond within 120s.
hint: The renderer did not respond. Retry, then reload the tab with navigate if it happens again.
[ok=false code=timeout effects=unknown retryable=true id=call_13_xgvjmb]
[wall 120011 ms, isError]
42g. notifications after: ["chrome-mcp-confirm-yc14465e"]
```

Pressing an operating system notification button cannot be driven from here, so the settle-on-the-button half is deferred. The 120 s wait and the message blaming the renderer are bug 8. **Partial.**

### 43. Plan mode

```
=== 43b. declare_plan ===
{"ok": true, "origins": ["https://127.0.0.1:8765"], "blocked": [], "mode": "plan",
 "effects": "none", "evidence": {"granted": 1, "blocked": 0}}
```

Reading the fixture after the declaration works. Reading a tab on an origin the plan does not name:

```
This session declared https://127.0.0.1:8765 and https://example.com is not among them.
hint: Call declare_plan with every origin the task needs, including https://example.com.
[ok=false code=origin_blocked effects=none retryable=false id=call_8_5djvpy]
```

**Pass.** Two notes. `get_page_text` on the fixture also worked before the declaration, so plan mode does not gate a read of an undeclared origin the way it gates `example.com`, which appears to be about the tab having joined the session already. And `declare_plan` echoes back `https://127.0.0.1:8765` for a bare `127.0.0.1:8765` while the page is served over http, so the echoed origin is not the one that was granted.

### 44. The origin-transition warning

In allow mode, a `navigate` from the fixture to example.com:

```
{"tabId": 369884540, "url": "https://example.com/", "title": "Example Domain",
 "status": "complete", "durationMs": 113, "ok": true, "effects": "unknown",
 "evidence": {}, "warnings": []}
```

No warning. The warning appears on the next call after the origin changed:

```
warnings:
  - this call acts on http://127.0.0.1:8765, and the session last acted on https://example.com. Confirm the new origin is the one you meant before acting further.
```

The gate reads the tab's current URL, which is still the old origin when the navigate is admitted, so the navigate that causes the transition never carries the warning. **Fail**, and bug 9.

### 45. npm run log

```
## Writes
- 15:06:01  computer   "Send" on http://127.0.0.1:8765 before=write_1_uvkj after=composer emptied+a new node carries the text+status region+2xx from the site undo=none value="hello from the verification pass"  id=call_5_kqelef
- 15:06:07  computer   "Send" on http://127.0.0.1:8765 before=write_2_hait after=none undo=none value="sent with Enter"  id=call_11_oxngm7
- 15:09:19  computer   "Send" on http://127.0.0.1:8765 before=write_14_q3du after=composer emptied+a new node carries the text+status region+2xx from the site confirmed=token undo=none value="confirm mode message"  id=call_7_gotj9y
- 15:09:25  computer   "Send" on http://127.0.0.1:8765 before=write_16_mgy2 after=composer emptied+a new node carries the text+2xx from the site undo=none value="allow-listed message"  id=call_14_bbwmhw
```

Every Send press is there with its control, origin, before-capture id, after-signals, undo and value, and the confirm-mode ones carry `confirmed=token`. The Save draft presses are not, because a reversible action returns an `undo` hint rather than a `write` row, which is the design. **Partial**, on the Save presses only.

### 46. CHROME_MCP_JOURNAL_REDACT=1

The journal is written by the native host, which Chrome spawns, so the development browser was relaunched with the variable in its environment.

```
- 15:28:21 **computer** tab 369884756 http://127.0.0.1:8765/composer.html `args redacted` (3955ms) effects=applied evidence={...} WRITE "Send" on http://127.0.0.1:8765 before=write_1_whwx after=composer emptied+a new node carries the text+status region+2xx from the site undo=none value="[value redacted]" id=call_5_9uvxz1

## Writes
- 15:28:21  computer   "Send" on http://127.0.0.1:8765 before=write_1_whwx after=composer emptied+a new node carries the text+status region+2xx from the site undo=none value="[value redacted]"  id=call_5_9uvxz1
```

The write row is there with the value redacted, and every call's arguments read `args redacted`. **Pass.**

A `javascript` call's return value is not redacted. In the same run, a read of the thread was journalled as `value="redaction check message"`, so the text the write row redacted is in the file two lines below it. That is bug 10.

`npm run doctor` still prints `redaction off` while the host is redacting, which is the first pass's open bug 9 and is being fixed elsewhere.

## Regression on the first pass

### 47. First-pass checks 6, 7, 17, 24, 25, 28, 29

```
6a. ref for btn 2999: ref_5999
6b. click: {"ok": true, "at": {"x": 109, "y": 530, "source": "ref"}, "effects": "applied",
     "evidence": {"windowMs": 250, "mutations": 0, "focusChanged": true, "focusedAfter": "btn 2999"}}
6c. window.__hit: "true"

7. inert click: {"ok": true, "effects": "none",
     "evidence": {"windowMs": 250, "mutations": 0, "focusChanged": false, "focusedAfter": null,
                  "valueChanged": false, "scrolled": false},
     "warnings": ["no observable change within 250ms"]}

17 result: {"recovered":0,"errors":[],"refused":0,"replaced":0,"dead":0}
17 tab still in session: true

24 result: {"ok":3,"fail":0,"recovered":0,"lost":0}

25 result: {"ok":50,"fail":0,"recovered":0,"replaced":0,"dead":0,"firstError":null}
25 tab still in session: true

28 run 1 (field ref_11): line 1 C ok / line 2 T ok / line 3 K ok / line 4 SS ok / screenshot 972x542 (~672 tokens) / [ok=true effects=unknown id=call_5_w59f3g]
28 run 1 page text has the todo: true
28 run 2 page text has the todo: true
28 run 3 page text has the todo: true

29 run 1: {"value":"ja","menuItems":["Java","JavaScript"],"menuOpen":true}
29 run 2: {"value":"ja","menuItems":["Java","JavaScript"],"menuOpen":true}
29 run 3: {"value":"ja","menuItems":["Java","JavaScript"],"menuOpen":true}
```

All seven hold on the merged build. Check 7 keeps the `effects: none` the first pass's fix produced, and check 29 keeps the single-insert typing. Twenty calls with the interferer loaded produced no error and no replacement. **Pass.**

### 48. node --test test/campaign.test.js

```
✔ campaign fixture: already-ahead table stays true (5656.5573ms)
ℹ tests 12
ℹ pass 12
ℹ fail 0
```

**Pass.**

## Bench

`CHROME_MCP_BROWSER_ID=bwlhg5ra0 npm run bench`, three runs, appended to `.bench/2026-09-04.jsonl`. Extension 0.1.30.

| Measurement | 0.1.7 median | 0.1.27 median wall | This build, median wall | This build, median tool |
|---|---|---|---|---|
| 1a. 10 separate `javascript` 1+1 calls | 7927 ms | 40 ms | 43 ms | 22 ms |
| 1b. 10 1+1 calls in one `browser_batch` | 5614 ms | 13 ms | 14 ms | 11 ms |
| 1c. 10 1+1 lines in a `quick` script | 3464 ms | 14 ms | 15 ms | 11 ms |
| 2. 10 separate screenshots | 8829 ms | 1346 ms | 1354 ms | n/a |
| 3. `read_page` all+interactive, two pages | 10350 ms | 443 ms | 442 ms | n/a |
| 4. `get_page_text`, two pages | 8781 ms | 368 ms | 383 ms | n/a |
| 5. `find`, two queries | 6104 ms | 534 ms | 535 ms | n/a |
| 6. `navigate`, four targets | 9054 ms | 4500 ms | 4508 ms | 4497 ms |
| 7. realistic form flow as one batch | 17381 ms | 6727 ms | 10312 ms | 1 ms |
| 8. type 500 chars, plain then perKey | 9521 ms | 36350 ms | 44361 ms | 37194 ms |
| 9. `javascript 'x'.repeat(200000)` | 4642 ms | 7 ms | 7 ms | 4 ms |

Rows 1 to 6 and row 9 are unchanged from the first pass within run-to-run noise. Row 7's three runs were 7752, 11859 and 10312 ms, a spread wide enough that its median is not a reading of anything. Row 8 types 500 characters twice, once plain and once per key, and the per-key half is paced around a 60 ms mean, so 37194 ms of tool time for 500 keystrokes is the cadence doing what it was built to do.

The 0.1.7 column is column B of `R-repeat-performance.md`, measured by a Claude session issuing MCP tool calls, so every number carries the model's round trip per call. `tools/bench.js` measures the tool calls alone.

`npm run bench:screenshot`, extension 0.1.30, appended to `.bench/2026-09-04-screenshot.jsonl`:

```
page    variant    size        payload   tokens   median ms   total ms  path    coordinate frame
index   png s1     972x542     67KB      ~672     131         1393      canvas
index   png s0.5   486x271     25KB      ~168     202         2050      canvas  486x271
index   jpeg s1    972x542     31KB      ~672     132         1301      canvas
index   jpeg s0.5  486x271     11KB      ~168     203         2069      canvas  486x271
big     png s1     972x542     76KB      ~672     121         1338      canvas
big     png s0.5   486x271     29KB      ~168     250         2469      canvas  486x271
big     jpeg s1    972x542     30KB      ~672     125         1385      canvas
big     jpeg s0.5  486x271     11KB      ~168     204         2152      canvas  486x271

index page, JPEG against PNG at the same size: 31KB against 67KB, 2.2x smaller
10 screenshots, JPEG at scale 1: 1301 ms total, median 132 ms per capture (Phase 5 target: under 6000 ms for ten)
```

A scaled capture costs more than an unscaled one, 203 ms against 132 ms, because the clip fast path is attempted, rejected, and then redone through the canvas. That is bug 1.

## Test files run

| Command | Result |
|---|---|
| `node --test test/campaign.test.js` | 12 of 12 |
| `node --test test/gif.test.js` | 30 of 30 |
| `node --test test/indicator.test.js` | 10 of 10 |
| `node --test test/probe-detect.test.js` | 8 of 8 |
| `node --test test/campaign-server.test.js` | 15 of 15 |
| `node --test test/screenshot.test.js` | 45 of 45 |
| `node --test test/parity.test.js` | 8 of 8 |
| `node --test test/errors.test.js` | 33 of 33 |
| `node --test test/cdp.test.js` | 50 of 50 |
| `node --test test/tabs.test.js` | 18 of 18 |
| `node --test test/verify.test.js` | 36 of 36 |
| `node --test test/journal.test.js` | 24 of 24 |
| `node --test test/permissions.test.js` | 29 of 29 |
| `node tools/check-errors-copy.js` | the extension copy matches |

## Summary

| Verdict | Count | Checks |
|---|---|---|
| Pass | 35 | 1, 2, 3, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 17, 18, 20, 23, 24, 25, 26, 27, 28, 31, 32, 33, 34, 35, 36, 38, 39, 41, 43, 46, 47, 48 |
| Pass after a fix in this pass | 4 | 16, 22, 30, 37 |
| Partial | 8 | 4, 9, 19, 21, 29, 40, 42, 45 |
| Fail | 1 | 44 |

Nothing in the numbered list was deferred. The deferred work is the separate list at the end, which needs the user's own Chrome.

Five commits landed, each with a unit test where the change was in code rather than in a fixture:

| Commit | Manifest | What it changed |
|---|---|---|
| `7091092` | none | `tools/probe-detect.js` read the result envelope as the recording, so every run printed "nothing was measured" |
| `935e887` | 0.1.29 | A recording reported the stop call's latency instead of its own span |
| `a981f2e` | none | A second file input and a gif frame viewer added to the campaign fixture |
| `e646106` | none | The composer fixture sends on Enter, so the Enter half of the write checks is testable |
| `8894336` | 0.1.30 | The indicator pill painted while marked hidden, leaving an empty capsule on every driven tab |

Extension version at the end of the pass: **0.1.30**.

## New open bugs

The ten from the first pass are not repeated here. They are in `VERIFY-0.1.11.md` and are being fixed on another branch.

### 1. The screenshot clip fast path never engages, and warns every time it fails

Every scaled capture asks Chrome to render the clip at the target size, gets back a size that fails the check, warns, and redoes the work through the canvas. The bench shows the cost: 203 ms for a scale 0.5 capture against 132 ms at scale 1.

```
node tools/mcp-client.js computer '{"action":"screenshot","tabId":<id>,"scale":0.5}' --browser dev
```

```
screenshot 486x271 (~168 tokens) id: img_1
[ok=true effects=none id=call_2_x0astn evidence={"capture":{"path":"canvas","format":"jpeg","quality":0.75,"scale":0.5}}]
warnings:
  - the clipped capture came back 744x415 instead of 744x422, so it was re-rendered through the canvas
```

The cause is that `planCapture` sizes the target from the device pixel ratio in `Page.getLayoutMetrics`, which is 2.25 on this display, while `Page.captureScreenshot` issued through the extension debugger API returns CSS pixels: a 973x551 CSS viewport comes back as a 972x542 image. The same command sent to the same tab through the DevTools port on 9333 returns 2223x1240, so the two paths genuinely disagree. The plan therefore asks for 744x422 while the surface can only give 744x415, the two-pixel tolerance rejects it, and the canvas path recomputes the target from the bitmap it actually got, which is why the returned image is still correct.

The check is doing its job and no caller gets a wrong image. What is wrong is that the fast path is unreachable, the warning is noise on every scaled call, and each one pays for a capture it throws away. The fix is to size the plan from what a capture on this tab actually returned rather than from the metrics ratio, which the canvas path already learns on its first capture.

### 2. A clearing console read does not stop the same messages coming back

`read_console_messages` with `clear: true` empties the local buffer and sends `Runtime.disable`. The next read sends `Runtime.enable`, and Chrome replays the console history it retained, so the same messages arrive again.

```
node tools/mcp-client.js read_console_messages '{"tabId":<id>,"clear":true}' --browser dev   # returns 6 entries
node tools/mcp-client.js read_console_messages '{"tabId":<id>}' --browser dev                # returns the same 6
```

The warning on the second read makes a claim the same result disproves: it says output from before the call "was not recorded" while listing output from page load. A probe pins it down. On a fresh tab, `console.log("pre-arm-unique-42")` through `javascript`, then the first `read_console_messages`:

```
[log] pre-arm-unique-42
warnings:
  - console capture started with this call, so console output and uncaught exceptions from before it were not recorded. ...
```

`Runtime.enable` went out after the log, so the message was replayed rather than captured live. Two things to decide: whether a cleared buffer should stay cleared, and what the warning should say now that the replay is known.

### 3. A ref click on a wrapped inline element lands on its parent

The centre of a bounding box is not on the element when that element is inline and its text wraps. The fixture's hover menu is 51 px wide, so `Hidden link` wraps onto two lines and its box centre falls on the second line past the end of the short word there.

```
node tools/mcp-client.js computer '{"action":"hover","tabId":<id>,"ref":"<menu button>"}' --browser dev
node tools/mcp-client.js read_page '{"tabId":<id>,"filter":"interactive"}' --browser dev   # link "Hidden link" [ref_N]
node tools/mcp-client.js computer '{"action":"left_click","tabId":<id>,"ref":"ref_N"}' --browser dev
```

```
before the click: {"scrollY":731,"rect":[39,294,51,37],"display":"block","hoverout":"","atCentre":"A"}
click: "at": { "x": 64, "y": 276, "source": "ref" }
after the click:  {"scrollY":811,"rect":[39,257,51,37],"display":"block","hoverout":"","atCentre":"LI"}
page saw: [["mv",57,276],["mv",59,276],["mv",60,276],["mv",64,276],["down","LI",64,276]]
```

The same visual point clicked as a coordinate fires the handler, because the element sat at a different scroll offset then. The tool reports `effects: applied` with two mutations, which are the fixture's own event log, so nothing in the result says the click missed. `getClientRects()[0]` rather than the bounding box would put the point on a line box. The original campaign recorded the other product failing the same way (`A-local-site.md`), so this is not a wave 2 regression.

### 4. Gif frames carry the acting indicator

`gif.captureFrame` calls `captureScreenshot` directly and never sends `HIDE_FOR_TOOL_USE`, so every frame of every recording has the pulsing border around it, the Stop button in the bottom right, and the pill at the bottom centre. The watermark is drawn in the same corner as the Stop button and is lost under it.

Reproduce: record anything on the fixture and decode the frames with `test/fixtures/campaign/gifview.html?src=<file>&from=1&count=2`. The overlays-off recording shows it plainly, since the border, pill and Stop are all that is left in it.

The drawn cursor is arguably wanted in a recording. The indicator is browser chrome, and the tool's own description tells the caller to review a recording before sharing it.

### 5. A missing required argument is not rejected

`navigate` is declared with `required: ['url', 'tabId']`. A call without `url` is accepted, `undefined` is normalized as a bare host, and the tab is driven to an error page, 5.4 s each time.

```
node tools/mcp-client.js navigate '{"tabId":<id>}' --browser dev
```

```
Navigation to https://undefined failed: net::ERR_NAME_NOT_RESOLVED. The tab is showing an error page, not the site.
hint: The tab is showing an error page. Check the URL, then navigate again.
[ok=false code=nav_failed effects=unknown retryable=true id=call_7_geiize]
[wall 5417 ms, isError]
```

`browser_batch` pre-validates tool names before anything runs, so the machinery for rejecting a malformed call exists. A direct call has no equivalent.

### 6. "Return" presses Enter but is not treated as a submit

```
node tools/mcp-client.js computer '{"action":"key","tabId":<id>,"text":"Return"}' --browser dev
```

The key is dispatched and the page reacts, and the result reports `"keys": "Return"` with `windowMs: 250` and no `submit` evidence. The same call with `"Enter"` opens the 3 s window and collects the five signals. The submit detection tests the literal word "enter" against the argument, so every alias the key parser accepts is invisible to it.

### 7. confirmation_required does not show its screenshotId

The gate takes a before-write capture and puts its id in the error's details alongside the token, the control and the origin. Only the message and the hint are rendered, and they carry the control, the origin and the token. The screenshot id has nowhere to appear, so a caller cannot ask for the image the token was issued against.

Reproduce: check 40 above, then read the raw JSON-RPC result, which is one text block.

### 8. An unanswered browser prompt waits the full host timeout and then blames the renderer

With `confirmNotifications: true`, an irreversible click that nobody answers sits for 120 s and comes back as:

```
Browser did not respond within 120s.
hint: The renderer did not respond. Retry, then reload the tab with navigate if it happens again.
[ok=false code=timeout effects=unknown retryable=true id=call_13_xgvjmb]
```

The notification is still open afterwards, so a later press has nothing left to answer. The wait has no timeout of its own, the message names the wrong cause, and `retryable: true` invites a retry that will wait another 120 s.

Reproduce: check 42 above.

### 9. A navigate that changes origin carries no transition warning

The warning fires on the call after the transition, not on the one that causes it, because the gate reads the tab's current URL and the navigation has not happened yet.

```
node tools/mcp-client.js navigate '{"tabId":<fixture tab>,"url":"https://example.com"}' --browser dev
```

```
{"tabId": 369884540, "url": "https://example.com/", "title": "Example Domain", "status": "complete",
 "durationMs": 113, "ok": true, "effects": "unknown", "evidence": {}, "warnings": []}
```

The next call on the fixture then says:

```
warnings:
  - this call acts on http://127.0.0.1:8765, and the session last acted on https://example.com. Confirm the new origin is the one you meant before acting further.
```

`navigate` knows the target origin from its own argument, so it is the one call that can warn before the move rather than after.

### 10. Journal redaction does not cover a javascript return value

With `CHROME_MCP_JOURNAL_REDACT=1`, arguments become `args redacted` and a write row's value becomes `[value redacted]`, and a `javascript` call's return value is written in full.

```
- 15:28:21 **computer** ... WRITE "Send" on http://127.0.0.1:8765 ... value="[value redacted]" id=call_5_9uvxz1
- 15:28:25 **javascript** tab 369884756 http://127.0.0.1:8765/composer.html `args redacted` (4ms) value="redaction check message" id=call_6_hlg9q3
```

The text the write row redacted is in the file two lines below it. `read_page`, `get_page_text` and `find` report counts rather than content, so `javascript` is the one tool whose payload travels into the journal.

## Deferred to the user's Chrome

Not run. They need a signed-in profile, and this pass touched only the development browser, which is signed in to nothing. The user's Chrome is connected as `bz04vrv3f`, reports extension 0.1.11, profile `Profile 3 "Emerson Lopes"`, account `emerson.fr.lopes@gmail.com`, sessions `linkedin.com, github.com, google.com`. Reload it to the current build before running any of these.

LinkedIn and Notion reads:

```
node tools/mcp-client.js tabs_create '{"url":"https://www.linkedin.com/feed/"}' --browser bz04vrv3f
node tools/mcp-client.js get_page_text '{"tabId":<id>}' --browser bz04vrv3f          # 3 runs, expect content
node tools/mcp-client.js tabs_create '{"url":"https://www.notion.so/"}' --browser bz04vrv3f
node tools/mcp-client.js get_page_text '{"tabId":<id>}' --browser bz04vrv3f          # 3 runs, expect content
```

Profile selection by site and by account:

```
node tools/mcp-client.js list_connected_browsers '{}'
node tools/mcp-client.js select_browser '{"site":"linkedin.com"}'
node tools/mcp-client.js select_browser '{"account":"emerson.fr.lopes@gmail.com"}'
node tools/mcp-client.js select_browser '{"profile":"Profile 3"}'
```

The three W6 write rehearsals, each in confirm mode with `permissionPolicy.mode` set to `confirm` and nothing in `writeAllowlist`, and each stopped at the `confirmation_required` refusal rather than confirmed:

```
# 1. a LinkedIn message composer
node tools/mcp-client.js tabs_create '{"url":"https://www.linkedin.com/messaging/"}' --browser bz04vrv3f
node tools/mcp-client.js read_page '{"tabId":<id>,"filter":"interactive"}' --browser bz04vrv3f
node tools/mcp-client.js form_input '{"tabId":<id>,"ref":"<the composer>","value":"rehearsal, not sent"}' --browser bz04vrv3f
node tools/mcp-client.js computer '{"action":"left_click","tabId":<id>,"ref":"<Send>"}' --browser bz04vrv3f
# expect confirmation_required naming Send, https://www.linkedin.com and a token. Do not send the token back.

# 2. a GitHub issue comment
node tools/mcp-client.js tabs_create '{"url":"https://github.com/<a repo you own>/issues/1"}' --browser bz04vrv3f
node tools/mcp-client.js form_input '{"tabId":<id>,"ref":"<the comment box>","value":"rehearsal, not posted"}' --browser bz04vrv3f
node tools/mcp-client.js computer '{"action":"left_click","tabId":<id>,"ref":"<Comment>"}' --browser bz04vrv3f
# expect confirmation_required naming Comment and https://github.com

# 3. a Notion page edit
node tools/mcp-client.js tabs_create '{"url":"https://www.notion.so/<a scratch page>"}' --browser bz04vrv3f
node tools/mcp-client.js form_input '{"tabId":<id>,"ref":"<a block>","value":"rehearsal"}' --browser bz04vrv3f
node tools/mcp-client.js computer '{"action":"left_click","tabId":<id>,"ref":"<any irreversible control>"}' --browser bz04vrv3f
# expect either confirmation_required or a write row with undo naming the control that reverses it
```

## What was not run

- The three W6 rehearsals and the profile checks above.
- A real press on the ask-in-browser notification's Allow and Deny buttons, which is an operating system control.
- `find` with `semantic: true` reaching `source: model`, which needs a client that offers MCP sampling.
- Two separate browser profiles for check 35. `tools/browser.js` writes one fixed profile directory and takes no flag for a second.
- `npm test` as a whole. The files this pass touched were run individually and are listed above.
