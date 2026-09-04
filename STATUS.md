# chrome-mcp: status, parity and test coverage

State of the build as of 2026-09-04, extension 0.1.39. 26 tools, 30 test files.

- Source: about 17,600 lines across the extension, host and tools
- Tests: about 10,500 lines
- Verified against Chrome for Testing 152 and against the user's own Chrome 152 on Windows 11

On 2026-09-04 the non-browser files pass, 640 tests across 24 files, and `campaign.test.js` passes 12 of 12 against a browser. The build that was driven against a browser is the one described under "Live verification of the second set of bug fixes", which ran 17 checks by hand from 0.1.34 to 0.1.37. Twelve of the thirteen fixes hold and the session restore does not. The five other browser-driven files were not run.

## Feature parity with Claude Code's browser integration

Claude Code drives Chrome through Anthropic's `claude-in-chrome` extension, which exposes 22 tools. This is the mapping.

| Claude Code | chrome-mcp | Notes |
|---|---|---|
| `tabs_context_mcp` | `tabs_context` | `createIfEmpty` opens an unselected tab in the window the user is looking at, and nothing is ever brought to the front. Claude in Chrome opens a new window and selects its tabs |
| `tabs_create_mcp` | `tabs_create` | |
| `tabs_close_mcp` | `tabs_close` | |
| `navigate` | `navigate` | Also reports load failures, which `chrome.tabs.update` cannot |
| `read_page` | `read_page` | |
| `get_page_text` | `get_page_text` | |
| `find` | `find` | Local ranking first, so a clear match costs no inference. A weak local score, or `semantic: true`, escalates to a model call through MCP sampling |
| `form_input` | `form_input` | Also refuses disabled and read-only controls |
| `computer` | `computer` | All 13 actions, plus `perKey` typing |
| `javascript_tool` | `javascript` | |
| `read_console_messages` | `read_console_messages` | |
| `read_network_requests` | `read_network_requests` | |
| `resize_window` | `resize_window` | |
| `file_upload` | `file_upload` | Also handles drop zones with no file input |
| `upload_image` | `upload_image` | Takes the `imageId` printed under each screenshot, a path, or `"last"` |
| `gif_creator` | `gif_creator` | Own GIF89a encoder, no dependency. `start_recording` / `stop_recording` / `export` / `clear` and `filename` are accepted, and the overlay `options` (click indicators, drag paths, action labels, progress bar, watermark) are drawn |
| `browser_batch` | `browser_batch` | |
| `list_connected_browsers` | `list_connected_browsers` | |
| `select_browser` | `select_browser` | |
| `switch_browser` | `switch_browser` | |
| `shortcuts_list` | `shortcuts_list` | Saved quick scripts, edited from the options page |
| `shortcuts_execute` | `shortcuts_execute` | |
| — | `quick` | Compact one-line-per-action script protocol |
| side panel | popup and settings page | Claude in Chrome shows progress in a side panel. Here a toolbar popup shows the connection state, the sessions with their marks, and the last calls, with a settings page for policy and shortcuts. Both on the Ash Lumen design system |
| side panel status | tab group title | Claude in Chrome shows progress in its side panel and marks its group. Here the group title carries ⏳ / ✅ / ❌ with a matching colour, updated per call, and `tabs_context` reports the title |
| — | action journal | Every call recorded by the host as JSONL and a Markdown timeline, `npm run log`. Claude in Chrome keeps no equivalent record |
| — | `page_state` | URL, title, scroll, viewport |
| — | `wait_for_page` | Wait for load and for the DOM to settle |

All 22 are covered. Three tools have no counterpart on the Claude Code side.

Claude in Chrome's own spellings are accepted everywhere a tool name or argument is read, at the top level and inside `browser_batch`: `tabs_context_mcp`, `tabs_create_mcp`, `tabs_close_mcp`, `javascript_tool` with `action: "javascript_exec"` and `text`, `onlyErrors`, `urlPattern` (a substring there, escaped into the regex here), `deviceId`, `command` for shortcuts, and the gif action names. The mapping lives in `extension/src/lib/aliases.js` and is applied by both the server and the extension. Its quick-mode tab commands `NT`, `ST` and `LT` exist too, and a tab created earlier in a batch can be addressed by later actions as `tabId: "$last"`.

One difference is deliberate. `find` ranks locally instead of asking a model, which returns in under a millisecond and spends no tokens, at the cost of resolving descriptions by wording rather than meaning.

## Test coverage

| File | Tests | Covers |
|---|---|---|
| `journal.test.js` | 4 | Argument and result summaries, entry shape, both files written, failures marked |
| `tabs.test.js` | 4 | Navigation-start wait behind `wait_for_page`, group status marks |
| `aliases.test.js` | 6 | Claude in Chrome names and argument spellings, quick `NT` / `ST` / `LT` |
| `cdp.test.js` | 9 | Debugger transport: stale-attachment recovery, `onDetach` tracking, frame diagnostics on a refused attach |
| `a11y.test.js` | 38 | Accessibility tree against a real DOM: roles, names, refs, filtering, budgeting, shadow DOM, labels |
| `find.test.js` | 22 | Ranking, tree parsing, URL-attribute exclusion |
| `screenshot.test.js` | 10 | Downscaling, token budget, aspect ratio |
| `permissions.test.js` | 16 | Modes, grants, blocklist, origin re-verification |
| `protocol.test.js` | 10 | Native messaging framing, chunk reassembly, malformed input |
| `ipc.test.js` | 7 | Socket framing, multiple clients, large payloads |
| `parity.test.js` | 8 | Schemas and handlers describe the same tool set |
| `e2e.test.js` | 11 | MCP protocol across real spawned processes |
| `live.test.js` | 40 | Every tool against a running browser |
| `edge.test.js` | 26 | Adversarial cases (see below) |
| `shortcuts.test.js` | 5 | Saved shortcuts end to end, storage seeded through the service worker |
| `resilience.test.js` | 4 | Idle worker, host killed, session resume, in-flight failure |

### What is exercised live

All 13 `computer` actions individually: `left_click`, `right_click`, `double_click`, `triple_click`, `hover`, `type`, `key`, `screenshot`, `zoom`, `wait`, `scroll`, `scroll_to`, `left_click_drag`. Plus `modifiers`, `repeat`, `perKey` and `save_to_disk`.

Also live: same-origin iframes, open and closed shadow roots, non-ascii text through the tree and both typing paths, pointer drags and HTML5 drag and drop, file uploads to inputs and to drop zones, GIF output validated as a real multi-frame GIF89a, browser listing and selection, and saved shortcuts driving a page.

### What is not tested

- **Cross-origin iframes.** Reported as leaves by design. Reading inside one needs a frame-targeted call that does not exist yet.
- **Two browsers at once.** The multi-browser path is built and `list_connected_browsers` / `select_browser` are tested against one live browser. Nothing has exercised Chrome and Edge connected simultaneously.
- **The user's own Chrome, by the suite.** The automated files run against Chrome for Testing with an isolated profile, because Chrome 137 and later ignore `--load-extension` and loading unpacked is a manual click-through. The user's Chrome was driven by hand on 2026-09-03, see below.
- **Non-Windows platforms.** The code paths exist for macOS and Linux (unix sockets, per-browser manifest directories) and are unexercised.

## Bugs found and fixed

Every one of these was found by testing rather than review, and each has a regression test. The last one came from driving Wikipedia rather than a fixture.

| Bug | Symptom | Cause |
|---|---|---|
| Iframe clicks landed elsewhere | Reported success, page unchanged | `getBoundingClientRect` inside a frame is frame-relative; CDP dispatches in top-level coordinates |
| Iframe offsets went stale | Same, after any scroll | The offset was captured when the tree was read. Now measured live from the frame chain |
| Shadow elements read as covered | Every click inside a shadow root refused | `document.elementFromPoint` retargets a shadow descendant to its host |
| Clipped elements read as covered | Anything inside a scroll container refused | Hit tested before scrolling it into view |
| Disabled inputs accepted values | `form_input` wrote to a disabled field | No enabled check |
| Covered elements clicked the cover | Reported success, wrong element pressed | No hit test |
| Failed navigation looked successful | Landed on Chrome's error page silently | `chrome.tabs.update` reports nothing |
| Out-of-range coordinates no-op'd | Nothing happened, no error | No bounds check |
| Stale socket wiped the live one | First call after `select_browser` failed | A replaced socket's late `close` handler cleared shared state |
| Handshake race after reconnect | Same | Status message raced a 250ms fixed wait |
| Generic containers took subtree text | Every wrapper repeated everything inside it | Name-from-content applied to `generic` |
| Interactive divs had no name | A `div` with `tabindex` was unnamed and unusable | Name-from-content applied too narrowly |
| `find` matched URL substrings | "the search bar" returned a Donate link | `sidebar` inside an href scored as a match |
| A styled radio or checkbox vanished | Wikipedia's theme controls were absent from the tree | The native input is hidden with `opacity: 0` and its label is the visible control, so the input was dropped as invisible and the label as a duplicate |
| Second browser lost the pipe | Every call went to the first browser | One fixed pipe name for all browsers |
| Session dropped silently after a navigation | The call after a navigation failed with "Debugger is not attached" while the extension believed it was | Chrome force-detaches a debugger session when a navigation makes the tab one the extension may not debug. Nothing listened to `chrome.debugger.onDetach`, so the attachment map stayed stale. It is tracked now, and the message counts as recoverable |
| `find` ranked a textbox above the file input for "file input" | Uploads went to a drop target instead of the input | "input" is a role hint for textboxes, and a file input renders as a button, so the role bonus went to the wrong element. A term matching the control's `type` now satisfies the role hint |
| The suite drove the wrong browser | Live tests failed against the user's Chrome, which ran an older extension build | `anyBridge()` sorted by connection time. `npm run browser` now records its browser id in `.browsers/dev-browser-id` and the test files prefer it |
| `wait_for_page` returned before a submit navigation began | A batch of click, wait, read saw the form instead of the response | The wait checked whether the tab was loading, and a click returns before the browser has started the request. It now gives a navigation up to 600ms to start, then waits for the load and the DOM to settle, and reports `navigated` |
| A hidden alert's links looked clickable | GitHub's "Please reload this page" links appeared in every tree | The `hidden` attribute marked the element hidden but its children were still walked. It prunes the subtree now |
| Bare text was missing from the tree | `<div>Hello</div>`, a frame body holding one word, and the A and B boxes on a drag-and-drop page produced no output | Only elements with a role were emitted. Text directly inside a container with no role is emitted as `text` nodes, outside the interactive filter |
| A soft navigation read the old page | On GitHub, click Issues then `wait_for_page` then `read_page` returned the header and footer only | The React app fetches, then renders, and neither the load event nor a 120ms DOM quiet check waits for that. `wait_for_page` now waits for in-flight requests to drain (bounded at four seconds) before the settle check, and reports `networkIdle` |
| Page text included collapsed panels and menus | Wikipedia's search page dumped its advanced-search panel, an article began with the appearance menu | `display:none` was checked on the text node's parent only. Visibility is judged through ancestors with `checkVisibility`, navigation, aside and page-level header and footer regions are skipped, select options are not run together, and adjacent inline elements get a space |
| Page text ignored frames | A frameset page read as "(no text)" | Only the top document was walked. Same-origin frames are walked recursively |
| Page text reported a wrong total | A full opinion piece reported 1478 chars total | The walk stopped at twice the budget and reported that as the size. The whole page is counted now |
| A consent dialog was invisible to the tree | The Guardian's tree showed the page underneath the cookie dialog as if clickable | The dialog is a cross-origin iframe. The tree now opens with a note naming the frame and the share of the viewport it covers, and says to act by coordinate |
| `find` missed a query made of role words | "search box" found nothing on Wikipedia while a "Search" link was on the page | Role-hint words were excluded from name matching. They still count, at reduced weight |
| `find` filled its result with copies | Twenty identical label links on GitHub's issue list | Identical role, name and attributes are collapsed to one entry with a count |
| Batch output hid useful results | Console and network reads, tab context and a saved screenshot's path collapsed to "ok" inside a batch | Those steps are inlined now, and any step that produced an image also inlines its text line |
| The browser was brought to the front on every action | The user lost their place whenever the agent clicked or captured | Visibility was treated as a requirement for input and capture. Hidden tabs are woken through CDP instead and captured through a screencast frame, so nothing is activated or focused any more |
| A blank tab appeared in front when a session ended | An about:blank tab opened selected when the last empty session tabs closed in the browser's last window | The guard against quitting the browser created a replacement tab as the active one. One of the tabs about to close is kept instead |
| `find` collapsed same-named buttons | Ten "Add to cart" buttons became one entry with a count | Dedupe keyed on name and attributes. It now collapses only links to the same href |
| `resize_window` restored a minimized window | The window came to the front | It set the state to normal unconditionally. Only maximized and fullscreen windows are normalised now |
| Popup history vanished on worker restart | Recent calls emptied after an idle period | Kept in memory only. It is mirrored to session storage |
| Closing a tab could quit the browser | `tabs_close` on a session's last tab closed its window, and with no other window Chrome exited and took the bridge with it | Chrome closes a window with its final tab. A blank tab is now inserted first, so closing one tab closes exactly one tab |

## Verification on real browsers, 2026-09-03

The one open bug from the previous handoff was that on the user's own Chrome every CDP command failed with `Cannot access a chrome-extension:// URL of different extension` while the content-script path kept working. What was run, in order, on the user's Chrome 152 (profile "Profile 3", extensions installed: Claude, ChatGPT, Bitwarden, Chrome Remote Desktop, Google Docs Offline, Google Wallet):

1. With the extension build that carried the retry in `send()`: navigate the session's first tab to `https://httpbin.org/forms/post`, screenshot (ok), two `form_input` fills (ok), click the "Medium" radio: **failed** with the exact message. Navigating that tab to example.com and clicking again failed with "Debugger is not attached".
2. Through Claude in Chrome in the same profile: loaded the same page, clicked the name field with a real CDP click, and listed the DOM including shadow roots. Only a `form` in `body`, no iframes. Claude's extension evaluated JS through CDP there without trouble, so the page itself passes Chrome's check.
3. After reloading the extension (verified as v0.1.2 through `npm run doctor`): the same first tab still failed, this time from `chrome.debugger.attach` itself, so Chrome refused to attach to that tab at all.
4. In a fresh tab created at example.com: javascript, screenshot, click, javascript, all ok. Navigate it to httpbin, then the full sequence with a CDP probe between every step: all ok.
5. In a fresh tab created blank first and then navigated to httpbin: all ok.
6. All session tabs closed, `tabs_context createIfEmpty` again (the same new-window path the failing tab came from), navigate to httpbin, fill name and email, click Medium, click Bacon, click Submit, wait, read the page: **httpbin echoed `custname`, `custemail`, `size: medium`, `topping: bacon`**.

So the flow the handoff asked for passes on the user's Chrome. What is established: the refusal is a property of a particular tab, not of the page or the profile, and it survives navigations within that tab. The only tab that showed it had been driven by the extension build loaded before the reload. What is not established: which frame or target Chrome is objecting to. The attach and command failure paths now append `chrome.webNavigation.getAllFrames` and `chrome.debugger.getTargets` output for the tab to the error, naming any `chrome-extension://` frame that is not ours, so the next occurrence carries the answer. A useful experiment that was not run: keep a session tab open, reload the extension at `chrome://extensions`, and attach to that tab again. If it is refused, the trigger is the reload itself.

After a second reload of the extension on the user's Chrome (v0.1.2 with the current-window and alias changes): `tabs_context` reported no tabs, so the session's group from before the reload was gone and the planned attach-after-reload experiment could not be run. Whether the window was closed by hand or the reload dropped the stored group mapping was not established. A new session tab then opened in the user's current window, and the httpbin flow passed again through CDP clicks (echo showed `custname: Reload Check`, `size: large`).

### Audit on real sites, 2026-09-03

Driven by hand on the user's Chrome: Wikipedia (search with per-key typing and suggestions, results, an article, back and forward), GitHub (repository page, the React issues list, the filter combobox), the-internet.herokuapp.com (dropdown, hovers, shadow DOM, TinyMCE in an iframe, nested framesets, dynamic loading, HTML5 drag and drop, key presses, a link opening a new window), Hacker News (scroll then click by coordinate), a personal blog, the Guardian (cookie dialog in a cross-origin frame, an article, `scroll_to`), and the home page of a video site built on custom elements with a lazily rendered grid. Worked as expected: per-key typing into autocompletes, history navigation, hover-revealed content, open shadow roots, a select through `form_input`, HTML5 drag and drop, key presses including Shift+Tab, coordinate clicks after scrolling, a coordinate click into a cross-origin consent frame, a tab opened by a click joining the session group, zoom, saved screenshots. Everything that did not work is in the bugs table above. Each fix was then verified on the development browser against the same pages.

Known limits seen during the audit: `find` is lexical, so "most viewed article link" cannot find links whose names share no word with the query. A page that renders five seconds after a click with no network or DOM activity in between (the-internet's dynamic loading example) is read too early by `wait_for_page`, which has nothing to wait on.

The development browser exited six times during the session with exit code 0. The user later said they had been closing its window by hand, which is what a clean exit with nothing in the logs looks like. Not a bug. The launcher keeps --enable-logging with --log-file=.browsers/chrome.log, which is cheap and answers this class of question next time. It was restarted each time and the probes after each restart passed.

## Constraints that shape the implementation

Five behaviours that are not visible from a tool surface, each of which silently breaks a naive implementation.

**A pending `setTimeout` does not keep an MV3 service worker alive.** Chrome suspends the worker while it awaits one, so a 100ms hover delay measured about five seconds and every click paid it. Timed waits run on the page's clock through `Runtime.evaluate`, which keeps the worker busy on a pending extension API callback.

**`Input.dispatchMouseEvent` answers only after the renderer processes the event.** A throttled renderer holds that answer for a fixed five seconds. Dispatch waits briefly and moves on, since the event is delivered either way, and records that the renderer looked throttled so the next action can bring the window forward.

**Chrome reports a fully covered window as occluded**, which sets `visibilityState` to `hidden` and makes the renderer drop input outright rather than delay it. Whether a test passed depended on which window happened to be in front. The development browser launches with `--disable-features=CalculateNativeWinOcclusion`. The agent now works in hidden tabs by design and never raises anything: on attach it sends `Emulation.setFocusEmulationEnabled` and `Page.setWebLifecycleState active`, which on Chrome 152 make a hidden or minimized tab answer input in a millisecond, run animation frames and report itself visible. Screenshots of hidden tabs come from a single screencast frame (about 50ms), because a surface capture of a hidden tab takes seconds and the extension debugger API refuses renderer captures ("Only screenshots from surface are allowed").

**`requestAnimationFrame` stops entirely in a hidden tab**, so an rAF-driven settle loop never resolves. Waiting for the DOM to quieten runs on timers.

**Chrome caches the compiled module graph for an extension service worker** across browser restarts, so a cold start can run stale code while serving the edited file over `chrome-extension://`. On Chrome 152 the cache that matters is `Default/Extension Scripts` in the profile, alongside `Service Worker` and `Code Cache`. `npm run browser` clears all three on launch. `chrome.runtime.reload()` over the DevTools port did not drop it: an edited `wait_for_page` kept returning the old result shape until the browser was restarted with the directory removed.

## Architecture

```
Claude Code ──stdio──> mcp-server.js ──named pipe──> native-host.js ──native messaging──> extension ──CDP──> page
```

Each connected browser gets its own native host, its own pipe, and one entry in a registry directory. An MCP server discovers browsers through that registry, uses the only one when there is one, and asks the session to choose when there are several. The host is the listener and MCP servers are clients, so several Claude Code sessions share one browser.

Payloads above 384KB are chunked, because Chrome caps a single native message at 1MB and screenshots exceed it.

The installer resolves the real path to the node binary with `realpath` before writing the host wrapper. Chrome spawns the host from the browser process rather than a shell, and fnm's `process.execPath` points into a per-shell directory that disappears when the terminal closes.

## Running it

```bash
npm install
npm run install-host    # registers the native messaging host, id comes from the committed manifest key
npm run doctor          # checks every link in the chain
```

Then load `extension/` at `chrome://extensions` with Developer mode on, and restart Chrome. That step is manual because Chrome 137 and later ignore `--load-extension`.

```bash
npm test                # everything, about five minutes with a browser up
npm run browser         # isolated development browser with the extension loaded
npm run test:live       # browser tests only
npm run test:resilience # the slow recovery tests on their own
```

The browser-driven files share one bridge, so the suite runs with `--test-concurrency=1`. Running them in parallel had the recovery tests killing the bridge underneath the live tests.

With more than one browser connected the browser-driven files pick, in order, `CHROME_MCP_BROWSER_ID`, the browser recorded in `.browsers/dev-browser-id` by `npm run browser`, then the earliest connected. The full run takes about five minutes with a browser up. During development run the file you are working on, and `npm run test:fast` skips the recovery tests.

## Known limits

- Loading the extension is manual on Chrome 137 and later
- Cross-origin iframes are reported as leaves
- A JavaScript modal dialog blocks all further extension calls until a human dismisses it, which is a Chrome constraint
- The CDP debugger banner is visible on tabs the session has attached
- A site probing for CDP automation can detect the session. On 0.1.7, `deviceandbrowserinfo.com/are_you_a_bot` returned `isBot: true` on all three runs with `isAutomatedWithCDP: true` as the only flag set, while every spoofable signal read clean: webdriver, Selenium, Playwright and headless markers `false`, and canvas, WebGL, plugin and user-agent fingerprints identical to the same Chrome driven by hand (`docs/claude-in-chrome-comparison/evidence/D-bot-detection.md` section 4). `browserscan.net/bot-detection` reported Normal on the same build, including its own CDP section, so vendors disagree on the heuristic. 0.1.13 makes console capture opt-in, so `Runtime.enable` is never issued on a tab that does not read the console, which reduces the surface without removing it
- Completely covering the browser window can stall input until the extension raises it again
- `wait_for_page` cannot catch an update driven by a bare timer with no DOM or network activity, because it has nothing to wait on. `test/campaign.test.js` uses a retry loop for that case
- `chrome.runtime.reload()` disables an unpacked extension on Chrome for Testing 152. Sent from the service worker over the DevTools port it takes the extension down and Chrome does not bring it back: the profile records `disable_reasons [16777216]` against the extension id, the worker and offscreen targets are gone, creating a tab does not wake it, and only a browser restart restores the bridge. Three runs, deterministic, and the interferer loaded from the same command line stays enabled. It is not a developer reload path on this Chrome. Pick up an edit by restarting the browser, and exercise the session restore by stopping the worker from `chrome://serviceworker-internals`, which is the path `test/tabs.test.js` covers. The first pass ran the same call on 0.1.11 and the bridge came back, so this is worth re-checking after a Chrome for Testing update
- Letting the worker idle out is not a route to a restart while the bridge is attached. The extension holds a native messaging port to the host, and a connected port keeps the worker alive: with a session holding two tabs and nothing else running, the worker target stayed in the DevTools list for 180 s. The Stop button on `chrome://serviceworker-internals` is the route that works. It is a `cr-button` in a shadow root and only a trusted click reaches the WebUI handler, so it has to be pressed with `Input.dispatchMouseEvent` on that page's CDP target

## Plan phases 0 to 3 integrated, 2026-09-03

Five branches off `main`, merged onto `plan/integration` in the order harness, host-contract, attach-recovery, content-verify, profiles. Extension version 0.1.11.

What each branch landed:

- `plan/harness` (Phase 0): the campaign fixture and its Node server (`/slow`, `/big`, `/redirect`, `/spa`, `/dialog`, `/api/*`, plus `/sensitive.html`, `/unload.html`, `/scroll.html`, `/composer.html`), `test/campaign.test.js` as the "already ahead" table, and `tools/bench.js` behind `npm run bench`.
- `plan/host-contract` (Phase 1, host half): `host/errors.js` as the one result shape and error catalogue, contract marshalling with retries and correlation ids in `host/mcp-server.js`, output caps and credential-shaped redaction on the read path, a parked response queue with a generation stamp, journal rotation and the `CHROME_MCP_JOURNAL_REDACT` switch.
- `plan/attach-recovery` (C2, C5, C6 extension half, R14): the attach recovery ladder with tab replacement, dialogs answered and reported in the result, a bounded frozen renderer, an offscreen document keeping the worker alive, stale results dropped after a reconnect, and batch pre-validation.
- `plan/content-verify` (C3, R2, R3, R5, R7, S4, S7, P5, P9, F1): every input arms a watch in the page and reports `effects` and `evidence`, `get_page_text` falls back to `body` and names the container, per-key typing carries real key codes, drags dwell either side of the movement, `read_page interactive` fits a news page inline, sensitive fields are redacted at the source.
- `plan/profiles` (M1 to M5): profile directory, name and account per connected browser, a user-set label from the options page, signed-in site detection, `select_browser` by label, profile, account or site, a per-call `browser` argument, and the profile row in `npm run doctor`.

Cross-track work done at the merge: one catalogue of 25 codes with `invalid_argument` folded into `bad_request` and `unknown_failure` into `internal`, `callId` as the single correlation id, `journal_note` messages written as journal lines, the `tabs.adopted` hook implemented so a click reports the tab it opened, `mouseDrag` and `typeKeys` redirected to the helpers that replaced them, and the manifest permissions merged.

Test counts on 2026-09-03, `node --test` per file, no browser running:

| File | Tests | Pass |
|---|---|---|
| a11y.test.js | 44 | 44 |
| aliases.test.js | 6 | 6 |
| batch.test.js | 8 | 8 |
| campaign-server.test.js | 14 | 14 |
| cdp.test.js | 22 | 22 |
| errors.test.js | 33 | 33 |
| find.test.js | 28 | 28 |
| ipc.test.js | 17 | 17 |
| journal.test.js | 18 | 18 |
| parity.test.js | 8 | 8 |
| permissions.test.js | 16 | 16 |
| profile.test.js | 20 | 20 |
| protocol.test.js | 14 | 14 |
| redact.test.js | 19 | 19 |
| registry.test.js | 20 | 20 |
| screenshot.test.js | 15 | 15 |
| sensitive.test.js | 16 | 16 |
| sessions.test.js | 14 | 14 |
| tabs.test.js | 12 | 12 |
| verify.test.js | 21 | 21 |
| **Total** | **365** | **365** |

`node tools/check-errors-copy.js` reports the extension copy matches. `node --check` passes on all 29 files under `extension/src` and `host`.

The six browser-driven files (`live`, `e2e`, `edge`, `resilience`, `shortcuts`, `campaign`) were not run, and neither was the live verification pass. Nothing in this merge has been driven against a browser.

## Plan wave 2 integrated, 2026-09-04

Five branches off `plan/integration`, merged onto `plan/integration2` in the order screenshots, detect, gif-find, indicator, writes. Extension version 0.1.13, which adds the `notifications` permission and a second content script.

What each branch landed:

- `plan/screenshots` (R4, P2, P3): screenshots are JPEG at quality 0.75 by default with `format`, `quality` and `scale` arguments, a byte budget that lowers quality before it lowers size, a clip fast path that asks CDP for the crop instead of redrawing it on a canvas, a hidden-tab path that takes the screencast frame at the target size, and a batch frame held from `beginBatch` to `endBatch` so coordinates written against the pre-batch image still land. `npm run bench:screenshot` measures ten captures.
- `plan/detect` (D1, D3, D4, D5): `Runtime.enable` is no longer part of joining a session, it goes on when `read_console_messages` first runs on a tab and off again on a read that clears the buffer, with an `always` setting on the options page and a pre-arm for a batch whose later step reads the console. Typing draws each inter-key interval around a mean of 60 ms (`cadence` on `computer type`), and a click or hover moves the pointer along a bowed 3 to 6 point path inside the gap it already spent. `tools/probe-detect.js` measures both against the campaign fixture.
- `plan/gif-find` (P1, P6, P10, plus navigate and upload fixes): GIF frames carry click rings, action labels, a progress bar, a watermark and real elapsed time, `find` escalates to MCP sampling when the local score is weak or `semantic` is set, `pressKey` refuses the ctrl/cmd zoom chords, pressed and held mouse events carry `force`, `navigate back` and `forward` go through `Page.navigateToHistoryEntry` and wait for the load, and upload filenames are normalized.
- `plan/indicator` (F4, D2): a three-state acting indicator drawn into the cursor overlay's closed shadow root, a pulsing border and Stop button on the tab being driven, a pill on the session's other tabs, and both hidden from screenshots by the existing hide and show pair. Stop halts a running batch and every later call with the `stopped` code until Resume. The overlay host id is random per install, and `file_upload` resolves its target without writing a marker attribute onto the page.
- `plan/writes` (W2, W4, W5, W7, F5, F6): a submit-shaped click or Enter gets a 3 s window and five named signals under `evidence.submit.fired`, confirm mode refuses an irreversible click once with `confirmation_required` and a single-use token bound to tab, origin and control, an irreversible action returns a `write` row the host copies into the journal, a reversible one returns an `undo` hint, `declare_plan` grants a session's declared origins in plan mode, and a call on a new origin carries a transition warning.

Cross-track work done at the merge:

- The batch runner in `background.js` runs one order for all four tracks: pre-validate, refuse to arm anything when the session is stopped, arm console reads, open the screenshot batch frame, check `isStopped` between steps, close the frame in a `finally`.
- `cdp.js` keeps detect's `movePointerTo`, which records every `mouseMoved` and waits for an acknowledgement only on the final point, and carries gif-find's `force: 0.5` on any point of that path dispatched with a button held.
- The click path in `tools.js` runs the confirm gate and the before-write capture, dispatches inside the submit window, records the GIF frame with the action name and the point, reads the submit evidence, then adds the undo hint and the audit row.
- `computer` gained `format`, `quality`, `scale`, `cadence`, `confirm` and `replace`, `find` gained `semantic`, `gif_creator` gained `options`, and `declare_plan` was added. Nothing was renamed or removed, and `test/parity.test.js` passes.
- The error catalogue gained `stopped` and `confirmation_required`. `extension/src/lib/errors.js` matches `host/errors.js`.
- The options page renders and saves the browser label, the five permission modes, the ask-in-browser switch, the write allow-list and the console capture choice from one `options.html` and one `options.js`.

Test counts on 2026-09-04, `node --test` per file, no browser running:

| File | Tests | Pass |
|---|---|---|
| a11y.test.js | 47 | 47 |
| aliases.test.js | 6 | 6 |
| batch.test.js | 8 | 8 |
| campaign-server.test.js | 15 | 15 |
| cdp.test.js | 48 | 48 |
| errors.test.js | 33 | 33 |
| find.test.js | 43 | 43 |
| gif.test.js | 30 | 30 |
| indicator.test.js | 9 | 9 |
| ipc.test.js | 17 | 17 |
| journal.test.js | 24 | 24 |
| parity.test.js | 8 | 8 |
| permissions.test.js | 29 | 29 |
| profile.test.js | 20 | 20 |
| protocol.test.js | 14 | 14 |
| redact.test.js | 19 | 19 |
| recorder.test.js | 8 | 8 |
| registry.test.js | 20 | 20 |
| screenshot.test.js | 44 | 44 |
| sensitive.test.js | 16 | 16 |
| sessions.test.js | 14 | 14 |
| tabs.test.js | 17 | 17 |
| verify.test.js | 30 | 30 |
| **Total** | **519** | **519** |

`node tools/check-errors-copy.js` reports the extension copy matches. `node --check` passes on all 41 files under `extension/src`, `host` and `tools`.

The six browser-driven files (`live`, `e2e`, `edge`, `resilience`, `shortcuts`, `campaign`) were not run. Nothing in this merge has been driven against a browser, and the live checks each branch asked for are still open.

## Live verification of the merged build, 2026-09-04

The pass is written up in `docs/claude-in-chrome-comparison/evidence/VERIFY-0.1.11.md`, one entry per check with the call and the verbatim result. It ran entirely against the development browser started by `node tools/browser.js --interferer --detach`, with `test/fixtures/interferer` loaded so the attach recovery ladder fires on every page.

Two tools were added for it. `tools/mcp-client.js` spawns `host/mcp-server.js` from the working tree and drives it over stdio, as a library and as a one-off CLI, because a Claude Code session's MCP tools are bound to whichever server process it started. `tools/browser.js --interferer` loads the second extension.

Of the 57 checks: 39 passed, 5 passed after a fix made during the pass, 6 were partial, 2 failed, and 7 are deferred because they need a signed-in profile or a DevTools window opened by hand.

Eleven fixes landed, each with a unit test and a manifest bump. Extension 0.1.11 to 0.1.27. The ones that changed behaviour a caller can see:

- Screenshots of a hidden tab did not work at all. A sleeping tab emits no screencast frame, and once woken, the frame a screencast opens with is the surface as it was before the redraw that request forced. The capture now wakes the tab, waits two animation frames, and opens screencasts until two carry the same image. A window that stays barren is raised as `timeout`, which the read retry policy handles.
- Per-key typing inserted every character twice, so `ja` arrived as `jjaa` and the jQuery UI autocomplete never opened. Both the keyDown and the char event carried the text.
- A click on an inert element reported `effects: applied`, because focus falling back to the body counted as a focus change and the value comparison read whatever held focus at the end of the window.
- A type with nothing able to hold text focused reported `ok`. It is now a `no_effect` naming what did have focus.
- Chrome's `chrome://` refusals were classified as `internal` rather than `origin_blocked`.
- A tab opened by a click was recorded after the click had already read the bookkeeping.

Ten open bugs are listed at the end of the verification file with their reproductions. The ones worth reading first: a batch does not pre-validate refs the way it pre-validates tool names, a session does not survive `chrome.runtime.reload()`, and calls are serialized behind a frozen renderer so a long `javascript` blocks the next call for its whole duration.

## Verification fixes merged into wave 2, 2026-09-04

`plan/integration` was merged into `plan/integration2`, so the eleven fixes the verification pass made sit on top of the wave 2 work. Extension version 0.1.28.

Four files conflicted. What each merged version does:

- `cdp.js`, the hidden-tab capture. The tab is woken with `force: true`, then read from the renderer with `fromSurface: false`, which is a fresh frame of the current document and carries `clip` with its scale natively. Where a build refuses that, the screencast fallback keeps wave 2's sizing: a clip covering the whole viewport is asked for through `maxWidth` and `maxHeight` rather than cropped in a canvas, and a narrower clip is cropped against `scroll`. Both screencast routes go through `settledScreencastFrame`, which waits two animation frames and opens screencasts until two carry the same image, with a barren window raised as `timeout` so the read retry policy rescues it. The visible path is unchanged: one `Page.captureScreenshot` from the surface with `clip` and JPEG quality.
- `cdp.js`, typing. `pressPrintable` sends one keyDown carrying the key identity and no text, then the char event that does the insert, so a character arrives once. `typeKeysReal` keeps the jittered cadence around a 60 ms mean and the `cadence` argument.
- `tools.js`, the click and type paths. `dispatchVerified` takes both `ref`, so a write is watched on the element it names, and `retry`, so a submit-shaped click is never dispatched twice. The type path passes `input.cadence` and `{ ref: input.ref }`, records the GIF frame with its action name, and still fails with `no_effect` when nothing able to hold text had focus. The click path keeps the confirm gate, the before-write capture, the 3 s submit window, the undo hint, the audit row and the GIF frame with its point.
- `manifest.json` and `STATUS.md`, version and section text.

`agent.js`, `tabs.js`, `background.js`, `errors.js` and the test files merged without conflicts, and the behaviour each side added is present: a click on an inert element reports `effects: none` because focus falling back to the body is not counted and the value is compared on the element the watch was armed on, an opened tab is recorded synchronously before the click reads the bookkeeping, `chrome://` refusals classify as `origin_blocked`, and the indicator's stop state and the batch runner's arming order are unchanged.

One assertion was rewritten. `test/screenshot.test.js`, "a hidden tab asks the screencast for the target size", asserted that no `Page.captureScreenshot` was attempted at all. It now asserts that no capture was taken from the compositor surface, which is what the assertion was about, since the renderer probe is a `Page.captureScreenshot` with `fromSurface: false`. A test was added beside it for the case the probe answers: the clip and its scale reach the renderer capture and no screencast is opened.

Test counts on 2026-09-04, `node --test` per file, no browser running:

| File | Tests | Pass |
|---|---|---|
| a11y.test.js | 47 | 47 |
| aliases.test.js | 6 | 6 |
| batch.test.js | 8 | 8 |
| campaign-server.test.js | 15 | 15 |
| cdp.test.js | 50 | 50 |
| errors.test.js | 33 | 33 |
| find.test.js | 43 | 43 |
| gif.test.js | 30 | 30 |
| indicator.test.js | 9 | 9 |
| ipc.test.js | 17 | 17 |
| journal.test.js | 24 | 24 |
| parity.test.js | 8 | 8 |
| permissions.test.js | 29 | 29 |
| profile.test.js | 20 | 20 |
| protocol.test.js | 14 | 14 |
| recorder.test.js | 8 | 8 |
| redact.test.js | 19 | 19 |
| registry.test.js | 20 | 20 |
| screenshot.test.js | 45 | 45 |
| sensitive.test.js | 16 | 16 |
| sessions.test.js | 14 | 14 |
| tabs.test.js | 18 | 18 |
| verify.test.js | 36 | 36 |
| **Total** | **529** | **529** |

`node tools/check-errors-copy.js` reports the extension copy matches. `node --check` passes on all 42 files under `extension/src`, `host` and `tools`.

The six browser-driven files (`live`, `e2e`, `edge`, `resilience`, `shortcuts`, `campaign`) were not run. The merged build has not been driven against a browser: the verification pass ran on `plan/integration` before wave 2 was merged in, so its ten open bugs stand and the wave 2 live checks are still open.

## Live verification of wave 2, 2026-09-04

The pass is written up in `docs/claude-in-chrome-comparison/evidence/VERIFY-0.1.28.md`, one entry per check with the call and the verbatim result. It ran against the development browser started by `node tools/browser.js --interferer`, with `test/fixtures/interferer` loaded so the attach recovery ladder fires on every page, and drove `host/mcp-server.js` from this tree through `tools/mcp-client.js`. The user's Chrome was never driven.

Of the 48 checks: 35 passed, 4 passed after a fix made during the pass, 8 were partial and 1 failed. The deferred work is a separate list, since it needs a signed-in profile.

Five commits landed:

- `7091092` `tools/probe-detect.js` parsed the `javascript` result envelope as the recording, so every run printed "nothing was measured" while the page had recorded a full cadence and a full pointer path. It also now uses `tools/mcp-client.js` rather than its own fallback client. With that fixed, per-key typing measures a 15.7 percent coefficient of variation around a 73 ms mean, against the 1 percent band 0.1.7 produced, and the pointer path draws 3 to 6 points.
- `935e887` A recording reported the stop call's own latency, about 0.8s, rather than its span, because `gif.stop()` answered in `durationMs` and `runTool` overwrites that field. The span travels as `recordedMs` now. Extension 0.1.29.
- `8894336` The indicator's pill painted while marked hidden, because `.ind-pill` sets `display:flex` and an author rule beats the user agent's `[hidden]{display:none}`. Every tab being driven carried an empty dark capsule at the bottom of the viewport. Extension 0.1.30.
- `a981f2e` and `e646106` Fixture work the checks needed: a second file input on `/index.html`, `gifview.html` for decoding a recording's frames with `ImageDecoder`, and an Enter handler on the composer, since a form does not submit implicitly from a contenteditable.

What the pass confirmed on the merged build. No `Runtime.enable` in a session that never reads the console, with all four detector pages reporting no bot across three runs each. Screenshots as JPEG at 2.2x fewer bytes, ten captures in 1301 ms. Hidden-tab capture in 107 ms. A coordinate written against a pre-batch screenshot still landing after the batch took its own. Stop and Resume driven by trusted clicks through the DevTools port. Confirm mode's single-use token, and the write journal with and without redaction. The seven first-pass checks re-run to confirm the merge kept those fixes.

Ten new open bugs are listed at the end of the verification file with their reproductions. The ones worth reading first: the screenshot clip fast path never engages because the plan sizes from the metrics device pixel ratio while the capture returns CSS pixels, so every scaled capture warns and pays for a discarded capture; a `navigate` that changes origin carries no transition warning, because the gate reads the tab's URL before the move; and an unanswered ask-in-browser notification waits the full 120 s host timeout and then reports a renderer failure.

## Bug fixes merged into wave 2, 2026-09-04

`plan/bugs` was merged into `plan/integration2`, so the ten fixes for the bugs the first verification pass left open sit on top of wave 2 and on top of the second pass's five commits. Extension version 0.1.31.

One file conflicted, `extension/manifest.json`, where both branches had bumped the version on their own, 0.1.30 against 0.1.29. The merged value is 0.1.31.

`host/mcp-server.js` was the only other file both branches changed. It merged without a conflict and both sides are present: `clipNote` and the per-step contract line from `plan/bugs`, and the `recordedMs` span in `formatGif` from the pass.

`extension/src/lib/cdp.js` came across whole from `plan/bugs`, which is what the merge should do because the pass never touched that file. Its line endings are LF, so it shows in `git diff --stat` as 184 insertions rather than as all 1936 lines.

What the ten fixes change:

- `find` ranked over a tree cut to 200000 characters, which on a 3000 row page left the node the query named outside the search. The ranking budget is 1000000 characters now, and a quoted label or a run of query words in order scores as an exact match and outranks a fuzzy hit.
- A click on an element that opens a tab reports `newTabId`. The watch decides at arm time whether the element opens a tab, from `target="_blank"` on it or an ancestor or an inline `window.open`, then polls the adoption bookkeeping for up to 1500 ms. Every other click keeps its 250 ms window.
- The attach replacement ladder is capped at one tab per cause, so a refusal repeating its predecessor's cause returns `attach_refused` naming the extension frame holding the tab.
- A CDP command queued behind one that has not answered fails with `timeout`, `effects: none` and the reload hint, counted from the moment it was queued. The command it waited behind still finishes. Input dispatch is sent with timeout 0 and is neither tracked nor waited on.
- A batch resolves every distinct ref against its tab before the first item runs, so a stale ref fails the batch with `batch_invalid` naming the item, the ref and the tab, instead of costing the side effects of the items before it. A ref an earlier `read_page` or `find` on the same tab is about to create is skipped.
- `resize_window` sends the state change and the size as separate `windows.update` calls, because Chrome ignores a size that arrives with a state change. The result is read back from `chrome.windows`, a size that did not take is retried once, and `matched` is judged against the bounds Chrome reports.
- Every line of a batch or a `quick` script prints its own `ok`, `effects`, `evidence` and `warnings`, so a screenshot taken inside a script can be checked for `evidence.paint.painted`. A failed step prints its code, effects and retryable flag. `stepContractLine` lives in `host/errors.js` and is mirrored into the extension copy.
- `read_console_messages` and `read_network_requests` carry `clipped`, `clippedTo` and `longestClipped`, and both replies end with a line giving the row count and the clipping, the way `read_page` already did.
- `doctor` prints journal redaction and retention as the native host reports them in `browser_status`, one line per connected host, and marks its own shell's reading as the one that does not count.
- A session survives `chrome.runtime.reload()`. The session table is written to `chrome.storage.session` and `chrome.storage.local` on every change and read back at worker start. Tabs that still exist are grouped again without activating anything, and tabs that are gone are named once, with a warning, on the first `tabs_context` after the restart.

Test counts on 2026-09-04, `node --test --test-concurrency=1` per file, no browser running:

| File | Tests | Pass |
|---|---|---|
| a11y.test.js | 47 | 47 |
| aliases.test.js | 6 | 6 |
| batch.test.js | 13 | 13 |
| campaign-server.test.js | 15 | 15 |
| cdp.test.js | 59 | 59 |
| errors.test.js | 37 | 37 |
| find.test.js | 50 | 50 |
| gif.test.js | 30 | 30 |
| indicator.test.js | 10 | 10 |
| ipc.test.js | 18 | 18 |
| journal.test.js | 24 | 24 |
| parity.test.js | 8 | 8 |
| permissions.test.js | 29 | 29 |
| probe-detect.test.js | 8 | 8 |
| profile.test.js | 20 | 20 |
| protocol.test.js | 14 | 14 |
| recorder.test.js | 8 | 8 |
| redact.test.js | 22 | 22 |
| registry.test.js | 20 | 20 |
| screenshot.test.js | 45 | 45 |
| sensitive.test.js | 16 | 16 |
| sessions.test.js | 14 | 14 |
| tabs.test.js | 23 | 23 |
| verify.test.js | 46 | 46 |
| **Total** | **582** | **582** |

`node tools/check-errors-copy.js` reports the extension copy matches. `node --check` passes on all 42 files under `extension/src`, `host` and `tools`.

The six browser-driven files (`live`, `e2e`, `edge`, `resilience`, `shortcuts`, `campaign`) were not run. The ten bugs the second pass opened are untouched by this merge. The live checks the ten fixes ask for are open: `resize_window` against a maximized window, a session read back after `chrome.runtime.reload()`, the replacement ladder against the interferer, a queued CDP command behind a busy renderer, and `doctor` against a host started with `CHROME_MCP_JOURNAL_REDACT` set.

## Live verification of the first wave-2 bug fixes, 2026-09-04

The pass is written up in `docs/claude-in-chrome-comparison/evidence/VERIFY-0.1.31.md`, one entry per check with the call and the verbatim result. It ran against the development browser started by `node tools/browser.js --interferer` and drove `host/mcp-server.js` from this tree through `tools/mcp-client.js`. The user's Chrome was never driven.

Fourteen checks: the ten fixes merged from `plan/bugs`, a re-run of seven first-pass checks, a re-run of four second-pass checks, the test and bench files, and a recording decoded frame by frame. Ten passed outright, three passed with a caveat now carried as an open bug, and the drag part of the recording check was not exercised because the script used the wrong argument name for the drag origin.

Two commits landed during the pass:

- `e4c2e59` A type into a field inside an iframe was reported as `no_effect` and retried by the host, so the text landed twice. `document.activeElement` in the parent reports the frame element, and the element that actually has focus lives in the frame's own document. `focusedEditable` answers `null` for a frame element now, and the `no_effect` check fires only on an explicit `false`.
- `56b01c9` A click that opens a tab found no `newTabId` when Chrome named the wrong opener. Chrome fills `openerTabId` from the active tab, and background mode never activates the tab it drives. `tabs.js` keeps a 3 s ledger of page-opened tabs, and a click the watch flagged as opening a tab falls back to it, reporting only a candidate that ended up in the acting tab's group.

Three bugs were opened and are fixed in the section below.

## Second set of bug fixes merged into wave 2, 2026-09-04

`plan/bugs2` was merged into `plan/integration2`, so the ten fixes for the bugs the second verification pass left open sit on top of the third pass's two commits. Extension version 0.1.33, and 0.1.34 with the three fixes below.

The merge produced no conflicts. Both branches had bumped `extension/manifest.json` to 0.1.32 on their own, which git resolved as the same change, and the merged value was set to 0.1.33 by hand. `extension/src/lib/tools.js` and `extension/src/content/agent.js` were the two files both branches changed and both merged cleanly, with all four sides present: required-argument validation, screenshot by `imageId`, the `pressesEnter` submit test and the `confirmGate` export from `plan/bugs2`, the iframe `no_effect` check and the new-tab fallback in `readVerify` from the pass, `clickPointFor` with `getClientRects` from `plan/bugs2`, and `focusedEditable` for frame elements from the pass. `extension/src/lib/cdp.js` shows in `git diff --stat` as 39 insertions rather than as all of its lines, so the line endings match the rest of the tree.

What the ten fixes change:

- A `javascript` return value is dropped from the journal when `CHROME_MCP_JOURNAL_REDACT` is on, and when it repeats a string a sensitive write or a denylisted argument already had redacted in this session. This governs the journal only.
- A `navigate` that changes origin carries the transition warning on its own result. `checkPermission` takes `noteTransition`, and `navigate` passes false, so the origin is recorded by the check that runs on the URL the tab landed on.
- An unanswered browser confirmation waits 60 s rather than the host's 120 s call timeout, closes the notification on the way out, and returns `confirmation_required` with `retryable` false.
- A confirmation renders the screenshot id beside the token, the control and the origin, and `computer` takes an `imageId` for action `screenshot`, which returns the stored capture rather than taking a new one.
- Submit detection reads the same key table the dispatch reads, so Return, NumpadEnter, a chord ending in Enter and a bare newline all open the three second window.
- A call missing an argument the schema declares required is refused with `bad_request` naming the argument, in the host before a browser is chosen and in the extension from `lib/required.js`. `test/parity.test.js` asserts the two tables agree.
- Gif frames are captured with the acting indicator hidden, the way screenshots already were.
- A ref click aims at a line box rather than at the centre of the bounding box, which is not on the element when the element is inline and its text wraps. The covered check reads the same point.
- A cleared console buffer stays cleared, because entries stamped before the clear are dropped as they arrive rather than replayed by `Runtime.enable`. The warning says which of three things happened.
- `planCapture` sizes a capture in the unit the capture returns, measured from a capture the tab actually produced, so a scaled capture no longer fails its size check and pays for a discarded capture on every call.

## Fixes for the three bugs the third pass opened, 2026-09-04

Extension 0.1.34. Each fix has its own commit and its own test, and none of them has been driven against a browser.

- A read behind a frozen renderer no longer waits the freeze out. The read retry policy sent a timed-out capture again, the second attempt landed once the renderer freed up, and the caller got ok after 49.8 s with the timeout and the reload hint reaching it only as a retry note. A `timeout` the renderer caused is excluded from the read retry codes, matched on the hint `frozenError` and `queuedTimeoutError` both set, which the catalogue's own timeout hint does not carry, so a slow transport or a host timeout keeps its three attempts. `cdp.js` imports `RENDERER_FROZEN_HINT` from `errors.js` rather than repeating the string.
- A capture that follows a submit carries paint evidence again. The paint window was 2000 ms against a 3000 ms submit watch, so the stamp was always older than the window by the time the capture ran. `noteInput` records the action's own verification window and the paint clock adds it to the ordinary 2000 ms, so the grace after the action returns is the same whatever the action watched for.
- The session restore covers a worker restart Chrome decided on. It was built for `chrome.runtime.reload()`, which disables an unpacked extension on this Chrome, so the path that is left is an idle worker being stopped and started again, and that path does not give the restore the head start a reload did. `recordSession`, `forgetRemovedTab`, `getSessionGroupId` and `sessionForTab` wait for the restore, which stops the waking call from persisting a table holding only its own session.

Test counts on 2026-09-04, `node --test --test-concurrency=1` per file, no browser running:

| File | Tests | Pass |
|---|---|---|
| a11y.test.js | 52 | 52 |
| aliases.test.js | 6 | 6 |
| batch.test.js | 16 | 16 |
| campaign-server.test.js | 15 | 15 |
| cdp.test.js | 64 | 64 |
| errors.test.js | 44 | 44 |
| find.test.js | 50 | 50 |
| gif.test.js | 33 | 33 |
| indicator.test.js | 10 | 10 |
| ipc.test.js | 18 | 18 |
| journal.test.js | 28 | 28 |
| parity.test.js | 12 | 12 |
| permissions.test.js | 34 | 34 |
| probe-detect.test.js | 8 | 8 |
| profile.test.js | 20 | 20 |
| protocol.test.js | 14 | 14 |
| recorder.test.js | 12 | 12 |
| redact.test.js | 22 | 22 |
| registry.test.js | 20 | 20 |
| screenshot.test.js | 52 | 52 |
| sensitive.test.js | 16 | 16 |
| sessions.test.js | 14 | 14 |
| tabs.test.js | 26 | 26 |
| verify.test.js | 50 | 50 |
| **Total** | **636** | **636** |

`node tools/check-errors-copy.js` reports the extension copy matches. `node --check` passes on all 43 files under `extension/src`, `host` and `tools`.

The six browser-driven files (`live`, `e2e`, `edge`, `resilience`, `shortcuts`, `campaign`) were not run. The live checks the three fixes ask for: a read queued behind a busy loop of more than 40 s, which must return the `timeout` with the reload hint rather than a late ok; a `quick` script of C ref / T text / K Enter / SS, whose SS line must carry `evidence.paint`; and the session restore driven by stopping the worker from `chrome://serviceworker-internals`, since `chrome.runtime.reload()` is not usable on this Chrome.

## Live verification of the second set of bug fixes, 2026-09-04

The pass is written up in `docs/claude-in-chrome-comparison/evidence/VERIFY-0.1.34.md`, one entry per check with the call and the verbatim result. It ran against the development browser started by `node tools/browser.js --interferer --detach` and drove `host/mcp-server.js` from this tree through `tools/mcp-client.js`. The user's Chrome was never driven.

Seventeen checks: the ten fixes merged from `plan/bugs2`, the three for the bugs the third pass opened, a re-run of seven first-pass checks, four second-pass checks and six third-pass checks, and the test and bench files. Twelve of the thirteen fixes hold, two of them after a fix landed during the pass. The session restore does not.

Two commits landed during the pass:

- `8c39149` The gif watermark is `rgba(255,255,255,0.55)` with nothing behind it. It was legible only while the acting indicator sat under it, so hiding the indicator in the frames, which is one of the ten bugs2 fixes, left the mark white on a white page. Sampling the mark's own box on a recording of the fixture found the page's colours and nothing else, and the same recording with the page background set to `#111` found `144,144,144` there. The glyphs carry a dark stroke now. Extension 0.1.35.
- `3d27dbe`, amended by `6eb9a03` A screenshot on a tab in a 50 s busy loop reported its 20 s timeout after 40 s. The best-effort `HIDE_FOR_TOOL_USE` before the capture went through `pageCall`, which waits on the CDP queue with the full command deadline, and its failure was swallowed, so the capture then queued `Page.getLayoutMetrics` and waited a second deadline. `hideForCapture` does the queue wait and lets its timeout out, and only the message to the content script stays best effort, so a page with no content script is still captured. Extension 0.1.36 then 0.1.37.

Three bugs are open, with reproductions in the evidence file:

- A session loses its tabs when the service worker restarts. With two tabs in a session and the worker stopped from `chrome://serviceworker-internals`, `read_page` on a live tab returns `tab_gone`, `tabs_context` lists nothing with a null group id and no `missingTabs`, and the DevTools page list shows both tabs still open. The restore rewrites the persisted entry with an empty tab list and a null group with no tool call involved, so the record it was reading is destroyed and no later call can recover it. Both `Target.closeTarget` and the WebUI Stop button produce it.
- Chrome's idle timeout is not a route to a worker restart. The known limit below says the path left is Chrome stopping an idle worker after 30 s. With a session holding two tabs and nothing else running, the worker target stayed in the DevTools list for 180 s, because the extension holds a native messaging port and a connected port keeps the worker alive.
- The before-write capture a confirmation points at carries the acting indicator, which the screenshot path and the gif frames both hide.

`node --test --test-concurrency=1` over the 24 non-browser files: 640 of 640, plus `campaign.test.js` at 12 of 12. `node tools/check-errors-copy.js` reports the copy matches.
## Fixes for the five bugs the 0.1.35 checks on the user's Chrome opened, 2026-09-04

Extension 0.1.38, branch `plan/bugs3`. Each fix has its own commit and its own test, and none of them has been driven against a browser. The evidence they come from is `docs/claude-in-chrome-comparison/evidence/USER-CHROME-0.1.35.md`.

- `get_page_text` returns what a feed shows. On linkedin.com/feed it kept 28 text nodes and rejected 383 as hidden while `main.innerText` was 8989 characters and `visibilityState` was `visible`. The hidden test asked a wider question than the one that matters: `checkVisibility` reports false for a subtree the renderer is skipping and for an element with no box of its own, and `aria-hidden` kept out the visible copy of every label on a site that puts the accessible copy in a clipped span beside it. The test is now what `innerText` leaves out and nothing more, `checkVisibility` survives as the one check the relaxed pass drops, counted in a new `rejectedUnrendered`, and the pass that read more of the container wins. `test/fixtures/campaign/feed.html` carries the shape.
- GitHub's write controls get the submit window. Create, Comment, Close issue and the modal Delete each ran the 250 ms window, and the navigation or the 2xx that proved the write landed arrived after it closed. `SUBMIT_WORDS` now covers create, comment, close, delete, remove, confirm, apply, save, update, submit, ok, done and yes, which changes the window only: irreversibility stays governed by `IRREVERSIBLE_WORDS`. `close` and `reopen` join the undo classifier as a pair, so a Close issue click reports `undo: "Reopen issue"`.
- A click that opened a modal reports `applied`. The Delete menu item opened GitHub's confirm modal, the watch counted 40 mutations and focus on its Cancel button, and the result said `unknown` because no submit signal had fired. `unknown` is now reserved for a watch that saw nothing inside the extended window, and the missing submit evidence is a warning instead. The click and key paths share `applySubmitEvidence` for it.
- `find` weighs the role a query names. On the new-issue page "issue title field" returned twenty markdown toolbar buttons and "submit new issue button" returned no Create button. Field, input, box, textbox, textarea, button, link, checkbox, menu, dropdown, select and tab now filter the candidates when the page has that role, the weak hints they override go back to the scorer as ordinary terms, a placeholder scores above the rest of the attribute text, and the accessible name of the nearest enclosing form reaches every control inside it.
- A `find` result says when the query named a role nothing on the page carries, as one line in `warnings` and under `evidence.roleGap`, so twenty buttons returned for a field query do not read as twenty fields.

Test counts on 2026-09-04, `node --test --test-concurrency=1` per file, no browser running:

| File | Tests | Pass |
|---|---|---|
| a11y.test.js | 55 | 55 |
| aliases.test.js | 6 | 6 |
| batch.test.js | 16 | 16 |
| campaign-server.test.js | 15 | 15 |
| cdp.test.js | 67 | 67 |
| errors.test.js | 44 | 44 |
| find.test.js | 59 | 59 |
| gif.test.js | 34 | 34 |
| indicator.test.js | 10 | 10 |
| ipc.test.js | 18 | 18 |
| journal.test.js | 28 | 28 |
| parity.test.js | 12 | 12 |
| permissions.test.js | 34 | 34 |
| probe-detect.test.js | 8 | 8 |
| profile.test.js | 20 | 20 |
| protocol.test.js | 14 | 14 |
| recorder.test.js | 12 | 12 |
| redact.test.js | 22 | 22 |
| registry.test.js | 20 | 20 |
| screenshot.test.js | 52 | 52 |
| sensitive.test.js | 16 | 16 |
| sessions.test.js | 14 | 14 |
| tabs.test.js | 26 | 26 |
| verify.test.js | 55 | 55 |
| **Total** | **657** | **657** |

The 23 files excluding `campaign-server` run together as 642 of 642. `node tools/check-errors-copy.js` reports the extension copy matches, and `node --check` passes on all 43 files under `extension/src`, `host` and `tools`.

The six browser-driven files (`live`, `e2e`, `edge`, `resilience`, `shortcuts`, `campaign`) were not run. The live checks these five ask for are the fixture pages, not LinkedIn or GitHub: `get_page_text` on `/feed.html` against `javascript` reading `feedInnerTextLength()`, a click on the composer fixture's Save draft and on a Close issue control, a click that opens a modal, and `find "issue title field"` and `find "submit new issue button"` on a page carrying both a title textbox and a Create button.
