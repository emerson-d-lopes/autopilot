# Claude in Chrome 1.0.90 internals, and how chrome-mcp compares

Static analysis only. No browser tools were used.

## Sources and method

Official extension, unpacked:
`C:\Users\edfl\AppData\Local\Google\Chrome\User Data\Profile 3\Extensions\fcoeoabgfenejglbffodgkkbkcdhcgfn\1.0.90_0`

The bundles are minified. To make them greppable I copied every `.js` into a scratchpad and ran a small string- and regex-aware line breaker over them:

- copies: `...\scratchpad\ext\*.js`
- prettified: `...\scratchpad\p\*.js`
- the breaker: `...\scratchpad\pretty.js`

Every line number below refers to the **prettified** copy in `...\scratchpad\p\`, because the originals are one line each. The identifier names are the minified ones. Where a file is shipped unminified (`offscreen.js`, `gif.js`, `gif.worker.js`, all `.html`, `manifest.json`, `managed_schema.json`), line numbers refer to the original file in the extension directory.

Prettified file sizes:

| file | prettified lines |
|---|---|
| `service-worker.ts-CNWEmoH7.js` | 4612 |
| `mcpPermissions-BIFqj2d3.js` | 22572 |
| `accessibility-tree.js-B-oUarrX.js` | 286 |
| `agent-visual-indicator.js-CwioqiOd.js` | 434 |
| `offscreen.js` (as shipped) | 643 |

`mcpPermissions-BIFqj2d3.js` is the real engine: it holds the CDP wrapper, every tool implementation, the permission manager and the tab manager. `service-worker.ts-CNWEmoH7.js` is transport plus lifecycle.

---

# Part 1. The official extension

## 1. Transport

### Two independent channels, both live at once

The extension can be driven over a **WebSocket bridge** and over **native messaging**, and the code paths are separate. There is no "choose one" logic: both are started when their preconditions hold, and each carries its own `tool_call` handler.

**WebSocket bridge.** URL selection, `service-worker.ts-CNWEmoH7.js:174-177`:

```js
const e=le();
return e.localBridge?"ws://localhost:8765"
  :"https://api.anthropic.com"===e.apiBaseUrl?"wss://bridge.claudeusercontent.com"
  :"wss://bridge-staging.claudeusercontent.com"
```

The connect URL is `${base}/chrome/${accountUuid}` (`:209`, `s=\`${t}/chrome/${r}\``). In local-bridge dev mode the account id is the literal `"dev_user_local"` (`:181`).

Auth is an OAuth token sent in the first frame after `onopen` (`:216-233`):

```js
const t={type:"connect",client_type:"chrome-extension",device_id:o,
  os_platform:wt(),extension_version:chrome.runtime.getManifest().version,
  ...a&&{display_name:a}};
n?t.dev_user_id=r:t.oauth_token=i,
c.send(JSON.stringify(t))
```

Framing is **one JSON object per WebSocket text frame**. No length prefix, no envelope. `c.onmessage=async e=>{...(JSON.parse(e.data))}` at `:234-236`.

Server-to-extension message types (`:240-505`): `paired`, `waiting`, `ping`, `pong`, `peer_connected`, `peer_disconnected`, `tool_call`, `external_message`, `external_config`, `pairing_request`, `permission_response`, `error`.
Extension-to-server: `connect`, `ping`, `pong`, `tool_result`, `permission_request`, `external_message_result`.

**Native messaging.** `service-worker.ts-CNWEmoH7.js:2466-2540`. It probes **two** host names in order and keeps the first that answers:

```js
const t=[{name:"com.anthropic.claude_browser_extension",label:"Desktop"},
         {name:"com.anthropic.claude_code_browser_extension",label:"Claude Code"}];
```

The probe is a `{type:"ping"}` postMessage with a **10 s** timeout waiting for `{type:"pong"}` (`:2500-2515`). On success it registers `onMessage`/`onDisconnect` and immediately sends `{type:"get_status"}`.

`nativeMessaging` is an **optional permission**, requested at runtime, not in the manifest's granted set: `chrome.permissions.contains({permissions:["nativeMessaging"]})` gates the whole path (`:2470-2472`), and `Fr()` at `:2545-2558` calls `chrome.permissions.remove` to turn it off. `chrome.permissions.onAdded`/`onRemoved` re-run connect/disconnect (`:3730-3736`).

Native-messaging inbound message types (`Kr`, `:2560+`) include `tool_request` with `method:"execute_tool"`, and the params may be `local_pairing` or `sealed`. The `sealed` variant runs the payload through an encrypted channel (`o.channel.open("execute_tool", ...)`) keyed by a session id `sid`, so the local Desktop/Claude Code link is itself E2E-sealed rather than plaintext JSON.

### Keepalive and reconnect

Three separate mechanisms.

1. **`chrome.alarms` every 30 s**, name `"bridge-keepalive"` (`:135`, created at `:3388-3390` with `periodInMinutes:.5`). The handler (`:3393-3428`) does four things: kills a socket stuck in `CONNECTING` for more than 30 s with close code 4003; calls `vt()` (connect) if the backoff deadline has passed; closes with code 4001 if no `pong` has arrived in 90 s; otherwise sends a `ping`. It also refreshes auth every 30 min (`Date.now()-nt>=18e5`).
2. **A 20 s `setInterval` ping** while open (`_t()` at `:153-160`).
3. **An offscreen document as an MV3 idle-timer defeat.** `offscreen.js:6-13`, shipped with the comment intact:

```js
// SW keepalive — offscreen docs aren't subject to MV3's 30s idle kill. A
// message every 20s resets the SW's idle timer, keeping the bridge WS
// setInterval ping running under background throttle/freeze.
setInterval(() => {
  chrome.runtime.sendMessage({ type: "SW_KEEPALIVE" }).catch(() => {});
}, 20_000);
```

The document is created with `reasons:[AUDIO_PLAYBACK, BLOBS]` (`mcpPermissions-BIFqj2d3.js:6550-6553`), which is how it justifies being persistent.

**Reconnect backoff** (`Pt()`, `service-worker.ts-CNWEmoH7.js:632-651`): `2000 * 1.5^(n-1)` capped at `mt = 300000` (5 min), jittered by `0.8 + 0.4*random`. If the browser is offline and the last close was not a clean server close, or the close code was 4003, the delay is a flat 5 s. Close code **1008 twice in a row** clears the stored access token and forces a refresh on the next attempt (`:552-575`).

**Delivery buffering.** Tool results that could not be sent are queued: up to `Gt = 8` entries with a `Bt = 120000` ms (2 min) expiry (`:672-690`), replayed by `qt()` on `paired`/`peer_connected`. External messages get their own queue, `xt = 8` entries at `Ut = 300000` ms (`:646-665`). Errors are never queued (`if(!t&&!n)`).

**Epoch guard.** `Et` is a monotonic counter bumped on disconnect (`Nt()` at `:626-630`); every async tool path re-checks `h!==Et` before replying, so results from a previous connection are dropped rather than delivered to a new peer.

### Device targeting

`device_id` is a `crypto.randomUUID()` persisted in `chrome.storage.local.bridgeDeviceId` (`:146-155`). Every inbound `tool_call`, `external_message` and `external_config` is filtered by `target_device_id` (`:296-297`, `:441`, `:483`).

## 2. Input

Everything mouse and keyboard goes through **CDP `Input.*` via `chrome.debugger`**. There is no synthesized-DOM-event path for clicks or keys. The only DOM-event fallbacks are for scrolling (below) and for drop targets in `upload_image`.

`Ss` is the CDP singleton (`mcpPermissions-BIFqj2d3.js:2370`).

### Mouse

`dispatchMouseEvent` (`:2664-2703`). Before dispatching it messages the content script to move a **phantom cursor**:

```js
const r=chrome.tabs.sendMessage(e,{type:"UPDATE_PHANTOM_CURSOR",
  x:Math.round(t.x),y:Math.round(t.y)}).catch(()=>{});
"mouseMoved"!==t.type&&"mouseWheel"!==t.type||t.skipCursorWait||
  (await chrome.tabs.get(e).catch(()=>{}))?.active&&
  await Promise.race([r,ce(250)]);
```

so a move or wheel on the **active** tab waits up to 250 ms for the cursor overlay to catch up. Background tabs skip the wait entirely.

The payload sets `buttons` and, notably, `force: 0.5` when a button is held (`:2687-2688`), a real-mouse property most naive automations omit.

`click` (`:2716-2775`), sequence for one click:

1. hide the agent indicator, `await ce(50)`
2. `mouseMoved` at the target with `button:"none", buttons:0`
3. only when `document.visibilityState === "visible"` in the service worker (i.e. the extension page is foregrounded): `await Promise.race([moveEvent, 200ms])` then `await ce(100)`
4. `mousePressed` (clickCount `l`)
5. `await ce(12)` (visible only)
6. `mouseReleased`
7. repeat 4-6 for `clickCount = 2` (double) and `3` (triple), with `await ce(100)` between iterations (visible only)

So the delays are **50 / 200-cap / 100 / 12 / 100**, and every one of them is skipped when the browser is backgrounded. Double and triple click are the same primitive with `clickCount` 2 and 3, not separate events.

Modifier mapping is a bitmask, identical in `pressKeyChord` (`:2828-2846`) and in click modifiers (`:5627-5644`):

```js
{alt:1, ctrl:2, control:2, meta:4, cmd:4, command:4, win:4, windows:4, shift:8}
```

Mouse button to `buttons` bitmask: left 1, right 2, middle 4 (`:2721-2723`).

### Typing

`type` (`:2775-2795`) is **per character, and per-key wherever a keycode exists**:

```js
for(const n of t){
  let t=n;
  "\n"!==n&&"\r"!==n||(t="Enter");
  const o=this.getKeyCode(t);
  if(o){
    const t=this.requiresShift(n)?8:0;
    r.push(this.keyDown(e,o,t)), r.push(this.keyUp(e,o,t))
  } else r.push(this.insertText(e,n))
}
await Promise.all(r)
```

Three things matter here.

- `getKeyCode` (`:2884-2905`) only resolves single characters `A-Z`, `a-z`, `0-9` plus a named table `Ts`. Anything else (accented letters, CJK, emoji, most punctuation) falls through to **`Input.insertText`**.
- `requiresShift` (`:2906-2908`) is `'~!@#$%^&*()_+{}|:"<>?'.includes(e) || (e>="A"&&e<="Z")`. But those shifted punctuation characters have no entry in `getKeyCode` (which only maps letters and digits), so in practice they take the `insertText` branch and the shift flag is unused for them.
- **`await Promise.all(r)`**. Every keystroke is dispatched concurrently, not sequentially. Ordering is left to CDP's queue. There is no inter-keystroke delay at all.

`keyDown` (`:2795-2812`) picks `keyDown` vs `rawKeyDown` based on whether the key has printable `text`, and fills `windowsVirtualKeyCode`, `code`, `location`, `commands`, `isKeypad`. On macOS, `pressKeyChord` looks up an editing-command list `xs` for the chord and passes it as CDP `commands` (`:2847-2851`) so that e.g. cmd+A maps to `selectAll` at the editor level.

`key` action (`:4936-4987`): the text is split on whitespace into a sequence of key names. Special cases before dispatch:

- reload chords (`cmd+r`, `ctrl+r`, `cmd+shift+r`, `ctrl+shift+r`, `f5`, `ctrl+f5`, `shift+f5`) are turned into `chrome.tabs.reload(tabId,{bypassCache})` rather than key events
- browser **page-zoom chords are rejected**. `uc()` (`:4574-4586`) detects `ctrl/cmd + (+ | - | 0)` and `Mc()` (`:5771-5776`) returns `errorCode:"page_zoom_shortcut_unsupported"` telling the model to use the `zoom` action instead
- `repeat` is 1-100

### Scrolling

`scroll` (`:4821-4930`). It is **CDP wheel first, DOM fallback second, with verification**:

1. record scroll position via `Ec()` (`executeScript` returning `pageXOffset/pageYOffset`, `:5766-5779`)
2. if the tab is active, dispatch `Input.dispatchMouseEvent` `mouseWheel` with `delta = ticks * 100` px, raced against a 5 s timeout (`oc=5e3`, `:4509`)
3. `await ce(200)`, re-read the scroll position, and if it moved less than 5 px in both axes **throw `"CDP scroll ineffective"`**
4. on any failure, and always for inactive tabs, fall back to `sc()` (`:4512-4553`): an injected script that finds `document.elementFromPoint(x,y)`, walks up to the nearest ancestor with `overflow-x/y` `auto|scroll` **and** actual overflow, and calls `scrollBy({behavior:"instant"})` on it, else on `window`
5. after scrolling, if the domain permits read, it takes a screenshot and returns it inline with the result

That verify-and-fall-back is the single most robust piece of input handling in the extension.

### Drag

`left_click_drag` (`:4988-5081`): `mouseMoved` → `mousePressed` → **5 interpolated `mouseMoved` steps** → `mouseReleased`. Intermediate moves pass `skipCursorWait:!0` for all but the last, and on an active tab each is raced against a 50 ms cap. No press/release dwell.

### Hover and scroll_to

`hover` (`:5254+`) and `scroll_to` (`:5226+`) are separate actions; `scroll_to` takes a `ref` and scrolls the element into view. Both are classified as read-level permissions (`bc` map, `:4646-4657`), while clicks, type and key are `d.CLICK` / `d.TYPE`.

### The `perKey` concept

I found **no `perKey` identifier** anywhere in the official bundles. Grep across all of `...\scratchpad\p\*.js` returns nothing for `perKey`. If that concept exists in chrome-mcp it has no counterpart here; the closest analogue is the `getKeyCode`-hit / `insertText`-miss branch in `type` described above.

## 3. Debugger attach lifecycle

**Persistent per tab, never detached on tool completion.** There is no attach/detach pairing around individual actions. `attachDebuggerImpl` (`mcpPermissions-BIFqj2d3.js:2540-2580`):

1. reject `chrome:` and `chrome-extension:` URLs up front with a specific message (`Te()` at `:417-426`, `xe=new Set(["chrome:","chrome-extension:"])`):
   `Cannot attach debugger to ${scheme}// pages. Navigate to a regular web page (http:// or https://) first, then retry.`
2. remember which of console/network tracking were enabled for this tab
3. **detach first, then attach**, `try{await this.detachDebugger(t)}catch{}` then `rawAttach`
4. re-enable `Runtime.enable`, `Network.enable {maxPostDataSize:65536}`, `Page.enable` as needed, each in its own swallowing try/catch

`attachDebugger` de-dupes concurrent attaches through a static `attachInFlight` Map (`:2513-2520`).

`rawAttach` (`:2521-2539`) races `chrome.debugger.attach(tabId,"1.3")` against a timeout whose message is the DevTools hint:

```
debugger_attach_error: chrome.debugger.attach timed out after ${t}ms on tab ${e}.
DevTools may be open on this tab, or the renderer may have crashed.
```

**"Another debugger is attached" is not handled as such.** What *is* handled is a different, subtler failure: `Cannot access a chrome-extension:// URL of different extension` (`Se()`, `:427-429`), which Chrome raises when another extension has injected a `chrome-extension://` iframe into the page. The recovery, `Ee()` at `:430-...`, is **`stripExtensionInterference`**: it enumerates frames with `chrome.webNavigation.getAllFrames`, walks the DOM (including open *and closed* shadow roots via `chrome.dom.openOrClosedShadowRoot`) in every frame to count iframes, finds frames whose iframe count exceeds their known child-frame count, and **removes the offending `chrome-extension://` iframes from the page**, then retries the attach. `maxRetries` defaults to 4 with a 75 ms settle (`:449-451`). It is kill-switched by `chrome.storage.local.cicStripExtensionInterference === false`.

Command sending is also self-healing. `sendCommand` (`:2620-2640`) catches `"debugger is not attached"` / `"detached while handling command"` (and the extension-URL error when a fresh `getTargets` check confirms detachment), re-attaches and retries **once**. `sendCommandOnce` races every CDP call against a timeout with the message `CDP sendCommand "${method}" timed out after ${n}ms on tab ${tab}. The renderer may be frozen or unresponsive.` (`:2593-2617`).

**Detach happens only at session boundaries**: `$e.detachAll("bridge")` on `peer_disconnected` (`service-worker.ts-CNWEmoH7.js:262-268`) and `$e.detachAll()` in `Nt()` (`:626-630`).

**The DevTools banner is not suppressed.** No `silent-debugger-extension-api` flag, no banner-hiding code exists in the bundles. The infobar is simply accepted.

### JavaScript dialogs

`Page.javascriptDialogOpening` is handled, but **only for `beforeunload`** (`mcpPermissions-BIFqj2d3.js:2464-2490`):

```js
if("Page.javascriptDialogOpening"===r){
  const t=n?.type;
  if("beforeunload"===t){
    const t="accept"===(e.beforeunloadPolicyByTab.get(o)??"dismiss");
    ...
    chrome.debugger.sendCommand({tabId:o},"Page.handleJavaScriptDialog",{accept:t},()=>{chrome.runtime.lastError})
  }
}
```

Default policy is **dismiss** (stay on the page). A tool that intends to navigate away sets `setBeforeunloadPolicy(tabId,"accept")` first (`:2641-2650`) and can wait for resolution with a timeout (`waitForBeforeunloadResolution`, `:2651-2665`).

`alert`, `confirm` and `prompt` are **not** auto-dismissed. Because `Page.enable` is on, an unhandled `alert()` will block the renderer until it times out. The code does not touch it. I could not find any handling for them anywhere in the bundle.

## 4. Accessibility tree and read_page

Built entirely by a **DOM walk in a content script**. The CDP `Accessibility` domain is never used (no `Accessibility.` string appears in any bundle).

The walker is `assets/accessibility-tree.js-B-oUarrX.js`, registered `all_frames:true, run_at:document_start, matches:<all_urls>` (manifest). It installs `window.__generateAccessibilityTree` in the **isolated world**, plus three module-level stores (`accessibility-tree.js-B-oUarrX.js:1-6`):

```js
window.__claudeElementMap        // ref string -> WeakRef<Element>
window.__claudeElementReverseMap // WeakMap<Element, ref string>
window.__claudeRefCounter        // monotonic int
```

### Refs

`accessibility-tree.js-B-oUarrX.js:196-206`:

```js
var c=window.__claudeElementReverseMap.get(e)||null;
if(c){ var f=window.__claudeElementMap[c]; f&&f.deref()===e||(c=null) }
c||(c="ref_"+ ++window.__claudeRefCounter,
     window.__claudeElementMap[c]=new WeakRef(e),
     window.__claudeElementReverseMap.set(e,c))
```

Refs are **stable across reads for the same element object** (reverse WeakMap lookup) and are held by `WeakRef` so a detached node can be garbage collected. After each walk, dead entries are swept: `for(var f in window.__claudeElementMap) window.__claudeElementMap[f].deref()||delete ...` (`:258`). Refs do **not** survive a navigation, because the content script re-initializes.

### Roles and names

`v()` (`:12-45`) is a hand-written implicit-role table: `a→link`, `button→button`, `input`→`submit|button→button`, `checkbox`, `radio`, `file→button`, else `textbox`; `select→combobox`, `textarea→textbox`, `h1..h6→heading`, `img→image`, and the landmark set. Everything unmapped is `generic`. An explicit `role` attribute wins.

`_()` (`:65-135`) is the accessible-name computation, in priority order: selected `<option>` text for a select, `aria-label`, `placeholder`, `title`, `alt`, `<label for=id>` text, `value` for submit inputs, `value` for other inputs when under 50 chars, direct text children for `button`/`a`/`summary`, heading text capped at 100 chars, then direct text children when at least 3 chars, capped at 100 with an ellipsis. `aria-labelledby` is **not** consulted.

### Redaction

`p()` (`:45-58`) marks an element sensitive when `type` is `password` or `hidden`, or `autocomplete` contains any of `current-password`, `new-password`, `one-time-code`, `cc-number`, `cc-csc`, `cc-exp`, `cc-exp-month`, `cc-exp-year`. Sensitive fields report `"[value redacted]"` and a sensitive `<select>` has its `<option>` list suppressed entirely (`:220`, `:246`).

### Visibility and filtering

`y()` (`:135-138`):

```js
var t=window.getComputedStyle(e);
return"none"!==t.display&&"hidden"!==t.visibility&&"0"!==t.opacity
  &&e.offsetWidth>0&&e.offsetHeight>0
```

`C()` (`:161-181`) decides inclusion:

- always drop `script`, `style`, `meta`, `link`, `title`, `noscript`
- unless `filter==="all"`, drop `aria-hidden="true"` and invisible elements
- unless `filter==="all"` **or** a `ref_id` root was given, drop elements outside the **current viewport rectangle** (`rect.top<innerHeight && rect.bottom>0 && rect.left<innerWidth && rect.right>0`)
- `filter==="interactive"` keeps only `x()` matches: tags `a, button, input, select, textarea, details, summary`, or `onclick`, or any `tabindex`, or `role=button|link`, or `contenteditable="true"`
- otherwise keep interactive, or structural (`h1..h6, nav, main, header, footer, section, article, aside`, or any `role`), or anything with a non-empty name, or anything whose role is not `generic`/`image`

Note the trap: the tool description says `"all"` returns "all elements including non-visible ones", and `filter:"all"` is the default. So the **default read_page ignores the viewport filter and the visibility filter**, while `filter:"interactive"` applies both.

### Output format

Indentation-by-depth plain text, one element per line (`:207-232`):

```
<indent><role> "<name>" [ref_N] href="..." type="..." placeholder="..."
```

`<select>` children are emitted as `option "text" (selected) value="..."` lines. Names are whitespace-collapsed and truncated to 100 chars with `"` escaped. Depth defaults to 15, max nodes 10000 (`o=1e4`, `:180`), max chars 50000 by default.

Truncation is two-stage. At 10000 nodes it appends
`[truncated at 10000 elements — page is very large; use a refId or smaller depth to focus]`.
At `max_chars` it cuts at the last newline before the limit and appends
`[output truncated at N of M characters. Pass a larger max_chars (default 50000) to see more, or use ref_id or a smaller depth to focus.]` (`:264-274`).

The return value is `{pageContent, viewport:{width,height}}`, and the tool appends `Viewport: WxH` to the output (`mcpPermissions-BIFqj2d3.js:7492-7500`).

### Shadow DOM and iframes: both unsupported in read_page

The walker recurses on `e.children` only (`:236-241`). **It never enters a shadow root.** Custom-element internals are invisible to `read_page`.

`read_page` executes with `target:{tabId:l.id}` and **no `allFrames`** (`mcpPermissions-BIFqj2d3.js:7464-7481`), then uses `n[0].result`, the top frame only. So **iframe content does not appear in read_page**, despite `all_frames:true` in the manifest. The all-frames registration exists so that `__claudeElementMap` and the phantom cursor exist in subframes for other paths (`stripExtensionInterference` uses `allFrames:!0` at `:461-463`; `upload_image` manually descends one iframe level via `contentDocument.elementFromPoint` at `:7996-8008`).

That is a real capability gap versus a CDP-based or shadow-piercing walker.

## 5. find

**It is a model call.** `mcpPermissions-BIFqj2d3.js:6035-6046`:

```js
const g=await m({
  maxTokens:800,
  modelClass:"small_fast",
  messages:[{role:"user",content:
    `You are helping find elements on a web page. The user wants to find: "${r}"\n\n`+
    `Here is the accessibility tree of the page:\n${f.pageContent}\n\n`+
    `Find ALL elements that match the user's query. Return up to 20 most relevant matches, ordered by relevance.\n\n`+
    `Return your findings in this exact format (one line per matching element):\n\n`+
    `FOUND: <total_number_of_matching_elements>\nSHOWING: <number_shown_up_to_20>\n---\n`+
    `ref_X | role | name | type | reason why this matches\n...`}]
}, "sampling_find_tool")
```

Pipeline: run `__generateAccessibilityTree("all", null, maxChars)` → send the whole tree to a small fast model → parse the pipe-delimited lines → **validate every returned ref against the refs actually present in the tree** (`w=new Set(f.pageContent.match(/\[ref_\d+\]/g)?.map(e=>e.slice(1,-1)))`, `:6053-6056`) → drop hallucinated refs.

When the call is relayed through MCP sampling rather than run in-extension, the tree is capped at 30000 chars (`h=t?.inferenceRelayed?3e4:null`, `:6015`). Otherwise the default 50000 applies. `createAnthropicMessage` must be present in the context or the tool errors with `"Anthropic client not available"`.

Error codes: `find_permission_denied`, `find_no_match`, `find_exception`.

## 6. Screenshots

**`Page.captureScreenshot` via CDP**, never `chrome.tabs.captureVisibleTab`. `mcpPermissions-BIFqj2d3.js:3002-3170`.

Constants (`:2509-2512`, `:369-372`):

```js
MAX_BASE64_CHARS   = 1398100   // ~1.33 MB of base64, i.e. ~1 MB of bytes
INITIAL_JPEG_QUALITY = 0.75
JPEG_QUALITY_STEP    = 0.05
MIN_JPEG_QUALITY     = 0.10
defaultResizeParams  = {pxPerToken:28, maxTargetPx:1568, maxTargetTokens:1568}
```

Default format is `jpeg` at quality 75. `captureBeyondViewport:false, fromSurface:true`.

**Sizing.** `Ie()` (`:376-415`) binary-searches the largest width whose `ceil(w/28)*ceil(h/28)` token count stays under 1568 tiles and whose longest side stays under 1568 px, the Claude vision token budget, computed exactly rather than approximated.

**Two capture paths.**

- *Clip path* (preferred): if `Es()` says so (`:3348-3354`: enabled when `chrome.storage.local.captureScreenshotClipScale` is set, or when the tab is not `visible`), the resize is pushed into CDP itself via `clip:{x:scrollX,y:scrollY,width,height,scale:E}`, so Chrome renders straight to the target size. The result is then **verified by decoding the JPEG/PNG header** (`we()`, via `_e`/`ye`/`be` around `:340-368`) and checking the decoded dimensions match within 1 px (`:3140-3150`). Only then is it returned without a re-encode.
- *Content-script path* (`processScreenshotInContentScript`, `:3171-3345`): the base64 is injected into the page, drawn to a canvas, downscaled by DPR, re-scaled to the token budget, and re-encoded to JPEG in a **quality-reduction loop**: `while(b64.length > MAX_BASE64_CHARS && q > 0.10) q -= 0.05` (`:3277-3287`).

**Coordinate mapping.** Every screenshot writes a coordinate context (`$e.setContext`) carrying `{width,height,viewportWidth,viewportHeight}`. Clicks map back with `Si()` (`:3814-3819`):

```js
const n=r.viewportWidth/r.screenshotWidth, o=r.viewportHeight/r.screenshotHeight;
return [Math.round(e*n), Math.round(t*o)]
```

and `Ei()` (`:3821-3843`) bounds-checks first, returning

```
Coordinate (x, y) is outside the coordinate frame (WxH). Coordinates are pixels
in the full-resolution frame, never in a scaled image's own pixels — if the page
or window changed, take a new screenshot first.
```

So device scale factor is folded into the screenshot dimensions rather than tracked separately, and the model always works in **screenshot pixels**.

**The `scale` parameter** (`_c`, `:4667-4671`) is `[0.1, 1]` and shrinks the returned image only. The result string then says `— 0.5-scale view; coordinate frame: WxH.` and `frameWidth/frameHeight` carry the full-resolution frame (`:5714-5719`), so coordinates stay in full resolution even when the image is half size. This is a clean way to cut vision tokens without breaking clicking.

**`zoom`** (`:5088+`) captures a region and scales it to fill the viewport; the cropping is done by `Sc()` (`:5716-5765`), an injected canvas `drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh)` returning PNG.

A rate-limit *observation* (not enforcement) exists: `recentCaptureAttempts` tracks screenshots per tab in the last 60 s and reports it as a telemetry span attribute `screenshot_attempts_last_60s` (`:3019-3031`).

## 7. Console and network capture

Buffers live on `globalThis` in the service worker, not in storage, keyed by tab (`mcpPermissions-BIFqj2d3.js:2376-2392`):

```js
globalThis.__cdpConsoleMessagesByTab
globalThis.__cdpNetworkRequestsByTab
globalThis.__cdpNetworkTrackingEnabled
globalThis.__cdpConsoleTrackingEnabled
```

Caps: `MAX_LOGS_PER_TAB = 10000`, `MAX_REQUESTS_PER_TAB = 1000` (`:2371-2372`), enforced by splicing from the front (`:2925-2932`, `:2966-2972`).

Events captured (`:2400-2462`): `Runtime.consoleAPICalled`, `Runtime.exceptionThrown`, `Network.requestWillBeSent`, `Network.responseReceived` (fills in `status`), `Network.loadingFailed` (sets `status = 503`). Network records keep only `{requestId, url, method, status}`, with **no headers and no bodies**, even though `Network.enable` is called with `maxPostDataSize:65536`.

Capture starts when the debugger attaches, which happens on first use of any CDP tool on that tab. `enableConsoleTracking` (`:2937-2944`) and `enableNetworkTracking` (`:2973-2992`) mark the tab. Network enabling deliberately does `Network.disable` → 50 ms → `Network.enable` to force a clean stream.

**The "current domain only" rule** is a *reset on domain change*, implemented in the append path rather than on a navigation event. Console, `:2914-2924`:

```js
let o=e.consoleMessagesByTab.get(t);
if(o&&o.domain!==r ? (o={domain:r,messages:[]}, e.consoleMessagesByTab.set(t,o)) : o||(...))
```

Network, `:2953-2960`:

```js
if(o ? o.domain!==r&&(o.domain=r, o.requests=[]) : (...))
```

The domain is the **hostname of the message's own URL** (`extractDomain`, `:2909-2913`, using the stack-frame URL for console messages and `documentURL` for requests). Consequence worth knowing: a message whose URL is a third-party script host flips the buffer's domain and **wipes everything already collected**. That is a fragile design.

Console messages also get a monotonicity fix-up: a message whose timestamp precedes the previous one is bumped forward (`:2919-2923`).

Filtering at read time (`getConsoleMessages`, `:2945-2952`): `errorsOnly` keeps `error`/`exception`; a filter string is compiled as a case-insensitive regex, falling back to substring match if the regex is invalid. Network filtering is a plain `url.includes(filter)`.

## 8. javascript_tool

`mcpPermissions-BIFqj2d3.js:5840-5852`:

```js
const p=(e,t)=>Ss.sendCommand(a,"Runtime.evaluate",{
  expression:e, returnByValue:!0, awaitPromise:!0, replMode:t, timeout:z
}, z+N);
let f=await p(`{${n}\n}`,!0);
```

So: `returnByValue: true`, `awaitPromise: true`, and **`replMode: true`** with the code wrapped in a block `{ ... }`. That is what gives top-level `await` and last-expression-value semantics. If the block form throws a `SyntaxError` matching `/Illegal return statement/`, it retries once as `(async()=>{ ... })()` with `replMode:false` (`:5853-5856`). Evaluation runs in the **page's main world** (CDP, not `chrome.scripting`).

Result serialization (`:5920-5945`) is by `RemoteObject.type`/`subtype`: `undefined`, `null`, functions and `node`/`array` subtypes are reduced to their `description` string. Only plain objects and primitives are actually returned by value.

Everything returned passes through a **redaction walker** `w()` (`:5857-5919`), depth-limited to 5, which:

- blocks strings that look like cookie or query strings (`includes("=") && (includes(";")||includes("&"))`)
- blocks JWT-shaped strings `^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$`
- blocks long base64 `^[A-Za-z0-9+/]{20,}={0,2}$`
- blocks hex credentials `^[a-f0-9]{32,}$`
- truncates any string over 1000 chars
- blanks any object key matching `/password|token|secret|api[_-]?key|auth|credential|private[_-]?key|access[_-]?key|bearer|oauth|session/i`, plus `cookie`/`cookies`
- truncates arrays at 100 items

Final output cap is **51200 chars** (`_=51200`, `:5919`) with `\n[OUTPUT TRUNCATED: Exceeded 50KB limit]`.

Errors: exceptions are returned as `error: "JavaScript execution error: ..."`, and a timeout is reported as `Execution timeout: Code exceeded ${z/1000}-second limit`. `chrome:`/`chrome-extension:` pages are refused before evaluation (`:5814-5817`).

## 9. form_input

`mcpPermissions-BIFqj2d3.js:6170-6340`. Values are set from an **injected script in the isolated world**, resolving the element from `window.__claudeElementMap[ref]` and checking `document.contains`.

Per element type:

- `<select>`: linear scan matching `option.value === String(value)` **or** `option.text === String(value)`, sets `selectedIndex`. On no match it returns the full option list in the error (redacted when the field is sensitive).
- checkbox: requires a boolean, sets `.checked`
- radio: sets `.checked = true`, reports the group `name`
- `date`/`time`/`datetime-local`/`month`/`week`: `.value = String(value)`
- `range`: numeric check then `.value`
- `number`: numeric check then `.value`
- any other `input` or `textarea`: `.value = String(value)`, then `setSelectionRange(len,len)` for `text|search|url|tel|password` and textareas

**Every branch does the same three things**: `scrollIntoView({behavior:"smooth",block:"center"})`, `.focus()`, then

```js
r.dispatchEvent(new Event("change",{bubbles:!0}));
r.dispatchEvent(new Event("input", {bubbles:!0}));
```

Two weaknesses stand out.

1. **No native value setter.** It assigns `element.value` directly. React (and any framework that patches the value descriptor on the element instance) will not see the change, because React reads its own cached `_valueTracker`. The standard workaround, `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el, v)`, is absent. Grep for `getOwnPropertyDescriptor` in the bundle finds no such use.
2. **Event order is inverted.** Real browsers fire `input` then `change`. This fires `change` then `input`, and never fires `blur`, `keydown`, or `beforeinput`.

There is **no `contenteditable` branch at all**: a contenteditable div falls through to `Element type "DIV" is not a supported form input`. The model must use `computer.type` for those.

Sensitivity redaction mirrors the a11y tree: `password`/`hidden` type or `autocomplete` in `{current-password, new-password, one-time-code, cc-number, cc-csc, cc-exp}` produces `[redacted]` in the output message (`:6180-6186`).

## 10. file_upload and upload_image

**`DOM.setFileInputFiles` is not used.** Grep finds no occurrence. Both tools build a `DataTransfer` in the page's isolated world and assign `input.files`.

`file_upload` (`:20519-20740`). Bytes arrive **from the MCP controller as base64 in the tool arguments**, and the extension never touches the filesystem:

```
files: "Files to upload, as base64-encoded bytes. The MCP controller is responsible
        for reading the file and supplying its contents here."
paths: "DEPRECATED. Host filesystem paths are no longer accepted; pass file contents
        via `files` instead."
```

Validation (`:20565-20590`): each entry needs `data` and `name`; `name` is normalized by `tb()` to a plain filename (no directories, max 255 chars); the running decoded size is accumulated by `eb()` and compared against `Qg`, and exceeding it returns

```
Total upload size exceeds 10 MB; use smaller files or split across multiple file_upload calls.
```

The injection (`:20620-20685`) refuses anything that is not `INPUT[type=file]`, builds `File` objects from `atob`, assigns `s.files=o.files`, focuses, and dispatches `input` then `change` (correct order here, unlike `form_input`).

I did **not** find a "only shared files" restriction inside the extension. The extension's own constraint is purely "the caller supplies bytes". Any shared-file gating must live in the MCP controller (Claude Code / Desktop), which is outside these bundles. Stated as undetermined rather than guessed.

`upload_image` (`:7871-8200`) takes an `imageId` instead of bytes. Two retrieval paths (`:7947-7975`):

- when the caller passed message history (`t.messages`), it scans back through the conversation for the image block adjacent to the text block containing the id (`Ii()` at `:3730-3805`), including user-uploaded images
- on the **bridge** path there is no message history, so it consults a **screenshot byte cache** keyed by session scope (`I.get(t.sessionScope, r.imageId)`), with the error
  `The requested screenshot is no longer available (it may have expired, or was not taken in this session)...` and `errorCode:"screenshot_bytes_unavailable"`

Delivery is either the file-input path (same `DataTransfer` assignment, plus a custom `filechange` event) or, for a `coordinate` target, a **synthetic drag-and-drop**: `dragenter` → `dragover` → `drop`, each a real `DragEvent` carrying the `DataTransfer` and full `clientX/clientY/screenX/screenY` (`:8065-8110`). If the element at the point is an `IFRAME`, it descends one level via `contentDocument.elementFromPoint` (`:7996-8008`).


## 11. gif_creator

Split across three contexts: frames are captured in the service worker, encoding happens in the **offscreen document**, and export goes out through `chrome.downloads` or a synthetic drop.

**Frame capture is event-driven**, in `Ci()` (`mcpPermissions-BIFqj2d3.js:3888-3985`). After any `computer` or `navigate` tool call on a tab whose **group** is recording, it waits `await ce(100)`, takes a screenshot with `updateCoordinateContext:!1`, reads `window.devicePixelRatio` with a separate `executeScript`, and pushes `{base64, action, frameNumber, timestamp, viewportWidth, viewportHeight, devicePixelRatio}`.

Two refinements worth copying:

- for click and drag actions it **first re-emits the previous frame** annotated with the click marker (`:3924-3945`), so the viewer sees the pointer land before the page changes
- the coordinate stored on the action is mapped from screenshot space to viewport space with `Si()` first (`:3890-3893`)

Store `Mi` (`:3844-3880`) is a `Map<tabGroupId, {frames, lastUpdated}>` capped at **50 frames**, dropping the oldest. Recording is scoped to a tab group, not a tab.

Per-action frame delays, `Nc()` (`:6907-6922`):

```js
{wait:300, screenshot:300, navigate:800, scroll:800, scroll_to:800,
 type:800, key:800, zoom:800,
 left_click:1500, right_click:1500, double_click:1500,
 triple_click:1500, left_click_drag:1500}   // default 800
```

The last frame gets **+2000 ms** so the result is readable (`offscreen.js:534-538`).

**Encoder: `gif.js` with 2 workers**, `quality: options.quality ?? 10`, `repeat: 0`, `workerScript: chrome.runtime.getURL("gif.worker.js")` (`offscreen.js:540-550`). This is the stock `gif.js` / `gif.worker.js` pair, shipped unminified.

**Overlays**, all drawn on a per-frame canvas before encoding and all scaled by `scaleFactor = canvas.width / frame.viewportWidth` (`offscreen.js:485-495`):

- click indicator, a ring at the mapped coordinate (`applyActionIndicators`, `:325-345`)
- drag path: a line plus start and end markers, `#cf6b3c` stroke and a `#dc2626` end ring (`drawDragPath`, `:140-164`)
- action label: a rounded black pill with a shadow and white text, auto-flipped when it would run past the right edge (`drawActionLabel`, `:169-238`)
- progress bar: 4 px tall, `#C96442` fill over `rgba(0,0,0,0.3)` (`drawProgressBar`, `:243-262`)
- watermark: the Claude glyph as a `Path2D`, 32 px, bottom-right, gradient `#DC6038` to `#D97757` (`drawWatermark`, `:268-320`)

All five default to `true`.

Frames can differ in size (a `zoom` crop is a real frame), so the encoder runs on `max(width)` by `max(height)` and smaller frames are **padded right and bottom with white after overlays are drawn**, so the progress bar and watermark stay anchored to the visible edge (`padCanvasToSize`, `:401-421`, with the reasoning in the comment).

**Export** (`mcpPermissions-BIFqj2d3.js:6700-6810`): either `chrome.downloads.download({url: blobUrl, filename, saveAs:false})` with an `onChanged` listener that revokes the blob URL when the download completes or is interrupted, or a synthetic `dragenter` / `dragover` / `drop` at a coordinate, carrying the GIF as a `File` in a `DataTransfer`. Frames are cleared after a successful export.

## 12. Tab management

The unit of work is a **Chrome tab group**, not a tab. `Is` (the tab manager, `chunk-dumb.js:700-730`) keeps `groupMetadata: Map<mainTabId, {chromeGroupId, memberStates, ...}>` persisted to `chrome.storage.local` under `O.TAB_GROUPS`.

**Two kinds of group.**

- The **MCP group** (`getOrCreateMcpTabContext`, `chunk-dumb.js:1795-1850`): a single group per browser, id kept in `chrome.storage.session`, forced to `title: ws` and `color: YELLOW` by `ensureMcpGroupCharacteristics`. When it does not exist and `createIfEmpty` is set, it opens **a whole new focused window** on `chrome://newtab` and groups its first tab.
- **Session groups** (`getOrCreateSessionTabContext`, `chunk-dumb.js:1852-1910`): one per client session, titled with the client's `displayName`, coloured from a rotating palette `[BLUE, CYAN, GREEN, ORANGE, RED, PINK, PURPLE, GREY]` indexed by `colorIndex % 8`. These prefer `chrome.windows.getLastFocused({windowTypes:["normal"]})` and create a tab there with `active:false`, only opening a new window when there is no normal window at all.

So the official extension opens a new window for the legacy MCP group and reuses the current window for session groups.

**Every tool call resolves its tab through `getEffectiveTabId(requested, contextTab)`** (`chunk-dumb.js:1499-1510`), which throws when the requested tab is not in the same group:

```
Tab ${e} is not in the same group as the current tab. Valid tab IDs are: ${r.join(", ")}
```

`isTabInSameGroup` treats `TAB_GROUP_ID_NONE` as "only itself" (`chunk-dumb.js:1455-1462`). Every successful tool result carries a `tabContext` with `currentTabId`, `executedOnTabId`, `availableTabs` and `tabCount`, so the model is re-grounded on every call.

**Tabs opened by the page.** There is no `chrome.tabs.onCreated` listener and no adoption by `openerTabId`. The one place new tabs are created deliberately is the **foreground guard** (`Ae`, `mcpPermissions-BIFqj2d3.js:692-795`), and it only arms when the window is **minimized** and the feature gate `cic_minimized_window_guard` is on:

- `Me()` (`:643-690`) installs a `click` listener that intercepts trusted clicks landing on an `<a href>` whose effective `target` is `_blank` (or a named target with no matching frame), calls `preventDefault()` and records the href. It deliberately does not intercept clicks on `BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY|LABEL|EMBED`, controls-bearing media, `usemap` objects, contenteditable, or same-origin `download` links.
- `finishClickInterception` (`:722-780`) then opens up to **3** of the captured hrefs itself with `chrome.tabs.create({active:false, windowId, openerTabId, index: tabIndex+1+i})` and adds them to the same tab group. The ids come back in the click result as
  `[note: the link opened in a new tab (tab ID N); pass that tab ID to interact with it]`.

The point is that letting Chrome open a `_blank` tab from a minimized window would un-minimize it and steal focus.

**Tab leaves the group.** `handleTabGroupChange` (`chunk-dumb.js:761-790`) listens for `groupId` changes: it hides the indicator, drops the member state, notifies detach, and if the departing tab was the group's **main** tab it re-groups it into its own window rather than losing the session.

**Tab removal.** `chrome.tabs.onRemoved` only clears blocklist tracking (`chunk-dumb.js:719-723`). Closing the last tab lets Chrome remove the group, which the `tabs_close_mcp` description states outright: `If the closed tab is the last one in the group, Chrome auto-removes the group.` There is no window-keep-alive guard, so closing the last tab in a window closes the window.

## 13. Permissions and safety

Four layers, in the order they run.

### Layer 1, enterprise policy

`managed_schema.json` exposes three settings.

- `blockedUrlPatterns`: hostname-plus-path glob list, case-insensitive, `http(s)://` and `www.` stripped, a bare domain treated as `<domain>/*`. Checked by `l.isUrlBlockedByManagedPolicy` before anything else and mapped to `category_org_blocked`.
- `forceLoginOrgUUID`: one UUID or a JSON array. A signed-in user outside the list gets a blocking page with a log-out button.
- `thirdPartyDesktopMode`: when true (only honoured on a force-installed copy, and requiring exactly one `forceLoginOrgUUID`), the extension stops connecting to the hosted bridge, stops sending error reports, performance telemetry and usage analytics, stops fetching feature configuration, and makes **no Anthropic API calls other than identifying the user and the hosted URL-safety check**.

### Layer 2, hosted URL safety categories

`Ue.getCategory(url)` (`d-mcpPermissions-BIFqj2d3.js:548-590`):

```js
const o=new URL("/api/web/url_hash_check/browser_extension","https://api.anthropic.com"),
a=await fetch(o.toString(),{method:"POST",
  headers:{"Content-Type":"application/json",Authorization:`Bearer ${n}`},
  body:JSON.stringify({url:e,max_supported_category:4})});
```

The URL is normalized first (`normalizeUrl`, `:539-547`): a scheme is added if missing, **the fragment is stripped** (`t.hash=""`), and a trailing dot is removed from the hostname. Path and query are sent. Results are cached for `CACHE_TTL_MS = 300000` (5 min) and in-flight requests are de-duplicated.

Categories and their restrictiveness order (`d-mcpPermissions-BIFqj2d3.js:4461`):

```js
{category0:1, category4:2, category3:3, category_unknown_error:4,
 category2:5, category_org_blocked:5, category1:6}
```

**Blocking set**: `category1`, `category2`, `category_org_blocked`, `category_unknown_error` (`:6184`). A failed lookup blocks:
`Could not verify this site's safety category. Blocking as a precaution — try again in a moment.` (`:519`)

`category1` is the hard block: a top-frame `webNavigation.onCommitted` into it **redirects the tab to `blocked.html?url=<encoded>`** (`:17411-17420`), whose entire body reads "The content on this page isn't available when Claude is active for safety reasons." A tab sitting on `blocked.html` is itself treated as `category1` afterwards (`:4444`, `:4520`).

`category4` is not blocked but attaches a **copyright notice** into the tool result, once per domain (`Kg` / `Vg`, `d-mcpPermissions-BIFqj2d3.js:16140-16148`):

```
<system-reminder>The user has confirmed they have the right to access content on
${domain}. Do not reproduce substantial portions of this site's content verbatim.
</system-reminder>
```

Every tool calls a shared gate `i(tabId, url, label)` before acting, and `browser_batch` re-checks the category **before and after every item**, including `pendingUrl` (`d-mcpPermissions-BIFqj2d3.js:6340-6420`), so a mid-batch navigation into a blocked domain aborts the batch with `batch_domain_blocked`.

### Layer 3, per-domain user permission

`dd` (`d-SavedPromptsService-BQWFiAS3.js:9998-10050`) holds a persisted list of grants, each `{id, scope, action: allow|deny, duration: once|always, toolUseId, origin, surface}`. `checkPermission(url, toolUseId)` in order:

1. `isDeniedHost` on the normalized domain (suffix match on `deniedDomains`) gives denied, no prompt
2. turn-approved set non-empty and this host not in it gives denied, no prompt
3. localhost bypass when `bypassLocalhostForMcp`
4. `skip_all_permission_checks` gives allowed
5. host in `turnApprovedDomains` (and not `restrictOnly`) gives allowed
6. otherwise look for a stored grant, honouring `once` bound to a `toolUseId`
7. no grant gives `{allowed:false, needsPrompt:true}`

`permission_mode` arrives on the bridge `tool_call` and maps (`Sb`, `d-mcpPermissions-BIFqj2d3.js:17029-17034`):

- `ask` or absent: the default manager, prompt per domain
- `follow_a_plan`: the model must first call `update_plan` declaring the domains it will visit. Those domains are **filtered through the category API** (`Jc`, `:8773-8790`) and only the survivors become `turnApprovedDomains`. The system reminder is `You are in planning mode. Before executing any tools, you must first present a plan to the user using the update_plan tool.`
- `skip_all_permission_checks`: everything allowed except the denied-host list, which is still applied

Permission actions are classified per tool and, inside `computer`, **per action** (`bc`, `mcpPermissions-BIFqj2d3.js:4646-4657`): `screenshot`, `scroll`, `scroll_to`, `zoom`, `hover` are `read_page_content`; the four clicks and `left_click_drag` are `click`; `type` and `key` are `type`. Separate categories exist for `navigate`, `upload_image`, `execute_javascript`, `domain_transition`, `plan_approval` and `remote_mcp` (`d-SavedPromptsService-BQWFiAS3.js:9845`).

The prompt is not inline: `Yb()` (`d-mcpPermissions-BIFqj2d3.js:17357-17390`) writes the request into `chrome.storage.local` under `mcp_prompt_<uuid>` and opens a **600 by 600 popup window** on `sidepanel.html?mcpPermissionOnly=true&requestId=...`. For clicks the prompt carries a screenshot with the click coordinate translated into that screenshot's frame (`mcpPermissions-BIFqj2d3.js:4718-4745`), so the user sees where the click would land. On the bridge path the host can instead answer with a `permission_response` message (`requestPermissionFromHost`, `service-worker.ts-CNWEmoH7.js:380-404`).

There is a **domain-transition** permission type: moving from one domain to another mid-task needs its own grant (`checkDomainTransition`, `d-SavedPromptsService-BQWFiAS3.js:10051-10090`).

### Layer 4, in-page redaction

Covered above: the a11y walker and `form_input` replace password, hidden and `autocomplete`-marked payment fields with `[value redacted]` / `[redacted]`, and `javascript_tool` runs its result through the credential-shaped-string filter.

### What is not there

No CAPTCHA detection strings, no payment-form heuristic beyond the `autocomplete` list, no prompt-injection classifier. Grepping the bundles for `captcha`, `recaptcha` and `hcaptcha` finds nothing in the tool paths.

### The visual indicator

`assets/agent-visual-indicator.js-CwioqiOd.js`, injected at `document_idle` in the top frame only. It draws, all at `z-index` 2147483646-7:

- `#claude-phantom-cursor`: an SVG arrow, 20 by 26, `aria-hidden`, `pointer-events:none`, moved with `transform: translate3d(...)` and a `180ms cubic-bezier(0.2,0,0,1)` transition. Two variants, `claude-phantom-cursor-plain` (white on `#111`) and `claude-phantom-cursor-styled` (`#D97757` with two `drop-shadow` glows).
- `#claude-agent-glow-border` and `-inner`: a pulsing border around the whole viewport while the agent is acting on this tab.
- `#claude-agent-stop-container` and `#claude-agent-stop-button`: a floating **Stop** button. Its click handler requires `e.isTrusted` and sends `STOP_AGENT`, with a fallback `STOP_AGENT_DROPPED` toast when the worker does not answer.
- `#claude-static-indicator-container` with a chat button, a close button and tooltips: the resting pill shown on secondary tabs in the group.

The message vocabulary is `SHOW_AGENT_INDICATORS`, `HIDE_AGENT_INDICATORS`, `SHOW_STATIC_INDICATOR`, `HIDE_STATIC_INDICATOR`, `HIDE_STATIC_PILL`, `DISMISS_STATIC_INDICATOR_FOR_GROUP`, `STATIC_INDICATOR_HEARTBEAT`, `HIDE_FOR_TOOL_USE`, `SHOW_AFTER_TOOL_USE`, `UPDATE_PHANTOM_CURSOR`, `SWITCH_TO_MAIN_TAB`, `STOP_AGENT`, `STOP_AGENT_DROPPED`.

State is tracked per tab in the tab manager as `pulsing`, `static`, `hidden_for_screenshot` or `none`, with `hideIndicatorForToolUse` and `restoreIndicatorAfterToolUse` wrapping every screenshot and click (`chunk-dumb.js:1589-1620`), so the overlay never lands in a capture. Exactly one tab in a group is `pulsing` at a time (`setActiveIndicatorTab`, `chunk-dumb.js:1529-1560`).

## 14. Bot-detection posture

**Nothing is hidden and nothing is spoofed.** Across every bundle:

- no `Emulation.setUserAgentOverride`, no `Network.setUserAgentOverride`, no `Emulation.setDeviceMetricsOverride`, no `Emulation.*` call of any kind in the tool paths
- no `Page.addScriptToEvaluateOnNewDocument`, so `navigator.webdriver` is untouched
- no attempt to suppress the `chrome.debugger` infobar
- `Runtime.enable` is issued on every attached tab (`mcpPermissions-BIFqj2d3.js:2559-2562`), the classic CDP-detection tripwire, and is never disabled

The only `webdriver` reference in the whole extension is **self-detection for analytics** in the side panel (`d-sidepanel-CAcalR0O.js:20768-20776`), which tags the session `ua_bot`, `ua_headless` or `webdriver` using

```js
/bot(?:[^a-z0-9]|$)|crawl|spider|slurp|scrape|lighthouse|pagespeed|ptst\/|prerender|
 google(?:other|-inspectiontool|-read-aloud| favicon)|bingpreview|facebookexternalhit|
 datadogsynthetics|checkly/i
```

That is telemetry hygiene, not evasion.

What does help it pass as human is structural rather than deliberate: every click, key and wheel event goes through CDP `Input.*`, so events carry `isTrusted: true`, and it drives the user's real signed-in profile. The timing is only loosely human-shaped (50 ms before a click, up to 200 ms for the cursor, 100 ms settle, 12 ms press-to-release) and **all of it is skipped when the browser is backgrounded**, which is when most automation runs.

Two things it actively adds to the page that a detector could see: the injected `#claude-phantom-cursor` element (an **open** DOM node, not a shadow root) and, in the `stripExtensionInterference` path, the removal of other extensions' iframes.

## 15. Multi-browser

The device identity lives in the extension. The browser-picking tools do not.

- `bridgeDeviceId`, a `crypto.randomUUID()` persisted in `chrome.storage.local` (`service-worker.ts-CNWEmoH7.js:146-155`), is sent as `device_id` in the `connect` frame, and every inbound `tool_call`, `external_message` and `external_config` is filtered on `target_device_id` (`:296-297`, `:441`, `:483`). One account can therefore have several browsers on the bridge, and the server routes by device.
- `bridgeDisplayName` in `chrome.storage.local` is the human label, sent as `display_name` and set through the pairing flow.
- **Pairing is server-initiated.** A `pairing_request` bridge message (`:472-497`) first tries `chrome.runtime.sendMessage({type:"show_pairing_prompt", ...})` so an open side panel can handle it, and otherwise opens
  `chrome.tabs.create({url: chrome.runtime.getURL("pairing.html?request_id=...&client_type=...&current_name=...")})`.
  `pairing.html` is a React page (`assets/pairing-DxZkpdLN.js` plus `PairingPrompt-Bm4k0wzK.js`). Confirming posts `pairing_confirmed` back to the worker, which stores the chosen name (`:3455-3470`). Duplicate `request_id`s are ignored.
- `list_connected_browsers`, `select_browser` and `switch_browser` are **not implemented in the extension**. The only trace of them is display metadata in the chat UI (`d-mcpPermissions-BIFqj2d3.js:9543-9560`), which tells us what they do from the browser's side:

```
switch_browser  -> "Waiting for you to choose a browser"
  hint: "Switch to the Chrome window you want Claude to use. You'll see a
         'Claude Desktop wants to connect' prompt in the side panel, give the
         browser a name and click Connect."
select_browser  -> "Connecting to browser"
list_connected_browsers -> "Checking connected browsers"
```

So the registry of browsers lives on the bridge server (or in Claude Desktop over native messaging), `list_connected_browsers` queries it, `select_browser` sets the routing target, and `switch_browser` additionally triggers the interactive `pairing_request` above. The native-messaging side has its own analogue: the `sealed` and `local_pairing` `execute_tool` variants keyed by a session id `sid` (`service-worker.ts-CNWEmoH7.js:2570-2620`), an encrypted channel per paired Desktop.

## 16. Telemetry

Four sinks are declared in the manifest CSP `connect-src`: `https://api.segment.io` and `https://*.segment.com`, `https://*.ingest.us.sentry.io`, `https://browser-intake-us5-datadoghq.com`, plus `https://api.anthropic.com`.

- **Anthropic event logging** is the primary sink: `https://api.anthropic.com/api/event_logging/v2/batch` (`d-SavedPromptsService-BQWFiAS3.js:5446`), batched at 500.
- **Segment** analytics-node is bundled, with `api.segment.io/v1` and a `/v1/batch` default path (`:1526`, `:4889`), 10 s HTTP timeout.
- **Sentry** is bundled (the `sentry*` symbol set runs through `SavedPromptsService-BQWFiAS3.js`).
- **Datadog RUM** appears only in the side panel bundle (`ext/sidepanel-CAcalR0O.js`).

Event names emitted from the worker and the tool engine, complete list:

```
claude_chrome.bridge.{connected, disconnected, error, connect_timeout,
  stale_socket_reconnect, network_online, network_offline, peer_connected,
  peer_disconnected, tool_received, tool_call, result_sent,
  external_result_sent, access_token_cleared}
claude_chrome.mcp.tool_called
claude_chrome.chat.tool_called
claude_chrome.permission.{prompted, responded}
claude_chrome.foreground_guard.{prevented, aborted, create_failed, drain_failed}
claude_chrome.extension_url.{reconnect, tab_switch, unknown_exception}
claude_chrome.extension.update_available
claude_chrome.scheduled_task.executed
claude_chrome.skill_migration.{completed, dry_run, aborted_auth_change,
  deferred_no_org, skipped_too_many}
claude_chrome.sidepanel.unsupported_browser
claude_chrome.stop_pill.dropped
```

**Can page content be included? No, but the hostname can.** The `mcp.tool_called` payload (`d-mcpPermissions-BIFqj2d3.js:17224-17232`) is:

```js
{tool_name, client_id, model, success, tab_id, tab_group_id, duration_ms,
 tool_use_id, session_id, ...spanAttrs, domain, app, error_type}
```

`domain` is the page hostname and `app` is a coarse label from a small table (`google_sheets`, `google_slides`, and so on, `:16118-16134`). Permission events carry `host: m(e.url)` (`:17367`, `:17372`). No accessibility tree, page text, screenshot bytes, console lines or network bodies appear in any payload.

Separately, the **URL safety check sends the full URL, path and query included**, to `api.anthropic.com` for every page the agent navigates to. That is documented in `managed_schema.json` and stays on even under `thirdPartyDesktopMode`.

Tracing spans carry performance attributes that never leave the machine as content: `viewport_probe_ms`, `screenshot_cdp_ms`, `screenshot_b64_len`, `screenshot_format`, `screenshot_capture_px`, `screenshot_use_clip`, `screenshot_decoded_width` / `_height`, `screenshot_dims_verified`, `screenshot_attempts_last_60s`, `target_dom_nodes`, `target_ready_state`, `target_visibility_state`, `target_iframe_count`, `target_js_heap_mb`, `debugger_attach_error`.

## 17. Other notable machinery

### Timeouts, all remotely configurable

The feature gate `cic_ext_timeouts` (`oi()` in `d-SavedPromptsService-BQWFiAS3.js`) overrides these defaults:

| what | default | constant |
|---|---|---|
| `chrome.debugger.attach` | 8 s | `ri = 8e3`, via `debuggerAttachMs` |
| CDP `sendCommand` | 30 s | `ii = 3e4`, via `cdpSendCommandMs` |
| `javascript_tool` `Runtime.evaluate` | 40 s, CDP call 45 s | `ci = 4e4` plus `pi = 5e3` |
| default `executeScript` wrapper | 8 s | `li = 8e3` |
| OAuth refresh | 10 s | `ni = 1e4` |
| CDP wheel scroll race | 5 s | `oc = 5e3` |
| DOM fallback scroll | 2.6 s | `ac = max(8000-5000-400, 1000)` |
| bridge stuck in CONNECTING | 30 s, then close 4003 | |
| bridge pong staleness | 90 s, then close 4001 | |
| reconnect backoff | 2 s times 1.5^n, capped 5 min, plus or minus 20 % jitter | |
| `computer wait` | 0-10 s, hard limit | |
| beforeunload resolution wait | 300 ms | `Lc()` |

Every browser-side timeout error names the likely cause rather than just failing:

```
CDP sendCommand "X" timed out after Nms on tab T. The renderer may be frozen or unresponsive.
debugger_attach_error: chrome.debugger.attach timed out after Nms on tab T. DevTools may be
open on this tab, or the renderer may have crashed.
```

### Retries

- `sendCommand` retries **once** after a detach-shaped error, re-attaching first (`mcpPermissions-BIFqj2d3.js:2620-2640`)
- `attachDebugger` retries up to **4** times through `stripExtensionInterference` when another extension's iframe blocks the attach
- `javascript_tool` retries **once** with an async-IIFE wrapper when the REPL form hits `Illegal return statement`
- `scroll` falls back to the DOM path when the CDP wheel produced under 5 px of movement
- unsent bridge results are replayed on reconnect: 8 slots, 2 min TTL

### Error-code catalogue

Machine-readable `errorCode` values found in the bundle: `find_permission_denied`, `find_no_match`, `find_exception`, `navigate_blocked_domain`, `navigate_category_lookup_error`, `navigate_permission_denied`, `navigate_beforeunload_blocked`, `navigate_exception`, `page_zoom_shortcut_unsupported`, `screenshot_bytes_unavailable`, `batch_disabled`, `batch_invalid_input`, `batch_no_tools_context`, `batch_tab_outside_group`, `batch_cancelled`, `batch_unknown_tool`, `batch_permission_required`, `batch_domain_blocked`, `batch_navigation_blocked`, `category_unknown_error`.

### browser_batch

Description (`d-mcpPermissions-BIFqj2d3.js:6213`):

> Execute a sequence of browser tool calls in ONE round trip. Each item is `{name, input}`... Actions execute SEQUENTIALLY (not in parallel) and stop on the first error. Use this tool extensively to quickly execute work whenever you can predict two or more steps ahead... Each tool's own permission check runs per item... Screenshots and other images are returned interleaved with outputs; **coordinates you write in THIS batch refer to the screenshot taken BEFORE this call**. browser_batch cannot be nested.

The last clause is enforced, not just documented. Inside a batch every screenshot is taken with `updateCoordinateContext:"defer"` and a `pendingContextScope` (`Tc()`, `mcpPermissions-BIFqj2d3.js:5688-5697`), so the coordinate frame the model was working from stays valid for the whole batch and is only committed at the end. That is the single cleverest idea in the extension.

Pre-flight it validates every item's shape and every item's `tabId` group membership before running anything (`d-mcpPermissions-BIFqj2d3.js:6320-6338`). It reports progress through `onBatchProgress`, supports `isCancelled`, and rejects a permission prompt mid-batch with the instruction to `call <tool> standalone (not in browser_batch) so the user is prompted`. A gate `chrome_ext_browser_batch_enabled` can turn it off remotely.

### shortcuts and workflows

Not scripts. A shortcut is a **saved prompt** run by a nested agent:

> Execute a shortcut or workflow by running it in a new sidepanel window using the current tab (shortcuts and workflows are interchangeable). This starts the execution and returns immediately - it does not wait for completion.

`shortcuts_execute` (`mcpPermissions-BIFqj2d3.js:20842-20910`) resolves by `shortcutId` or `command`, records usage, and posts `[[shortcut:<id>:<command>]]` into a new side-panel agent session with the shortcut's own `skipPermissions` and `model` settings. `shortcuts_list` returns only `{id, command}`.

### onboarding prompts

`assets/onboarding-prompts-CJtFEMjA.js` is a static string table, web-accessible to `claude.ai`, holding practice tasks (`challenge-email`, `challenge-form`, `challenge-equipment`) and canned use cases (`usecase-zillow`, `usecase-calendar`, and others). Teaching material, not a mechanism.

### Rate limits

None are enforced. The only counter is `recentCaptureAttempts`, a rolling 60 s per-tab screenshot count reported as a telemetry attribute (`mcpPermissions-BIFqj2d3.js:3019-3031`).

### iframe bridge

An in-page control surface for `claude.ai` itself: `CIC_IFRAME_BRIDGE_INIT`, `CIC_IFRAME_TOOL_CALL`, `CIC_IFRAME_AGENT_STATE`, panel id `cic-panel`, with an allowlist of 17 tools reachable that way (`mcpPermissions-BIFqj2d3.js:3355-3374`).

---

# Part 2. Comparison with chrome-mcp

chrome-mcp source paths below are absolute under `C:\Users\edfl\workspace\chrome-mcp`.

## 1. Transport

**Official.** Two channels. A hosted WebSocket bridge (`wss://bridge.claudeusercontent.com/chrome/<accountUuid>`, OAuth token in the first frame, one JSON object per frame) and native messaging to one of two host names. Keepalive is triple-redundant: a 30 s `chrome.alarms`, a 20 s in-socket ping, and an offscreen document pinging the worker every 20 s specifically to defeat the MV3 idle timer. Reconnect is exponential with jitter and a 5 min cap. Unsent results are queued 8 deep for 2 min and replayed. An epoch counter drops results belonging to a dead connection.

**chrome-mcp.** Three hops, all local: stdio MCP to `host/mcp-server.js`, a named pipe to `host/native-host.js` (`host/ipc.js:22-32`), then Chrome native messaging with a uint32-LE length prefix (`host/protocol.js:3-4`) and application-level chunking at 384 KB (`extension/src/background.js:18`, `:36-53`). Keepalive is a 20 s host ping plus a 30 s alarm backstop (`host/native-host.js:17`, `extension/src/background.js:14`, `:297`). Reconnect backs off 500 ms to 30 s (`background.js:22`, `:126-132`). Auth is Chrome's `allowed_origins` pin on a deterministic extension id derived from a generated RSA key (`tools/gen-key.js:23-32`, `host/com.chromemcp.host.json:7`).

**Verdict: chrome-mcp is better for its purpose, with three real gaps.**

Better: the host as listener means several Claude Code sessions share one browser, which the official design does not do locally at all. Chunking past Chrome's 1 MB native-messaging cap is a genuine engineering win the official extension never needed because it uses a socket. The deterministic extension id is a neat fix for unpacked-extension identity. Nothing leaves the machine.

Gaps:
- **No offscreen keepalive.** The official extension explicitly says the 20 s message from an offscreen document is what keeps the worker alive "under background throttle/freeze" (`offscreen.js:6-13`). chrome-mcp relies on port traffic alone, which is subject to the same throttling. A frozen worker with a 120 s request timeout is a 120 s stall.
- **No result queue and no epoch guard.** If the port drops between dispatch and reply, chrome-mcp's pending promise rejects with `{kind:'disconnected'}` (`host/mcp-server.js:87-99`) and the work is lost. There is no replay and no generation counter to prevent a stale reply landing in a new session.
- **No auth on hop 2.** The subagent's finding stands: any local process that can open `\\.\pipe\chrome-mcp-<USERNAME>-<id>` can drive the browser. The official local channel is sealed per pairing session.

## 2. Input

**Official.** CDP only, no synthetic fallback. Click is move, then a visibility-gated 200 ms cursor race and 100 ms settle, then press, 12 ms, release. `type` builds keyDown/keyUp for `[A-Za-z0-9]` and named keys and falls back to `Input.insertText` per character for everything else, then **fires them all with `Promise.all`** with no ordering guarantee and no inter-key delay. Drag is 5 interpolated steps. Scroll is CDP wheel, **verified by re-reading `pageYOffset` and falling back to a scroll-container-aware `scrollBy` when movement is under 5 px**. Modifier bitmask `{alt:1, ctrl:2, meta:4, shift:8}`. macOS chords carry CDP `commands`. No `perKey` concept.

**chrome-mcp.** CDP only as well (`extension/src/lib/cdp.js:3-5`). Click is move, `hoverDelay = 100` ms on the page clock, awaited press, awaited release, 30 ms between repeats (`cdp.js:321-361`). `type` defaults to atomic `Input.insertText` and offers `perKey: true` for 12 ms-spaced per-character key events (`cdp.js:442-457`). Drag is **10** interpolated steps at 16 ms (`cdp.js:370-414`). Key handling has a real key table with `windowsVirtualKeyCode` and `code`, suppresses the `text` payload when a non-shift modifier is held so `ctrl+a` does not type "a" (`cdp.js:485`), and emits a separate `char` event. `sendInput` races the CDP ack against 400 ms and flags a throttled renderer, which the caller turns into `ensureVisible` (`cdp.js:255-279`, `tools.js:178-180`).

**Verdict: chrome-mcp is better on almost every axis, with two things to steal.**

Better in chrome-mcp:
- **`Promise.all` in the official `type` is a bug waiting to fire.** Fifty concurrent `Input.dispatchKeyEvent` calls rely on CDP's internal ordering. chrome-mcp's `insertText` default is both faster and deterministic, and `perKey` is the correct escape hatch for editors that need real key events.
- **The `textual` guard** (`cdp.js:485`) is a correctness fix the official code lacks: the official `pressKeyChord` passes `text` through `keyDown` unconditionally.
- **10 drag steps at 16 ms** beat 5 unspaced steps for drag targets that need movement deltas.
- **The throttled-renderer detection and `ensureVisible`** is a better answer than the official "skip all the delays when backgrounded", which silently degrades reliability.
- chrome-mcp maps `perKey` and `code`/`windowsVirtualKeyCode` on the named-key path; the official `typeKeys` equivalent omits them for the `insertText` fallback.

To steal from the official:
- **Scroll verification.** The official code measures the scroll offset before and after, and falls back to a DOM `scrollBy` on the nearest scrollable ancestor when the wheel moved nothing. chrome-mcp's `mouseScroll` (`cdp.js:416-426`) is fire-and-forget, and a CDP wheel over a virtualized list or a `overflow:hidden` body silently does nothing. This is the single highest-value input fix.
- **`force: 0.5` on pressed mouse events** (`mcpPermissions-BIFqj2d3.js:2687-2688`). Cheap, and some pointer-event handlers read it.
- **Rejecting browser page-zoom chords** with a specific error instead of dispatching them.

## 3. Debugger attach lifecycle

**Official.** Persistent per tab, detached only on session teardown. Attach de-duplicates in-flight attempts, detaches before attaching, and re-enables the domains that were on. `sendCommand` self-heals once on detach-shaped errors. The `chrome-extension:// URL of different extension` failure triggers **`stripExtensionInterference`**: enumerate frames, walk open and closed shadow roots to count iframes, and physically remove the offending extension iframes, then retry up to 4 times. `beforeunload` dialogs are handled with a per-tab accept/dismiss policy defaulting to dismiss; `alert`, `confirm` and `prompt` are not handled at all. The DevTools banner is not suppressed.

**chrome-mcp.** Persistent per tab, refcounted, detached only on worker `beforeunload` (`cdp.js:94-113`, `background.js:319-321`). `already attached` is swallowed and recorded as `foreign:true` (`cdp.js:79-82`). `STALE_ATTACHMENT` errors trigger force-detach, re-attach, re-enable and one retry (`cdp.js:189-210`), with a `describeFrames` diagnostic appended for `chrome-extension` failures (`cdp.js:149-172`). No dialog handling of any kind. Banner not suppressed.

**Verdict: roughly equivalent, with the official ahead on two specific failures.**

- The official `stripExtensionInterference` is a **fix** for exactly the failure chrome-mcp's `STATUS.md:134` and `HANDOFF.md:20-24` record as open and unexplained: "Cannot access a chrome-extension:// URL of different extension" and "What Chrome objects to is not established". The answer is in the official bundle: another extension has injected an iframe whose `src` is a `chrome-extension://` URL from a different extension, and Chrome refuses the attach because of it. chrome-mcp already has `describeFrames` to diagnose it; it needs the removal step to fix it.
- **`beforeunload` handling.** The official code intercepts it, defaults to dismissing, and reports back either `(discarded a "Leave site?" dialog...)` or a blocking error suggesting `force: true`. chrome-mcp's `navigate` has no equivalent, so a page with unsaved changes silently blocks navigation.
- chrome-mcp's `already attached` swallow is worse: recording a DevTools-owned attachment as owned means every subsequent command fails with a confusing error. The official code at least attempts a real attach and reports a timeout naming DevTools.
- Neither handles `alert`/`confirm`/`prompt`, and both document it. Both are wrong to leave it: `Page.javascriptDialogOpening` with `Page.handleJavaScriptDialog` is four lines.

## 4. Accessibility tree and read_page

**Official.** DOM walk in an isolated-world content script. Refs are `ref_N` from a `WeakRef` map plus a reverse `WeakMap`, swept after each walk. Roles from a ~30-entry tag table plus explicit `role`. Names from `aria-label`, `placeholder`, `title`, `alt`, `label[for]`, `value`, direct text children, capped at 100 chars. Visibility is `display`, `visibility`, `opacity`, `offsetWidth/Height`. **No shadow-root traversal at all.** **No iframe traversal at all** (the walk runs only in the top frame). Default `filter:"all"` skips both the visibility and the viewport filter. Depth 15, 10000 nodes, 50000 chars. Output is `role "name" [ref] href= type= placeholder=`.

**chrome-mcp.** DOM walk in an isolated-world content script, same ref scheme with the same `WeakRef` plus reverse `WeakMap` design (`extension/src/content/agent.js:16-42`). But: **open shadow roots are walked** (`agent.js:576-578`), **same-origin iframes are walked inline with live-measured offsets** (`agent.js:580-589`, `offsetFor` at `:455-468`), `aria-labelledby` is resolved (`agent.js:292-366`), hit-box visibility falls back to the associated `<label>` for styled radios and checkboxes (`hitBoxFor`, `:283-290`), offscreen nodes are kept and marked `(offscreen)` rather than dropped, bare text nodes are emitted, `interestingAttributes` includes `checked`, `selected`, `expanded`, `disabled`, `required`, heading `level` and the first 8 `<option>` labels, and only emitted nodes consume depth. There is a cross-origin-frame overlay warning (`coveringForeignFrame`, `agent.js:688-712`). Depth 15, 20000 nodes, 50000 chars.

**Verdict: chrome-mcp is decisively better. This is its strongest area.**

Concretely, chrome-mcp reads pages the official extension cannot: any web-component-based UI (shadow DOM) and any same-origin iframe. It also names elements better (`aria-labelledby`), keeps below-the-fold content, and reports state attributes the official tree omits entirely. The frame-offset handling means CDP clicks inside iframes land correctly, which the official code only approximates for `upload_image` and not at all for `computer`.

Two things the official does that chrome-mcp does not:
- **Sensitive-value redaction in the tree.** The official walker replaces password and payment-`autocomplete` field values with `[value redacted]` and suppresses the option list of a sensitive `<select>`. chrome-mcp emits `value` for any non-password input (`agent.js:498-552` excludes only `type=password`), so a `cc-number` field's contents go straight into the transcript.
- **Truncation messaging that names the remedy.** Both truncate at a line boundary and report the total. Equivalent.

One official design decision is worth rejecting explicitly: `filter:"all"` as default with no viewport or visibility filter produces enormous trees on modern pages. chrome-mcp's default of dropping hidden nodes and keeping offscreen ones is the better trade.

## 5. find

**Official.** A nested model call: the whole accessibility tree plus the query go to a `small_fast` model with `maxTokens: 800`, and the pipe-delimited response is parsed and every returned ref validated against the refs actually in the tree.

**chrome-mcp.** Local lexical scoring over the rendered tree (`extension/src/lib/find.js:110-218`), with role hints, stopwords, URL-attribute stripping, exact-phrase and prefix weights, an offscreen penalty and duplicate collapsing. Sub-millisecond, zero tokens.

**Verdict: different trade-offs, and chrome-mcp's is the right default with one gap.**

chrome-mcp wins on latency, cost and determinism, and its `STATUS.md:49` states the trade honestly. The official approach wins only on semantic queries where the query shares no vocabulary with the element ("most viewed article link"), which chrome-mcp's own `STATUS.md:142` records as a limitation.

The official implementation also has a failure chrome-mcp does not: it silently truncates the tree to 30000 chars when relayed through MCP sampling, so a `find` on a large page can miss elements that exist, with no signal. And it costs a full model round trip per call, which is why the official `browser_batch` description pushes so hard on batching.

Neither offers the obvious middle: local ranking with an optional model escalation when the top score is below a threshold.

## 6. Screenshots

**Official.** `Page.captureScreenshot`, JPEG at quality 75 by default, `captureBeyondViewport:false`, `fromSurface:true`. Sizing binary-searches the exact Claude vision tile budget (`ceil(w/28)*ceil(h/28) <= 1568`, long side under 1568 px). Two paths: a CDP `clip` with `scale`, whose output is **verified by decoding the image header and comparing dimensions**, or a content-script canvas re-encode with a quality-reduction loop down to 0.10 until the base64 fits 1398100 chars. Coordinates come back in screenshot pixels and are mapped by `viewportWidth/screenshotWidth`, with an explicit out-of-bounds error. A `scale` parameter shrinks the returned image while keeping coordinates in the full-resolution frame.

**chrome-mcp.** `Page.captureScreenshot` PNG, then an `OffscreenCanvas` re-encode (`extension/src/lib/screenshot.js:54-71`). Long edge capped at 1568, then a `sqrt(budgetArea/scaledArea)` scale with `maxTokens` default 1600 and `PX_PER_TOKEN = 28`. Viewport from `Page.getLayoutMetrics` preferring `cssLayoutViewport`, so DPR folds into a single `cssToImage` factor (`:126`). `imageToCss` maps back, and passes coordinates through unchanged when no capture is recorded (`:155-163`). Zoom is a clipped capture whose scaling context carries the crop offset. Format PNG, quality not exposed.

**Verdict: close, with the official ahead on cost and chrome-mcp ahead on zoom coordinates.**

Official advantages worth taking:
- **JPEG by default.** PNG of a text-heavy page is several times larger than JPEG at quality 75 for no model-visible benefit. chrome-mcp hard-codes PNG (`screenshot.js:78`) and does not expose `format` or `quality` at all. This is pure wasted bandwidth over a 384 KB-chunked native-messaging pipe.
- **The size-fit loop.** The official code guarantees the payload fits a hard byte budget by stepping quality down. chrome-mcp has no byte budget, so a large PNG becomes many chunks.
- **The `clip`-with-`scale` fast path**, which makes Chrome render straight to the target size instead of capturing full-size and downscaling in a canvas. Plus the decode-and-verify check, which catches Chrome returning the wrong size.
- **The `scale` parameter that keeps coordinates in the full-resolution frame** and says so in the result text. chrome-mcp has an undocumented `maxTokens` passthrough (`tools.js:188`) with no equivalent contract.
- **The out-of-bounds coordinate error** naming the frame size. chrome-mcp has `Coordinate x,y is outside the WxH viewport` (`tools.js:147-152`), so this is equivalent.

chrome-mcp advantage: `cssToImage` from `cssLayoutViewport` is a cleaner DPR model than the official mix of `devicePixelRatio` probes and clip scales, and the zoom crop offset is carried in the scaling context so coordinates read off a zoomed image resolve correctly. The official `zoom` does not appear to do this.

## 7. Console and network capture

**Official.** Buffers on `globalThis` in the worker, 10000 console entries and 1000 requests per tab. Events: `Runtime.consoleAPICalled`, `Runtime.exceptionThrown`, `Network.requestWillBeSent`, `Network.responseReceived`, `Network.loadingFailed`. **The buffer is wiped whenever an entry's own URL hostname differs from the buffer's current domain.**

**chrome-mcp.** Buffers in the worker, 1000 console and 500 network (`extension/src/lib/recorder.js:11-12`). Events add `Log.entryAdded`, `Network.loadingFinished`, and normalize `warning` to `warn`. Navigation inserts a `--- navigated to <url> ---` marker instead of clearing (`recorder.js:242-245`). `pendingRequests()` powers `wait_for_page`.

**Verdict: chrome-mcp is better, and the official domain rule is a bug.**

The official rule keys on the hostname of each individual message's URL, so one console line from a CDN script host flips the buffer's domain and **deletes every entry collected so far**. On a page that loads third-party scripts, which is most pages, the console buffer is effectively random. chrome-mcp's explicit choice ("Console entries survive navigation by design, so a reload does not erase the errors that caused it", `recorder.js:242`) is correct and the navigation marker is strictly more useful.

chrome-mcp also has `Log.entryAdded`, which the official misses, so it sees network and security warnings the official never records. And `pendingRequests` with resource-type exclusions is machinery the official has no counterpart for.

One thing the official does that chrome-mcp does not: `Network.enable {maxPostDataSize: 65536}`. It requests post bodies and then throws them away, keeping only `{requestId, url, method, status}`. chrome-mcp keeps the same shape. Neither exposes headers or bodies.

## 8. javascript tool

**Official.** `Runtime.evaluate` with `returnByValue`, `awaitPromise`, `replMode:true` and the code wrapped in `{ ... }`, retried once as an async IIFE on `Illegal return statement`. The result passes through a credential-shaped-string redactor (JWT, base64, hex, cookie strings, sensitive keys, 1000-char string cap, 100-item array cap) and a 51200-char output cap. 40 s evaluation timeout.

**chrome-mcp.** `Runtime.evaluate` with `awaitPromise`, `returnByValue`, `replMode:true` and **`userGesture: true`** (`cdp.js:523-538`). Result is `{result: value ?? description, type}`. No redaction, no size cap.

**Verdict: chrome-mcp is faster and more honest; the official is safer and better bounded.**

- `userGesture: true` is a real advantage: it lets the evaluated code call gesture-gated APIs (clipboard, fullscreen, autoplay) that would otherwise throw. The official does not set it.
- The official wraps in `{ ... }` rather than evaluating bare, which is what makes `replMode` return the last expression cleanly. chrome-mcp evaluates the expression directly with `replMode`, which achieves the same thing. Equivalent.
- **chrome-mcp has no output cap.** A `document.body.innerHTML` on a big page returns megabytes through the chunked pipe and into the transcript. The official 50 KB cap with an explicit truncation note is strictly better.
- **chrome-mcp has no redaction.** The official filter is crude (it will mangle legitimate base64 and any object key containing "auth") but it stops `document.cookie` and `localStorage` dumps from landing verbatim in a transcript. Given that chrome-mcp drives the user's real signed-in profile, this matters more there, not less.
- The official reports a distinct timeout message. chrome-mcp surfaces the raw CDP error.

## 9. form_input

**Official.** Sets `element.value` directly, then dispatches `change` and then `input`, both bubbling, after `scrollIntoView` and `focus`. Handles select (value or text match), checkbox, radio, date/time family, range, number, text and textarea. **No contenteditable branch.** **No native value setter.** Redacts sensitive values in the output message.

**chrome-mcp.** Uses the **native prototype value setter** (`agent.js:1021-1032`), with the comment explaining that this is what stops React's value tracker from swallowing the change. Dispatches `input` then `change`, the correct order. Has a **contenteditable branch** (`:1014-1019`). Refuses disabled and read-only elements with specific errors (`:969-974`). Checkbox and radio go through `el.click()`, which fires the full event sequence a real click would.

**Verdict: chrome-mcp is clearly better, and the official has a genuine defect.**

Setting `.value` directly on a React-controlled input is the classic failure: React's `_valueTracker` believes the value never moved, so no `onChange` fires and the component reverts on the next render. The official extension will fail on a large share of modern forms in a way that looks like the page ignoring the input. chrome-mcp's native-setter path is the standard fix and it is documented in the source.

Event order is also right in chrome-mcp and wrong in the official (`change` before `input` is not what a browser does).

Gaps in chrome-mcp:
- **No sensitive-value redaction.** The official returns `[redacted]` for password and payment fields in its confirmation message. chrome-mcp echoes the value it set, so a typed password appears in the tool result and, via the journal, on disk (`host/journal.js:23-38` keeps string args up to 160 chars).
- The official emits `setSelectionRange(len, len)` after setting text so the caret is at the end, which matters for a subsequent `type`. chrome-mcp does not.
- contenteditable is replaced wholesale with `textContent`, with no `beforeinput` and no selection handling. Rich editors (Google Docs, Notion, ProseMirror) will not accept that. The official has nothing at all here, so chrome-mcp is still ahead, but neither is usable for real editors.

## 10. file_upload and upload_image

**Official.** No filesystem access. `file_upload` takes base64 in the tool arguments, capped at 10 MB total, filenames normalized to a plain name of at most 255 chars, and assigns `input.files` from a `DataTransfer` built in the page. `upload_image` takes an `imageId` and resolves it from conversation history or a session-scoped screenshot byte cache. Drop targets get real `DragEvent`s with `clientX/clientY/screenX/screenY`, descending one iframe level via `contentDocument.elementFromPoint`.

**chrome-mcp.** Sends **paths**, validated host-side (exists, is a file, readable, 25 MB total, `host/mcp-server.js:397-423`), and uses **`DOM.setFileInputFiles`** via a marker-attribute selector (`cdp.js:590-596`, `agent.js:1218-1232`), falling back to **`Input.dispatchDragEvent`** with `dragOperationsMask: 1` for drop zones (`cdp.js:601-607`). `upload_image` is rewritten into a `file_upload` by materializing the remembered image to disk (`mcp-server.js:516-542`).

**Verdict: chrome-mcp is better, decisively.**

`DOM.setFileInputFiles` is the browser-process path: the file is read by Chrome itself, `input.files` is a real `FileList`, and there is no `DataTransfer` reconstruction. `Input.dispatchDragEvent` is likewise a browser-level drag, not a synthetic `DragEvent` a page can distinguish (and many drop zones reject synthetic drags because `dataTransfer.files` on a synthetic event is not always populated the same way). The official approach exists because the extension has no filesystem, not because it is preferable.

chrome-mcp also allows 25 MB against the official 10 MB, and does not have to push file bytes through the model's context.

The one official idea worth borrowing: **filename normalization** (`tb()`, reject anything with a path separator or over 255 chars). chrome-mcp sanitizes on the `materializeImage` path (`mcp-server.js:370-379`) but `file_upload` takes raw paths, which is intentional and fine, and its 25 MB check is host-side and sound.

## 11. gif_creator

**Official.** Event-driven frames (after every `computer` and `navigate`), 50 frame cap, per-action delays 300 to 1500 ms, last frame plus 2 s, `gif.js` with 2 workers in an offscreen document, five overlays (click ring, drag path, action label, progress bar, watermark), white padding to a common size after overlays, export via `chrome.downloads` or a synthetic drop.

**chrome-mcp.** Event-driven frames, 60 frame cap, 480 px max width, elapsed-time delays clamped to 60-3000 ms, a hand-written GIF89a encoder with LZW in the host (`host/gif.js:103-154`), a fixed 6x6x6 cube plus 40-grey palette with grey routing to stop text banding (`extension/src/lib/gif.js:10-70`), no third-party dependency, **no overlays at all**.

**Verdict: chrome-mcp is leaner and its palette work is better; the official output is far more useful.**

The custom encoder and the grey-ramp quantization are genuinely good, and shipping one byte per pixel across native messaging is the right call given the palette is fixed. But a GIF of an automation run without click indicators is much harder to read than one with them, and the official overlay set is the whole reason its GIFs are shareable. chrome-mcp's `STATUS.md:32` and `HANDOFF.md:15` already list "overlay options accepted and ignored" as an open gap.

The official's retroactive click frame (re-emit the previous frame with the click marker before the effect) is a small idea with a large readability payoff.

## 12. Tab management

**Official.** A Chrome tab group is the session. Two group flavours, MCP (single, yellow, forces a **new window**) and per-session (coloured from a rotating palette, reuses the last focused window). `getEffectiveTabId` refuses cross-group tabs. Every result carries `tabContext`. Tabs opened by the page are not adopted, except by the minimized-window foreground guard, which intercepts up to 3 `target=_blank` clicks and re-creates them inactive inside the group. A tab dragged out of the group is cleanly released, and if it was the main tab the session follows it into its own window. Closing the last tab lets Chrome drop the group and close the window.

**chrome-mcp.** A tab group per `clientId`, persisted (`extension/src/lib/tabs.js:10-24`). Tabs created `active:true` on purpose. The session's first tab goes into the last focused normal window rather than a new one (`tabs.js:123-155`). `assertTabInSession` refuses tabs outside the group (`:216-233`). Group title carries a status mark: working, done, error, idle (`:53-78`). `keepWindowAlive` inserts a blank tab so closing the last tab never closes a window (`:188-209`). `releaseSession` on SIGINT closes only blank tabs. `ensureVisible` raises minimized windows. `adoptTab` exists but has **no caller**.

**Verdict: chrome-mcp is better on window hygiene and status visibility; the official is better on popup handling.**

chrome-mcp's `keepWindowAlive` is a real correctness win the official lacks: closing the agent's last tab in the official extension closes the window, and if it was the only window, Chrome quits. The status mark in the group title is a nicer at-a-glance signal than the official's per-tab pills, and `ensureVisible` with throttle detection is more robust than the official's "skip the delays when hidden".

The official is ahead on one thing chrome-mcp explicitly does not do: **new tabs opened by the page**. chrome-mcp has no `chrome.tabs.onCreated` listener, and `adoptTab` is dead code (`tabs.js:235-247`). When a click opens a `target=_blank` tab, chrome-mcp relies on Chrome adding it to the opener's group by accident, and the model is never told the tab id. The official returns `[note: the link opened in a new tab (tab ID N)...]` in the click result. That note is worth more than the whole minimized-window guard.

## 13. Permissions and safety

**Official.** Four layers: enterprise policy (`blockedUrlPatterns`, `forceLoginOrgUUID`, `thirdPartyDesktopMode`), a hosted URL-category API with a hard-block redirect to `blocked.html` and a copyright notice for `category4`, per-domain grants with `once`/`always` and a domain-transition permission type, and in-page redaction of password and payment fields. Three permission modes including a plan mode where the model declares its domains up front and they are category-filtered before approval. Prompts render in a popup window with a screenshot of the click target. A rich in-page indicator with a working Stop button.

**chrome-mcp.** Three modes (`allow` default, `ask`, `skip_all_permission_checks`), a 17-entry financial blocklist that applies **even to read-only tools and even in skip mode** (`extension/src/lib/permissions.js:135-157`), a `READ_ONLY_TOOLS` bypass, localhost bypass, per-origin grants with `once`/`always`, and `verifyOriginUnchanged` re-checking the hostname immediately before every mutating action (`permissions.js:205-217`). Options page for mode, blocklist and grant revocation. `HARD_BLOCKED_REASONS` is declared and unused.

**Verdict: different philosophies. chrome-mcp's origin re-check is better; the official's coverage is broader.**

chrome-mcp's `verifyOriginUnchanged` has no official counterpart and closes a real TOCTOU hole: the official checks permission at gate time and acts later, so a page that navigates between the two acts on the new origin under the old grant. Note the official does check the category before and after each `browser_batch` item, but not the permission grant, and not for standalone calls.

The blocklist applying to read-only tools is also the right call and is well reasoned in the source comment.

Gaps in chrome-mcp:
- **No sensitive-field redaction anywhere.** The a11y tree emits `value` for non-password inputs, `form_input` echoes the value it set, and `javascript` returns anything. The official's `autocomplete`-based list (`current-password`, `new-password`, `one-time-code`, `cc-number`, `cc-csc`, `cc-exp`) is a small, high-value addition.
- **No in-page indicator that a page can be seen through.** The pointer is drawn but there is no border glow and no Stop button. On a page the user is watching, there is no visible signal that the agent is acting on it, and no way to stop it from the page.
- **No plan mode.** The official `follow_a_plan` (declare domains, get them category-checked, get them approved once) is a genuinely better UX than per-domain prompting for multi-site tasks.
- **No domain-transition permission.** Following a link to a different origin inherits the current grant.
- The static blocklist is 17 hard-coded financial hostnames. That is a reasonable default, but it will not cover a user's own bank.

## 14. Bot-detection posture

**Official.** Nothing hidden, nothing spoofed, `Runtime.enable` always on, DevTools banner visible, `#claude-phantom-cursor` added to the page as an open DOM node.

**chrome-mcp.** Same posture, plus: the pointer lives in a **closed** shadow root (`agent.js:1050-1109`), a `data-chrome-mcp-mark` attribute is briefly written during `file_upload`, and `userGesture: true` is set on every `Runtime.evaluate`.

**Verdict: equivalent, with chrome-mcp very slightly quieter and one avoidable tell.**

Both are equally detectable through the debugger banner and `Runtime.enable`. chrome-mcp's closed shadow root hides the cursor's contents but not the host element's `id`, which is `__chrome_mcp_cursor__` and trivially greppable. The `data-chrome-mcp-mark` attribute is visible to a `MutationObserver` during uploads.

Neither should pretend to be a stealth tool, and neither claims to be. The realistic improvements are small: name the cursor host something neutral and use a random per-session id, and use `DOM.querySelector` on a node id obtained from `DOM.getDocument` plus `DOM.pushNodesByBackendIdsToFrontend` instead of writing a marker attribute (or write it, read it, and remove it inside a single injected function so no frame is observable).

## 15. Multi-browser

**Official.** A `bridgeDeviceId` UUID plus a `bridgeDisplayName`, routed by `target_device_id` on the bridge. Pairing is server-initiated and interactive: a `pairing_request` opens `pairing.html` or a side-panel prompt, and the user names the browser. `list_connected_browsers` / `select_browser` / `switch_browser` are implemented on the controller side, not in the extension.

**chrome-mcp.** A per-browser `browserId` minted in the extension and persisted (`background.js:62-80`), a file registry under `tmpdir()/chrome-mcp-browsers` with liveness probing (`host/registry.js:64-77`), a per-browser pipe name, and `list_connected_browsers` / `select_browser` / `switch_browser` all answered by the MCP server (`mcp-server.js:316-352`). `select_browser` and `switch_browser` are literally the same code.

**Verdict: chrome-mcp is better for a local tool.**

A probed file registry with dead-entry pruning is more robust than a hosted device list, and it works offline. The `pickDefault` behaviour (exactly one browser auto-selects, several force an explicit choice) is right.

Gaps, both already in `HANDOFF.md:15-19`:
- `list_connected_browsers` does not report OS platform or which browser is on this machine. The official `connect` frame carries `os_platform`, and the display name is user-chosen. chrome-mcp's name is derived from the user agent, so two Chromes look identical.
- `switch_browser` does not prompt in the browser, so there is no way to confirm you are pointing at the window you think you are. The official's "switch to the window you want, then confirm in the side panel" flow is the correct interaction for a human sitting in front of several windows.

## 16. Telemetry

**Official.** Segment, Sentry, Datadog RUM and `api.anthropic.com/api/event_logging/v2/batch`. Payloads carry tool name, client, model, tab and group ids, duration, session id, **page hostname** and a coarse app label. No page content. Separately, every navigated URL, path and query included, goes to the hosted safety-category endpoint.

**chrome-mcp.** Nothing leaves the machine. A local JSONL and Markdown journal per browser per day under `tmpdir()/chrome-mcp-logs` (`host/journal.js:102-105`), recording tool, tab url and title, summarized args with strings clipped to 160 chars, and metadata-only result summaries.

**Verdict: chrome-mcp is better by design, with one privacy hole to close.**

The journal records **typed text, form values and `javascript` source, up to 160 chars each** (`journal.js:23-38`), and the README's own example shows `form_input ... value="Test Person"`. A password typed with `computer type` lands in a plaintext file on disk that is never rotated and never pruned. The official extension redacts those values at the tool boundary and never persists them.

Otherwise the local-only design is strictly better, and the journal is a feature the official has no equivalent of.

## 17. Other

**Batching.** The official `browser_batch` defers the coordinate context for the whole batch so that "coordinates you write in THIS batch refer to the screenshot taken BEFORE this call" is actually true. chrome-mcp's `browser_batch` (`background.js:155-180`) has no coordinate-frame contract at all: a screenshot taken mid-batch immediately updates `scalingContext`, so a coordinate written for the pre-batch frame is silently remapped against the new one. **This is a correctness bug**, and it is the most important single finding of this comparison.

The official also pre-validates every item's tab-group membership before running anything, and reports progress. chrome-mcp validates per item as it goes, which means a batch can do three steps and then fail on step four for a reason that was knowable up front.

chrome-mcp's `quick` script language and `$last` tab reference have no official counterpart and are a real ergonomic win for multi-step work. So is the alias layer applied on both sides of the wire.

**Shortcuts.** Official shortcuts are saved prompts run by a nested agent. chrome-mcp shortcuts are saved `quick` scripts. These are different features with the same name. chrome-mcp's is deterministic and free; the official's can handle open-ended tasks. Not comparable on quality.

**Timeouts and retries.** The official has a remote-configurable timeout table and error messages that name the likely cause. chrome-mcp's timeouts are hard-coded constants, its errors are good (arguably better: `Element X is covered by <role "name"> at the point a click would land. No click was sent.` has no official equivalent and is excellent), and it retries in fewer places.

**Navigation.** chrome-mcp uses `Page.navigate` and reports `Navigation to <url> failed: <errorText>. The tab is showing an error page, not the site.` The official uses `chrome.tabs.update`, which reports nothing, and does not wait for load at all. chrome-mcp is clearly better here.

**Rate limits.** Neither enforces any.

---

# Part 3. Improvement candidates for chrome-mcp

Ordered by expected value. Effort is small (under an hour), medium (a few hours), large (a day or more).

## Tier 1, correctness bugs

### 1.1 Freeze the coordinate frame for the duration of a batch

**What.** In `browser_batch` and `quick`, defer `screenshot.js`'s `scalingContext` update until the batch finishes, exactly as the official `updateCoordinateContext:"defer"` plus `pendingContextScope` does. Every coordinate written inside one batch must resolve against the frame that existed when the batch was submitted.

**Why.** The official extension states the contract in the tool description and enforces it (`mcpPermissions-BIFqj2d3.js:5688-5697`). chrome-mcp updates `scalingContext` on every capture (`extension/src/lib/screenshot.js:110-136`), so a batch of the form `[screenshot, left_click(x,y)]` where the model wrote `x,y` from the *previous* screenshot silently remaps them against the new one. If the window was resized or the zoom level changed, the click lands somewhere else. Silent mis-clicks are the worst possible failure mode.

**Where.** `extension/src/lib/screenshot.js` (add a `pending` slot and a `commitPending(scope)`), `extension/src/lib/tools.js` (thread an `inBatch` / `scope` flag into `capture`), `extension/src/background.js:155-180` (`runBatch` commits at the end).

**Effort.** Medium.

### 1.2 Verify that a CDP scroll actually scrolled, and fall back

**What.** Read `pageYOffset`/`pageXOffset` before and after `mouseScroll`, and if the delta is under 5 px in both axes, fall back to an injected `scrollBy` on the nearest scrollable ancestor of `elementFromPoint(x, y)`.

**Why.** This is the official implementation (`mcpPermissions-BIFqj2d3.js:4855-4890`) and the fallback (`sc()`, `:4512-4553`), and it exists because a CDP wheel event does nothing on plenty of real pages: virtualized lists, `overflow:hidden` bodies, scroll containers that only respond to their own wheel handler. chrome-mcp's `mouseScroll` (`cdp.js:416-426`) is fire-and-forget with no verification, so "scrolled" is reported whether or not anything moved.

**Where.** `extension/src/lib/cdp.js` (add `getScrollPosition` and `domScrollBy`), `extension/src/lib/tools.js:283-299`.

**Effort.** Small.

### 1.3 Handle JavaScript dialogs instead of documenting them

**What.** Add a `Page.javascriptDialogOpening` listener. For `beforeunload`, apply a per-tab policy defaulting to dismiss, exposed as `navigate({force: true})`. For `alert`, `confirm` and `prompt`, auto-dismiss (accept for `alert`, dismiss for the others) and surface the dialog's message in the tool result.

**Why.** Both projects list "a modal dialog blocks every later browser call until a human dismisses it" as a known limit (`README.md:187`, `STATUS.md:198`, `SPEC.md:192`). The official at least handles `beforeunload` (`mcpPermissions-BIFqj2d3.js:2464-2490`) with a policy, a waiter and two well-written result strings. Neither handles `alert`. Given `Page.enable` is already on in both, this is a listener plus one `Page.handleJavaScriptDialog` call, and it converts a session-killing hang into a normal result.

**Where.** `extension/src/lib/cdp.js` (listener beside `installDetachListener` at `:181-187`), `extension/src/lib/recorder.js:62-142` (`Page` is already enabled), `extension/src/lib/tools.js:325-360` (`navigate` gains `force`).

**Effort.** Medium.

### 1.4 Tell the model about tabs the page opened

**What.** Wire up the dead `adoptTab` (`extension/src/lib/tabs.js:235-247`): add a `chrome.tabs.onCreated` listener that, when `openerTabId` is a session tab, groups the new tab into the session and records it, then append a note to the triggering click's result, in the shape of the official
`[note: the link opened in a new tab (tab ID N); pass that tab ID to interact with it]`.

**Why.** `target=_blank` links are everywhere. Today chrome-mcp depends on Chrome's own grouping behaviour (`STATUS.md:140` observed it but the code does not do it), and the model is never told the id, so it has to call `tabs_context` and guess. The official surfaces the ids directly in the click result (`mcpPermissions-BIFqj2d3.js:5665-5670`).

**Where.** `extension/src/background.js` (new listener next to `:305-311`), `extension/src/lib/tabs.js:235-247`, `extension/src/lib/tools.js:233-243`.

**Effort.** Medium.

### 1.5 Do not report a foreign debugger attachment as success

**What.** Change `cdp.js:79-82` so an `already attached` error is surfaced as a distinct, actionable error rather than being recorded as an owned attachment.

**Why.** Chrome allows one debugger client per target. Recording `foreign:true` and returning success means the very next `send()` fails with a generic CDP message, and the `foreign` flag is never read by anything. The official's message is the model to copy: `chrome.debugger.attach timed out after Nms on tab T. DevTools may be open on this tab, or the renderer may have crashed.`

**Where.** `extension/src/lib/cdp.js:67-92`.

**Effort.** Small.

## Tier 2, reliability

### 2.1 Add an offscreen document as a keepalive

**What.** Create `offscreen.html` with `reasons: [BLOBS]` and a `setInterval` posting a message to the worker every 20 s. Create it at worker startup and re-create it from the alarm handler if `chrome.offscreen.hasDocument()` is false.

**Why.** The official ships this with the reason in a comment: "offscreen docs aren't subject to MV3's 30s idle kill. A message every 20s resets the SW's idle timer, keeping the bridge WS setInterval ping running under background throttle/freeze" (`offscreen.js:6-13`). chrome-mcp's keepalive is the host's 20 s port ping, which is subject to the same background throttling the comment describes, plus a 30 s alarm that only reconnects when the port is already gone (`background.js:297-300`). A frozen worker with a 120 s request timeout is a two-minute stall.

**Where.** `extension/manifest.json` (add `offscreen` permission), new `extension/offscreen.html` and `extension/offscreen.js`, `extension/src/background.js:293-324`.

**Effort.** Small.

### 2.2 Queue and replay undelivered tool results, and add a generation counter

**What.** In `host/native-host.js`, buffer a `tool_response` whose requesting IPC socket has closed (bounded, with a TTL) and drop it on expiry rather than losing it silently. In `extension/src/background.js`, bump a generation counter on `port.onDisconnect` and refuse to send a `tool_response` whose generation is stale.

**Why.** The official does exactly this: 8 slots, 120 s TTL, replayed on reconnect (`service-worker.ts-CNWEmoH7.js:672-690`), plus the `Et` epoch guard checked before every reply (`:296`, `:404`, `:426`). Without the epoch guard, a slow tool that finishes after a reconnect can deliver its result into a new session and corrupt its state. chrome-mcp already found the sibling of this bug (`STATUS.md:100`, the stale socket wiping the live link).

**Where.** `host/native-host.js:116-185`, `extension/src/background.js:82-132` and `:215-287`.

**Effort.** Medium.

### 2.3 Port `stripExtensionInterference`

**What.** When `cdp.attach` fails with `Cannot access a chrome-extension:// URL of different extension`, run the official's recovery: `chrome.webNavigation.getAllFrames` to learn the real frame tree, an all-frames injected walk (piercing open and closed shadow roots via `chrome.dom.openOrClosedShadowRoot`) to count `<iframe>` elements, identify frames with more iframes than known children, remove the `chrome-extension://` ones whose origin is not ours, then retry the attach. Cap at 4 retries with a 75 ms settle, behind a storage kill switch.

**Why.** This is the fix for the failure chrome-mcp records as open and unexplained in both `STATUS.md:134` and `HANDOFF.md:20-24` ("What Chrome objects to is not established"). The official source answers it: another extension has injected an iframe pointing at its own `chrome-extension://` origin, and Chrome refuses the attach because the extension cannot access that frame. `describeFrames` (`cdp.js:149-172`) already gathers most of the input.

**Where.** `extension/src/lib/cdp.js:67-92` and `:149-172`.

**Effort.** Large.

### 2.4 Cap the `javascript` tool's output

**What.** Truncate the serialized result at 50 KB with an explicit note, and truncate individual strings at some sane bound before serializing.

**Why.** The official caps at 51200 chars with `[OUTPUT TRUNCATED: Exceeded 50KB limit]` (`mcpPermissions-BIFqj2d3.js:5919`). chrome-mcp has no cap at any layer: `cdp.evaluate` returns the value whole, `mcp-server.js:483` `JSON.stringify`s it, and only the 384 KB chunking bounds the transfer. One `document.body.innerHTML` blows the context window.

**Where.** `extension/src/lib/tools.js:500-509` or `host/mcp-server.js:483`.

**Effort.** Small.

### 2.5 Make the input ack timeout adaptive rather than fixed

**What.** `sendInput`'s 400 ms ack race (`cdp.js:255-279`) is a good idea. Extend it: on the first throttle detection, after `ensureVisible` raises the window, **retry the dispatch once** rather than continuing with an event that may have been dropped.

**Why.** Today a throttled renderer flags the tab and continues, so the click may simply not have happened, and the tool still reports success. The official has no equivalent detection at all, so this is chrome-mcp extending its own advantage rather than copying.

**Where.** `extension/src/lib/cdp.js:255-279`, `extension/src/lib/tools.js:169-180`.

**Effort.** Medium.

## Tier 3, speed and token cost

### 3.1 Switch screenshots to JPEG with a byte budget

**What.** Default `format: 'jpeg'`, `quality: 0.75`. Add a byte budget (the official uses 1398100 base64 chars) and a quality-reduction loop stepping down by 0.05 to a floor of 0.10 until the payload fits. Expose `format` and `quality` on the `computer` schema.

**Why.** The official uses JPEG 75 by default with exactly this loop (`mcpPermissions-BIFqj2d3.js:3008`, `:3277-3287`). chrome-mcp hard-codes PNG (`screenshot.js:78`) with no byte bound. On a typical page, PNG is three to six times the bytes of JPEG 75 for the same model-visible content, and every one of those bytes crosses a 384 KB-chunked native-messaging pipe and lands in the transcript. This is the single biggest speed and cost win available.

**Where.** `extension/src/lib/screenshot.js:54-78`, `host/schemas.js:135-201`.

**Effort.** Small.

### 3.2 Push the downscale into CDP with `clip.scale`

**What.** When the target size is smaller than the viewport, pass `clip: {x: scrollX, y: scrollY, width, height, scale}` to `Page.captureScreenshot` so Chrome renders straight to the target size, and skip the `OffscreenCanvas` round trip. Verify the returned dimensions by decoding the image header, and fall back to the canvas path when they do not match.

**Why.** The official does both (`mcpPermissions-BIFqj2d3.js:3106-3150`), including the decode-and-verify. Capturing a 2560x1440 retina viewport at full size and then downscaling in a canvas is several times slower than asking Chrome for a 1568-wide render.

**Where.** `extension/src/lib/screenshot.js:86-136`, `extension/src/lib/cdp.js:511-517`.

**Effort.** Medium.

### 3.3 Add a documented `scale` parameter that keeps coordinates full-resolution

**What.** Promote the undocumented `input.maxTokens` passthrough (`tools.js:188`) into a schema'd `scale` in `[0.1, 1]`, and append to the result text the full-resolution frame size, exactly as the official does: `— 0.5-scale view; coordinate frame: WxH.`

**Why.** The official's `_c` description is the contract worth copying verbatim: "Coordinates are ALWAYS in the full-resolution coordinate frame (reported with every scaled screenshot), never in the scaled image's own pixels." A half-scale screenshot costs a quarter of the tokens, and with this contract it stays clickable.

**Where.** `host/schemas.js:135-201`, `extension/src/lib/screenshot.js:30-46`, `extension/src/lib/tools.js:188-193`.

**Effort.** Small.

### 3.4 Give `find` a model escalation path

**What.** Keep local ranking as the default. When the best score is below a threshold, or the caller passes `semantic: true`, fall back to an MCP **sampling** request (`sampling/createMessage` on the MCP connection) carrying the tree and the query, with the same ref-validation the official does.

**Why.** chrome-mcp's own `STATUS.md:142` records the failure: "most viewed article link" cannot be found lexically. The official gets this right at the cost of a model call on *every* `find`. Escalating only on a low score gives the semantic capability at close to zero average cost. The ref-validation step (`mcpPermissions-BIFqj2d3.js:6053-6056`) is essential and cheap.

**Where.** `extension/src/lib/find.js:177-218`, `host/mcp-server.js:214-233`, plus a sampling request path in `host/mcp-server.js`.

**Effort.** Large.

### 3.5 Batch pre-validation

**What.** Before running any item of a `browser_batch`, validate every item's shape and every item's `tabId` group membership, and fail the whole batch up front.

**Why.** The official does this (`d-mcpPermissions-BIFqj2d3.js:6320-6338`) and it turns "three steps done, then a knowable failure" into one clean error. chrome-mcp's `runBatch` (`background.js:155-180`) validates as it goes, so a typo in item five costs the side effects of items one to four.

**Where.** `extension/src/background.js:155-180`.

**Effort.** Small.

## Tier 4, safety and privacy

### 4.1 Redact sensitive field values in the tree, in form_input results, and in the journal

**What.** Adopt the official's sensitivity test: `type` is `password` or `hidden`, or `autocomplete` contains any of `current-password`, `new-password`, `one-time-code`, `cc-number`, `cc-csc`, `cc-exp`, `cc-exp-month`, `cc-exp-year`. Apply it in three places:

- `agent.js:498-552`, so `value` is `[value redacted]` for those fields and a sensitive `<select>` does not list its options
- `agent.js:960-1035`, so the `form_input` confirmation says `[redacted]` instead of echoing the value
- `host/journal.js:23-38`, so `computer type` text and `form_input` values are not written to disk verbatim

**Why.** The official does all three (`accessibility-tree.js-B-oUarrX.js:45-58`, `mcpPermissions-BIFqj2d3.js:6180-6186`). chrome-mcp does none, and the journal makes it worse by persisting: `README.md:122`'s own example shows `form_input ... value="Test Person"` written to a never-rotated plaintext file. A password typed through `computer type` ends up on disk today.

**Where.** As listed. A shared `isSensitiveField(el)` helper in `agent.js` plus a key/arg denylist in `journal.js`.

**Effort.** Medium.

### 4.2 Redact credential-shaped strings from `javascript` results

**What.** Port the official's `w()` filter (`mcpPermissions-BIFqj2d3.js:5857-5919`): blank object keys matching `/password|token|secret|api[_-]?key|auth|credential|private[_-]?key|access[_-]?key|bearer|oauth|session/i`, blank `cookie`/`cookies`, block JWT-shaped, long-base64-shaped, long-hex-shaped and cookie-string-shaped values, cap strings at 1000 chars and arrays at 100 items, depth-limit at 5.

**Why.** chrome-mcp drives the user's real signed-in profile, so `document.cookie` and `localStorage` are live session material. The official's filter is crude but it is the difference between "the agent read a cookie" and "the cookie is in the transcript and in the journal". Pair it with 2.4.

**Where.** `extension/src/lib/tools.js:500-509` or `host/mcp-server.js:483`.

**Effort.** Small.

### 4.3 Draw a visible acting indicator with a Stop button

**What.** Extend the existing cursor overlay into the official's three-state model: a pulsing viewport border while acting on this tab, a static pill on other session tabs, and a floating Stop button whose handler requires `event.isTrusted` and sends a stop message. Reuse `HIDE_FOR_TOOL_USE` so none of it lands in a screenshot.

**Why.** The official's `agent-visual-indicator.js` is the only thing telling a user watching their own screen that a page is being driven, and the only way to stop it without switching to the client. chrome-mcp's only signals are the tab-group title mark and the pointer, neither of which is a control. For a tool that drives the user's signed-in profile this is a safety feature, not decoration.

**Where.** `extension/src/content/agent.js:1050-1211`, `extension/src/lib/tabs.js:53-78`, `extension/src/background.js`.

**Effort.** Large.

### 4.4 Add a plan mode

**What.** A `permissionPolicy.mode = 'plan'` in which the first tool call of a session must declare the domains it will visit, those domains are checked against the blocklist, the user approves once, and they become turn-approved for the rest of the session.

**Why.** The official `follow_a_plan` (`mcpPermissions-BIFqj2d3.js:8773-8790`, system reminder at `:8772`) is a better model than per-domain prompting for anything touching more than one site: one decision instead of five interruptions, and the user sees the whole scope before anything runs.

**Where.** `extension/src/lib/permissions.js:10-14` and `:138-183`, `host/schemas.js` (a new declare-plan tool), `extension/src/options/options.js`.

**Effort.** Large.

### 4.5 Add a domain-transition check

**What.** When an action would act on an origin different from the one the session last acted on, require its own grant, as the official's `checkDomainTransition` does.

**Why.** `verifyOriginUnchanged` already catches the *involuntary* case (the page navigated under us). It does not catch the voluntary case: a `navigate` to a different origin inherits nothing, and after it every subsequent action on the new origin is checked only against the new origin's own grant, which in `allow` mode is automatic. A redirect chain into an unexpected site is currently invisible.

**Where.** `extension/src/lib/permissions.js:138-217`.

**Effort.** Medium.

## Tier 5, capability parity and polish

### 5.1 GIF overlays

**What.** Implement the five overlays the schema already implies: click ring, drag path, action label, progress bar, watermark. Draw them into the quantized frame in the extension before shipping bytes to the host, scaled by `canvas.width / viewportWidth`. Copy the official's retroactive click frame (re-emit the previous frame carrying the click marker before capturing the effect).

**Why.** `STATUS.md:32` and `HANDOFF.md:15` already list this as an accepted-and-ignored gap. A recording without click indicators is much harder to read, and the overlays are the whole reason the official GIFs are shareable. The official code is unminified (`offscreen.js:100-400`) and directly portable.

**Where.** `extension/src/lib/gif.js:77-128`, and the per-action delay table from `mcpPermissions-BIFqj2d3.js:6907-6922` is worth copying too.

**Effort.** Medium.

### 5.2 Report platform and locality in `list_connected_browsers`

**What.** Include the OS platform (from `navigator.userAgentData.platform`, sent in `hello`) and a marker for the browser this MCP server is on. Allow a user-set display name stored in `chrome.storage.local`, editable from the options page.

**Why.** `HANDOFF.md:16` lists this. Two Chromes on the same machine currently look identical, because the name is derived from the user agent (`background.js:70-79`). The official carries `os_platform` in its `connect` frame and lets the user name the browser during pairing.

**Where.** `extension/src/background.js:62-111`, `host/native-host.js:199-206`, `host/registry.js:64-77`, `host/mcp-server.js:319-332`, `extension/src/options/options.js`.

**Effort.** Small.

### 5.3 Make `switch_browser` confirm in the browser

**What.** Give `switch_browser` a distinct behaviour: send a prompt to the target browser and require an in-page or options-page confirmation before routing there, mirroring the official's "switch to the window you want, then Connect".

**Why.** `HANDOFF.md:17` lists this. Right now `select_browser` and `switch_browser` are the same call (`mcp-server.js:334`), so a user with several windows cannot confirm which one they just pointed at.

**Where.** `host/mcp-server.js:334-352`, `extension/src/background.js`.

**Effort.** Medium.

### 5.4 Set `force` on pressed mouse events, and reject page-zoom chords

**What.** Add `force: 0.5` to `mousePressed`/`mouseMoved`-with-buttons payloads. In `pressKey`, detect `ctrl|cmd + (+|-|0)` and return the official's error rather than dispatching.

**Why.** Both are one-liners from the official (`mcpPermissions-BIFqj2d3.js:2687-2688`, `:4574-4586` and `:5771-5776`). Pointer-event handlers that read `force` see a plausible value, and browser zoom chords silently break every subsequent coordinate, so returning `"x" was not pressed: page zoom keyboard shortcuts are not supported. To magnify part of the page for closer inspection, use the zoom action with a region instead.` is better than letting it happen.

**Where.** `extension/src/lib/cdp.js:321-361` and `:464-505`.

**Effort.** Small.

### 5.5 Caret position after `form_input`

**What.** After setting a text value, call `setSelectionRange(len, len)` for `text|search|url|tel|password` inputs and textareas.

**Why.** The official does it (`mcpPermissions-BIFqj2d3.js:6320-6324`). Without it, a `form_input` followed by a `computer type` can insert at position 0 rather than appending.

**Where.** `extension/src/content/agent.js:1021-1032`.

**Effort.** Small.

### 5.6 Wait for load on `navigate` back and forward, and handle `beforeunload`

**What.** `navigate back|forward` currently goes through `Runtime.evaluate('history.back()')` (`tools.js:332`). Use `Page.navigateToHistoryEntry` or at least pair it with `waitForNavigationStart` plus `waitForLoad`, and surface the `beforeunload` outcome from 1.3.

**Why.** `history.back()` returns immediately and the tool reports success before the page has begun loading. The official has the same weakness (it uses `chrome.tabs.goBack`) but it does gate on `beforeunload` and report `(discarded a "Leave site?" dialog — the page had unsaved changes that are now lost)`.

**Where.** `extension/src/lib/tools.js:325-340`.

**Effort.** Small.

### 5.7 Quiet the automation tells

**What.** Give the cursor host a per-session random id instead of the fixed `__chrome_mcp_cursor__`. Replace the `data-chrome-mcp-mark` attribute round trip in `file_upload` with a single injected function that sets, resolves and removes the attribute without yielding, or resolve the node through `DOM.getDocument` plus `DOM.querySelectorAll` on a stable structural selector.

**Why.** `agent.js:1050` appends a fixed-id element to `document.documentElement` on every page, and `agent.js:1221` writes an attribute a `MutationObserver` can see. Neither is worth the exposure given the debugger banner already announces the session, but both are cheap to remove and there is no reason to leave a branded fingerprint on every page the user visits.

**Where.** `extension/src/content/agent.js:1050`, `:1213-1238`, `extension/src/lib/tools.js:446-470`.

**Effort.** Small.

## Ideas neither implementation has

### 6.1 A `Runtime.enable` budget

Both projects enable `Runtime` on every session tab and never disable it, which is the loudest CDP-detection signal after the banner. Console capture needs `Runtime.enable`, but `javascript` and every input path do not. Making console capture opt-in per tab (`read_console_messages` enables it and a subsequent `clear` could disable it) would let a session drive a bot-sensitive page with `Network`, `Page` and `DOM` only. chrome-mcp already has the structure for this: `startCapture` is a single call site (`recorder.js:159-171`).

### 6.2 Element-level click verification

chrome-mcp already refuses a click when the element is covered (`tools.js:127-132`), which the official does not do at all and which is excellent. The natural extension is post-hoc verification: after a click on a `ref`, check whether anything observable changed (a `MutationObserver` tick, a navigation start, a focus change) within a short window, and if not, say so. Today a click on a dead element reports success. The official has nothing here either, so this is a place chrome-mcp can be plainly better.

### 6.3 A real contenteditable path

Both replace `textContent` and fire a synthetic `input`. Rich editors need `beforeinput` with the correct `inputType`, a selection, and often composition events. A `computer type`-based path (focus the element with a real click, then CDP `insertText`) already works better than `form_input` for these, so `form_input` on a contenteditable could simply delegate to that instead of doing something the editor will reject.

### 6.4 Journal rotation and a redaction switch

`host/journal.js` writes one file per browser per day forever, with no pruning. A retention setting (delete files older than N days on host start) and a `CHROME_MCP_JOURNAL_REDACT` mode that records tool names and outcomes without argument strings would make the journal safe to leave on by default. Neither exists in the official because the official does not persist anything locally.
