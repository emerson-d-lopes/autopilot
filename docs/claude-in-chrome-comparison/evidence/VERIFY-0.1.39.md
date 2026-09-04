# Live verification of the bugs3 merge and the fourth pass fixes

Branch `plan/integration2`, extension 0.1.39. Run 2026-09-04. This is the fifth live pass. The four before it are [VERIFY-0.1.11.md](VERIFY-0.1.11.md), [VERIFY-0.1.28.md](VERIFY-0.1.28.md), [VERIFY-0.1.31.md](VERIFY-0.1.31.md) and [VERIFY-0.1.34.md](VERIFY-0.1.34.md).

Two sets of fixes are under test. The five from `plan/bugs3` close what the 0.1.35 checks on the user's Chrome opened, and the three on `plan/integration2` close what the fourth pass opened. None of the eight had been driven against a browser before this pass.

## How this pass was driven

Same method as the four earlier passes. Every call went through `tools/mcp-client.js`, which spawns `host/mcp-server.js` from this working tree, so the code under test is the code on disk. This session's own `mcp__chrome-mcp__*` tools were never used.

```
node tools/mcp-client.js <tool> '<json args>' [--browser dev]
```

Most checks ran as a script holding one client open across a group of calls, with `CHROME_MCP_CLIENT_ID` pinned so a restart resumes the same session and its tabs. Calls that need extension internals went through the DevTools port on 9333, to the service worker target, the way `test/shortcuts.test.js` does.

The browser is Chrome for Testing 152.0.7977.75, launched by `node tools/browser.js --interferer --detach` after killing the one already running so the script cache was dropped. Registry id `bwlhg5ra0`, profile `Default "Your Chromium"`, signed in to nothing. The interferer extension mounts a `chrome-extension://` iframe into every page, so `attach_recovered` and `attach_refused` appear in several results below.

The fixture server is `node test/fixtures/campaign/server.js 8765`.

`npm run doctor` at the start of the pass:

```
  ok   Chrome extension is attached
         extension v0.1.39, 19 handlers, 26 tools advertised
         profile Default "Your Chromium"  account not signed in  label none  local true  dev true
         sessions none detected
```

Nothing in this pass activated a tab or focused a window. The user's own Chrome is connected as `bz04vrv3f` and was never driven. `chrome.runtime.reload()` was not used: on this Chrome it disables an unpacked extension.

The worker is stopped two ways below. The Stop button on `chrome://serviceworker-internals` is pressed with a trusted click through `Input.dispatchMouseEvent` on that page's CDP target, since `element.click()` does not reach the WebUI handler, and the page is opened in a background tab through the extension's own `chrome.tabs.create({active: false})`. The other way is `Target.closeTarget` on the worker target through the browser endpoint. Both are proved to have restarted the worker rather than left it running: the DevTools target id changes, and a marker set on `globalThis` before the stop is gone afterwards.

The notification checks replace `chrome.notifications` on the worker with a recorder that holds the created notifications and the listeners the extension registers on it. `installNotificationListeners` re-registers whenever the API object has changed, which is what makes this possible without touching the code under test. Clicks are then fired into the listener the extension itself installed, at controlled times. `confirmNotifications: true` and `mode: confirm` were written into `chrome.storage.local` for those checks and put back afterwards, which check 8 records.

## Session restore across a worker restart

### 1. Two tabs, the worker stopped from chrome://serviceworker-internals

```
1a. tabs 369888843 369888844 in group 133870667, tabs_context lists 2
1a. page targets before: ["http://127.0.0.1:8765/index.html","http://127.0.0.1:8765/composer.html", ...]
1b. worker target id before: 744E441086F31C6E4C7E04382D8716A3  marker set
1b. Stop pressed: {"ok":true,"statusBefore":"Running Status:\n        RUNNING","x":66,"y":275}
  t+5s worker id none
  t+10s worker id none
  t+15s worker id none
  t+20s worker id 3E90CA765F84121553A96293D6E33D3E (new)
  t+25s worker id 3E90CA765F84121553A96293D6E33D3E (new)
1b. worker restarted: true  marker now: gone
```

The worker was gone for about 20 s and came back as a different target with no `globalThis` state. `tabs_context` after that:

```
1c. tabs_context after (10 ms):
{
  "tabGroupId": 133870667,
  "groupTitle": "chrome-mcp",
  "tabs": [
    {"tabId": 369888843, "url": "http://127.0.0.1:8765/composer.html", "title": "composer", "active": false, "status": "complete", "windowId": 369888571},
    {"tabId": 369888844, "url": "http://127.0.0.1:8765/index.html", "title": "Bridge test page", "active": false, "status": "complete", "windowId": 369888571}
  ],
  "warnings": [], "durationMs": 3, "ok": true, "effects": "none"
}

1d. read_page on tab 369888843 (78 ms):
url: http://127.0.0.1:8765/composer.html  |  title: composer  |  nodes: 5

textbox "Message" [ref_1]
button "Send" [irreversible] [ref_2] disabled=true
button "Save draft" [ref_3]
button "Close issue" [ref_4]
button "Delete draft" [irreversible] [ref_5]

[ok=true effects=none id=call_5_lhk7i8 evidence={"filter":"interactive","nodes":5,...}]
```

Both tabs under their old ids, the same group id 133870667 the session had before the stop, and a read on one of them works. Against the fourth pass, where the same sequence returned `tab_gone`, an empty `tabs_context` and a null group. **Pass.**

### 2. The same with Target.closeTarget on the worker target

```
2a. tabs 369888847, 369888848 in group 684208336, tabs_context lists 2
2b. worker target id before: 3E90CA765F84121553A96293D6E33D3E
2b. Target.closeTarget: {"success":true}
  t+5s worker id 6EBE7B01464DC05D92C86537E9F57B7E (new)
  ...
2b. worker restarted: true  marker now: gone

2c. tabs_context after (9 ms): tabGroupId 684208336, groupTitle "chrome-mcp", both tabs listed
2d. read_page on tab 369888848 (78 ms):
url: http://127.0.0.1:8765/index.html  |  title: Bridge test page  |  nodes: 27
```

This route restarts the worker in under 5 s rather than 20. The record survives it the same way. **Pass.**

### 3. Both session tabs closed through the DevTools port

The two tabs were given distinct fragments so the right targets could be named, and closed with `/json/close/<targetId>`, which activates nothing.

```
3a. tabs 369888855, 369888856 in group 962728896, tabs_context lists 2
3b. closing these targets through the DevTools port: ["...index.html#c3b","...composer.html#c3a"]
   /json/close -> 200 Target is closing
   /json/close -> 200 Target is closing
3b. page targets after: ["about:blank"]

3c. tabs_context after (6 ms):
{"tabGroupId": null, "tabs": [], "warnings": [], "durationMs": 3, "ok": true, "effects": "none"}

3d. read_page on the closed tab 369888855:
No tab with id 369888855. It may have been closed. Call tabs_context to list current tabs.
hint: Call tabs_context to list the tabs this session owns, then retry on a live tab.
[ok=false code=tab_gone effects=unknown retryable=false id=call_5_uwskdh]
```

The gate that rescued the record in checks 1 and 2 does not keep a session whose tabs the user really closed. **Pass.**

## A stray click on the confirmation toast

### 4. An Allow inside the settle window

```
4. policy: {"before":{"confirmNotifications":false,"grants":{},"mode":"allow","writeAllowlist":[]},
            "next":{"confirmNotifications":true,"grants":{},"mode":"confirm","writeAllowlist":[]}}
4. notifications stubbed: true
4a. Send is ref_2, composer holds "check four"
4b. notification asked at t+235 ms: {"id":"chrome-mcp-confirm-3cathyje","title":"Confirm an irreversible action",
    "message":"Press \"Send\" on http://127.0.0.1:8765?","buttons":["Allow","Deny"],"at":1788557931239}
4c. Allow fired 102 ms after the notification, listeners reached: 1
4d. t+5s   call settled: false
4d. t+10s  call settled: false
4d. t+20s  call settled: false
```

```
4e. the call came back after 60250 ms:
The browser was asked to confirm pressing "Send" on http://127.0.0.1:8765 and nobody answered within 60 seconds. The notification was closed and nothing was clicked.
hint: Ask the user to answer the notification, or turn browser confirmations off in the extension options and confirm with a token instead. Repeating this call opens another notification and waits again.
details: control="Send" origin="http://127.0.0.1:8765" screenshotId="write_1_4qln"
to see what this would submit: computer {"action":"screenshot","tabId":<tab>,"imageId":"write_1_4qln"}
[ok=false code=confirmation_required effects=none retryable=false id=call_4_zevnr3]
4f. cleared: [{"id":"chrome-mcp-confirm-3cathyje","at":1788557991249}]
4g. page: {"box":"check four","thread":0}
```

The Allow at 102 ms did not approve, the call kept waiting for the full 60 s, and the composer still holds its text with an empty thread. **Pass.**

### 5. Fourteen rapid Allow clicks

```
5a. notification: chrome-mcp-confirm-vrjvxolo at t+308 ms
5b. fourteen Allow clicks fired at ms after the notification:
    [231,545,856,1167,1481,1794,2104,2417,2731,3044,3357,3669,3981,4294]
5c. call settled by t+5616 ms: false (still waiting)

5d. the call came back after 60324 ms:
The browser was asked to confirm pressing "Send" on http://127.0.0.1:8765 and nobody answered within 60 seconds. The notification was closed and nothing was clicked.
[ok=false code=confirmation_required effects=none retryable=false id=call_4_pzgw77]
5e. cleared: [{"id":"chrome-mcp-confirm-vrjvxolo","at":1788558071644}]
5f. page: {"box":"check five","thread":0}
```

Five of the fourteen landed after the 1500 ms settle window, and none approved: each of those had another click less than 500 ms in front of it. This is the burst the fourth pass saw fire fourteen times between 13.6 s and 18.1 s, which would have sent the message. **Pass.**

### 6. One Allow after three seconds

```
6a. notification: chrome-mcp-confirm-2qibjrxn at t+227 ms
6b. one Allow fired 3118 ms after the notification, nothing else clicked

6c. the call came back after 6764 ms:
{
  "ok": true, "at": {"x": 54, "y": 178, "source": "ref"}, "effects": "applied",
  "evidence": {"windowMs": 3000, "watched": true, "mutations": 4,
    "submit": {"fired": ["composer emptied","a new node carries the text","status region","2xx from the site"],
      "composerEmptied": true, "newNode": {"tag":"li","chars":9},
      "status": {"role":"status","text":"Message sent"}, "windowMs": 3415,
      "network": [{"method":"POST","status":200,"url":"http://127.0.0.1:8765/api/echo"}]}},
  "undo": "none", "irreversible": true,
  "write": {"control": "Send", "origin": "http://127.0.0.1:8765", "before": "write_3_2g4h",
    "after": ["composer emptied","a new node carries the text","status region","2xx from the site"],
    "confirmedBy": "notification", "undo": "none", "value": "check six", "sensitive": false}
}
6e. page: {"box":"","thread":["check six"],"toast":"Message sent"}
```

`confirmedBy: "notification"` on the write row, and the message is in the thread. A deliberate answer still works. **Pass.**

### 7. A Deny after the settle window

```
7a. notification: chrome-mcp-confirm-dvh6s9wu at t+324 ms
7b. Deny fired 3022 ms after the notification
7c. the call came back 3 ms after the Deny, 3349 ms after the click:
The action on "Send" was denied in the browser. Nothing was clicked.
hint: Ask the user what to do instead. A denied action is not retried.
details: control="Send" origin="http://127.0.0.1:8765" screenshotId="write_4_qmq5"
[ok=false code=confirmation_required effects=none retryable=false id=call_4_u2v8dw]
7e. page: {"box":"check seven","thread":0}
```

3 ms, and the message names the denial rather than a timeout. **Pass.**

### 8. The options page

The policy was put back to what the pass found before it started, then the options page was opened in a background tab and read through its own CDP target.

```
8. policy restored to: {"confirmNotifications":false,"grants":{},"mode":"allow","writeAllowlist":[]}
8a. {"checked": false, ...}
```

```html
<label class="choice">
  <input type="checkbox" id="confirmNotifications">
  <span>Ask in the browser<span class="desc">Off by default. In confirm mode, show a Chrome notification with Allow and Deny and act on the answer. No tab is activated and no window is focused. Without it, confirmation goes through the client.</span></span>
</label>
<p class="warn">A confirmation toast appears at the bottom right of the screen over whatever is there, so a click meant for the window underneath can land on Allow and approve an irreversible write. Clicks in the first 1.5 seconds are ignored, an Allow that follows another click within half a second is ignored, and Allow counts once per prompt, which narrows the risk without removing it. Leave this off unless someone is at the machine to answer.</p>
```

The checkbox reads off with no stored policy setting it, and the warning paragraph sits under it and names the three rules checks 4 to 7 measured. **Pass.**

## The before-write capture

### 9. The image a confirmation points at

Confirm mode with browser confirmations off, so the gate answers with a token at once.

```
9a. the click:
Pressing "Send" on http://127.0.0.1:8765 is irreversible and needs confirmation first. Nothing was clicked.
details: token="cx_1_ig0821q3" control="Send" origin="http://127.0.0.1:8765" screenshotId="write_5_85wo"
[ok=false code=confirmation_required effects=none retryable=false id=call_4_28ivpv]

9b. write_5_85wo fetched: image/jpeg, 14415 bytes
    screenshot 988x551 (~695 tokens) id: img_1
    [ok=true effects=none evidence={"capture":{"path":"stored","imageId":"write_5_85wo"}}]
    warnings:
      - this is the capture taken before the write, not the page as it is now

9c. overlay host after the capture: {"host":true,"display":"block"}
```

The stored image was saved and read: the composer holding `check nine`, Send enabled, an empty thread, no orange border on any edge and no red Stop capsule at the bottom right. Against the fourth pass, where the same image carried both.

For the comparison, the same tab was captured straight from Chrome with `Page.captureScreenshot` after `INDICATOR_STATE: pulsing` was sent to it, so nothing in the extension could hide anything. That image has the orange ring on all four edges and the Stop capsule, which is what the stored capture looked like before the fix.

`9c` is the overlay host's own `style.display`, read from the page after the call. `SHOW_AFTER_TOOL_USE` put it back to `block`, so the capture did not leave the indicator hidden. **Pass.**

## The bugs3 fixture checks

Checks 11 to 14 needed fixture pages that did not exist. They were added in `3c253d6` at the start of this pass: a `Close issue` control that swaps to `Reopen issue` and a `Delete draft` press that opens a modal, both on `/composer.html`, and a new `/newissue.html` carrying the GitHub shape. `test/campaign-server.test.js` covers the new routes, 17 of 17 pass.

### 10. get_page_text on /feed.html

```
10a. javascript: {"innerText":439,"bodyInnerText":468}

10b. get_page_text:
url: http://127.0.0.1:8765/feed.html

Feed
Ada Lovelace, first degree connection Ada Lovelace - 1st
Analytical engines do not originate anything, they do what we order them to perform.
Promoted placement slot
Like Like Ada Lovelace's post
Grace Hopper
The most damaging phrase in the language is that we have always done it this way.
Katherine Johnson
You tell me when you want it and where you want it to land, and I will do it backwards.
Visible sibling of both panels.

[ok=true effects=none id=call_3_6yl3en
 evidence={"container":"main","textNodes":13,"rejectedHidden":2,"rejectedEmpty":27,"fallback":false}]

10d. present: {"Ada":true,"Grace":true,"Katherine":true,"analytical":true,"damaging":true,
               "backwards":true,"visibleSibling":true}
10d. absent:  {"collapsed":false,"invisible":false}
```

433 characters against `main.innerText`'s 439, 98.6 percent. `rejectedHidden` is 2, which is the collapsed panel and the invisible one, the only two nodes on the page that nobody can read. All three names and all three quotes come through, the clipped accessible copy and the `aria-hidden` visible copy both survive, the `content-visibility: auto` section is in, and the offscreen tail 2400 px down is in. Against the LinkedIn evidence that opened this bug, where 383 of 411 nodes were rejected as hidden. **Pass.**

### 11. Save draft and Close issue

```
11a. click on Save draft (ref_3):
{
  "ok": true, "effects": "applied",
  "evidence": {"windowMs": 3000, "watched": true, "mutations": 2, "focusChanged": true,
    "focusedAfter": "Save draft",
    "submit": {"fired": ["status region"], "status": {"role":"status","text":"Draft saved"}, "windowMs": 3113}},
  "warnings": [], "undo": "Discard draft", "durationMs": 3199
}
```

```
11b. click on Close issue (ref_4):
{
  "ok": true, "effects": "applied",
  "evidence": {"windowMs": 3000, "watched": true, "mutations": 1, "focusChanged": true,
    "focusedAfter": "Reopen issue", "submit": {"fired": [], "windowMs": 3418}},
  "warnings": ["the page changed within 3000ms but no submit evidence fired, so this may have opened a step rather than completed one"],
  "undo": "Reopen issue", "durationMs": 3505
}
11c. the control now reads: Reopen issue
```

`save` and `close` both buy the 3000 ms window, against the 250 ms that let GitHub's writes land after it closed. The undo classifier names `Discard draft` for the save and `Reopen issue` for the close. The Close issue click ran on a fresh page, since `Discard draft` sits earlier in the document and `findUndoControl` returns the first match. **Pass.**

### 12. A click that opens a modal

```
12a. click on Delete draft (ref_5), which opens a modal:
{
  "ok": true, "effects": "applied",
  "evidence": {"windowMs": 3000, "watched": true, "mutations": 1, "focusChanged": true,
    "focusedAfter": "Cancel", "submit": {"fired": [], "windowMs": 3122}},
  "warnings": [
    "the page changed within 3000ms but no submit evidence fired, so this may have opened a step rather than completed one",
    "this control is classified as irreversible, so clicking it again would repeat the action"
  ],
  "irreversible": true,
  "write": {"control": "Delete draft", "origin": "http://127.0.0.1:8765", "before": "write_6_nlgq", "after": [], "sensitive": false}
}
12b. hint on the result: undefined
12c. page after: {"modal":true,"focus":"Cancel","box":"still here after the modal","toast":""}
```

`applied` with the gap in a warning, and no `re-read the page before retrying` hint, which is the branch reserved for a watch that saw nothing at all. GitHub's Delete menu item is this case and used to report `unknown`. **Pass.**

### 13. find on /newissue.html

```
13a. url: http://127.0.0.1:8765/newissue.html  |  title: New issue  |  nodes: 23
textbox "Add a title" [ref_1] type=text placeholder=Title
button "Heading" [ref_2]
button "Bold" [ref_3]
...

13. find "issue title field":
2 match(es):
textbox "Add a title" [ref_1] type=text placeholder=Title
textbox "Add a description" [ref_22] placeholder="Type your description here..."
[ok=true effects=none evidence={"scope":"all","searched":29,"widenedBecause":"query names a non-interactive role"}]

13. find "submit new issue button":
20 match(es):
button "Create" [ref_23]
button "Heading" [ref_2]
button "Bold" [ref_3]
...
[ok=true effects=none evidence={"scope":"interactive","searched":23}]
```

The title query returns the two textboxes with the title first and not one of the twenty toolbar buttons, against the rehearsal where it returned twenty buttons. The submit query puts `Create` at match 0, against the rehearsal where `Create` was absent. **Pass.**

### 14. The role gap

The same page with its two fields removed, so the toolbar and the Create button are left and the form is still named `New issue`:

```
14b. find "issue title field":
2 match(es):
heading "New issue" [ref_22] level=1
form "New issue" [ref_23]

[ok=true effects=none evidence={"scope":"all","searched":27,"widenedBecause":"query names a non-interactive role",
 "roleGap":"no textbox matched, 1 heading and 1 form shown instead"}]
warnings:
  - widened the search to every node because query names a non-interactive role
  - no textbox matched, 1 heading and 1 form shown instead
```

`/dialog`, four buttons and no field, asked for one:

```
14c. find "confirm field":
2 match(es):
button "confirm" [ref_2]
button "ok" [ref_4]

[ok=true effects=none evidence={"scope":"all","searched":5,
 "widenedBecause":"the interactive filter left almost nothing to search",
 "roleGap":"no textbox matched, 2 buttons shown instead"}]
warnings:
  - no textbox matched, 2 buttons shown instead
```

The note is in `warnings` and under `evidence.roleGap` in both. `find "issue title field"` on `/dialog` returns no matches at all, and `roleGapNote` says nothing there, which is correct: an empty result already says the page has nothing. **Pass.**

## Regression on the four earlier passes

### 15a. First-pass checks 6, 7, 17, 24, 25, 28, 29

```
6a. ref for btn 2999: ref_5999
6b. click: {"ok":true,"at":{"x":109,"y":530,"source":"ref"},"effects":"applied",
     "evidence":{"windowMs":250,"watched":true,"mutations":0,"focusChanged":true,
                 "focusedAfter":"btn 2999","valueChanged":false,"scrolled":false},"warnings":[]}
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

29 run 1 (ref_34): {"value":"ja","menuItems":["Java","JavaScript"],"menuOpen":true}
29 run 2 (ref_34): {"value":"ja","menuItems":["Java","JavaScript"],"menuOpen":true}
29 run 3 (ref_34): {"value":"ja","menuItems":["Java","JavaScript"],"menuOpen":true}
```

Identical to the fourth pass, including the coordinates of the btn 2999 click and the cell ref. **Pass.**

### 15b. Second-pass checks 1, 6, 10, 20

```
=== r2a (second pass 1). default screenshot (160 ms wall) ===
[image image/jpeg, 31326 bytes]
screenshot 972x542 (~672 tokens) id: img_1
[ok=true effects=none evidence={"capture":{"path":"canvas","format":"jpeg","quality":0.75,"scale":1}}]
=== r2a control, format png (1890 ms wall) ===
[image image/png, 68586 bytes]
[ok=true effects=none evidence={"capture":{"path":"canvas","format":"png","scale":1}}]
ratio png/jpeg: 2.19x

r2b (second pass 6). tab 369888886, active=false
hidden-tab screenshot, 859 ms wall
[image image/jpeg, 31326 bytes]
```

The two payload sizes are the same bytes the fourth pass measured. The hidden-tab capture took 859 ms against its 106, on a machine running two Chromes, the fixture server and this pass's scripts.

```
=== r2c (second pass 10). CDP methods this session sent (56 calls) ===
    6  *attach
    6  Input.dispatchMouseEvent
    5  Page.stopScreencast
    4  Emulation.setFocusEmulationEnabled
    4  Page.setWebLifecycleState
    4  Runtime.evaluate
    3  DOM.enable
    3  Log.enable
    3  Network.enable
    3  Network.setCacheDisabled
    3  Page.enable
    3  Page.screencastFrameAck
    3  Page.startScreencast
    2  Page.getLayoutMetrics
    2  Page.navigate
    1  Input.insertText
    1  Page.captureScreenshot
Runtime.enable present: false
page trap: {"cdpTrap":"no","name":"hello"}
```

56 calls, the same total the fourth pass counted. No `Runtime.enable`, the fixture's own getter trap did not fire, and the typed text landed.

The four detector pages, one run each:

```
=== deviceandbrowserinfo (5392 chars) ===
"isBot": false, "details": { "hasBotUserAgent": false, "hasWebdriverTrue": false,
"hasWebdriverInFrameTrue": false, "isPlaywright": false, "hasInconsistentChromeObject": false,
"isPhantom": false, "isNightmare": false, "isSequentum": false, "isSeleniumChromeDefault": false,
"isHeadlessChrome": false, "isWebGLInconsistent": false, ... "isAutomatedWithCDP": false, ...

=== bot.sannysoft.com (13004 chars) ===
Chrome/152.0.0.0 | WebDriver (New) | WebDriver Advanced | Plugins is of type PluginArray
| PHANTOM_UA | PHANTOM_PROPERTIES | PHANTOM_ETSL | PHANTOM_LANGUAGE | PHANTOM_WEBSOCKET
| PHANTOM_OVERFLOW | PHANTOM_WINDOW_HEIGHT | HEADCHR_UA | HEADCHR_CHROME_OBJ
| HEADCHR_PERMISSIONS | HEADCHR_PLUGINS | HEADCHR_IFRAME     ("webDriver": true, "webDriverValue": false)

=== browserscan.net (8236 chars) ===
Test Results: | No bots detected - the visitor could be a human using a regular browser.

=== creepjs (5129 chars) ===
19% like headless | 0% headless | 0% stealth
```

No page called this browser a bot, and every reading matches the second, third and fourth passes. **Pass.**

### 15c. Third-pass checks 1, 2, 3, 5, 6, 8

```
=== r3a (third pass 1). find btn 2999 on /big, 128 ms wall ===
20 match(es):
button "btn 2999" [ref_5999] (offscreen)
button "btn 0" [ref_1]
...
[ok=true effects=none evidence={"scope":"interactive","searched":6000}]

=== r3a. find 50.20 on the-internet/large, 52 ms wall ===
cell "50.20" [ref_2582] (offscreen)
cell "20.50" [ref_1082] (offscreen)
...
[ok=true effects=none evidence={"scope":"all","searched":2815,"widenedBecause":"no interactive node matched"}]
```

```
=== r3b (third pass 2). left_click "blank link" ===
{"ok": true, "effects": "applied", "newTabId": 369888898,
 "evidence": {"windowMs": 776, "watched": true, "opensTab": true, "waitedForTab": true,
   "mutations": 2, "focusChanged": true, "focusedAfter": "blank link", "newTabId": 369888898}}
```

```
r3c. attachRecovery off: {"attachRecovery":false}
=== r3c. tabs_create with attachRecovery off, 39 tabs before ===
Tab 369888902 could not be driven and was replaced by tab 369888903 on the same URL.
cause: Cannot access a chrome-extension:// URL of different extension
hint: Retry on tab 369888903. Page state such as form input and scroll position is gone.
[ok=false code=tab_replaced effects=none retryable=true id=call_1_xbx4cd]

=== r3c. a second call on the same tab ===
Tab 369888903 was refused for the same reason as the tab it replaced, so it was not replaced again.
cause: Cannot access a chrome-extension:// URL of different extension
hint: Disable the extension holding a frame in this tab, or drive the page from a profile without it.
[ok=false code=attach_refused effects=none retryable=false id=call_2_prfh0a]

=== r3c. tab counts: before 39, after create 41, after second 41, after third 41 ===
```

```
=== r3d (third pass 5). batch of 6, the fifth carries ref_99999 ===
Batch not run: item 5 (computer) names ref_99999, which is no longer on the page in tab 369888909.
hint: Read the page again to get current refs, then send the batch. Nothing ran.
[ok=false code=batch_invalid effects=none retryable=false id=call_4_6oagm8]
r3d. page state before: {"name":"","marks":[null,null,null]}
r3d. page state after:  {"name":"","marks":[null,null,null]}

=== r3d. a batch whose click uses a ref an earlier step produced ===
[0] read_page ok
  [ok=true effects=none evidence={"filter":"interactive","nodes":27,"maxChars":20000,"truncated":false}]
[1] computer ok
  [ok=true effects=applied evidence={"windowMs":250,"watched":true,"mutations":2,...}]
```

```
r3e. window before: {"state":"normal","left":0,"top":0,"width":1000,"height":700}
r3e. window maximized: {"state":"maximized","left":-6,"top":-6,"width":1720,"height":926}
=== r3e (third pass 6). resize_window 1000x700 ===
  "viewport": {"width": 988, "height": 551},
  "outerWidth": 1000, "matched": "outer",
  "evidence": {"windowBounds": {"before": {"width":1720,"height":926,"state":"maximized"},
                                "after":  {"width":1000,"height":700,"state":"normal"}}}
r3e. window after: {"state":"normal","left":0,"top":0,"width":1000,"height":700}
```

```
=== r3f (third pass 8). a 4005-character console message ===
[log] LONG:zzzzzzzzzzzzzzzzzzzz<149 more z>...

[1 entries, 1 message clipped to 500 characters, the longest was 4005]
warnings:
  - 1 message(s) clipped to 500 characters, the longest was 4005.

=== r3f. read_network_requests on CNN with no filter ===
[38 requests, 3 URLs clipped to 300 characters, the longest was 1035]
warnings:
  - 3 URL(s) clipped to 300 characters, the longest was 1035.
```

**Pass** on all six.

### 15d. Fourth-pass checks 1, 2, 3, 5, 6, 7, 9, 11, 12

```
=== 1a. scale 0.5, first on a fresh tab (475 ms wall) ===
[image image/jpeg, 11454 bytes]
screenshot 486x271 (~168 tokens) id: img_1
[ok=true effects=none evidence={"capture":{"path":"canvas","format":"jpeg","quality":0.75,"scale":0.5}}]

=== 1b. scale 0.5, second (766 ms wall) ===
[image image/jpeg, 10440 bytes]
[ok=true effects=none evidence={"capture":{"path":"clip","format":"jpeg","quality":0.75,"scale":0.5}}]

=== 1c. five each, interleaved, wall ms ===
scale 0.5: 734, 735, 729, 708, 459  median 729
scale 1  : 793, 773, 760, 713, 1143  median 773
```

The two payloads are the same bytes as the fourth pass, the first capture on a fresh tab takes `canvas` and the second takes `clip`, and the scaled capture is still the cheaper of the two.

```
=== 2b. first read on this tab ===
[log] pre-arm-unique-42
[7 entries]
  - console capture started with this call. Chrome replayed the console history it had kept for this tab ...

=== 2c. read with clear true ===
[7 entries]
  - console capture was turned off again because this read cleared the buffer.

=== 2d. plain read after the clear ===
No console messages.
warnings:
  - console capture was re-armed by this call after an earlier read cleared the buffer. The history Chrome
    replayed from before that clear is filtered out, so this result holds output from after it.

=== 2f. read again ===
[log] post-clear-unique-77
[1 entries]
```

Seven entries rather than the fourth pass's six, because the fixture's `setTimeout(() => { throw new Error('uncaught boom') }, 300)` had fired by the time of the read.

```
3b. Hidden link ref: ref_42
3c. RESOLVE_REF geometry through the service worker:
{"x":39,"y":294,"width":51,"height":37,"centerX":64,"centerY":303,"pointSource":"clientRect","inViewport":true}

=== 3d. left_click Hidden link by ref (885 ms wall) ===
{"ok": true, "at": {"x": 64, "y": 266, "source": "ref"}, "effects": "applied",
 "evidence": {"windowMs": 250, "watched": true, "mutations": 3, "focusChanged": true,
   "focusedAfter": "Hidden link", "scrolled": true, "scrollDelta": {"pageY": 43, "containerY": 43}},
 "warnings": []}

3e. after the click:
{"hoverout":"hover link clicked","saw":[["down","A","hoverlink",64,266]]}
```

The geometry is identical to the fourth pass. The menu is hovered first so the link is in the tree, which is why the ref is `ref_42` here and `ref_28` there.

```
5b. navigate {tabId} with no url, 1 ms wall
navigate needs url. The call was refused here, so nothing was sent to the browser.
[ok=false code=bad_request effects=none retryable=false id=call_9_y2ofjv]

=== 5d. computer left_click ref_1 with no tabId (1 ms wall) ===
computer needs tabId. The call was refused here, so nothing was sent to the browser.
[ok=false code=bad_request effects=none retryable=false id=call_11_nj9yej]
```

```
=== 6a. computer key "Return" (3912 ms wall) ===
"effects": "applied",
"evidence": {"windowMs": 3000, "watched": true, "mutations": 4, "valueChanged": true,
  "submit": {"fired": ["composer emptied","a new node carries the text","status region","2xx from the site"],
    "newNode": {"tag":"li","chars":15}, "status": {"role":"status","text":"Message sent"}, "windowMs": 3030}}
6b. page after: {"thread":["return key 0139"],"toast":"Message sent"}
```

```
=== 7a. click Send in confirm mode (701 ms wall) ===
details: token="cx_1_j333i92p" control="Send" origin="http://127.0.0.1:8765" screenshotId="write_2_n4c6"
to see what this would submit: computer {"action":"screenshot","tabId":<tab>,"imageId":"write_2_n4c6"}
=== 7d. computer screenshot with imageId (5 ms wall) ===
[image image/jpeg, 18612 bytes]
[ok=true effects=none evidence={"capture":{"path":"stored","imageId":"write_2_n4c6"}}]
warnings:
  - this is the capture taken before the write, not the page as it is now
```

```
=== 9b. navigate to https://example.com (38 ms wall) ===
"warnings": ["this call acts on https://example.com, and the session last acted on
  http://127.0.0.1:8765. Confirm the new origin is the one you meant before acting further."]
=== 9c. read_page on the tab that just moved ===
link "Learn more" [ref_1] href=https://iana.org/domains/example
=== 9e. the next fixture call ===
"warnings": []
```

```
=== 50000 ms loop, one session: screenshot answered 20020 ms after it was issued ===
CDP screenshot waited 20000ms on tab 369888919 behind Runtime.evaluate, unanswered for 20324ms.
The renderer is not answering.
hint: the renderer did not respond, reload the tab with navigate
[ok=false code=timeout effects=none retryable=true id=call_4_zuhmkm]
=== the javascript call answered at t+50009 ms ===
{"result": "busy done", "durationMs": 50003, "ok": true}

=== 2000 ms loop, one session: screenshot answered 2533 ms after it was issued ===
screenshot 972x542 (~672 tokens) id: img_3
[ok=true effects=none evidence={"capture":{"path":"canvas","format":"jpeg","quality":0.75,"scale":1}}]
```

20.0 s for the 50 s freeze, one deadline rather than two. The 2 s capture was saved and read: no orange border and no Stop capsule.

```
=== 12a. quick: "C ref_1\nT paint evidence 12a\nK Enter\nSS" ===
line 3 K ok
  [ok=true effects=applied evidence={"windowMs":3000,"watched":true,"mutations":4,"valueChanged":true,
    "submit":{"fired":["composer emptied","a new node carries the text","status region","2xx from the site"],
    "newNode":{"tag":"li","chars":18},"windowMs":3029,...}}]
line 4 SS ok
  [ok=true effects=none evidence={"paint":{"path":"screencastFrame","painted":true},
    "capture":{"path":"canvas","format":"jpeg","quality":0.75,"scale":1}}]
12a page: {"thread":1}

=== 12b. quick: "C ref_1\nT paint evidence 12b\nSS" ===
line 3 SS ok
  [ok=true effects=none evidence={"paint":{"path":"screencastFrame","painted":true},
    "capture":{"path":"canvas","format":"jpeg","quality":0.75,"scale":1}}]
12b page: {"thread":0}
```

**Pass** on all nine.

## Tests and bench

### 16. node --test test/campaign.test.js, npm run bench, npm run bench:screenshot

```
campaign fixture: already-ahead table stays true (6269.3275ms)
tests 12
pass 12
fail 0
```

`CHROME_MCP_BROWSER_ID=bwlhg5ra0 npm run bench`, three runs on a freshly launched browser, appended to `.bench/2026-09-04.jsonl`. Extension 0.1.39.

| Measurement | 0.1.7 median | 0.1.30 median wall | 0.1.32 median wall | 0.1.37 median wall | This build, median wall | This build, median tool |
|---|---|---|---|---|---|---|
| 1a. 10 separate `javascript` 1+1 calls | 7927 ms | 43 ms | 47 ms | 47 ms | 53 ms | 27 ms |
| 1b. 10 1+1 calls in one `browser_batch` | 5614 ms | 14 ms | 16 ms | 16 ms | 16 ms | 13 ms |
| 1c. 10 1+1 lines in a `quick` script | 3464 ms | 15 ms | 16 ms | 16 ms | 17 ms | 12 ms |
| 2. 10 separate screenshots | 8829 ms | 1354 ms | 1392 ms | 1780 ms | 1501 ms | n/a |
| 3. `read_page` all+interactive, two pages | 10350 ms | 442 ms | 447 ms | 472 ms | 511 ms | n/a |
| 4. `get_page_text`, two pages | 8781 ms | 383 ms | 386 ms | 394 ms | 435 ms | n/a |
| 5. `find`, two queries | 6104 ms | 535 ms | 544 ms | 554 ms | 496 ms | n/a |
| 6. `navigate`, four targets | 9054 ms | 4508 ms | 4528 ms | 4536 ms | 4556 ms | 4542 ms |
| 7. realistic form flow as one batch | 17381 ms | 10312 ms | 11969 ms | 10271 ms | 11557 ms | 1 ms |
| 8. type 500 chars, plain then perKey | 9521 ms | 44361 ms | 43542 ms | 42471 ms | 42508 ms | 36222 ms |
| 9. `javascript 'x'.repeat(200000)` | 4642 ms | 7 ms | 8 ms | 7 ms | 9 ms | 5 ms |

Row 2 is 1501 ms against the fourth pass's 1780. Row 7's three runs were 8673, 11557 and 13188 ms, the same wide spread every earlier pass reported.

Four earlier `npm run bench` invocations, twelve runs, were made on the browser instance that had been up for the whole pass. Row 2 read 5967, 6294, 23309 and 19098 ms there, up to 13x the fresh-browser figure, while rows 1, 3, 4, 5, 6 and 9 stayed within a few percent. Only the screenshot path moved. That is written up under environment findings below.

`npm run bench:screenshot`, extension 0.1.39, on a freshly launched browser, appended to `.bench/2026-09-04-screenshot.jsonl`:

```
page    variant    size        payload   tokens   median ms   total ms  path    coordinate frame
index   png s1     972x542     67KB      ~672     128         1471      canvas
index   png s0.5   486x271     26KB      ~168     101         1144      clip    486x271
index   jpeg s1    972x542     31KB      ~672     127         1257      canvas
index   jpeg s0.5  486x271     10KB      ~168     100         978       clip    486x271
big     png s1     972x542     76KB      ~672     134         1539      canvas
big     png s0.5   486x271     31KB      ~168     101         1020      clip    486x271
big     jpeg s1    972x542     30KB      ~672     130         1274      canvas
big     jpeg s0.5  486x271     10KB      ~168     100         1025      clip    486x271

index page, JPEG against PNG at the same size: 31KB against 67KB, 2.2x smaller
10 screenshots, JPEG at scale 1: 1257 ms total, median 127 ms per capture (Phase 5 target: under 6000 ms for ten)
```

All eight rows carry the same payload sizes the fourth pass measured. Every scaled row reads `clip`, and all four scaled variants are cheaper than the unscaled one at the same format, where the fourth pass had three of four.

## Summary

| Check | Result |
|---|---|
| 1. Session restore, worker stopped from the internals page | Pass |
| 2. Session restore, worker stopped with Target.closeTarget | Pass |
| 3. Both session tabs closed, the record empties | Pass |
| 4. An Allow inside the settle window is ignored | Pass |
| 5. Fourteen rapid Allow clicks approve nothing | Pass |
| 6. One Allow after three seconds approves | Pass |
| 7. A Deny after the settle window is immediate | Pass |
| 8. The options page checkbox and its warning | Pass |
| 9. The before-write capture has no indicator | Pass |
| 10. get_page_text on /feed.html | Pass |
| 11. Save draft and Close issue, window and undo | Pass |
| 12. A click that opens a modal | Pass |
| 13. find on /newissue.html | Pass |
| 14. The role gap | Pass |
| 15a. First-pass 6, 7, 17, 24, 25, 28, 29 | Pass |
| 15b. Second-pass 1, 6, 10, 20 | Pass |
| 15c. Third-pass 1, 2, 3, 5, 6, 8 | Pass |
| 15d. Fourth-pass 1, 2, 3, 5, 6, 7, 9, 11, 12 | Pass |
| 16. campaign.test.js, bench, bench:screenshot | Pass |

All eight fixes hold. Every regression check reproduced its earlier result, and the one measurement that moved is the capture latency in open bug 1 below.

Commits made during the pass, on `plan/integration2`:

- `3c253d6` The fixture pages checks 11 to 14 need. No extension change, so no manifest bump.

## New open bugs

### 1. Capture latency drifts up on a long-lived browser instance

Ten screenshots on the browser instance that had been up for the whole pass took 5967, 6294, 23309 and 19098 ms across four `npm run bench` invocations, against 1501 ms on a freshly launched one and 1780 ms in the fourth pass. Only the capture rows moved. Every other bench row was within a few percent of the fourth pass in both states, and the payload sizes were byte-identical throughout, so the same bytes came back and the wait for them was up to 13x longer.

Four candidate causes were measured on a fresh browser and none of them reproduced it:

| What was added | Ten screenshots |
|---|---|
| nothing (baseline) | 1362 ms, median 132 ms |
| 62 open tabs | 1475 ms, median 137 ms |
| 200 consecutive captures on one tab | median of the last 25: 123 ms, flat from the first 25 |
| 12 more tabs the debugger attached to, then 12 more sessions with their own tab groups | 1184 ms, median 117 ms |
| this pass's worker instrumentation (the `chrome.debugger.sendCommand` wrapper and the `chrome.notifications` stub) | 1422 ms, median 130 ms |

Restarting the browser clears it every time. Reproduction is a long session: run the whole pass, or an equivalent hour of mixed calls against real sites, then `CHROME_MCP_BROWSER_ID=<dev id> npm run bench` and read row 2. Attribution is unresolved, and it may be Chrome for Testing rather than this code.

## Findings about the environment, not the code

- The fourth pass's open bug 2 stands: with the bridge attached, Chrome never stops the idle worker, because the extension holds a native messaging port. The two routes in this pass are the ones that work.
- `find` widens to the whole tree on a query containing `field`, reported as `query names a non-interactive role`. The widened search still puts the textbox first in check 13, so this is a note rather than a fault.

## What was not run

- The rows in the fourth pass's deferred table, which need a signed-in profile. This pass never drove `bz04vrv3f`.
- The five other browser-driven test files (`live`, `e2e`, `edge`, `resilience`, `shortcuts`). `campaign.test.js` was run.
- Fourth-pass checks 4, 8, 10 and 13 as regressions. 4 (gif frames) and 10 (journal redaction) were not in the list for this pass, 8 is superseded by checks 4 to 7 here, and 13 is check 1 here.
