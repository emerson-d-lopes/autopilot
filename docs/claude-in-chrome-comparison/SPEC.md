# Claude in Chrome: how it works

Reverse-engineered and documented behavior of the Claude in Chrome extension, written as a build target for a parity implementation. Details refer to extension v1.0.56 unless stated otherwise.

Extension ID: `fcoeoabgfenejglbffodgkkbkcdhcgfn`

## Sources

- sshh12, "Claude for Chrome Extension Internals (v1.0.56)": https://gist.github.com/sshh12/e352c053627ccbe1636781f73d6d715b
- Claude Code Chrome docs: https://code.claude.com/docs/en/chrome
- Permissions guide: https://support.claude.com/en/articles/12902446-claude-in-chrome-permissions-guide
- Getting started: https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome
- Anthropic security writeup: https://claude.com/blog/claude-for-chrome
- Permission bypass issue: https://github.com/anthropics/claude-code/issues/26779

## Architecture

Manifest V3 extension, React UI, rendered as a Chrome side panel next to the active tab. Manifest permissions that matter: `debugger` (all automation), `scripting` (page reading), `nativeMessaging` (desktop and CLI integration).

Two independent operating paths share the same tool implementations.

**Standalone path.** The extension talks to `api.anthropic.com` itself and runs its own agentic loop. Auth is OAuth PKCE with scopes `user:profile user:inference`, or a manually entered API key. Model `claude-sonnet-4-5-20250929`, `max_tokens: 10000`, beta header `oauth-2025-04-20`. Fast mode adds `speed: "fast"` and beta `fast-mode-2026-02-01`. Effort control uses beta `effort-2025-11-24`.

**MCP path.** Claude Desktop and Claude Code drive the same tools from outside. Transport is Chrome native messaging via `chrome.runtime.connectNative()`, not a WebSocket. Host names:

- `com.anthropic.claude_browser_extension` (Claude Desktop)
- `com.anthropic.claude_code_browser_extension` (Claude Code)

Host manifest locations: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/<host>.json` on macOS, `~/.config/google-chrome/NativeMessagingHosts/` on Linux, and the registry key `HKCU\Software\Google\Chrome\NativeMessagingHosts\` on Windows. Chromium forks read the same filename from their own profile directory. On Windows the local side uses a named pipe, which produces `EADDRINUSE` when two sessions collide.

Native messaging protocol:

| Message | Shape |
|---|---|
| `ping` / `pong` | handshake |
| `get_status` | status query |
| `tool_request` | `{ method: "execute_tool", params: { tool, args, tabGroupId, tabId, client_id } }` |
| `tool_response` | `{ result: { content } }` or `{ error: { content } }` |
| `mcp_connected` / `mcp_disconnected` | lifecycle |

Remote Claude Code sessions route through `bridge.claudeusercontent.com`, which matters only for corporate IP allowlists.

## Agentic loop, standard mode

1. Build the system prompt: server config value `chrome_ext_system_prompt`, plus platform info, plus current tab context (URLs, titles, tab IDs), plus domain-specific skills for the sites in play.
2. Stream with `beta.messages.stream()`.
3. Execute each `tool_use` block after a permission check.
4. Feed `tool_result` back.
5. Detach the CDP debugger when the loop finishes.

Step 5 is why the yellow "being debugged" banner appears while Claude works and clears when it stops. The attach is per-turn, not per-action.

Step 1 is the part that cannot be copied from tool schemas. The system prompt is fetched from server config, so it is versioned and tuned independently of the extension build, and the site-specific skills (Slack, Google Calendar, Gmail, Docs, GitHub) are injected conditionally based on which domains the tabs are on.

## Tool surface

21 tools in v1.0.56. The `computer` tool uses Anthropic's built-in `computer_20250124` type.

| Tool | Parameters |
|---|---|
| `computer` | `action`, `coordinate`, `ref`, `text`, `duration`, `region`, `modifiers`, `scroll_direction`, `scroll_amount`, `repeat`, `start_coordinate`, `save_to_disk`, `tabId` |
| `navigate` | `url` (or `back` / `forward`), `tabId` |
| `read_page` | `filter` (`interactive` / `all`), `depth`, `ref_id`, `max_chars`, `tabId` |
| `get_page_text` | `tabId`, `max_chars` |
| `find` | `query`, `tabId` |
| `form_input` | `ref`, `value`, `tabId` |
| `javascript_tool` | `action: "javascript_exec"`, `text`, `tabId` |
| `read_console_messages` | `tabId`, `onlyErrors`, `clear`, `pattern`, `limit` |
| `read_network_requests` | `tabId`, `urlPattern`, `clear`, `limit` |
| `tabs_context` / `tabs_create` | tab group management |
| `upload_image` | `imageId`, `ref` or `coordinate`, `filename`, `tabId` |
| `file_upload` | `paths[]`, `ref`, `tabId` |
| `resize_window` | `width`, `height`, `tabId` |
| `gif_creator` | `action` (start/stop/export), `options`, `tabId` |
| `update_plan` | `domains[]`, `approach[]` |
| `shortcuts_list` / `shortcuts_execute` | `shortcutId`, `command` |
| `turn_answer_start` | none |
| `tabs_context_mcp` / `tabs_create_mcp` | MCP variants |

`computer` action enum: `left_click`, `right_click`, `double_click`, `triple_click`, `hover`, `type`, `key`, `screenshot`, `wait`, `scroll`, `scroll_to`, `left_click_drag`, `zoom`.

Versions after 1.0.56 add `browser_batch` (a sequence of tool calls in one round trip, executed sequentially, stopping at the first error, with the permission check re-run per item), `tabs_close_mcp`, and multi-browser selection (`list_connected_browsers`, `select_browser`, `switch_browser`).

## Input dispatch

Everything goes through Chrome DevTools Protocol v1.3, attached with `chrome.debugger.attach(tabId, "1.3")`. There is no synthetic-event path.

| Action | Implementation |
|---|---|
| Click | `Input.dispatchMouseEvent`, 100ms delay between `mouseMoved` and `mousePressed` / `mouseReleased` |
| Type | `Input.insertText`, character by character |
| Scroll | `Input.dispatchMouseEvent` with `mouseWheel`, delta = `scrollAmount * 100` px |
| Screenshot | `Page.captureScreenshot` (PNG) |

The 100ms move-then-press gap exists because hover-triggered UI (menus, tooltips, lazily mounted overlays) needs a frame or two to appear before the press lands.

Before a screenshot or click the extension sends `HIDE_FOR_TOOL_USE` to the content script and `SHOW_AFTER_TOOL_USE` afterward, keeping its own overlay UI out of the capture and out of the click path.

## Page reading

`read_page` injects `window.__generateAccessibilityTree(filter, depth, maxChars, refId)` via `chrome.scripting.executeScript`. The generator:

- walks the DOM recursively to `depth` (default 15)
- maps elements to ARIA roles (`<a>` to `link`, `<button>` to `button`, and so on)
- derives accessible names from `aria-label`, `placeholder`, `title`, `alt`, an associated `<label>`, or text content
- assigns ref IDs (`ref_1`, `ref_2`, ...) held in `window.__claudeElementMap` as `WeakRef`
- emits an indented tree of role, name, ref, and relevant attributes (`href`, `type`, `placeholder`)

Default `max_chars` is 50000. On truncation the result reports the true size, so the model knows to re-read a subtree with `ref_id` or a smaller `depth` instead of giving up.

Refs are the shared addressing scheme across `form_input`, `find`, `computer`, `upload_image`, and `file_upload`. `WeakRef` means a ref to a removed element resolves to nothing rather than pinning detached DOM in memory.

`find` is a nested LLM call. It sends the tree to `claude-sonnet-4-5` with `max_tokens: 800` and asks it to match elements semantically against the query, returning up to 20. Natural-language element lookup therefore costs a second inference, but a small one, and it keeps the full tree out of the main context.

## Screenshots and coordinates

Captured PNGs are resized by an algorithm tuned for token cost, with `pxPerToken: 28` and `maxTargetPx: 1568`. Retina captures are downscaled. The scaling context is stored so that coordinates the model produces against the downscaled image map back to real viewport pixels on the next action.

1568px is the threshold above which Claude's vision pipeline downscales server-side, so anything larger is paid for twice and used once.

## Speed mechanisms

**Quick Mode.** The largest one. It abandons the tool-use protocol entirely: `tools: []`, `stop_sequences: ["\n<<END>>"]`, and the model emits compact single-letter commands as plain text.

| Command | Action |
|---|---|
| `C x y` | left click |
| `RC x y` | right click |
| `DC x y` | double click |
| `TC x y` | triple click |
| `H x y` | hover |
| `T text` | type (multi-line) |
| `K keys` | press keys, space-separated |
| `S dir amt x y` | scroll |
| `D x1 y1 x2 y2` | drag |
| `Z x1 y1 x2 y2` | zoom to region |
| `N url` | navigate, or `back` / `forward` |
| `J code` | execute JavaScript (multi-line) |
| `W` | wait for page settle |
| `ST tabId` | switch tab |
| `NT url` | new tab |
| `LT` | list tabs |

A screenshot is captured after each batch and fed back as context. This removes JSON tool-call overhead, removes tool schemas from the context entirely, and lets one inference emit an arbitrarily long action sequence.

**Message compaction.** Past roughly 25MB of messages, base64 images in older turns are replaced with placeholders and `tokensSaved` is tracked. Screenshot-heavy sessions otherwise fill the window with stale pixels.

**Domain classification cache.** Classification results are cached for 5 minutes per domain.

## Permissions and safety

A `PermissionManager` singleton gates every tool execution. Three modes:

- `ask` (default): prompt per domain
- `follow_a_plan`: the model submits domains and approach via `update_plan`, the user approves once, and the listed domains are pre-authorized
- `skip_all_permission_checks`: auto-approve

Grant durations are `once` (bound to a specific `toolUseId`) or `always` (persistent per domain). Storage is Chrome LevelDB under `Local Extension Settings/fcoeoabgfenejglbffodgkkbkcdhcgfn/`, key `permissionStorage`, holding approved netlocs with status, creation timestamp, duration, and scope. Writing that LevelDB directly bypasses the entire permission system (issue 26779).

Domain classification queries `api.anthropic.com/api/web/domain_info/browser_extension?domain=...`. `category1` and `category2` are blocked outright, `category3` forces a prompt. The blocked set covers financial services, adult content, and pirated content.

**URL verification before mutating actions.** Before `form_input`, click, type, key, or drag, the extension re-checks that the tab's current URL domain still matches the domain the action was authorized against. This closes the race where a page navigates between the model deciding to click and the click landing.

Anthropic's published injection numbers: autonomous mode went from 23.6% attack success across 123 test cases covering 29 scenarios, down to 11.2%. A browser-specific challenge set of four attack types went from 35.7% to 0%. The listed mitigations are site permissions, high-risk action confirmation, system prompt hardening, blocked categories, and classifiers for suspicious instruction patterns and unusual data access, with specific handling for hidden DOM form fields and injections through URLs and tab titles.

Hard-blocked regardless of mode: purchases and financial transactions, account creation, credit card and ID handling, downloads from untrusted sources, permanent deletion, investment advice, trade execution, system file modification, and acting on instructions found in page or email content.

Claude Code adds a read-only vs state-changing split for plan mode. Read-only: `read_page`, `get_page_text`, `find`, console and network reads, screenshots. State-changing: clicks, typing, navigation, tab and window management, GIF recording. An otherwise read-only call becomes state-changing when it sets a mutating flag such as `createIfEmpty`, `clear`, or `save_to_disk`. A `browser_batch` skips the prompt only when every item inside it is read-only.

## Session and tab management

Tabs opened by the agent are collected into a Chrome tab group tied to the session, tracked in `chrome.storage.local`. The side panel shows a loading animation during work and a checkmark on completion.

Claude Code closes the group on `/clear`, open pages included, unless surviving work is still running. On `/resume`, exit, or a `/clear` with surviving work, it closes the group only when it contains nothing but empty new tabs.

The agent shares the browser's existing login state, which is the capability no external-driver approach reproduces. On a login page or CAPTCHA it stops and hands control back to the user.

## Features beyond automation

- **Workflow recording**: rrweb session capture with speech narration transcription. Steps are described by `claude-haiku-4-5`. Classic side panel only.
- **Scheduling**: `chrome.alarms`, daily / weekly / monthly / annually.
- **Shortcuts**: saved prompts invoked with `/`, exposed to the model as `shortcuts_list` and `shortcuts_execute`.
- **GIF export** of an interaction sequence.
- **1Password integration** for credential entry, macOS beta.
- **Site-specific skills** conditionally appended to the system prompt for Slack, Google Calendar, Gmail, Docs, and GitHub.
- **Cowork sessions**: persisted server-side, visible across devices, defaulting to auto-approve. The classic side panel is local and keeps workflow recording.

## Known problems in the shipped product

- The MV3 service worker goes idle during long sessions and breaks the native messaging connection. The documented fix is manual: `/chrome` then "Reconnect extension". Anthropic has not solved this.
- Errors reachable in normal use: "Browser extension is not connected", "No tab available", "Receiving end does not exist" (idle service worker).
- A JavaScript modal dialog blocks all further extension events and requires manual dismissal.
- Site permissions are bypassable by writing the extension's LevelDB directly.
- The CDP debugger banner is visible whenever a turn is in flight.

## Build order for parity

1. Native messaging host plus MV3 extension skeleton, `ping` / `pong` and `get_status` only. Prove the transport first, since it is the platform-specific part and Windows has its own named-pipe behavior.
2. CDP attach per turn, detach on completion. `Page.captureScreenshot`, `Input.dispatchMouseEvent` with the 100ms move-press gap, `Input.insertText`.
3. Accessibility tree generator with the `WeakRef` ref map, `depth` / `ref_id` / `max_chars` / `interactive` filter, and truncation that reports true size.
4. Screenshot resize with stored scaling context, `pxPerToken: 28`, `maxTargetPx: 1568`.
5. MCP server exposing the tool set, including a `browser_batch` equivalent from the start.
6. Permission manager with `once` / `always` durations and pre-action URL re-verification.
7. Message compaction that strips stale base64 images.
8. Quick Mode as a second protocol, once the standard loop is stable and an eval suite exists to compare against.

Steps 1 through 5 produce a working system. Step 8 is where the speed difference lives, and it is only measurable with a fixed task suite scored on turns-to-completion.

## What the implementation in this repo found

Four constraints that the tool surface does not reveal, each of which silently breaks a naive implementation:

- A pending `setTimeout` does not keep an MV3 service worker alive. Chrome suspends the worker mid-await, so a 100ms delay measures about five seconds. Timed waits belong on the page's clock.
- `Input.dispatchMouseEvent` answers only after the renderer processes the event. A throttled renderer holds that answer for a fixed five seconds, so every awaited mouse move pays it.
- Chrome reports a fully covered window as occluded, which sets `visibilityState` to `hidden` and makes the renderer drop input entirely rather than merely delay it. Launching with `--disable-features=CalculateNativeWinOcclusion` removes it for an automation profile.
- Chrome caches the compiled module graph for an extension service worker across browser restarts, so a cold start can run stale code while serving the edited file over `chrome-extension://`.
