# chrome-mcp

An MCP server that drives your real Chrome through a Manifest V3 extension and the DevTools Protocol. The extension is called Lantern: it works in the background, in its own tab group, and its popup shows what it is doing. Built to match the capability set documented in [SPEC.md](SPEC.md).

It works against the browser you are already signed into, so it can act on Gmail, Notion, an internal dashboard, or a localhost dev server without any API credentials.

## What it does

- Reads pages as an accessibility tree with stable `ref_N` handles, which is cheaper and more reliable than screenshots
- Clicks, types, hovers, scrolls, and drags through CDP, so events arrive with `isTrusted` set
- Fills form controls in one call, including selects, checkboxes, and React-managed inputs
- Captures screenshots downscaled to a fixed token budget, with coordinates that map back correctly on any display scaling
- Reads console output and network requests captured from the moment the tab joined the session
- Runs several actions in one round trip with `browser_batch`, or a whole compact script with `quick`
- Attaches local files to file inputs and to drag-and-drop upload zones
- Draws a pointer on the page so you can watch what it is doing
- Works in the background: its tabs open unselected in your current window, nothing is ever brought to the front, and the group is marked ⏳ while a call runs, ✅ when it finished, ❌ when it failed. You look at its tabs when you choose to

## Requirements

- Node 20 or newer
- A Chromium browser. Chrome, Edge, Brave, and Vivaldi are registered automatically.

## Install

```bash
npm install
npm run keygen          # pins the extension id, run once
npm run install-host    # registers the native messaging host
```

Then load the extension:

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked** and select the `extension` folder in this repo
4. Restart Chrome so it picks up the native messaging host registration

Chrome 137 and later ignore the `--load-extension` command line flag, so this step cannot be scripted against a stock Chrome install. It is a one-time click-through. The extension id is pinned by `npm run keygen`, so it stays `giagijohigincdlpkfolgcljkhmjdiaa` across machines and the host registration keeps matching it.

Register the server with Claude Code:

```bash
claude mcp add chrome-mcp -- node "<repo>/host/mcp-server.js"
```

Check everything at once:

```bash
npm run doctor
```

It also prints where the action journal lives, and `npm run log` shows today's journal. It verifies the key, the host manifest, the node path baked into the wrapper, the per-browser registration, the bridge socket, and whether the extension is attached. It names the first broken link and what to run.

## Tools

| Tool | Purpose |
|---|---|
| `tabs_context` | List the tabs this session owns. Call it first. `createIfEmpty` opens a blank tab in the current window |
| `tabs_create` / `tabs_close` | Open and close tabs in the session group |
| `navigate` | Go to a URL, or back and forward |
| `read_page` | Accessibility tree with `ref_N` handles, `interactive` filter, depth and subtree control |
| `get_page_text` | Readable text, article content first |
| `find` | Ranked element lookup from a description |
| `form_input` | Set a form control by ref |
| `computer` | Click, hover, type, key, scroll, drag, screenshot, zoom, scroll_to |
| `javascript` | Evaluate an expression in the page |
| `read_console_messages` | Console output with regex and error filters |
| `read_network_requests` | Requests with status, size, and failure filters |
| `page_state` | URL, title, scroll position, viewport |
| `wait_for_page` | Wait for load and for the DOM to stop mutating |
| `resize_window` | Resize the window holding a tab |
| `file_upload` | Attach local files to a file input or a drop zone |
| `upload_image` | Attach a screenshot by the id printed under it, an image by path, or the last screenshot |
| `gif_creator` | Record a flow as an animated GIF |
| `list_connected_browsers` | List the browsers running the extension |
| `select_browser` / `switch_browser` | Choose which browser this session drives |
| `shortcuts_list` / `shortcuts_execute` | Saved quick scripts, edited from the options page |
| `browser_batch` | Run a sequence of tool calls in one round trip |
| `quick` | Run a compact one-line-per-action script in one round trip |

Tool names and argument spellings from Claude in Chrome (`tabs_create_mcp`, `javascript_tool`, `onlyErrors`, `urlPattern`, `deviceId`, the gif action names) are accepted as well, at the top level and inside `browser_batch`, so a batch written for that extension runs unchanged.

## The extension

Lantern shows up as a monochrome mark in the toolbar. Its popup shows the connection state, the sessions this browser holds with their status marks, and the last few calls. Clicking a session reveals its tabs, which is the one way a Lantern tab is ever brought to the front. The settings page holds the permission mode, blocked and allowed hosts, saved shortcuts, and granted sites.

Both pages are built on the Ash Lumen design system (`extension/src/ui/tokens.css` and `components.css`, copied from the `ash-lumen` package) with a small layout and motion file of their own. The icon is `extension/src/ui/icon.svg`, rendered to the PNG sizes Chrome needs by `npm run icons` through the development browser.

## Permissions

Two layers guard a call. The MCP client prompts per tool call on its side. The extension enforces the part a client cannot bypass:

- An origin blocklist covering financial and payment sites, applied to reading as well as acting
- Three modes: allow with blocklist (default), require a grant per origin, or skip grant checks
- A re-check before every mutating action that the tab is still on the origin the call was authorized against, which closes the window where a page navigates between the decision to click and the click landing

Manage it from the extension's options page (`chrome://extensions` then **Details** then **Extension options**).

## Quick mode

`browser_batch` collapses several calls into one round trip but still spends a nested JSON object per action. `quick` expresses the same sequence as one line each:

```
F ref_12 buyer@example.com
F ref_15 Portugal
C ref_18
W
R
```

Commands: `C` `RC` `DC` `TC` click, `H` hover, `SC` scroll into view, `T` type, `TK` type with real key events, `K` keys, `F` set a form control, `S` scroll, `D` drag, `N` navigate, `J` evaluate, `W` wait to settle, `R` read page, `X` page text, `SS` screenshot, `P` page state, `Z` zoom, `NT` new tab (later lines act on it), `ST` switch tab, `LT` list tabs, `#` comment. Targets are a ref or an `x y` pair.

The whole script is parsed before anything runs, so a typo on the last line cannot leave the page half way through a sequence. Execution stops at the first failing line and names it.

## The pointer

The agent draws a pointer where it is acting, with a warm halo so it is findable on a busy page, and a press state and ripple on click. It travels to a target before clicking and follows drags step by step, so the order you see matches the order the page receives.

It is presentation only. Input is dispatched through CDP and is byte for byte identical whether or not the pointer is drawn, so it makes no difference to how a site sees the automation. It lives in a closed shadow root with `pointer-events: none`, is excluded from the accessibility tree, and is hidden before every screenshot so the model never mistakes its own cursor for page content.

## Action journal

Every call is recorded by the native host, which sees each request and its response. Two files per browser per day under `%TEMP%\chrome-mcp-logs\<browser id>\` (or `CHROME_MCP_LOG_DIR`): `<date>.jsonl` with one object per call, and `<date>.md`, a timeline a person can read:

```
- 05:48:14 **navigate** tab 12 https://httpbin.org/forms/post `url="https://httpbin.org/forms/post"` (505ms) url=https://httpbin.org/forms/post
- 05:48:15 **form_input** tab 12 https://httpbin.org/forms/post `ref="ref_1" value="Test Person"` (8ms)
- 05:48:16 **computer** tab 12 https://httpbin.org/post `action="left_click" ref="ref_13"` (610ms)
```

Each entry has the time, the tool, the tab and the page it was on after the call, the arguments with bulk removed (no image data, long strings clipped), the duration, and either a short account of the result or the error. `npm run log` prints today's timeline, `npm run log -- --tail 20` the last twenty calls, `--json` the raw entries, `--date 2026-09-03` another day. The journal never blocks a call: a write failure is dropped.

The host's own lifecycle log (connections, disconnections, transport errors) is separate, at `%TEMP%\chrome-mcp-host.log`.

## Several browsers

Each connected browser gets its own native host, its own pipe, and an entry in a registry directory. With one browser connected it is used automatically. With several, a session calls `select_browser` once and the choice holds. `npm run doctor` lists what is connected.

## Architecture

```
Claude Code ──stdio──> mcp-server.js ──named pipe──> native-host.js ──native messaging──> extension ──CDP──> page
```

The native host is the listener and MCP servers are clients, so several Claude Code sessions share one browser connection instead of competing to bind the same pipe. Payloads above 384KB are chunked, because Chrome caps a single native message at 1MB and screenshots exceed it.

`tools/install.js` resolves the real path to the node binary with `realpath` before writing the wrapper. Chrome spawns the host from the browser process rather than a shell, and fnm's `process.execPath` points into a per-shell directory that disappears when the terminal closes.

## Five constraints that shape the implementation

**A pending `setTimeout` does not keep an MV3 service worker alive.** Chrome suspends the worker while it awaits one, so a 100ms hover delay measured about five seconds in practice and every click paid it. Timed waits run on the page's clock through `Runtime.evaluate`, which keeps the worker busy on a pending extension API callback.

**A hidden tab has its renderer throttled, and the agent works in hidden tabs.** Chrome holds input acknowledgements, stops animation frames and reports the page hidden. Two CDP calls on attach undo that from the page's point of view: focus emulation and an active web lifecycle state. Measured on Chrome 152, a hidden tab then answers a mouse event in a millisecond, runs `requestAnimationFrame`, keeps timers accurate and reports itself visible and focused, minimized window included. Captures are the exception: a surface screenshot of a hidden tab takes seconds or never returns, and the extension debugger API refuses renderer captures, so a hidden tab is captured through a single screencast frame, in about 50ms.

**Capping the long edge is not enough for screenshots.** A tall viewport stays under 1568px wide and still costs about 2800 tokens. Captures are bounded by area as well, to roughly 1600 tokens whatever shape the window is.

**A fully covered window is reported as hidden, and its renderer stops accepting input.** Chrome's native window occlusion detection sets `visibilityState` to `hidden` when another window completely covers Chrome. The same focus emulation and lifecycle state that make a hidden tab work make a covered or minimized window work. `npm run browser` still launches with `--disable-features=CalculateNativeWinOcclusion` so tests do not depend on which window happens to be in front.

**Input acknowledgements are bounded.** `Input.dispatchMouseEvent` answers only once the renderer has processed the event, and a throttled renderer holds that answer for a fixed five seconds. Dispatch waits briefly and moves on, since the event is delivered either way, and records that the renderer looked throttled so the next action can correct it.

## Development

```bash
npm test              # everything, about two minutes with a browser up
npm run browser       # isolated browser with the extension loaded
npm run test:live     # browser tests only
npm run test:resilience   # the slow recovery tests on their own
```

Live tests skip themselves when no bridge is listening, so `npm test` stays useful without a browser. With several browsers connected they prefer the one `npm run browser` started, which it records in `.browsers/dev-browser-id`. Start that browser from a terminal that stays open: launched from a shell that exits, it goes with it.

`npm run browser` uses Chrome for Testing, which still honours `--load-extension`, against its own profile. Install it once:

```bash
npx @puppeteer/browsers install chrome@stable --path .browsers
```

**After editing extension code, reload the extension.** Chrome keeps a compiled module graph for extension service workers and reuses it across browser restarts, so a cold start can still run stale code. On Chrome 152 it lives in `Default/Extension Scripts` in the profile. `npm run browser` deletes that cache on launch. In your own Chrome, press the reload button on the extension card at `chrome://extensions`.

The suite covers the accessibility tree against a real DOM, the ranking in `find`, screenshot maths, the permission model, native messaging framing including chunk reassembly, IPC, schema and handler parity, the MCP protocol across real processes, and a live pass over a fixture page that exercises every tool against a running browser, including right and double clicks, pointer drags, HTML5 drag and drop, per-key typing, file uploads, and quick scripts.

The recovery suite proves the parts that only fail over time: a session survives the service worker going idle past its 30 second timeout, it recovers when the native host is killed underneath it, a restarted client can resume a session by id, and a request that is in flight when the bridge dies reports an error rather than hanging.

## Status

[STATUS.md](STATUS.md) has the full picture: parity against Claude Code tool by tool, what is and is not tested, the bugs found during the build, and the browser behaviours that shape the implementation. [COMPARISON.md](COMPARISON.md) sets the project against Claude in Chrome, Playwright MCP, Chrome DevTools MCP and Browser MCP, feature by feature and with measured call latencies.

## Known limits

- Loading the extension is manual on Chrome 137 and later
- Cross-origin iframes are reported as leaves, since reading inside one needs a frame-targeted call
- A JavaScript modal dialog blocks all further extension calls until a human dismisses it, which is a Chrome constraint
- The CDP debugger banner is visible on tabs the session has attached
- Completely covering the Chrome window can stall input until the extension raises it again, because Chrome stops the renderer of an occluded window
