# chrome-mcp: status, parity and test coverage

State of the build as of 2026-09-03. 25 tools, 16 test files.

- Source: about 6,700 lines across the extension, host and tools
- Tests: about 3,600 lines
- Verified against Chrome for Testing 152 and against the user's own Chrome 152 on Windows 11

Last full run of the browser-driven files was before the 2026-09-03 changes. On 2026-09-03 the eleven non-browser files (135 tests) pass, and the new behaviour was verified by driving the development browser and the user's Chrome directly, as described under Verification on real browsers.

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
| `find` | `find` | Local ranking rather than a nested model call, so it costs no inference |
| `form_input` | `form_input` | Also refuses disabled and read-only controls |
| `computer` | `computer` | All 13 actions, plus `perKey` typing |
| `javascript_tool` | `javascript` | |
| `read_console_messages` | `read_console_messages` | |
| `read_network_requests` | `read_network_requests` | |
| `resize_window` | `resize_window` | |
| `file_upload` | `file_upload` | Also handles drop zones with no file input |
| `upload_image` | `upload_image` | Takes the `imageId` printed under each screenshot, a path, or `"last"` |
| `gif_creator` | `gif_creator` | Own GIF89a encoder, no dependency. `start_recording` / `stop_recording` / `export` / `clear` and `filename` are accepted. The overlay `options` (click indicators, labels, watermark) are not drawn |
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
- **The gif overlay options** Claude in Chrome draws (click circles, action labels, progress bar) are accepted and ignored.
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
- A site probing for CDP automation can detect the session. On 0.1.7, `deviceandbrowserinfo.com/are_you_a_bot` returned `isBot: true` on all three runs with `isAutomatedWithCDP: true` as the only flag set, while every spoofable signal read clean: webdriver, Selenium, Playwright and headless markers `false`, and canvas, WebGL, plugin and user-agent fingerprints identical to the same Chrome driven by hand (`docs/claude-in-chrome-comparison/evidence/D-bot-detection.md` section 4). `browserscan.net/bot-detection` reported Normal on the same build, including its own CDP section, so vendors disagree on the heuristic. 0.1.12 makes console capture opt-in, so `Runtime.enable` is never issued on a tab that does not read the console, which reduces the surface without removing it
- Completely covering the browser window can stall input until the extension raises it again
- `wait_for_page` cannot catch an update driven by a bare timer with no DOM or network activity, because it has nothing to wait on. `test/campaign.test.js` uses a retry loop for that case

## Phase 7, detectability, 2026-09-04

Branch `plan/detect`, extension 0.1.12. Items D1, D3, D4 and D5 from `docs/claude-in-chrome-comparison/IMPROVEMENTS.md`.

- D1. `Runtime.enable` is no longer part of joining a session. A tab gets `Log`, `Network`, `Page` and `DOM`, and `Runtime` goes on when `read_console_messages` first runs on that tab, then off again on a read that passes `clear: true`. `browser_batch` arms it before the batch starts when a later item reads the console, so an action earlier in the same batch is still captured. The console output logged before the first read is lost, and that read carries a warning saying so. `only_errors` carries a second warning, because an uncaught exception needs the same domain. A `consoleCapture` setting in `chrome.storage.local`, on the options page, restores the always-on behaviour.
- D3. `typeKeysReal` draws each inter-key interval from a distribution around a mean of 60 ms, plus or minus 40 percent, with a longer pause after roughly one space in seven. The mean is the interval the page sees, so the time the three key events took is subtracted from it, which is what keeps 500 characters inside the 30911 ms the campaign measured on 0.1.7. `computer type` takes a `cadence` argument to set the mean when `perKey` is true.
- D4. A click or a hover moves the pointer along a bowed path of 3 to 6 `mouseMoved` events from the tab's last known pointer position, dispatched inside the hover gap that was already being spent, so the wall time is unchanged. Only the last point waits for an acknowledgement, since a hidden tab acknowledges nothing and awaiting each point would turn one 400 ms ack timeout per click into six. The last position is recorded in `sendInput` for every `mouseMoved`, so drags and hovers feed it too. A tab with no known position, or a target within 8 px, gets the single move it got before.
- D5. The README and the list above record what the campaign measured.

`tools/probe-detect.js` drives the campaign fixture and prints the keydown intervals and the mousemove path points the page recorded, so D3 and D4 can be measured rather than assumed. It uses `tools/mcp-client.js` when that file is present and an equivalent client of its own when it is not.

Untested live at the time of writing: everything above is covered by `test/recorder.test.js` and `test/cdp.test.js` against the chrome stub. The CDP trace, the re-run of the four detector pages and the probe output belong to the verification pass.

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

## Write actions, confirmation, plan mode, 2026-09-04

Branch `plan/writes` off `plan/integration`. Extension version 0.1.12, which adds the `notifications` permission. Covers PLAN.md Phase 4 items W2, W4, W5 and W7, and Phase 6 items F5 and F6.

What landed:

- **W2, submit verification.** A click on a submit-shaped control (`button[type=submit]`, a bare button inside a form, or an accessible name matching send, post, save, publish, reply or submit) and an Enter inside a composer or a form field get a 3 s window instead of 250 ms. Five signals are looked for and named individually under `evidence.submit.fired`: the composer emptied, a new node carrying the typed text, a 2xx from the page's own origin in the recorder's buffer, a `role=status`, `role=alert` or `aria-live` region that spoke, and a navigation. None of them means `effects: unknown` with the hint `re-read the page before retrying`. A submit is never re-dispatched by the throttle retry, since a submit that shows no local effect may still have reached the server.
- **W4, confirm mode.** A fourth permission mode. A click or an Enter on a control the W3 classifier marks irreversible is refused once with `confirmation_required` carrying `{token, control, origin, screenshotId}`, and performed when the same call comes back with `confirm: <token>` inside 120 s. Tokens are single use and bound to the tab, the origin and the control name. The options page has a per-origin write allow-list that exempts named hosts, and a switch for in-browser approval, which shows a `chrome.notifications` notification with Allow and Deny and settles the pending call on the button. A notification activates no tab and focuses no window.
- **W5, audit.** An irreversible action returns a `write` object, and the host copies it into the journal as its own field: the control, the origin, the id of the screenshot taken before the click, what the submit evidence found afterwards, and how it was confirmed. The typed value is kept only when the journal is not in redaction mode and the composer was not a sensitive field. `npm run log` prints a Writes section under the timeline.
- **W7, undo hints.** A control whose name reads as an edit, a save or a comment is classified reversible, and the result carries `undo` naming a control on the page that would reverse it. A sent message reports `undo: none`.
- **F5, plan mode.** `declare_plan({origins})` checks a list against the blocklist and grants it for the session. In plan mode every other origin is refused with `origin_blocked` and the hint to declare it, reads included, since the point of one approval is that the user saw the whole scope.
- **F6, domain transitions.** The session's last acted origin is tracked per client. A call on a different origin is a warning on the result in allow and confirm mode, and needs its own grant in ask mode. A `navigate` is checked again after it lands, so a redirect into a third origin is caught.

The before-screenshot goes through the existing capture path and is held in the extension under its id. Nothing fetches those bytes back yet: the id is a correlation handle in the journal and in the confirmation details, not something a tool can render.

Tests, `node --test` per file on 2026-09-04, no browser running:

| File | Tests | Pass |
|---|---|---|
| permissions.test.js | 29 | 29 |
| verify.test.js | 30 | 30 |
| journal.test.js | 24 | 24 |
| campaign-server.test.js | 15 | 15 |
| parity.test.js | 8 | 8 |
| a11y, sensitive, batch, aliases, cdp, find, screenshot, sessions, tabs | 165 | 165 |
| errors, ipc, protocol, redact, registry, profile | 137 | 137 |

`node tools/check-errors-copy.js` reports the copy matches. Nothing on this branch has been driven against a browser.

The fixture at `/composer.html` gained a `role=status` toast, a POST to `/api/echo` after a send, and a Save draft control that leaves a Discard draft button behind, so all five submit signals and both undo branches can be rehearsed offline before a real site is touched.
