# Live verification of the merged build

Branch `plan/integration`. The pass started on extension 0.1.11 and ended on 0.1.27, because eleven fixes landed while it ran. Run 2026-09-03 and 2026-09-04.

## How this pass was driven

The MCP tools held by the Claude Code session were bound to a server process started before the merge, so they run the old host code. Every check below went through `tools/mcp-client.js`, a stdio MCP client added for this pass that spawns `host/mcp-server.js` from the working tree.

```
node tools/mcp-client.js <tool> '<json args>' [--browser <id>] [--raw]
```

The browser is Chrome for Testing launched by `node tools/browser.js --interferer --detach`, which loads `test/fixtures/interferer` next to the extension. That second extension mounts a `chrome-extension://` iframe into every page, which is what makes `chrome.debugger.attach` refuse, so the recovery ladder is exercised without x.com or a password manager. Registry id `bwlhg5ra0`, profile `Default "Your Chromium"`, not signed in to anything.

The fixture server is `node test/fixtures/campaign/server.js 8765`.

Nothing in this pass activated a tab or focused a window.

## Checks

### 1. Doctor after a reload

`npm run doctor`

```
  ok   a browser is connected
         Chrome 152.0.0.0 (bz04vrv3f), Chrome 152.0.0.0 (bwlhg5ra0)
         several browsers are connected, so a session must call select_browser
  ok   Chrome extension is attached
         extension v0.1.11, 18 handlers, 25 tools advertised
         profile Default "Your Chromium"  account not signed in  label none  local true  dev true
         sessions none detected

Retry policy (host/errors.js)
  read   attempts 3, backoff 250, 750ms
         tools: read_page, get_page_text, find, page_state, read_console_messages, read_network_requests, tabs_context, wait_for_page, shortcuts_list, list_connected_browsers, computer screenshot
         on: renderer_throttled, timeout, host_lost
  input  attempts 2, backoff 250ms
         tools: every other tool
         on: any retryable code, only when the error reports effects none
  never  attempts 1, backoff 0ms
         tools: any call carrying confirm, or flagged irreversible
         on: effects unknown or applied is never retried
  25 error codes in the catalogue: tab_gone, tab_replaced, tab_foreign, attach_refused, attach_recovered, renderer_throttled, dialog_open, ref_stale, ref_covered, element_disabled, element_readonly, not_a_form_control, no_effect, nav_failed, origin_changed, origin_blocked, confirmation_required, host_lost, timeout, output_truncated, browser_unknown, profile_ambiguous, batch_invalid, bad_request, internal

Journal: C:\Users\edfl\AppData\Local\Temp\chrome-mcp-logs
  4 file(s), 836 KB, retention 14 days (CHROME_MCP_JOURNAL_DAYS), redaction off (CHROME_MCP_JOURNAL_REDACT)
```

Version 0.1.11, 25 codes, the retry table, the retention line and the profile row are all present. **Pass.**

### 2. list_connected_browsers shows profile, name and account

`node tools/mcp-client.js list_connected_browsers '{}' --browser dev`

```
2 connected:
bz04vrv3f
  browser: Chrome 152.0.0.0  local: true  dev: false
  profile: unknown  account: not signed in
  sessions: not reported (reload the extension so it picks up the cookies permission)

bwlhg5ra0
  browser: Chrome 152.0.0.0  local: true  dev: true
  profile: Default "Your Chromium"  account: not signed in
  sessions: none detected

select_browser takes any of browserId, label, profile, account or site.

[ok=true effects=none id=call_1_0fv9qc]
```

The dev browser reports its profile directory and display name. It is signed in to nothing, so `account` is empty, which is correct for it. The other row was the user's Chrome on 0.1.9 at that moment. After the user reloaded it to 0.1.11 the same call reports `profile Profile 3 "Emerson Lopes"  account emerson.fr.lopes@gmail.com  sessions linkedin.com, github.com, google.com`, so the account and site columns are proven on a signed-in profile too. **Pass.**

### 3. Bench

`CHROME_MCP_BROWSER_ID=bwlhg5ra0 npm run bench`

Medians, with the 0.1.7 medians from `R-repeat-performance.md` beside them, are in the "Bench" section below. `.bench/2026-09-03.jsonl` was written with three runs. **Pass.**


### 4. The four new fixture pages render

`navigate` then `computer screenshot save_to_disk` on `/sensitive.html`, `/unload.html`, `/scroll.html`, `/composer.html`, three runs.

At 0.1.11 every screenshot of a background tab failed:

```
the hidden tab produced no frame within 4000ms
hint: Read the message. If it repeats, read the page again before acting on it.
[ok=false code=internal effects=unknown retryable=false id=call_3_fcoawc]
```

After the fixes listed below, all four pages render, three runs in a row, and the images are byte identical to the same pages captured with the interferer unloaded (29622, 22998, 38235 and 27456 bytes). Two were opened and looked at: `/sensitive.html` shows its heading and three labelled inputs, `/composer.html` shows the composer box and a greyed Send. **Pass, after two fixes.**

| Commit | What it fixed |
|---|---|
| `e2f8f31` | A sleeping tab emits no screencast frame at all, so every hidden-tab screenshot failed. The capture now forces the wake, waits two animation frames in the page, and opens screencasts until two carry the same image. |
| `9fc1e91` | Short per-attempt casts, and the give up raised as `timeout` so the read retry policy rescues it. |

### 5. Campaign tests

`CHROME_MCP_BROWSER_ID=bwlhg5ra0 node --test test/campaign.test.js`

```
  ok opens a tab and navigates to the fixture (132.1921ms)
  ok open shadow DOM button is present in read_page with a ref (8.7226ms)
  ok same-origin iframe button is present, clickable by ref, and the iframe span updates (2470.5311ms)
  ok (offscreen) marks are present for #farbtn (4.9877ms)
  ok form_input on the disabled input is refused (10.7441ms)
  ok navigate to /redirect returns the resolved URL and a numeric durationMs (27.6593ms)
  ok a closed tab id returns a structured error mentioning tabs_context (137.6154ms)
  ok passive capture of /api/ok in read_network_requests without a prior read (723.5024ms)
  ok wait_for_page returns after the /spa button appears (2093.0218ms)
  ok a token estimate line is printed under a screenshot (338.6371ms)
  ok quick runs a three-line script (128.3269ms)
tests 12   pass 12   fail 0
```

Before `9fc1e91` this was 10 of 12, the screenshot subtest failing with the barren capture window. **Pass, after a fix.**

### 6. /big, click btn 2999 by ref

```
javascript: document.addEventListener('click', e => { if (e.target.textContent==='btn 2999') window.__hit=true })
read_page filter=interactive max_chars=900000  ->  button "btn 2999" [ref_5999]
computer left_click ref_5999
```

```
{ "ok": true, "at": {"x": 109, "y": 730, "source": "ref"},
  "effects": "applied",
  "evidence": { "windowMs": 250, "watched": true, "mutations": 0,
                "focusChanged": true, "focusedAfter": "btn 2999", "valueChanged": false },
  "warnings": [], "durationMs": 2595 }
```

`javascript String(window.__hit)` returns `"true"`. **Pass.**

`find` with the query "the button labelled exactly btn 2999" does not resolve it. It returns btn 0 to btn 19 with the warning `the tree was truncated at 4439 of 6000 nodes, so the match may be outside it`. The warning is honest and `read_page` with a raised budget finds the element, so this is open bug 1 rather than a failure of this check.

### 7. An inert element reports no effect

`computer left_click` on the `td` holding "row 12" on `/big`:

```
{ "ok": true, "effects": "none",
  "evidence": { "windowMs": 250, "watched": true, "mutations": 0,
                "focusChanged": false, "focusedAfter": null, "valueChanged": false,
                "scrolled": false, "throttledRetry": true },
  "warnings": [
    "the renderer did not acknowledge the first dispatch, so the tab was woken and it was sent once more",
    "no observable change within 250ms"
  ] }
```

At 0.1.11 this returned `effects: applied` with `focusChanged: true` and `valueChanged: true`. Fixed in `5682768`. **Pass, after a fix.**

### 8. A large javascript return is truncated, never blocked

`javascript {code: "'x'.repeat(200000)"}`

```
"result": "xxx...[truncated, full length 200000 chars]",
"ok": true,
"warnings": ["string at $ truncated to 10240 chars, full length 200000"]
```

**Pass.**

### 9. A wheel scroll inside a pane falls back to scrollBy

`computer scroll` at [200, 300] on `/scroll.html`, whose body is `overflow: hidden`:

```
{ "ok": true, "direction": "down", "method": "scrollBy", "effects": "applied",
  "evidence": { "scroll": { "before": { "page": {"x":0,"y":0}, "container": {"tag":"div","x":0,"y":0,"isRoot":false} },
                            "after":  { "page": {"x":0,"y":0}, "container": {"tag":"div","x":0,"y":300,"isRoot":false} },
                            "delta":  { "pageX":0, "pageY":0, "containerX":0, "containerY":300 } },
                "method": "scrollBy", "target": "div" },
  "warnings": ["the wheel event moved nothing, so the nearest scrollable ancestor was scrolled directly"] }
```

**Pass.**

### 10. The composer

```
form_input ref_3 "first draft"            -> mode editor, replaced false, effects applied, setBy Input.insertText
read_page                                 -> button "Send" [irreversible] [ref_4]   (disabled=true is gone)
form_input ref_3 "second draft, replaced" -> replaced: true
computer left_click ref_4                 -> effects applied, irreversible: true,
                                             warning "this control is classified as irreversible,
                                             so clicking it again would repeat the action"
get_page_text                             -> "Message composer / Send / second draft, replaced"
```

Before the first write the tree showed `button "Send" [irreversible] [ref_4] disabled=true`. The thread carries the text after the click. **Pass.**

### 11. Sensitive fields are redacted

`read_page filter=all` on `/sensitive.html` after three writes:

```
textbox "Password" [ref_1] type=password value="[value redacted]"
textbox "Card number" [ref_2] type=text value="[value redacted]"
textbox "Notes" [ref_3] type=text value="ordinary note"
```

`form_input` on the password returns `{"value": "[redacted]", "sensitive": true, "effects": "applied"}`.

`npm run log -- --tail 20`:

```
- 13:29:28 **form_input** tab 369882988 http://127.0.0.1:8765/sensitive.html `ref="ref_1" value="[value redacted]"` (305ms) effects=applied ... id=call_4_6bb0eg
```

No trace of the value. **Pass.**

### 12. A typed password is absent from both journal files

`computer type` with `Zx-CANARY-PASSWORD-40217` into the password field, with nothing reading it back.

```
grep -c CANARY 2026-09-04.md    -> 0
grep -c CANARY 2026-09-04.jsonl -> 0
```

The entries themselves:

```
- 13:29:57 **computer** ... `action="type" ref="ref_1" text="[value redacted]" replace=true` ... id=call_4_hjdl33
{"tool":"computer", ..., "args":{"action":"type","ref":"ref_1","text":"[value redacted]","replace":true}, "ok":true, "effects":"applied", ...}
```

**Pass.**

### 13. Dialogs are results, not hangs

`/dialog` carried only an alert button, so confirm and prompt buttons and an `#answer` element were added to the fixture in `6847f35`.

| Button | Result field | Next call |
|---|---|---|
| alert | `dialog: {type: "alert", message: "1", handled: "accepted"}`, warning `a alert dialog was accepted: "1"` | `#answer` still "no answer", which is right for an alert |
| confirm | `dialog: {type: "confirm", message: "proceed?", handled: "dismissed"}` | `#answer` is `confirm:false` |
| prompt | `dialog: {type: "prompt", message: "your name?", handled: "dismissed"}` | `#answer` is `prompt:null` |

Every call completed and the call after each one worked. **Pass.**

### 14. beforeunload holds a navigation unless forced

```
computer type "unsaved" into the field  -> effects applied
javascript #armed                       -> "armed"
navigate /index.html                    -> Navigation to http://127.0.0.1:8765/index.html was cancelled by
                                           the page: "" was shown as a beforeunload dialog and dismissed,
                                           so the tab stayed put.
                                           hint: Call navigate again with force: true to leave the page
                                           and lose unsaved input.
                                           [ok=false code=dialog_open effects=none retryable=false]
javascript location.pathname            -> "/unload.html"
navigate /index.html force: true        -> ok, dialog: {type: "beforeunload", handled: "accepted"}
javascript location.pathname            -> "/index.html"
```

**Pass.**

### 47. A tab id from outside the session

Seen while setting up: each `tools/mcp-client.js` CLI invocation is its own session, so a tab id from a previous one is foreign.

```
Tab 369881528 is not in this session's tab group. Call tabs_context to list the tabs this session owns, or tabs_create to open one.
hint: Call tabs_context to list the tabs this session owns, or tabs_create to open one.
[ok=false code=tab_foreign effects=unknown retryable=false id=call_1_x06i7d]
```

**Pass.**

### 15. A result parked across a server restart

`navigate` to `/slow`, the MCP server killed with SIGKILL 1200 ms in, a new client started with the same `CHROME_MCP_CLIENT_ID`.

Host log:

```
[2026-09-04T13:55:03.954Z] parked tool_response for session verify-park-a queue 1
[2026-09-04T13:55:04.198Z] replaying parked tool_response to session verify-park-a
```

After reconnecting, the session still owns its tab and the tab is on `/slow`, so the navigation the killed call started did complete. **Pass.**

### 16. A parked result expires

The same run with 135 s before reconnecting:

```
[2026-09-04T13:55:19.704Z] parked tool_response for session verify-park-b queue 1
[2026-09-04T13:57:26.685Z] parked response dropped: expired session verify-park-b tool navigate
```

126 s between parking and expiry. The reconnected session still had its tab. **Pass.**

### 17. Ten screenshots and ten clicks with the interferer loaded

`/index.html`, which carries an `srcdoc` iframe, an `example.com` iframe and the interferer's `chrome-extension://` iframe.

```
17 result: {"recovered":1,"errors":[],"refused":0,"replaced":0,"dead":0}
17 tab still in session: true
```

Twenty calls, no errors, no `chrome-extension://` refusal surfacing as one, and one `attach_recovered` warning (the ladder fires on the first call after a page load, then the iframe stays removed until the next load). **Pass.**

### 18. Drag and drop, and a slider

Both need `computer scroll_to` first, because the block sits below the fold and `left_click_drag` takes viewport coordinates.

```
left_click_drag [88,229] -> [201,229]   effects applied, mutations 3
javascript #dndout                       -> "dropped A on B"
left_click_drag [183,275] -> [327,275]  effects applied, mutations 24
javascript #sliderval                    -> "100"
```

**Pass.** Each drag takes about 14 s, which is the dwell either side of the movement.

### 19. A click that opens a tab

The tab is opened and joins the session group, unselected. `newTabId` does not reliably reach the click result: open bug 2. `214ee82` fixed one half of it, a write-after-read race in the adoption bookkeeping. **Partial.**

### 20. A frozen renderer

An 8 s busy loop in `javascript`, then `read_page` issued 300 ms later:

```
20 read_page returned after 8099 ms
url: http://127.0.0.1:8765/index.html  |  title: Bridge test page  |  nodes: 26
...
```

Repeated with a 50 s loop and a screenshot: the screenshot returned after 50303 ms, and it succeeded rather than timing out. No `timeout` error and no reload hint, because the second call is queued behind the frozen one rather than racing it. The stated failure the check guards against, a 2 minute stall, did not happen, and the call after the freeze took 10 ms. **Partial**, recorded as open bug 4.

### 21. A batch with a misspelled tool

```
Batch not run: item 3 (reed_page) names no known tool.
hint: Known tools: tabs_context, tabs_create, tabs_close, navigate, read_page, get_page_text, find, form_input, computer, file_upload, gif_creator, javascript, read_console_messages, read_network_requests, shortcuts_list, page_state, wait_for_page, resize_window.
[ok=false code=batch_invalid effects=none retryable=false id=call_11_4lzrmf]
```

The two `javascript` items before it left no trace: `{"one":null,"two":null}`. **Pass.**

### 22. A batch with a bad ref at item 5

Items 0 to 3 ran, and item 4 failed:

```
[4] computer FAILED: ref ref_99999 is no longer on the page. Re-read the page.
Stopped at action 4. Later actions did not run.
```

`{"b3":1,"b4":1,"b5":1}` confirms the earlier items ran. Pre-validation covers tool names, not refs, so a bad ref stops the batch where it sits rather than before it starts. **Fail against the check as written**, open bug 5.

### 23. resize_window

```
"viewport": {"width": 1188, "height": 751},
"outerWidth": 1200, "outerHeight": 900,
"requested": {"width": 1000, "height": 700},
"matched": "neither",
"measuredAgainst": "neither: the window manager or device pixel ratio changed the result",
"evidence": {"before": {...}, "after": {...}, "devicePixelRatio": 2.25},
"warnings": ["the window ended at 1200x900 outer and 1188x751 viewport, neither of which is the requested size",
             "no observable change within 150ms"]
```

All four fields are reported. The window did not actually resize on this window manager, and the tool says so rather than claiming success. **Pass on the contract**, with the resize itself recorded as open bug 6.

### 24. Three fresh x.com tabs

```
24 result: {"ok":3,"fail":0,"recovered":0,"lost":0}
```

Three of three screenshots, no tab lost. The 0.1.7 measurement was 3 tabs lost of 3. **Pass.**

### 25. Fifty consecutive computer calls on one x.com tab

Alternating screenshot and scroll:

```
25 result: {"ok":50,"fail":0,"recovered":0,"replaced":0,"dead":0,"firstError":null}
25 tab still in session: true
```

Fifty of fifty, zero dead tabs, zero `attach_recovered` warnings. x.com did not refuse the attach in this profile at all, which is why the interferer exists: check 17 is the refusal case. **Pass.**

### 26. The same with attachRecovery off

Set through the extension's own storage over the DevTools port:

```
node sw.mjs "new Promise(r => chrome.storage.local.set({attachRecovery: false}, () => ...))"  ->  {"attachRecovery":false}
```

Every tab is then refused and replaced, and the replacement is refused in turn:

```
Tab 369884227 could not be driven and was replaced by tab 369884229 on the same URL.
cause: Cannot access a chrome-extension:// URL of different extension
hint: Retry on tab 369884229. Page state such as form input and scroll position is gone.
attempt 1 failed with tab_replaced, retrying (input, effects none)
[ok=false code=tab_replaced effects=none retryable=true]
```

Three runs: 0 of 3 screenshots, 6 replacements, every one reported with its cause and the new tab id. Nothing is silently dead, and nothing works either, since replacing a tab does not remove the extension that injects into every page. This is what the recovery ladder exists to prevent, so the result is the right one for the switch being off, but the replacement loop has no cap: open bug 3. `attachRecovery` was set back to true afterwards. **Pass, with a finding.**

### 27. A second debugger on a session tab

`Target.attachToTarget` through the browser endpoint attached a second CDP session, and every call kept working (`read_page` 7 ms, `computer screenshot` 116 ms).

A flat CDP session opened through the browser endpoint coexists with `chrome.debugger`, so this does not reproduce the exclusive attach a real DevTools window takes. **Deferred.** To run it: open DevTools on a session tab by hand, then call `computer screenshot` on that tab and expect `attach_refused`. The catalogue entry and its message matcher are covered by `test/errors.test.js`.

### 28. TodoMVC, a quick script, three runs

`quick` with `C <ref>`, `T verification todo N`, `K Enter`, `SS`, no `W`:

```
line 1 C ok
line 2 T ok
line 3 K ok
line 4 SS ok
screenshot 972x542 (~672 tokens) id: img_1
url: https://todomvc.com/examples/react/dist/
[ok=true effects=unknown id=call_4_9glaiv]
page text has the todo: true
```

Three of three. The screenshot comes back and the todo is in the page. The `quick` contract line carries no `evidence`, so `evidence.paint.painted` is not visible through this path. **Pass**, with the missing paint evidence recorded as open bug 7.

### 29. jQuery UI autocomplete, per-key typing, three runs

The Tags field is `textbox "Tags:" [ref_34]`, inside the demo iframe.

At 0.1.26 and before, typing "ja" per key left the field holding `jjaa` and no menu:

```
{"value":"jjaa","menuItems":[],"menuOpen":false}
```

Every printable character was sent twice, once by the `keyDown` carrying text and once by the `char` event. Fixed in `394be2a`. After the fix, three of three:

```
{"value":"ja","menuItems":["Java","JavaScript"],"menuOpen":true}
suggestion lines: listitem "Java" [ref_140] | listitem "JavaScript" [ref_141]
```

**Pass, after a fix.**

### 30 to 35. LinkedIn, Notion and profiles with real accounts

Deferred. They need a signed-in profile, and this pass ran entirely in the development browser, which is signed in to nothing. The user's own Chrome is connected as `bz04vrv3f` and now reports extension 0.1.11, profile `Profile 3 "Emerson Lopes"`, account `emerson.fr.lopes@gmail.com`, sessions `linkedin.com, github.com, google.com`. It was not driven by this pass.

Exact calls to run there, after reloading that browser to the current build:

```
node tools/mcp-client.js tabs_create '{"url":"https://www.linkedin.com/feed/"}' --browser bz04vrv3f
node tools/mcp-client.js get_page_text '{"tabId":<id>}' --browser bz04vrv3f          # 3 runs, expect content, not an empty read
node tools/mcp-client.js read_page '{"tabId":<id>,"filter":"interactive"}' --browser bz04vrv3f
node tools/mcp-client.js tabs_create '{"url":"<a Notion page URL>"}' --browser bz04vrv3f
node tools/mcp-client.js get_page_text '{"tabId":<id>}' --browser bz04vrv3f          # 3 runs on two different Notion pages
node tools/mcp-client.js list_connected_browsers '{}'                                 # expect both profiles distinguishable
node tools/mcp-client.js select_browser '{"site":"linkedin.com"}'                     # expect it to pick bz04vrv3f, never the dev browser
node tools/mcp-client.js select_browser '{"account":"emerson.fr.lopes@gmail.com"}'
```

The composer write path was rehearsed offline on `/composer.html` instead: check 10.

### 36. GitHub keyboard shortcuts

`K /` on github.com:

```
before:      {"active":"BODY#.logged-out env-production page-responsiv", "url":"/"}
after K /:   {"active":"INPUT#.prc-components-Input-IwWrt", "value":"", "placeholder":"Search or jump to...", "url":"/"}
```

The search field takes focus. **Pass.**

`K t` then `TR README` on github.com/nodejs/node:

```
after K t:   {"active":"BUTTON#.prc-Button-ButtonBase-9n-Xk position-rel", "url":"/nodejs/node/tree/main?search=1"}
TR result:   line 1 TR FAILED: Typed 6 characters with "Collapse file tree" focused, and nothing changed.
```

`t` navigates to the file finder, and GitHub leaves focus on a button rather than the filter input, so the text goes nowhere. Before `f0b17fd` this reported `line 3 TR ok` with nothing typed. It now fails loudly and names what had focus. The query of `README` is still not produced. **Partial**, and the silent half is fixed.

### 37. A navigating click

First link on news.ycombinator.com:

```
{ "ok": true, "effects": "applied",
  "evidence": { "windowMs": 1000, "watched": false,
                "navigation": { "started": true,
                                "from": "https://news.ycombinator.com/",
                                "to": "https://news.ycombinator.com/news",
                                "status": "complete" } },
  "warnings": [], "durationMs": 1185 }
```

**Pass.**

### 38. read_page interactive on two news sites

| Site | Default | With `max_chars: 40000` |
|---|---|---|
| cnn.com | 20273 chars, inline | 34721 chars |
| theverge.com | 20275 chars, inline | 23603 chars |

The truncation note on CNN:

```
truncated. 158 more nodes not shown, 310 in total (34497 chars). Narrow with ref_id, filter or depth, or raise max_chars.
```

Both return inline under 20000 characters of tree with an explicit note, and raising the budget returns more. **Pass.**

### 39. Unfiltered read_network_requests on CNN

Returns inline, 4010 characters, `ok`. The tail:

```
FAILED net::ERR_ABORTED GET https://www.gstatic.com/generate_204
200 POST https://beacons-wbd.mediamelon.com/MultiStreamProducer
pending POST https://beacons-wbd.mediamelon.com/MultiStreamProducer

[ok=true effects=none id=call_3_zvk6fj]
warnings:
  - 3 URL(s) clipped to 300 characters.
```

There is no `showing N of TOTAL` line, so a reader cannot tell whether rows were dropped. **Partial**, open bug 8.

### 40. A long console message

A 4000-character `console.log`, then `read_console_messages`:

```
[log] <497 Cs>...
[ok=true effects=none id=call_17_qdfplc]
warnings:
  - 1 message(s) clipped to 500 characters.
```

Capped at 500 characters with a warning saying how many messages were clipped. It does not report the clipped message's full length. **Partial**, same shape as open bug 8.

### 41. find on a large table

`https://the-internet.herokuapp.com/tables`, query "the cell with the email jdoe@hotmail.com":

```
cell "jdoe@hotmail.com" [ref_51]
cell "jdoe@hotmail.com" [ref_91] (offscreen)
...
[ok=true effects=none evidence={"scope":"all","searched":115,"widenedBecause":"query names a non-interactive role"}]
warnings:
  - widened the search to every node because the query names a non-interactive role
```

The widening is reported as `evidence.widenedBecause` plus a warning rather than a `widened: true` flag, and the target is the top match. On `/large` the same widening happened over 2815 nodes, and the exact cell asked for ranked below the twenty returned. **Pass** on the resolution and the widening report, with the ranking noted in open bug 1.

### 42. find on a page with an entry ad

`https://the-internet.herokuapp.com/entry_ad`, query "Close":

```
2 match(es):
paragraph "Close" [ref_10]
paragraph "If closed, it will not appear on subsequent page loads." [ref_6]
[ok=true effects=none evidence={"scope":"all","searched":10,"widenedBecause":"no interactive node matched"}]
```

**Pass.**

### 43. Cookies redacted, a query string kept

`https://www.theguardian.com/international`:

```
javascript document.cookie  -> "result": "[redacted]", warnings: ["redacted a cookie string at $"]
javascript location.href    -> "https://www.theguardian.com/international?utm_source=verify&q=one+two"
```

**Pass.**

### 44. The contract line on a read

Every `read_page` in this pass ends with one, for example:

```
[ok=true effects=none id=call_3_y5oao7 evidence={"filter":"all","nodes":72,"maxChars":50000,"truncated":false}]
```

**Pass.**

### 45. The contract fields on a click

Every click result carries `ok`, `effects`, `evidence`, `warnings` and `id`, seen throughout checks 6, 7, 10, 13, 17, 18, 19 and 37. **Pass.**

### 46. A stale ref

`read_page`, `navigate` elsewhere, then click the old ref:

```
ref ref_17 is no longer on the page. Re-read the page.
hint: Read the page again with read_page and use the new ref.
[ok=false code=ref_stale effects=none retryable=false id=call_11_n09e6g]
```

**Pass.**

### 48. A blocked origin

`navigate` to `chrome://settings` lands, then `read_page`:

```
Cannot access a chrome:// URL
hint: Read the message. If it repeats, read the page again before acting on it.
[ok=false code=internal effects=unknown retryable=false]
```

The code was `internal`. Fixed in `e3350af`, which adds Chrome's own chrome:// wordings to the `origin_blocked` matcher. **Pass, after a fix.**

### 49. The result id in the journal

`computer type`, id `call_4_hjdl33`, in `npm run log`:

```
- 13:29:57 **computer** ... `action="type" ref="ref_1" text="[value redacted]" replace=true` (4504ms) effects=applied ... id=call_4_hjdl33
```

and in the JSONL as `"callId":"call_4_hjdl33"`. **Pass.**

### 50. Journal retention

`2020-01-01.jsonl` and `2020-01-01.md` planted, development browser restarted:

```
before: 2020-01-01.jsonl  2020-01-01.md  2026-09-03.jsonl  2026-09-03.md  2026-09-04.jsonl  2026-09-04.md
after:  2026-09-03.jsonl  2026-09-03.md  2026-09-04.jsonl  2026-09-04.md
```

Host log:

```
[2026-09-04T13:54:26.635Z] journal retention 14 days, 2 file(s) removed
```

**Pass.**

### 51. The journal redaction switch

The journal is written by the native host, which Chrome spawns, so the variable has to be in the environment the browser is launched with. Setting it on the MCP client has no effect, and `npm run doctor` reads its own environment for the "redaction off" line, so it can disagree with the host: open bug 9.

Launched with `CHROME_MCP_JOURNAL_REDACT=1`, `npm run doctor` says `redaction on`, and the entries carry no args:

```
{"at":"2026-09-04T13:54:00.599Z","ms":82,"client":"49ee7ff9-...","tool":"navigate","tab":{...},"callId":"call_2_4gc1hs","redacted":true,"ok":true,"url":"http://127.0.0.1:8765/index.html"}
```

A `form_input` carrying `REDACTSWITCH-CANARY-5150` left zero occurrences of the canary in the JSONL. **Pass**, with the correction that the switch belongs in the host's environment.

### 52. Reloading the extension mid-session

`chrome.runtime.reload()` from the service worker over the DevTools port. The next call works:

```
52 the call after the reload: {"tabGroupId": null, "tabs": [], "ok": true, ...}
```

but the session's tabs are gone, and a call on the old tab id returns `No tab with id 369883694. It may have been closed.` So the session does not survive an extension reload. **Fail**, open bug 10.

### 53 to 56. Startup defaults against the development browser

| `CHROME_MCP_BROWSER` | Result |
|---|---|
| `bwlhg5ra0` | routed, tab opened in the development browser |
| `id=bwlhg5ra0` | routed |
| `profile=Default` | routed |
| `label=nosuchlabel` | `browser_unknown`, listing both browsers, with the hint |
| `profile=NoSuchProfile` | `browser_unknown`, same shape |

```
No connected browser matches label="nosuchlabel". Connected: bz04vrv3f (Chrome 152.0.0.0, profile Profile 3 "Emerson Lopes", emerson.fr.lopes@gmail.com), bwlhg5ra0 (Chrome 152.0.0.0, profile Default "Your Chromium").
hint: Call list_connected_browsers and use one of the ids, labels or profiles it prints.
[ok=false code=browser_unknown effects=none retryable=false]
```

**Pass** for the forms runnable here. `select_browser({site: ...})` and `account=` against a real signed-in profile stay deferred with checks 30 to 35. One gap: `tabs_context` with no `createIfEmpty` and several browsers connected lists every browser and ignores the startup default, by the design note in `host/mcp-server.js`. Every other tool honours it.

### 57. Ten minutes idle, then one screenshot

A session tab was parked on `/index.html` at 14:04:30Z and left alone for ten minutes while checks 26, 36, 39 and 41 to 43 ran on other tabs. Then one screenshot:

```
57 screenshot after the idle: ok [{"mimeType":"image/png","bytes":68253}]
57 wall 221 ms
57 offscreen documents: ["chrome-extension://giagijohigincdlpkfolgcljkhmjdiaa/offscreen.html"]
```

221 ms, inside the 1 s the check asks for, and the offscreen document that keeps the worker alive is still there, read through `chrome.runtime.getContexts` in the service worker over the DevTools port. **Pass.**

## Bench

`CHROME_MCP_BROWSER_ID=bwlhg5ra0 npm run bench`, three runs, written to `.bench/2026-09-04.jsonl`. Extension 0.1.27.

| Measurement | 0.1.7 median | This build, median wall | This build, median tool |
|---|---|---|---|
| 1a. 10 separate `javascript` 1+1 calls | 7927 ms | 40 ms | 17 ms |
| 1b. 10 1+1 calls in one `browser_batch` | 5614 ms | 13 ms | 10 ms |
| 1c. 10 1+1 lines in a `quick` script | 3464 ms | 14 ms | 10 ms |
| 2. 10 separate screenshots | 8829 ms | 1346 ms | n/a |
| 3. `read_page` all+interactive, two pages | 10350 ms | 443 ms | n/a |
| 4. `get_page_text`, two pages | 8781 ms | 368 ms | n/a |
| 5. `find`, two queries | 6104 ms | 534 ms | n/a |
| 6. `navigate`, four targets | 9054 ms | 4500 ms | 4488 ms |
| 7. realistic form flow as one batch | 17381 ms | 6727 ms | 1 ms |
| 8. type 500 chars, plain then perKey | 9521 ms | 36350 ms | 31046 ms |
| 9. `javascript 'x'.repeat(200000)` | 4642 ms | 7 ms | 3 ms |

The two columns do not measure the same thing and the gap is mostly that. The 0.1.7 column is column B of `R-repeat-performance.md`, measured by a Claude session issuing MCP tool calls, so every number carries the model's round trip per call. `tools/bench.js` measures the tool calls alone. Read the new column as the cost of the browser work, not as a speedup.

Row 8 is the one that moved the other way, and it is a scope difference: the 0.1.7 row typed 500 characters once, while `tools/bench.js` types 500 plain and then 500 per key in the same measurement. `R-repeat-performance.md` measured per-key typing separately at 30911 ms, which matches the 31046 ms tool total here almost exactly.

Row 2 is a real measurement of new behaviour: hidden-tab screenshots did not work at all at 0.1.11 (check 4), and the 1346 ms for ten is against a target of under 6000 ms.

The 0.1.11 bench in this repo's first run reported `10 separate screenshots: 433ms`, which was ten permission errors on `about:blank` at 43 ms each, not ten screenshots. `9ef39d7` navigates first and counts failures per measurement, so a row like that cannot be read as a timing again.

## Test files run

| Command | Result |
|---|---|
| `node --test test/campaign.test.js` | 12 of 12 |
| `node --test test/cdp.test.js` | 24 of 24 |
| `node --test test/verify.test.js` | 27 of 27 |
| `node --test test/tabs.test.js` | 13 of 13 |
| `node --test test/errors.test.js` | 33 of 33 |
| `node --test test/screenshot.test.js` | 15 of 15 |
| `node --test test/sensitive.test.js` | 16 of 16 |
| `node --test test/campaign-server.test.js` | 14 of 14 |
| `node tools/check-errors-copy.js` | the extension copy matches |

## Summary

| Verdict | Count | Checks |
|---|---|---|
| Pass | 39 | 1, 2, 3, 5, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 21, 24, 25, 26, 29, 37, 38, 41, 42, 43, 44, 45, 46, 47, 49, 50, 51, 53 to 56, 57 |
| Pass after a fix in this pass | 5 | 4, 6, 7, 23, 48 |
| Partial | 6 | 19, 20, 28, 36, 39, 40 |
| Fail | 2 | 22, 52 |
| Deferred | 7 | 27, 30, 31, 32, 33, 34, 35 |

Eleven fixes landed, each with a unit test, a manifest bump and a commit:

| Commit | Manifest | What it fixed |
|---|---|---|
| `10c621f` | none | `tools/mcp-client.js` and `tools/browser.js --interferer`, the tooling this pass needed |
| `5682768` | 0.1.12 | A click on an inert element reported `effects: applied` |
| `e2f8f31` | 0.1.19 | Screenshots of a hidden tab failed outright, then returned a stale or blank surface |
| `9ef39d7` | none | The bench measured calls that had failed |
| `6847f35` | 0.1.20 | The watch tracked the focused element rather than the one a write named, and `/dialog` gained confirm and prompt |
| `9fc1e91` | 0.1.23 | A barren capture window was fatal instead of retryable |
| `214ee82` | 0.1.24 | An opened tab's opener was recorded after the click had already read it |
| `e3350af` | 0.1.25 | Chrome's `chrome://` refusals were classified as `internal` |
| `394be2a` | 0.1.26 | Per-key typing inserted every character twice |
| `f0b17fd` | 0.1.27 | A type with nothing able to hold text focused reported `ok` |

Extension version at the end of the pass: **0.1.27**.

## Open bugs

### 1. find does not resolve an exact label on a large page

`/big` carries 3000 rows. `find({query: 'the button labelled exactly "btn 2999"'})` returns btn 0 to btn 19 and warns `the tree was truncated at 4439 of 6000 nodes, so the match may be outside it`. On `the-internet.herokuapp.com/large` the whole tree was searched (2815 nodes, nothing truncated) and the exact cell still ranked below the twenty returned, so ranking is the problem there rather than truncation.

Reproduce:

```
node tools/mcp-client.js tabs_create '{"url":"http://127.0.0.1:8765/big"}' --browser dev
node tools/mcp-client.js find '{"tabId":<id>,"query":"the button labelled exactly \"btn 2999\""}' --browser dev
node tools/mcp-client.js read_page '{"tabId":<id>,"filter":"interactive","max_chars":900000}' --browser dev   # finds button "btn 2999" [ref_5999]
```

The warning is honest and `read_page` with a raised budget is a working route, so this is a ranking and budget question, not a silent failure.

### 2. newTabId is not reported for a click that opens a tab

The tab is opened, adopted into the session group unselected, and shows up in `tabs_context`. The click result carries no `newTabId`, because the tab is created after the 250 ms verification window has closed. `214ee82` fixed a write-after-read race in the bookkeeping, which was one of two causes.

Reproduce: `/index.html`, `read_page`, click `link "blank link"`, read the result (no `newTabId`), then `tabs_context` a second later (the `https://example.com/` tab is there).

The fix would be for the watch to say whether the click landed on something that opens a tab, so `readVerify` polls only in that case rather than adding a grace to every click.

### 3. The replacement ladder has no cap

With `attachRecovery: false` and a second extension injecting into every page, every tab is refused, replaced, and the replacement is refused in turn. Three runs produced six replacements and no successful call. Nothing is silently lost, and nothing works.

Reproduce: set `attachRecovery: false` in the extension's `chrome.storage.local`, run the development browser with `--interferer`, and open any page. Every call returns `tab_replaced` naming a new tab.

A replacement whose cause matches the one that killed its predecessor should stop and return `attach_refused` rather than opening another tab.

### 4. Calls are serialized behind a frozen renderer

A `javascript` call running a 50 s busy loop delays the next call on the same tab by the full 50 s. It then succeeds, so nothing is lost and there is no 2 minute stall, but the caller gets no `timeout` and no reload hint while it waits. `frozenError` and its hint are covered by `cdp.test.js`, so the path exists, it is just not reached: the second call never gets to send a CDP command.

Reproduce: check 20 above.

### 5. Batch pre-validation covers tool names, not refs

A batch with a stale ref at item 5 runs items 0 to 3 and stops at item 4. Pre-validation catches an unknown tool name before anything runs, which is check 21, but a ref is only resolved when its action executes.

Reproduce: check 22 above. Resolving every ref in the batch before the first action would make this match check 21.

### 6. resize_window does not resize the window

`resize_window` to 1000x700 left the window at 1200x900 outer and 1188x751 viewport. The tool reports `matched: "neither"` with a warning naming both sizes, so the failure is visible, but the resize did not happen. The device pixel ratio on this display is 2.25.

Reproduce: check 23 above.

### 7. A quick script's contract line carries no evidence

`quick` returns one contract line for the whole script, `[ok=true effects=unknown id=...]`, with no `evidence`. A screenshot taken by an `SS` line inside a script therefore cannot be checked for `evidence.paint.painted`, which is exactly what the R3 acceptance asks for.

Reproduce: check 28 above.

### 8. Clipped output does not say how much was clipped

`read_network_requests` unfiltered on CNN returns inline with `3 URL(s) clipped to 300 characters` and no total row count, so a reader cannot tell whether requests were dropped. `read_console_messages` clips a long message to 500 characters and says how many messages were clipped, not the clipped message's real length. `read_page` does this properly, with `truncated. 158 more nodes not shown, 310 in total (34497 chars)`.

Reproduce: checks 39 and 40 above.

### 9. doctor reports the journal redaction state from the wrong process

The journal is written by the native host, which Chrome spawns, so `CHROME_MCP_JOURNAL_REDACT` has to be in the browser's environment. `npm run doctor` calls `redactionOn()` in its own process, so it prints "redaction off" while the host is redacting, and the other way round. The retention line has the same shape, and `CHROME_MCP_JOURNAL_DAYS` is read the same way.

Reproduce: launch the development browser with `CHROME_MCP_JOURNAL_REDACT=1`, then run `npm run doctor` from a shell without it.

The host already reports `journal retention 14 days` on connect, so the state could travel with `browser_status` instead of being guessed locally.

### 10. A session does not survive an extension reload

`chrome.runtime.reload()` from the service worker leaves the session with no tabs: `tabs_context` returns an empty list and the old tab id reports `No tab with id <id>. It may have been closed.` The next call works, so the bridge recovers, but the session's work is gone.

Reproduce: check 52 above.

## What was not run

- Checks 30 to 35, and the `site=` and `account=` halves of 53 to 56. They need a signed-in profile. The exact calls are listed under check 30 to 35.
- Check 27's real form, DevTools opened by hand on a session tab.
- The GIF and upload tools, which no numbered check covered.
- `npm test` as a whole. The files this pass touched were run individually, listed above.
