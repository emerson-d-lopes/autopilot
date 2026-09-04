# What would make chrome-mcp better, faster and more reliable than Claude in Chrome

Every item merges two sources: the static reverse-engineering of Claude in Chrome 1.0.90 in [`evidence/X-official-internals.md`](evidence/X-official-internals.md) part 3, and what the live campaign actually measured, in the other nine files under [`evidence/`](evidence/). The findings are summarized in [REPORT.md](REPORT.md).

Every item states what to change, the measured or observed fact that motivates it with its citation, where in this repo it lands, effort and priority. Effort is small (under an hour), medium (a few hours), large (a day or more). Line numbers in `chrome-mcp` paths were read from the source tree at version 0.1.9. Line numbers in citations to `X-official-internals.md` refer to prettified copies of the official bundles, described in that file's method section.

All live findings describe extension build 0.1.7, the build loaded in the user's Chrome during the campaign.

The last two sections are the ones to read first if you are picking this up cold: [what is already ahead and must not regress](#where-chrome-mcp-is-already-ahead-keep-it), and [the suggested order of work](#suggested-order-of-work).

## Reliability

### R1. Recover from a refused debugger attach instead of losing the tab

**What.** When `attach` fails with `Cannot access a chrome-extension:// URL of different extension`, run the official extension's recovery before giving up: call `chrome.webNavigation.getAllFrames` to learn the real frame tree, run an all-frames injected walk that pierces open and closed shadow roots with `chrome.dom.openOrClosedShadowRoot` to count `<iframe>` elements, identify frames holding more iframes than their known child-frame count, remove the `chrome-extension://` ones whose origin is not ours, then retry the attach. Cap at 4 retries with a 75 ms settle, behind a `chrome.storage.local` kill switch.

**Why.** This is the only failure in the campaign that takes a tab out of service. On `https://x.com/home`, which renders a Google Identity Services sign-in-button iframe, `computer` failed 3 of 3 runs on 3 different fresh tabs, and once triggered the same tab's later `navigate` calls failed identically while `read_page`, `get_page_text`, `javascript` and `page_state` kept working (`C3-social-news.md` bug 1). It also appeared intermittently on the local fixture with its `srcdoc` and `example.com` iframes: 3 times in `A-local-site.md`, once in `B-fixture-sites.md` at `/forgot_password`, once in `E-performance-resilience.md` section 7, twice in `R-repeat-performance.md` sections 7 and 8. `STATUS.md:140` and `HANDOFF.md:22` record the cause as unestablished. `X-official-internals.md` part 1 section 3 establishes it from the official bundle: another extension has injected an iframe pointing at its own `chrome-extension://` origin, and Chrome refuses the attach because of it. `describeFrames` already gathers most of the input the recovery needs.

**Where.** `extension/src/lib/cdp.js` `attach` at :67-92 and the frame diagnostic at :149-172.

**Effort.** Large. **Priority.** Highest. This is item one.

### R2. Make `get_page_text` return something on LinkedIn and Notion

**What.** Two changes in `pageText`. First, when the container chosen by the `article` then `main` then `[role="main"]` chain yields zero characters, fall back to `document.body` and walk again rather than returning empty. Second, return which container was chosen and how many text nodes each filter rejected, so an empty result is diagnosable instead of silent.

**Why.** `get_page_text` returned literally `(no text)` on `https://www.linkedin.com/feed`, 3 of 3 runs, while `read_page` on the same page in the same sequence returned 214 nodes and 17915 chars and a screenshot showed the feed rendered (`C3-social-news.md` bug 2). Same result on every `app.notion.com/p/...` page tested, 3 of 3, while `read_page` exposed the same prose as `text` children under `textbox` nodes, for example `"AccuKnox: Front-end engineer responsible for building the initial version of the app"` (`C4-google-notion.md` bug 2). Claude in Chrome returned full text on both sites every time. Two candidate causes worth checking first, both in `pageText`: `document.querySelector('article')` takes the first `article` in the DOM, which on a feed page can be an empty or hidden slot, and `hiddenByAncestor` uses `checkVisibility({visibilityProperty:true})`, which rejects a whole subtree under a `content-visibility` ancestor of the kind a virtualized editor uses. The fallback fixes both without needing to know which one fired.

**Where.** `extension/src/content/agent.js` `pageText` at :772, and the `get_page_text` handler at `extension/src/lib/tools.js:381`.

**Effort.** Medium. **Priority.** High.

### R3. Do not let an in-batch screenshot render a pre-repaint frame

**What.** Before a `screenshot` step inside `browser_batch` or `quick`, wait for one repaint on the page clock (a `requestAnimationFrame` pair where the tab is visible, a short timer where it is hidden, since rAF does not run in a hidden tab). Alternatively make the capture path itself wait for a fresh screencast frame that postdates the last mutating action in the batch.

**Why.** On TodoMVC React, a single `quick` script that clicked into the field, typed, pressed Enter and ended with `SS` produced a screenshot showing an empty field and no todo list, while a `read_page` from a later separate call showed the todo present. Reproduced on a delete click followed immediately by `SS` (`B-fixture-sites.md` bug 2, two occurrences). Inserting `W` before the screenshot fixed it both times. An output that contradicts what happened is worse than one that fails, because the agent acts on it: the same file records the run being logged as a failure before an independent read proved all four items had landed.

**Where.** `extension/src/lib/screenshot.js` capture path, `extension/src/background.js` `runBatch` at :155-180, and the `quick` runner in `extension/src/lib/quick.js`.

**Effort.** Small. **Priority.** High.

### R4. Freeze the coordinate frame for the duration of a batch

**What.** Defer the `scalingContext` update until a batch finishes, the way the official extension's `updateCoordinateContext:"defer"` plus `pendingContextScope` does. Every coordinate written inside one batch resolves against the frame that existed when the batch was submitted, and the new frame is committed at the end.

**Why.** The official extension states this contract in its own tool description and enforces it (`X-official-internals.md` part 1 section 17, `mcpPermissions-BIFqj2d3.js:5688-5697`). chrome-mcp updates `scalingContext` on every capture, so a batch shaped `[screenshot, left_click(x,y)]`, where the model wrote `x,y` from the previous screenshot, silently remaps them against the new one. `X-official-internals.md` part 2 section 17 calls this the most important single finding of the static comparison. The campaign supplies the matching hazard from the other side: on the local fixture, coordinates computed from an earlier screenshot missed because the page's own event log had grown two lines per click and pushed the layout down (`A-local-site.md` scenario 6), and `R-repeat-performance.md` section 7 records a B run where `pointerdown` landed on Submit and the paired `click` landed on a different element.

**Where.** `extension/src/lib/screenshot.js` (add a pending slot and a `commitPending(scope)`), `extension/src/lib/tools.js` (thread an `inBatch` or `scope` flag into the capture), `extension/src/background.js:155-180`.

**Effort.** Medium. **Priority.** High.

### R5. Fix `perKey` typing, or refuse when it cannot work

**What.** Find why `typeKeys` delivers nothing into some inputs and fix it. Failing that, verify the field's value after a `perKey` run and return an error naming the field instead of `{ok:true, typed:N}`.

**Why.** On `https://jqueryui.com/autocomplete/`, clicking the Tags field then calling `computer type` with `text: "ja"` and `perKey: true` returned `{ok:true, typed:2}` with the field empty and no suggestion dropdown, while the identical call without `perKey` worked immediately on the same field (`B-fixture-sites.md` bug 6). That input is exactly the case the option documents itself for. The local fixture confirms `perKey` does work elsewhere: it drove the keydown-only counter `#kd` correctly and typed 500 characters in order at about 61.8 ms per key (`A-local-site.md` scenario 5, `R-repeat-performance.md` section 8). The failing input sits inside a same-origin iframe, which is the first thing to check.

**Where.** `extension/src/lib/cdp.js` `typeKeys` at :442-457 and `sendInput` at :255-279, plus the `type` action in `extension/src/lib/tools.js`.

**Effort.** Medium. **Priority.** High.

### R6. Handle JavaScript dialogs instead of documenting them

**What.** Add a `Page.javascriptDialogOpening` listener. For `beforeunload`, apply a per-tab policy defaulting to dismiss and expose it as `navigate({force: true})`. For `alert`, `confirm` and `prompt`, auto-dismiss (accept for `alert`, dismiss for the others) and surface the dialog's message in the tool result.

**Why.** Both projects list a modal dialog blocking every later call until a human dismisses it as a known limit (`README.md:232`, `STATUS.md:203`). The campaign never tested it, because the brief forbade triggering one for exactly that reason, so the limit stands unmeasured and untouched. The official extension handles `beforeunload` with a policy, a waiter and two well-written result strings, and does not handle the other three either (`X-official-internals.md` part 1 section 3). `Page.enable` is already on in both, so this is a listener plus one `Page.handleJavaScriptDialog` call, and it converts a session-killing hang into a normal result.

**Where.** `extension/src/lib/cdp.js` beside the detach listener at :181-187, `extension/src/lib/recorder.js:62-142` where `Page` is already enabled, and `navigate` at `extension/src/lib/tools.js:325`.

**Effort.** Medium. **Priority.** High.

### R7. Tell the model about tabs the page opened

**What.** Wire up the dead `adoptTab`: add a `chrome.tabs.onCreated` listener that, when `openerTabId` is a session tab, groups the new tab into the session and records it, then append a note to the triggering click's result in the shape the official extension uses, `[note: the link opened in a new tab (tab ID N); pass that tab ID to interact with it]`.

**Why.** `adoptTab` at `extension/src/lib/tabs.js:235-247` has no caller. Today the behaviour works by accident: on `/windows` and on the local fixture's `window.open` and `target=_blank` buttons the new tab did appear in `tabs_context` and was readable and closable on both bridges (`B-fixture-sites.md` /windows, `A-local-site.md` scenario 14), so this is not a correctness failure. What it costs is a round trip: the model is never told the id, so it must call `tabs_context` and infer which tab is new. The official extension returns the ids directly in the click result (`X-official-internals.md` part 1 section 12). `A-local-site.md` scenario 14 also records that on B, clicking `#newtab` invalidated an unrelated ref read before the click, so the click result is the right place to hand back both the new tab id and a hint that refs need re-reading.

**Where.** `extension/src/background.js` next to the existing tab listeners at :305-311, `extension/src/lib/tabs.js:235-247`, `extension/src/lib/tools.js:233-243`.

**Effort.** Medium. **Priority.** Medium.

### R8. Verify a click did something, and say so when it did not

**What.** After a click on a `ref`, watch for one observable change within a short window: a `MutationObserver` tick, a navigation start, a focus change, or a scroll position change. When nothing fires, return that fact alongside the success, for example `clicked, no observable change within 250ms`.

**Why.** This is the single failure mode that cost Claude in Chrome the most in this campaign, and chrome-mcp has no protection against acquiring it. A's ref clicks reported `Clicked on element ref_N` and produced nothing on 11 or more distinct elements in `B-fixture-sites.md`, 3 of 3 on a Wikipedia TOC link, 3 of 4 on Notion's sidebar, and provably on `/big` where a `window.__hit` listener stayed `false` after a reported-successful click (`E-performance-resilience.md` section 16). B is far better here and still not immune: one no-op of two attempts on an Amazon product link (`C-real-sites.md` bug 8), and a silent no-op for a click and type immediately following an in-batch `read_page` (`A-local-site.md` scenario 23). chrome-mcp already refuses a click when the element is covered, which the official extension does not do at all, so post-hoc verification is the natural next step on ground where it is already ahead (`X-official-internals.md` part 3 item 6.2).

**Where.** `extension/src/lib/tools.js` click path around the existing hit test at :127-132, `extension/src/content/agent.js` for the observer.

**Effort.** Medium. **Priority.** Medium.

### R9. Verify that a CDP scroll actually scrolled, and fall back

**What.** Read `pageYOffset` and `pageXOffset` before and after `mouseScroll`, and when the delta is under 5 px in both axes, fall back to an injected `scrollBy` on the nearest scrollable ancestor of `elementFromPoint(x, y)`.

**Why.** This is the official implementation, and `X-official-internals.md` part 2 section 2 names it the single highest-value input fix available to chrome-mcp. It exists because a CDP wheel event does nothing on plenty of real pages: virtualized lists, `overflow:hidden` bodies, and scroll containers that only respond to their own wheel handler. `mouseScroll` is fire and forget, so it reports scrolled whether or not anything moved. The campaign did not catch a scroll no-op, which is why this ranks on the strength of the official code rather than on a measured failure, and the campaign did show the adjacent hazard: on `/floating_menu` an identical scroll command moved the page a different absolute amount on each bridge, so a coordinate click computed before the scroll landed on the wrong link (`B-fixture-sites.md`).

**Where.** `extension/src/lib/cdp.js` `mouseScroll` at :416-426 (add a `getScrollPosition` and a `domScrollBy`), `extension/src/lib/tools.js:283-299`.

**Effort.** Small. **Priority.** Medium.

### R10. Add an offscreen document as a keepalive

**What.** Create `offscreen.html` with `reasons: [BLOBS]` and a `setInterval` posting a message to the worker every 20 s. Create it at worker startup and re-create it from the alarm handler when `chrome.offscreen.hasDocument()` is false.

**Why.** The official extension ships this with the reason left in the source: offscreen documents are not subject to MV3's 30 s idle kill, and a message every 20 s resets the worker's idle timer, keeping the ping running under background throttle and freeze (`X-official-internals.md` part 1 section 1, `offscreen.js:6-13`). chrome-mcp's keepalive is the host's 20 s port ping, which is subject to the same throttling that comment describes, plus a 30 s alarm that only reconnects when the port is already gone. A frozen worker against a 120 s request timeout is a two-minute stall. The campaign found no idle failure on B, which is the point: the recovery suite and the live idle tests both passed (`E-performance-resilience.md` sections 11 and 20, where B screenshotted successfully after 45 s and after roughly 8 minutes idle, and recovered from a killed native host in 401 ms). This item protects a property that currently holds.

**Where.** `extension/manifest.json` (add the `offscreen` permission), new `extension/offscreen.html` and `extension/offscreen.js`, `extension/src/background.js:293-324`.

**Effort.** Small. **Priority.** Medium.

### R11. Queue undelivered results and add a generation counter

**What.** In `host/native-host.js`, buffer a `tool_response` whose requesting IPC socket has closed, bounded and with a TTL, and drop it on expiry rather than losing it silently. In `extension/src/background.js`, bump a generation counter on `port.onDisconnect` and refuse to send a `tool_response` whose generation is stale.

**Why.** The official extension does exactly this: 8 slots with a 120 s TTL replayed on reconnect, plus an epoch guard checked before every reply (`X-official-internals.md` part 1 section 1). Without the queue, a port drop between dispatch and reply loses the work, and `host/mcp-server.js:87-99` rejects with `{kind:'disconnected'}`. Without the epoch guard, a slow tool that finishes after a reconnect can deliver its result into a new session. chrome-mcp already found the sibling of this bug: `STATUS.md:101` records a replaced socket's late `close` handler clearing shared state.

**Where.** `host/native-host.js:116-185`, `extension/src/background.js:82-132` and :215-287.

**Effort.** Medium. **Priority.** Medium.

### R12. Do not report a foreign debugger attachment as success

**What.** Surface an `already attached` error from `chrome.debugger.attach` as a distinct, actionable error instead of recording it as an owned attachment.

**Why.** Chrome allows one debugger client per target. Recording `foreign:true` and returning success means the very next `send()` fails with a generic CDP message, and nothing ever reads the `foreign` flag (`X-official-internals.md` part 2 section 3). The official message is the model to copy, because it names the likely cause: `chrome.debugger.attach timed out after Nms on tab T. DevTools may be open on this tab, or the renderer may have crashed.` The campaign's error-message comparisons consistently favoured chrome-mcp for naming causes, and this is the one place it does the opposite.

**Where.** `extension/src/lib/cdp.js` `attach` at :67-92, specifically the swallow at :79-82.

**Effort.** Small. **Priority.** Medium.

### R13. Retry a dispatch once when the renderer looked throttled

**What.** `sendInput` races the CDP ack against 400 ms and flags a throttled renderer, which the caller turns into `ensureVisible`. Extend it: on the first throttle detection, after `ensureVisible` has raised the window, retry the dispatch once rather than continuing with an event that may have been dropped.

**Why.** Today a throttled renderer flags the tab and the call continues, so the click may not have happened and the tool still reports success. `README.md:199` documents the dispatch-and-move-on choice and its reasoning. The official extension has no equivalent detection at all, so this extends an existing advantage rather than copying one (`X-official-internals.md` part 3 item 2.5). Pairs naturally with R8.

**Where.** `extension/src/lib/cdp.js` `sendInput` at :255-279, `extension/src/lib/tools.js:169-180`.

**Effort.** Medium. **Priority.** Medium.

### R14. Validate every batch item before running any of them

**What.** Before running the first item of a `browser_batch`, validate every item's shape and every item's `tabId` group membership, and fail the whole batch up front.

**Why.** The official extension pre-flights the whole batch (`X-official-internals.md` part 1 section 17). `runBatch` validates as it goes, so a typo in item five costs the side effects of items one to four. Both bridges did stop cleanly on the first error and returned every prior result when a deliberately bad ref was placed last (`A-local-site.md` scenario 23), so the failure handling is already correct. What is missing is the knowable-up-front check. Note that `quick` already parses the whole script before running anything (`README.md:153`), so this brings `browser_batch` up to `quick`'s standard.

**Where.** `extension/src/background.js` `runBatch` at :155-180.

**Effort.** Small. **Priority.** Medium.

### R15. Work out why `left_click_drag` did nothing on the local fixture

**What.** Reproduce the local fixture's HTML5 drag boxes and its `<input type=range>` thumb against `mouseDrag`, and add press and release dwell time if that is what the fixture needs.

**Why.** On the local fixture, `computer left_click_drag` reported the drag while `#dndout` stayed empty and `#sliderval` stayed at 0, and the page's event log showed only `pointerdown HTML` and `click HTML` pairs with no drop and no sustained movement. Claude in Chrome performed both correctly on the same fixture, in the same session (`A-local-site.md` scenario 10). The same file records the page scrolling to 2904 after the two failed drags with no scroll requested. This is fixture-specific rather than general: on `https://the-internet.herokuapp.com/drag_and_drop` B's drag swapped the boxes correctly 3 of 3 runs, and on jqueryui `/sortable` it reordered the list identically to A (`B-fixture-sites.md`). `mouseDrag` uses 10 interpolated steps at 16 ms against the official 5 unspaced steps, so the interpolation is not the gap, which points at dwell before the first move or after the last.

**Where.** `extension/src/lib/cdp.js` `mouseDrag` at :370-414, `extension/src/lib/tools.js:245-248`.

**Effort.** Medium. **Priority.** Low. One fixture, and the two public drag fixtures pass.

## Speed and tokens

### S1. Switch screenshots to JPEG with a byte budget

**What.** Default `format: 'jpeg'`, `quality: 0.75`. Add a byte budget (the official uses 1398100 base64 chars) and a quality-reduction loop stepping down by 0.05 to a floor of 0.10 until the payload fits. Expose `format` and `quality` on the `computer` schema.

**Why.** The official extension uses JPEG 75 by default with exactly this loop (`X-official-internals.md` part 1 section 6). chrome-mcp hard-codes PNG with no byte bound, and PNG of a text-heavy page is several times the bytes of JPEG 75 for the same model-visible content, with every byte crossing a 384 KB-chunked native-messaging pipe and landing in the transcript. `X-official-internals.md` part 3 item 3.1 calls this the single biggest speed and cost win available. The campaign's own numbers show the headroom: B prints `~1516 tokens` under a 1568x758 screenshot of CNN and `~1414 tokens` on the local fixture (`C3-social-news.md` section 2, `A-local-site.md` scenario 21), and A prints no estimate at all, so B already has the measurement surface this change would improve.

**Where.** `extension/src/lib/screenshot.js:54-78`, `extension/src/lib/cdp.js` `captureScreenshot` at :601, `host/schemas.js:135-201`.

**Effort.** Small. **Priority.** High.

### S2. Push the downscale into CDP with `clip.scale`

**What.** When the target size is smaller than the viewport, pass `clip: {x: scrollX, y: scrollY, width, height, scale}` to `Page.captureScreenshot` so Chrome renders straight to the target size, and skip the `OffscreenCanvas` round trip. Verify the returned dimensions by decoding the image header, and fall back to the canvas path when they do not match.

**Why.** The official extension does both, including the decode-and-verify (`X-official-internals.md` part 1 section 6). Capturing a full retina viewport and then downscaling in a canvas is several times slower than asking Chrome for a 1568-wide render. B's median for 10 separate screenshots was 8829 ms wall clock against A's 109198 ms (`R-repeat-performance.md` section 2), so B is already far ahead on this measurement and this is where the remaining headroom is.

**Where.** `extension/src/lib/screenshot.js:86-136`, `extension/src/lib/cdp.js` `captureScreenshot` at :601.

**Effort.** Medium. **Priority.** Medium.

### S3. Promote the `maxTokens` passthrough into a documented `scale`

**What.** Turn the undocumented `input.maxTokens` passthrough into a schema'd `scale` in `[0.1, 1]`, and append the full-resolution frame size to the result text the way the official extension does, so a half-scale image stays clickable.

**Why.** The official contract is the one to copy: coordinates are always in the full-resolution coordinate frame, reported with every scaled screenshot, never in the scaled image's own pixels (`X-official-internals.md` part 1 section 6). A half-scale screenshot costs a quarter of the tokens. The campaign shows the two bridges already interpret `zoom` differently for the same reason: A magnifies a 400x300 region to 979x736 with no cost printed, B crops it at native size and prints `~154 tokens` (`A-local-site.md` scenario 21). Making `scale` explicit gives the caller the same choice on full captures.

**Where.** `host/schemas.js:135-201`, `extension/src/lib/screenshot.js:30-46`, `extension/src/lib/tools.js:188-193`.

**Effort.** Small. **Priority.** Medium.

### S4. Give `read_page` a default budget that survives a link-dense page

**What.** Lower the default node and character budget for `filter: "interactive"` on pages above some size, and when the budget binds, return the top of the tree plus the explicit truncation line that already exists rather than the whole thing. Expose `max_chars` on the `quick` `R` command, which currently has no way to pass one.

**Why.** B's full-tree honesty is a genuine advantage over A's silent under-reporting, and on ordinary news pages it currently costs the call. On CNN, `read_page interactive` returned 309 nodes and about 34112 chars against A's 39 nodes and 2464 chars, and on The Verge 343 nodes and 42345 chars against A's 1708 chars, consistently across three runs each (`C3-social-news.md` section 2). On `/big`, `read_page interactive` was rejected outright by the harness with `result (50,163 characters across 1,156 lines) exceeds maximum allowed tokens` in 3 of 3 runs, where A silently returned 25 rows of 3000 (`R-repeat-performance.md` section 3). The same happened to `get_page_text` on `/big` in all three runs. `C3-social-news.md` bug 4 records that the recovery path the harness suggests, paging through a saved file, is expensive for a routine read.

**Where.** `extension/src/content/agent.js` tree budget, `extension/src/lib/tools.js` `read_page`, `host/schemas.js`, and the `R` command in `extension/src/lib/quick.js`.

**Effort.** Medium. **Priority.** High.

### S5. Cap `read_network_requests` and `read_console_messages` output

**What.** Give both a default result limit and a per-entry length cap, and report the total alongside what was returned.

**Why.** An unfiltered `read_network_requests` on CNN returned 500 requests and 178499 characters, exceeded the harness maximum and was redirected to a saved file (`C3-social-news.md` section 2 and bug 4). A never hit the ceiling in the same scenario, because its defaults return far less. `X-official-internals.md` part 1 section 7 records that the official extension keeps 1000 requests per tab and filters at read time, so the caps here should be on the read rather than on the capture, which would lose the passive-tracking advantage described under R-keep below.

**Where.** `extension/src/lib/tools.js:511-530`, `extension/src/lib/recorder.js` read path, `host/schemas.js`.

**Effort.** Small. **Priority.** Medium.

### S6. Cap the `javascript` tool's output

**What.** Truncate the serialized result at 50 KB with an explicit note, and truncate individual strings at a sane bound before serializing.

**Why.** chrome-mcp has no cap at any layer: `cdp.evaluate` returns the value whole, the server `JSON.stringify`s it, and only the 384 KB chunking bounds the transfer (`X-official-internals.md` part 3 item 2.4). `'x'.repeat(200000)` was rejected by the harness with `result (200,057 characters across 5 lines) exceeds maximum allowed tokens` in all 3 runs (`R-repeat-performance.md` section 9). The official 51200-char cap with an explicit truncation note is the better shape. Note what to avoid: A's answer to the same input was `[BLOCKED: Base64 encoded data]` with the real value discarded, which is a worse outcome than either truncating or erroring with the real size.

**Where.** `extension/src/lib/tools.js:500-509` or `host/mcp-server.js:483`.

**Effort.** Small. **Priority.** Medium.

### S7. Close the two `quick` script gaps

**What.** Two fixes. Accept punctuation in `K` by falling through to the printable-character path when the token is a single non-alphanumeric character, rather than erroring. Add a `clear` flag or a `TR` (type replacing) command so `T` can replace a pre-filled input instead of appending.

**Why.** `K /` errors with `unknown key "/". Supported: 0,1,2,...`, so GitHub's global-search shortcut needs `TK /` instead, which is a different command (`C-real-sites.md` bug 6). And after GitHub's `t` file-finder puts a literal `t` in the box, a `T README` line produces the query `tREADME` and no matches, needing an explicit `K ctrl+a` first (`C-real-sites.md` bug 7). Both cost a round trip each time an agent meets a keyboard-driven site. A has the mirror-image punctuation gap, where `computer key text="slash"` did nothing and the literal `/` worked, so neither bridge is right here and this is cheap ground to take.

**Where.** `extension/src/lib/quick.js` `T` at :73 and `K` at :79, `extension/src/lib/cdp.js` `pressKey` at :464 and the unknown-key error at :472.

**Effort.** Small. **Priority.** Medium.

## Detectability

Read this section against one measured fact: `deviceandbrowserinfo.com/are_you_a_bot` returned `isBot: true` on all 3 of chrome-mcp's runs, and the only true flag in the payload was `isAutomatedWithCDP: true`, with webdriver, Selenium, Playwright and headless markers all `false` (`D-bot-detection.md` section 4). Nothing in this section changes that, because driving the browser through CDP is what the project is. These items reduce the incidental tells around it.

### D1. Give `Runtime.enable` a budget

**What.** Make console capture opt-in per tab. `read_console_messages` enables `Runtime` when first called on that tab, and a clear could disable it, so a session can drive a bot-sensitive page with `Page`, `DOM` and `Network` only.

**Why.** `X-official-internals.md` part 1 section 14 records that the official extension issues `Runtime.enable` on every attached tab and never disables it, and calls it the classic CDP-detection tripwire after the banner. chrome-mcp does the same. Console capture needs it, and `javascript` and every input path do not. `recorder.js` already has the structure for this, since `startCapture` is a single call site. This is the one item in this section with a plausible chance of moving a detector's verdict, and it is unproven: the campaign's own homemade getter trap never fired on either bridge (`A-local-site.md` scenario 1, `D-bot-detection.md` section 6), so a homemade probe cannot confirm the change worked and the production detector would have to be re-run.

**Where.** `extension/src/lib/recorder.js` `startCapture` at :159-171, `extension/src/lib/cdp.js` `enableDomains` at :664.

**Effort.** Medium. **Priority.** Medium.

### D2. Stop leaving a branded fingerprint on every page

**What.** Give the cursor host a per-session random id instead of the fixed `__chrome_mcp_cursor__`. Replace the `data-chrome-mcp-mark` attribute round trip in `file_upload` with a single injected function that sets, resolves and removes the attribute without yielding, or resolve the node through `DOM.getDocument` plus `DOM.querySelectorAll` on a stable structural selector.

**Why.** `agent.js` appends a fixed-id element to `document.documentElement` on every page, and the upload path writes an attribute a `MutationObserver` can see (`X-official-internals.md` part 2 section 14 and part 3 item 5.7). The closed shadow root hides the cursor's contents and not the host element's id, which is trivially greppable. Neither is worth the exposure given the debugger banner already announces the session, and both are cheap to remove.

**Where.** `extension/src/content/agent.js:1050` and :1213-1238, `extension/src/lib/tools.js:446-470`, `extension/src/lib/cdp.js` `setFileInputFiles` at :681.

**Effort.** Small. **Priority.** Low.

### D3. Add jitter to `perKey` typing cadence

**What.** Draw each inter-key delay from a distribution around the current 12 ms base rather than emitting a constant interval, and let the caller set the mean.

**Why.** Measured on the local probe, `perKey` typing of 19 characters ramped 23, 33 then 52 ms and settled into a very regular 62 to 64 ms band (`D-bot-detection.md` section 6). The magnitude is human-scale, which is already better than A's 0 to 1.2 ms burst, and the low variance is itself a known tell to a keystroke-dynamics classifier. Neither bridge is indistinguishable from a human typist today. Note the cost side: `perKey` on 500 characters took `durationMs: 30911`, about 61.8 ms per key (`R-repeat-performance.md` section 8), so any change here trades against an already slow path.

**Where.** `extension/src/lib/cdp.js` `typeKeys` at :442-457.

**Effort.** Small. **Priority.** Low.

### D4. Emit an interpolated mouse path before a click

**What.** Before `mousePressed`, dispatch a few `mouseMoved` events along a path from the last known pointer position to the target, the way `mouseDrag` already does for drags.

**Why.** Neither bridge produces a mouse path: both emit only start and end samples with a straight jump between click targets, on every scenario tested (`D-bot-detection.md` sections 6 and "What is visible to a site on both bridges"). `mouseDrag` already interpolates 10 steps at 16 ms, so the primitive exists and only the click path lacks it. The cost is latency on every click, which `COMPARISON.md:56` already budgets a deliberate 100 ms hover gap for, so the path can ride inside that gap at no extra cost.

**Where.** `extension/src/lib/cdp.js` `mouseClick` at :321-361 and `mouseHover` at :363, reusing the interpolation in `mouseDrag` at :370-414.

**Effort.** Medium. **Priority.** Low.

### D5. Document the CDP tell rather than implying it is absent

**What.** Add one line to `README.md`'s known limits: a site probing for CDP automation can detect the session, and one production detector did on every run.

**Why.** `README.md:233` lists the visible debugger banner and stops there. The campaign found a detector that flags the session through CDP itself with every spoofable signal reading clean (`D-bot-detection.md` section 4), and a second detector with a section named for the same purpose that did not flag it (browserscan.net). A user choosing this tool for a bot-sensitive site should read that before finding out.

**Where.** `README.md` known limits, `STATUS.md` known limits.

**Effort.** Small. **Priority.** Medium.

## Safety

### F1. Redact sensitive field values in the tree, in `form_input` results and in the journal

**What.** Adopt the official sensitivity test: `type` is `password` or `hidden`, or `autocomplete` contains any of `current-password`, `new-password`, `one-time-code`, `cc-number`, `cc-csc`, `cc-exp`, `cc-exp-month`, `cc-exp-year`. Apply it in three places.

- The tree, so `value` reads `[value redacted]` and a sensitive `<select>` does not list its options
- The `form_input` confirmation, so it says `[redacted]` instead of echoing the value
- The journal, so `computer type` text and `form_input` values are not written to disk verbatim

**Why.** The official extension does all three (`X-official-internals.md` part 1 sections 4, 9 and 13). chrome-mcp does none: the tree emits `value` for any non-password input, `form_input` echoes the value it set, and the journal keeps string args up to 160 chars. `README.md:167` shows the shape itself, `form_input ... value="Test Person"`, in a file that is never rotated and never pruned. A password typed through `computer type` lands on disk today. This matters more here than in the official extension, not less, because chrome-mcp drives the user's real signed-in profile with no cloud boundary in between.

**Where.** A shared `isSensitiveField(el)` helper in `extension/src/content/agent.js`, applied at the value-emitting path around :498-552 and the `form_input` path around :960-1035, plus an argument denylist in `host/journal.js:23-38`.

**Effort.** Medium. **Priority.** High.

### F2. Redact credential-shaped strings from `javascript` results

**What.** Port the official filter: blank object keys matching `/password|token|secret|api[_-]?key|auth|credential|private[_-]?key|access[_-]?key|bearer|oauth|session/i`, blank `cookie` and `cookies`, block JWT-shaped, long-base64-shaped, long-hex-shaped and cookie-string-shaped values, cap strings at 1000 chars and arrays at 100 items, depth-limit at 5.

**Why.** chrome-mcp drives the user's real signed-in profile, so `document.cookie` and `localStorage` are live session material and the tool returns them unfiltered. The campaign proved it directly: on theguardian.com, `javascript` returned the full cookie string while A returned `[BLOCKED: Cookie/query string data]` (`B-fixture-sites.md` bug 5). Read that finding in both directions. A's filter is crude and fires on ordinary reads (`C-real-sites.md` bug 2, three false positives on plain `location.href`), so the port must key on the value shape rather than on the page URL, which is exactly the mistake A makes. Pair with S6.

**Where.** `extension/src/lib/tools.js:500-509` or `host/mcp-server.js:483`.

**Effort.** Small. **Priority.** High.

### F3. Rotate the journal and add a redaction switch

**What.** A retention setting that deletes journal files older than N days on host start, and a `CHROME_MCP_JOURNAL_REDACT` mode that records tool names and outcomes without argument strings.

**Why.** `host/journal.js` writes one file per browser per day forever with no pruning (`X-official-internals.md` part 3 item 6.4). The official extension has no local persistence at all, so there is no counterpart to copy and nothing to compare against. With F1 in place the journal is safe to leave on by default, and with rotation it stays bounded. The journal itself is a real advantage over the official extension and should not be weakened, only bounded.

**Where.** `host/journal.js:23-38` and :102-105, `host/native-host.js` startup.

**Effort.** Small. **Priority.** Medium.

### F4. Draw a visible acting indicator with a Stop button

**What.** Extend the existing cursor overlay into the official three-state model: a pulsing viewport border while acting on this tab, a static pill on other session tabs, and a floating Stop button whose handler requires `event.isTrusted` and sends a stop message. Reuse the existing hide-before-capture path so none of it lands in a screenshot.

**Why.** The official `agent-visual-indicator.js` is the only thing telling a user watching their own screen that a page is being driven, and the only way to stop it without switching to the client (`X-official-internals.md` part 1 section 13). chrome-mcp's signals are the tab-group status mark and the pointer, neither of which is a control. This matters more here because of a measured difference: B activates the tab it acts on, so the fixture's probe read `visibility: visible / hasFocus: true` on every run while A read `hidden` and `false` (`F-gif-upload-tabs.md` section 5, 3 runs each). The user is more likely to be looking at the page chrome-mcp is driving.

**Where.** `extension/src/content/agent.js:1050-1211`, `extension/src/lib/tabs.js:53-78`, `extension/src/background.js`.

**Effort.** Large. **Priority.** Medium.

### F5. Add a plan mode

**What.** A `permissionPolicy.mode = 'plan'` in which the first tool call of a session declares the domains it will visit, those domains are checked against the blocklist, the user approves once, and they become turn-approved for the rest of the session.

**Why.** The official `follow_a_plan` is one decision instead of five interruptions, and the user sees the whole scope before anything runs (`X-official-internals.md` part 1 section 13). For a multi-site task this is a better model than per-origin prompting. The campaign gives the scale: a single group touched 8 real sites in one pass, and `C-real-sites.md`'s Amazon scenario alone crossed three origins.

**Where.** `extension/src/lib/permissions.js:10-14` and :138-183, `host/schemas.js` for a declare-plan tool, `extension/src/options/options.js`.

**Effort.** Large. **Priority.** Low.

### F6. Add a domain-transition check

**What.** When an action would act on an origin different from the one the session last acted on, require its own grant.

**Why.** `verifyOriginUnchanged` already catches the involuntary case, where the page navigated under us, and `X-official-internals.md` part 2 section 13 credits it as closing a TOCTOU hole the official extension has no answer for. It does not catch the voluntary case: a `navigate` to a different origin inherits nothing, and in `allow` mode every subsequent action on the new origin passes automatically. The campaign hit exactly this shape without harm: `/redirector` landed on a different path after a redirect, and `/redirect` on the local fixture resolved to a different URL than the one requested (`B-fixture-sites.md`, `A-local-site.md` scenario 17). A redirect chain into an unexpected origin is currently invisible.

**Where.** `extension/src/lib/permissions.js:138-217`.

**Effort.** Medium. **Priority.** Medium.

## Parity and polish

### P1. Draw the GIF overlays

**What.** Implement the five overlays the schema already accepts: click ring, drag path, action label, progress bar, watermark. Draw them into the quantized frame in the extension before shipping bytes to the host, scaled by `canvas.width / viewportWidth`. Copy the official retroactive click frame, which re-emits the previous frame carrying the click marker before capturing the effect, and its per-action delay table (300 ms for wait and screenshot, 800 ms for navigate, scroll, type, key and zoom, 1500 ms for every click and drag, plus 2000 ms on the last frame).

**Why.** `STATUS.md:32` and `HANDOFF.md:15` already list this as an accepted-and-ignored gap. A recording without click indicators is much harder to read, and the official code is unminified and directly portable (`X-official-internals.md` part 1 section 11). The campaign confirms both encoders produce valid output: A's run 1 file verified at 518098 bytes and B's at 96310 bytes, both with a `GIF89a` header (`F-gif-upload-tabs.md` section 1), so this is about readability rather than correctness.

**Where.** `extension/src/lib/gif.js:77-128`.

**Effort.** Medium. **Priority.** Medium.

### P2. Report the real elapsed time from `gif_creator stop`

**What.** Compute elapsed time from the first and last frame timestamps instead of reporting a constant.

**Why.** Every one of 5 recordings reported `Recorded N frames over 0.0s at 480x465`, including runs that spanned 15 seconds with a `PAUSE 2` in the middle (`F-gif-upload-tabs.md` bug 3). Cosmetic, and it is the kind of field a caller reads as real.

**Where.** `extension/src/lib/gif.js`, the `stop` result in `extension/src/lib/tools.js`.

**Effort.** Small. **Priority.** Low.

### P3. Report platform and a user-set name in `list_connected_browsers`

**What.** Include the OS platform from `navigator.userAgentData.platform`, sent in the hello frame, and a marker for the browser this MCP server is on. Allow a user-set display name stored in `chrome.storage.local` and editable from the options page.

**Why.** `HANDOFF.md:16` lists this. The name is derived from the user agent today, so two Chromes on the same machine look identical. The official extension carries `os_platform` in its connect frame and lets the user name the browser during pairing (`X-official-internals.md` part 1 section 15).

**Where.** `extension/src/background.js:62-111`, `host/native-host.js:199-206`, `host/registry.js:64-77`, `host/mcp-server.js:319-332`, `extension/src/options/options.js`.

**Effort.** Small. **Priority.** Low.

### P4. Make `switch_browser` confirm in the browser

**What.** Give `switch_browser` a distinct behaviour: send a prompt to the target browser and require an in-page or options-page confirmation before routing there.

**Why.** `HANDOFF.md:17` lists this, and `select_browser` and `switch_browser` are literally the same call today (`X-official-internals.md` part 2 section 15). A user with several windows cannot confirm which one they just pointed at. The official flow, switch to the window you want then confirm in the side panel, is the correct interaction for a human sitting in front of several browsers.

**Where.** `host/mcp-server.js:334-352`, `extension/src/background.js`.

**Effort.** Medium. **Priority.** Low.

### P5. Widen `find`'s default search scope on large pages

**What.** Work out why the candidate set collapses on deeply nested pages and raise it, and when the searched count is small relative to the page's node count, say so in the result instead of reporting no match.

**Why.** On `https://the-internet.herokuapp.com/large`, `find "table cell containing 50.20"` returned `No elements matched ... among 2 searched` on a page with more than 9000 table cells, and on `/tables` a descriptive query returned `among 18 searched`. A shorter query with `include_all: true` found the target both times (`B-fixture-sites.md` bug 7). A's longer descriptive queries worked on both pages without a flag. Also on `/entry_ad`, `find "Close"` returned `No elements matched ... among 2 searched` for a modal that was on screen (`B-fixture-sites.md`). The searched count is already in the message, which is the right instinct, and the number itself is the bug.

**Where.** `extension/src/lib/find.js:110-218`, the tree filter it consumes in `extension/src/content/agent.js`.

**Effort.** Medium. **Priority.** Medium.

### P6. Give `find` a model escalation path

**What.** Keep local ranking as the default. When the best score is below a threshold, or the caller passes `semantic: true`, fall back to an MCP sampling request carrying the tree and the query, with the same ref validation the official extension does against the refs actually present in the tree.

**Why.** `STATUS.md:148` records the failure: "most viewed article link" cannot be found lexically. The official extension gets this right at the cost of a model call on every `find`, which the campaign measured as the largest per-call latency gap of the whole comparison, a median 13735 ms against 6104 ms for two queries (`R-repeat-performance.md` section 5). Escalating only on a low score gives the semantic capability at close to zero average cost. Two campaign results argue for the escalation to be conservative: on `/big`, A's model-graded find located `btn 2999` exactly while B's returned low-numbered buttons in one session (`A-local-site.md` scenario 18), and on Amazon A's find failed outright with `400 prompt is too long: 234540 tokens > 200000 maximum` (`C-real-sites.md` bug 4), so the escalation needs the tree cap and the fallback that A lacks.

**Where.** `extension/src/lib/find.js:177-218`, `host/mcp-server.js:214-233` plus a sampling request path.

**Effort.** Large. **Priority.** Low.

### P7. Put the caret at the end after `form_input`

**What.** After setting a text value, call `setSelectionRange(len, len)` for `text`, `search`, `url`, `tel` and `password` inputs and for textareas.

**Why.** The official extension does it (`X-official-internals.md` part 2 section 9). Without it, a `form_input` followed by a `computer type` can insert at position 0 rather than appending. The campaign's own `form_input` then Enter pattern worked on both bridges (`B-fixture-sites.md` TodoMVC), so this has not bitten yet, and the GitHub `T`-appends finding in S7 is the same class of caret problem from the other direction.

**Where.** `extension/src/content/agent.js:1021-1032`.

**Effort.** Small. **Priority.** Low.

### P8. Wait for the load on `navigate back` and `forward`

**What.** `navigate back` and `forward` go through `Runtime.evaluate('history.back()')` today. Use `Page.navigateToHistoryEntry`, or pair the current call with the navigation-start wait plus the load wait that `wait_for_page` already implements, and surface the `beforeunload` outcome from R6.

**Why.** `history.back()` returns immediately and the tool reports success before the page has begun loading (`X-official-internals.md` part 3 item 5.6). The campaign did not catch a wrong read after a back navigation, and it did show the tool is exercised on real sites: `navigate back` worked on Hacker News in 3 of 3 B runs and returned `durationMs: 6` in Gmail, which is fast enough to be suspicious of the same race (`C-real-sites.md`, `C4-google-notion.md` section 1b). A's `navigate back` failed outright on Gmail with `Cannot find a next page in history`, so B is ahead here and the fix is about the wait rather than the navigation.

**Where.** `extension/src/lib/tools.js` `navigate` at :325-340.

**Effort.** Small. **Priority.** Low.

### P9. Make `resize_window` report what it changed

**What.** Return `outerWidth` and `outerHeight` alongside the CSS `viewport` in the `resize_window` result, and say which one the request was measured against.

**Why.** Two agents concluded from the returned `viewport` field that the resize was a no-op: it stayed 1707x769 across two attempts on the local fixture (`A-local-site.md` scenario 20), and returned the identical `{"viewport":{"width":1707,"height":825}}` for two different requested sizes (`E-performance-resilience.md` section 2b). A third agent measured the same tool differently and found it worked: a resize to 1000x700 produced `outerWidth:1001, outerHeight:700` read from the page (`F-gif-upload-tabs.md` section 4). The `viewport` field is the CSS layout viewport, which does not equal the requested outer size once device pixel ratio 2.25 and browser chrome are taken out. The tool is correct and its result is misleading, which cost two agents a wrong verdict.

**Where.** `extension/src/lib/tools.js` `resize_window` at :597.

**Effort.** Small. **Priority.** Medium.

### P10. Set `force` on pressed mouse events, and reject page-zoom chords

**What.** Add `force: 0.5` to `mousePressed` and to `mouseMoved` payloads carrying a held button. In `pressKey`, detect `ctrl` or `cmd` plus `+`, `-` or `0` and return an error pointing at the `zoom` action rather than dispatching.

**Why.** Both are one-liners from the official extension (`X-official-internals.md` part 3 item 5.4). Pointer-event handlers that read `force` see a plausible value, and a browser zoom chord silently breaks every subsequent coordinate, which is the same class of failure as the coordinate drift documented on the local fixture (`A-local-site.md` scenario 6).

**Where.** `extension/src/lib/cdp.js` `mouseClick` at :321-361 and `pressKey` at :464-497.

**Effort.** Small. **Priority.** Low.

### P11. Normalize upload filenames

**What.** Reject or normalize a filename carrying a path separator or exceeding 255 chars on the `file_upload` path, as the official extension does before building its `File` objects.

**Why.** `X-official-internals.md` part 2 section 10 names this as the one official idea worth borrowing in an area where chrome-mcp is otherwise decisively ahead. chrome-mcp sanitizes on the `materializeImage` path and takes raw paths in `file_upload`, which is intentional and fine for the path itself, and the name that reaches the page is a different question. The campaign confirms the upload path is otherwise sound: exact byte counts echoed back for 13-byte, 5000-byte and 12582912-byte files, a real HTML5 drop on a plain `<div>`, and a clean `Upload exceeds the 25MB limit.` at the ceiling (`F-gif-upload-tabs.md` section 2).

**Where.** `host/mcp-server.js:397-423`, `extension/src/lib/cdp.js` `setFileInputFiles` at :681.

**Effort.** Small. **Priority.** Low.

### P12. Give `form_input` a real contenteditable path

**What.** Have `form_input` on a contenteditable element delegate to the `computer type` path (focus it with a real click, then CDP `insertText`) instead of replacing `textContent` and firing a synthetic `input`.

**Why.** Rich editors need `beforeinput` with the correct `inputType`, a selection, and often composition events. Replacing `textContent` is what both projects do, and the official extension has no contenteditable branch at all, so chrome-mcp is already ahead and neither is usable for a real editor (`X-official-internals.md` part 2 section 9 and part 3 item 6.3). The campaign shows the typing path already works where the replacement path would not: on the local fixture's contenteditable, a ref click plus `ctrl+a` plus type produced the right result first try (`A-local-site.md` scenario 8), and in Quill, `ctrl+b` correctly bolded a selection through a sandboxed iframe on both bridges (`B-fixture-sites.md` section 7). Google Docs stays out of reach for both, since its canvas editor exposes no text nodes at all (`C4-google-notion.md` section 2c).

**Where.** `extension/src/content/agent.js:1014-1019`, `extension/src/lib/tools.js` `form_input` handler.

**Effort.** Large. **Priority.** Low.

## Where chrome-mcp is already ahead, keep it

Each of these was measured in the campaign. Any change that regresses one of them costs more than the item it was meant to fix.

| What | The measurement |
|---|---|
| Tree fidelity: open shadow DOM | `read_page` lists `button "Open shadow button" [ref_20]` inside the open shadow root, which A's tree never shows at any filter, and A's `find` errors on it outright (`A-local-site.md` scenarios 2, 3 and 6). On `/shadowdom` B showed all 14 nodes including the unrendered fallback paragraphs (`B-fixture-sites.md`) |
| Tree fidelity: same-origin iframes | `read_page` nests `button "Inside iframe" [ref_23]` under `iframe [ref_22]` and the ref click fires the handler. A has no ref for it and needs a coordinate click (`A-local-site.md` scenarios 2 and 7). `get_page_text` also crosses the boundary, including "Inside iframe" where A's does not, in all 3 runs (`R-repeat-performance.md` section 4) |
| Tree fidelity: offscreen marks and state flags | Offscreen nodes are kept and tagged `(offscreen)` rather than dropped, and inputs carry `disabled=true`. A's `interactive` filter dropped 63 of 9000 nodes on `/big` with no notice, zero of 2 links on `/large`, and 39 nodes against B's 309 on CNN across 3 runs (`A-local-site.md` scenario 18, `B-fixture-sites.md`, `C3-social-news.md` section 2) |
| Refusal of disabled and readonly | `element ref_8 is disabled, so its value cannot be set`. A wrote the value into both a disabled and a readonly input and reported success, which is something no real user interaction could do (`A-local-site.md` scenario 5) |
| The covered-element check | `Element X is covered by <role "name"> at the point a click would land. No click was sent.` The official extension has no equivalent at all (`X-official-internals.md` part 2 section 17) |
| Navigate error reporting | `navigate` returns the resolved URL, a status and a duration, so `/redirect` comes back as `.../index.html#redirected` with `durationMs: 42`, and a load failure is reported. A returns a one-line confirmation of the URL it was told to visit, so a redirect is invisible from its output (`A-local-site.md` scenario 17, `E-performance-resilience.md` section 6) |
| Structured JSON errors that name the cause | On a dead tab: `No tab with id 177110633. It may have been closed. Call tabs_context to list current tabs.` against A's `Couldn't determine which page this action targets.` On a foreign tab id: `Tab 177110669 is not in this session's tab group.` against A's identical generic string. On a stale ref: `ref ref_12 is no longer on the page. Re-read the page.` where A reported a successful click on a ref whose document no longer existed (`E-performance-resilience.md` sections 12, 14 and 15, `F-gif-upload-tabs.md` section 3) |
| Local `find` speed | Median 6104 ms for two queries against A's 13735 ms, and B's own reported ranking time is under a millisecond with no tokens spent. On the small fixture, 5 queries took 0.3 to 2.9 s against A's 5.6 to 12.1 s (`R-repeat-performance.md` section 5, `A-local-site.md` scenario 3) |
| 25 MB uploads and drop zones | A 12 MB file that A rejects client-side at its 10 MB ceiling uploads cleanly, with `#fileout` reading `big12.bin:12582912`. A plain `<div>` drop zone takes a real HTML5 drop by coordinate, `{"ok":true,"mode":"drop",...}`, which A's schema has no parameter for (`F-gif-upload-tabs.md` section 2) |
| Native host recovery | After the native host process was killed outright, the first screenshot succeeded in 401 ms with no error and `npm run doctor` reported all green (`E-performance-resilience.md` section 20) |
| Passive console and network capture | 3 `/api/` requests were captured with no arming step, where A returned `No requests matching "/api/" found for this tab.` and had to be primed by an earlier call before the requests fired (`A-local-site.md` scenario 15) |
| `wait_for_page` | Caught a 2-second SPA render and a 1.5-second dynamic list without a fixed sleep, returning `waitedMs: 121, durationMs: 983`, where A has only a blind wait of N seconds (`A-local-site.md` scenarios 12 and 17) |
| Printed token cost | `~1414 tokens` under a fixture screenshot and `~1516 tokens` under a CNN one. A prints no estimate for any image anywhere in the campaign (`A-local-site.md` scenario 21, `C3-social-news.md` section 2) |
| `quick` as the cheapest primitive | 10 `J 1+1` lines in a median 3464 ms against 5614 ms for the same work in `browser_batch` and 7927 ms as separate calls. A has no equivalent (`R-repeat-performance.md` sections 1a to 1c) |
| No cloud relay | Every hop is local. A's calls in this campaign went to `wss://bridge.claudeusercontent.com`, and its safety-category check sends every navigated URL with path and query to `api.anthropic.com` (`X-official-internals.md` part 1 sections 1 and 13) |
| No telemetry | Nothing leaves the machine. A ships Segment, Sentry, Datadog RUM and an Anthropic event-logging sink, whose payloads carry the page hostname (`X-official-internals.md` part 1 section 16) |

## Suggested order of work

The first ten items, in order, with the reason each sits where it does.

1. **R1, recover from a refused debugger attach.** It is the only failure in the campaign that takes a tab out of service, it reproduced 3 of 3 on a real site, and the cause is already answered in the official bundle, so the large effort buys a known fix rather than an investigation.
2. **R3, wait for a repaint before an in-batch screenshot.** Small, and it removes the one class of output that actively contradicts what happened, which is the failure an agent is least able to catch.
3. **S1, JPEG with a byte budget.** Small, and it is the largest token and bandwidth win available, on the tool that is called most.
4. **R9, verify a scroll and fall back.** Small, and it closes a silent no-op class before R8's verification work makes silent no-ops the theme.
5. **R2, fix `get_page_text` on LinkedIn and Notion.** An entire tool returning nothing on two real signed-in sites, 3 of 3 each, and the fallback that fixes it does not depend on identifying which filter fired.
6. **R4, freeze the coordinate frame for a batch.** Silent mis-clicks are the worst failure mode a browser tool has, and the contract is easier to add before more callers depend on `browser_batch`.
7. **S4, give `read_page` a workable default budget.** Two ordinary news sites already trip the harness cap, so the tree fidelity that is this project's strongest advantage currently costs the call on the pages that need it most.
8. **F1 and F2, redaction in the tree, in `form_input` results, in the journal and in `javascript` output.** Do them together, since they share the sensitivity test, and do them before the journal grows further, because it persists to disk and is never pruned.
9. **R5, fix `perKey`.** Its own documented use case fails silently on a real autocomplete, and R8 depends on knowing whether an input path can fail without saying so.
10. **R6, handle JavaScript dialogs.** It converts a session-killing hang into a normal result, and it is listed as a known limit in two files rather than being fixed.

After those: R7 tab adoption and R8 click verification together, since both change what a click result carries. Then S7 and P9, which are small corrections to output the campaign showed misleading a reader. Then R10 through R14, which protect properties that currently hold rather than fixing observed failures. The detectability items are last, because `isAutomatedWithCDP` stays true regardless and none of them changes that.
