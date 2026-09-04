# Claude in Chrome and chrome-mcp measured side by side

The project was named chrome-mcp and its extension was named Lantern when this campaign ran. It is now Autopilot. The references below keep the old name because they describe the build that was measured.

Test campaign run 2026-09-03. Evidence files are in [`evidence/`](evidence/) and every claim below cites one by name and section.

## 1. Summary

Two Chrome automation bridges were driven against the same Chrome 152 on the same signed-in Windows profile: bridge A, Anthropic's Claude in Chrome 1.0.90, and bridge B, chrome-mcp 0.1.7. Coverage was a 24-scenario local fixture site, eight public test fixtures, fourteen real sites including signed-in Gmail, GitHub, LinkedIn and Notion, six bot-detection probes, a timing suite re-measured three times, GIF recording, file upload and tab management, plus a static read of the official extension's bundles.

Verdict on capability: B reads pages the A tree cannot reach (open shadow DOM, same-origin iframes), refuses actions a real user could not perform, and reports failure loudly. Verdict on speed: B was faster on every median in `R-repeat-performance.md` except the realistic form flow, where both spent their time recovering from their own failure modes. Verdict on reliability: each bridge has a signature failure that costs a retry, and B's is recoverable in one call.

The five worst findings on A, each with its evidence:

- Ref clicks report success and fire no event, proven by a DOM listener (`E-performance-resilience.md` section 16)
- Enter does not submit a plain search form on four sites (`C-real-sites.md` bug 3)
- `computer screenshot` times out for 30 seconds on a median 3 of 10 calls (`R-repeat-performance.md` section 2)
- The `javascript_tool` content filter discards ordinary values as base64 or cookie data (`R-repeat-performance.md` section 9)
- `read_page interactive` under-reports with no notice, down to zero elements on one page (`B-fixture-sites.md`, /large)

The five worst on B:

- A `chrome-extension://` attach error kills a tab, 3/3 on x.com (`C3-social-news.md` bug 1)
- `get_page_text` returns `(no text)` on LinkedIn and Notion, 3/3 each (`C4-google-notion.md` bug 2)
- An in-batch screenshot can render a stale frame (`B-fixture-sites.md` bug 2)
- `perKey` typing silently types nothing into an autocomplete (`B-fixture-sites.md` bug 6)
- `isAutomatedWithCDP` flags it as a bot on every run (`D-bot-detection.md` section 4)

## 2. Method

**What the two bridges are.** Bridge A is Anthropic's Claude in Chrome extension version 1.0.90, git hash `0acc1914bfe56a4849da5b67e71323b57d695b2d`. Bridge B is chrome-mcp. The build loaded in the user's Chrome during all tests was extension version 0.1.7, as reported by `npm run doctor`, while the source tree in the repo was at 0.1.9 because another session was editing it during the campaign. Every finding below describes 0.1.7 behaviour.

**Environment.** Chrome 152.0.0.0 on Windows 11 Pro 10.0.26200, the user's own signed-in profile, both bridges driving the same Chrome. A opens its own window. B opens tabs in the user's window and activates them before input.

**Transport.** The official extension has a native messaging host registered for Claude Code (`com.anthropic.claude_code_browser_extension`, pointing at `claude.exe --chrome-native-host`), but that process was not running during the session, so A's calls went over the websocket bridge to `wss://bridge.claudeusercontent.com`. chrome-mcp uses a local native messaging host and a named pipe. Both extensions dispatch input through the Chrome DevTools Protocol.

**Who ran the tests.** Subagents on Opus 5 and Sonnet 5, one at a time, because both bridges share one Chrome and cannot run in parallel.

**How timings were taken.** Every timing is wall clock, measured with Bash `date +%s%3N` timestamps bracketing the tool call. That includes the agent's own turnaround, so absolute numbers are inflated for both bridges by the same mechanism and only the ratios carry meaning. B also prints its own `durationMs` and a per-screenshot token estimate, and those are quoted separately where available.

**The three-run rule and where it held.** The user asked for every scenario three times, alternating which bridge went first. Which groups met that:

| Group | File | Three runs? |
|---|---|---|
| Timing primitives, scenarios 1 to 9 | `R-repeat-performance.md` | Yes, three runs of every measurement, medians reported |
| Wikipedia, Hacker News | `C-real-sites.md` | Yes, three runs each per bridge |
| Reddit, CNN, The Verge, x.com, LinkedIn | `C3-social-news.md` | Yes, three runs each per bridge |
| Gmail shortcuts, Google Docs typing, Notion page open | `C4-google-notion.md` | Yes, three runs each per bridge |
| Bot-detection probes | `D-bot-detection.md` | Most probes three runs. CreepJS, browserscan and browserleaks single-run |
| Local fixture, deterministic structural checks | `A-local-site.md` | No. Scenarios 2, 6 to 11, 13, 16, 19, 20 ran once in full with spot checks. Scenarios 1, 3, 12, 15, 17, 18, 21, 24 ran three times |
| Public fixtures | `B-fixture-sites.md` | No. TodoMVC batched creation and `/drag_and_drop` ran three times. The rest ran once per bridge |
| GitHub, YouTube, Google, Amazon | `C-real-sites.md` | No, one full pass per bridge |
| Performance and resilience | `E-performance-resilience.md` | No, most scenarios one run. Sections 1 to 9 are superseded by the three-run medians in `R-repeat-performance.md` |
| GIF, upload | `F-gif-upload-tabs.md` | No. GIF ran three times per bridge, upload sub-cases once each |
| Tabs, windows, focus, shortcuts, cleanup | `F-gif-upload-tabs.md` | Yes for focus and shortcuts. Once for the tab create and close chain |

Anything not run three times is labelled single-run at the point it appears.

**Evidence.** The ten results files and the brief are copied unchanged into `evidence/`. Where the text below quotes an error string, that string is verbatim from the results file.

## 3. How the two bridges are built

Condensed from `X-official-internals.md`, a static reverse-engineering of the official extension's minified bundles with a source-level comparison against chrome-mcp. Line citations there refer to prettified copies of the bundles.

| Topic | Claude in Chrome | chrome-mcp | Winner and why |
|---|---|---|---|
| Transport | Hosted websocket to `wss://bridge.claudeusercontent.com/chrome/<accountUuid>`, OAuth token in the first frame, one JSON object per frame, plus optional native messaging to one of two host names over a sealed encrypted channel | Three local hops: MCP over stdio, a named pipe, then Chrome native messaging with a uint32-LE length prefix and application-level chunking at 384 KB | B for a local tool. Nothing leaves the machine, the host is the listener so several sessions share one browser, and chunking clears Chrome's 1 MB native-message cap. A's edge: the named pipe has no auth, so any local process that can open it drives the browser |
| Keepalive | Triple redundant: a 30 s `chrome.alarms`, a 20 s in-socket ping, and an offscreen document messaging the worker every 20 s specifically to defeat the MV3 idle kill, with the reason left in a shipped comment | A 20 s host port ping plus a 30 s alarm backstop | A. The offscreen document is the only one of the three that survives background throttling, and B has no equivalent |
| Reconnect and replay | Exponential backoff with jitter capped at 5 min, an 8-slot 2-minute result queue replayed on reconnect, and an epoch counter that drops results belonging to a dead connection | 500 ms to 30 s backoff, no result queue, no generation counter | A. B loses in-flight work when the port drops |
| Input dispatch | CDP `Input.*` only. Click is move, a visibility-gated 200 ms cursor race, 100 ms settle, press, 12 ms, release, and every delay is skipped when backgrounded. `type` builds keyDown and keyUp for `[A-Za-z0-9]` and named keys, falls back to `Input.insertText` for everything else, then dispatches all of them with `Promise.all` | CDP `Input.*` only. Click is move, a 100 ms hover delay on the page clock, awaited press and release. `type` defaults to atomic `insertText` with `perKey: true` as an opt-in for 12 ms-spaced key events. Drag is 10 interpolated steps at 16 ms against A's 5 unspaced steps | B on determinism. A's `Promise.all` leaves keystroke ordering to CDP's queue. B also suppresses the `text` payload under a non-shift modifier so `ctrl+a` does not type the letter a |
| Scroll | CDP wheel, then re-reads `pageYOffset`, and if it moved under 5 px falls back to an injected `scrollBy` on the nearest scrollable ancestor | CDP wheel, fire and forget, no verification | A. This is the most defensive piece of input handling in the official extension and B has no counterpart |
| Tree construction | DOM walk in an isolated-world content script. Never enters a shadow root. Runs only in the top frame, so iframe content never appears. Default `filter:"all"` skips both the visibility and the viewport filter | Same walk and the same `WeakRef` ref scheme, but walks open shadow roots, walks same-origin iframes inline with live-measured offsets, resolves `aria-labelledby`, keeps offscreen nodes and marks them, and emits `checked`, `disabled`, `required`, heading level and option labels | B, decisively. This is its strongest area. A's edge: sensitive-value redaction, which B lacks, so a `cc-number` field's contents go into the transcript |
| find | A nested model call. The whole tree plus the query go to a `small_fast` model, and returned refs are validated against the refs actually in the tree | Local lexical scoring with role hints, stopwords, exact-phrase and prefix weights, an offscreen penalty and duplicate collapsing | Split. B is faster and free and right as a default. A resolves queries whose wording shares nothing with the element, which B cannot. Neither offers local ranking with model escalation |
| Screenshots | `Page.captureScreenshot`, JPEG quality 75, a binary search for the exact Claude vision tile budget, a CDP `clip` fast path verified by decoding the image header, and a quality-reduction loop down to 0.10 until the payload fits a hard byte budget. A `scale` parameter shrinks the image while coordinates stay in the full-resolution frame | `Page.captureScreenshot` PNG, then an `OffscreenCanvas` re-encode with an area budget. No byte budget, no `format` or `quality` exposed | A on cost. PNG of a text-heavy page is several times the bytes of JPEG 75 for no model-visible gain, and every byte crosses a chunked pipe. B is ahead on the zoom crop offset, which A does not carry |
| Console and network | Buffers per tab, 10000 console entries and 1000 requests, wiped whenever an entry's own URL hostname differs from the buffer's current domain | 1000 console and 500 network, plus `Log.entryAdded`, with a navigation marker line instead of a clear | B. A's domain rule keys on each message's own URL, so one line from a CDN script host deletes everything collected so far |
| form_input | Assigns `element.value` directly, then dispatches `change` then `input`. No native value setter, no contenteditable branch, and it writes to disabled and readonly fields | Uses the native prototype value setter, dispatches `input` then `change` in the correct order, has a contenteditable branch, and refuses disabled and readonly with a specific error | B. Assigning `.value` directly on a React-controlled input is the classic failure: React's value tracker believes nothing moved. A's edge: `[redacted]` for password and payment fields, and `setSelectionRange` for the caret |
| Uploads | No filesystem access. Base64 bytes arrive in the tool arguments, capped at 10 MB total, and `input.files` is rebuilt from a `DataTransfer` in the page | Sends paths validated host-side at 25 MB, uses `DOM.setFileInputFiles`, and falls back to `Input.dispatchDragEvent` for drop zones | B, decisively. `DOM.setFileInputFiles` is the browser-process path and gives a real `FileList`. `Input.dispatchDragEvent` is a browser-level drag a page cannot distinguish |
| GIF | Event-driven frames, 50-frame cap, per-action delays 300 to 1500 ms, `gif.js` in an offscreen document, five overlays (click ring, drag path, action label, progress bar, watermark), and a retroactive click frame so the pointer is seen landing before the page changes | Event-driven frames, 60-frame cap, a hand-written GIF89a encoder with a 6x6x6 cube plus 40-grey palette, no third-party dependency, no overlays | Split. B's encoder and palette work are better and its output is leaner. A's output is far more readable, and the overlays are why its GIFs are shareable |
| Tabs | A Chrome tab group is the session. The legacy MCP group forces a new window. New tabs opened by the page are not adopted, except by a minimized-window guard that intercepts up to 3 `target=_blank` clicks and returns their ids in the click result | A tab group per client id in the last focused normal window, a status mark in the group title, `keepWindowAlive` so closing the last tab never closes a window, and `ensureVisible` for minimized windows. `adoptTab` exists with no caller | Split. B wins window hygiene and status visibility. A wins on page-opened tabs: it tells the model the new tab id in the click result, which B does not |
| Permissions | Four layers: enterprise policy, a hosted URL-category API that hard-blocks by redirecting to `blocked.html`, per-domain grants with a domain-transition type and a plan mode, and in-page redaction of password and payment fields | Three modes, a 17-entry financial blocklist applied to read-only tools and in skip mode, per-origin grants, and `verifyOriginUnchanged` re-checking the hostname immediately before every mutating action | Split. B's origin re-check closes a TOCTOU hole A has no answer for. A's coverage is broader: plan mode, domain transition, field redaction, and a visible Stop button in the page |
| Telemetry | Segment, Sentry, Datadog RUM and `api.anthropic.com/api/event_logging/v2/batch`. Payloads carry the tool name, ids, duration and the page hostname, no page content. Separately, every navigated URL with path and query goes to the hosted safety-category endpoint | Nothing leaves the machine. A local JSONL and Markdown journal per browser per day | B by design. A's edge: B's journal records typed text and form values up to 160 chars each to a file that is never rotated, so a password typed with `computer type` lands on disk |
| Bot posture | Nothing hidden, nothing spoofed. `Runtime.enable` on every attached tab and never disabled, DevTools banner accepted, and an open-DOM `#claude-phantom-cursor` node added to the page | Same posture, plus the pointer in a closed shadow root, a `data-chrome-mcp-mark` attribute written briefly during upload, and `userGesture: true` on every evaluate | Roughly equal. Both are equally detectable through the banner and `Runtime.enable`. B's cursor host id `__chrome_mcp_cursor__` is fixed and greppable |

## 4. Results by area

### 4.1 Local fixture site

Source: `A-local-site.md`. The runs column states what was actually done.

| Scenario | Claude in Chrome | chrome-mcp | Runs | Verdict |
|---|---|---|---|---|
| Page load and probe | `wd=false cdp=no vis=hidden focus=false`, consistent | `wd=false cdp=no`, visibility flipped between runs (`hidden` run 1, `visible` runs 2 and 3) | 3 each | Both work. B's visibility field is flaky because it activates its tab |
| `read_page` all | 2239 chars, shadow and iframe content absent | 2358 chars, 71 nodes, open shadow button and iframe button present, offscreen and disabled marked | 1 full, spot-checked | B better |
| `read_page` interactive | 14 nodes, everything below the Form section dropped | 26 nodes, keeps offscreen ones and tags them | 1 full | B better |
| `find`, 5 queries | Single reasoned match. Shadow and iframe queries error outright | 8 to 12 ranked matches, correct element always first, all 5 succeed | 3 each | B better on this page |
| Click by ref and by coordinate | Both work when the click lands, log shows `isTrusted=true` | Both work first try | 1 | Both work |
| Default `type` keydown behaviour | One real `keydown` plus `input` per character | Zero `keydown`, one `input` for the whole string, `#kdcount` stayed 0 | 1 | A better by default. B needs `perKey: true` |
| `form_input` on disabled and readonly | Wrote the value anyway, no warning | Refused: `element ref_8 is disabled, so its value cannot be set` | 1 | B correct |
| Shadow DOM click | `pointerdown open-host` then `click SECTION`, `#shadow-out` stayed empty | Same signature, same empty result | 3+ on A, 2 on B | Both fail, shared cause |
| Same-origin iframe click | Works by coordinate only, no ref available | Works by ref, `#r` reads `iframe clicked` | 1 | B better |
| Contenteditable | Ref click did nothing, coordinate click worked | Ref click worked first try | 1 | B better |
| Hover menu | Hover revealed the link, needed a 7 px coordinate correction | Hover revealed the link, click hit first try | 1 | Both work |
| Drag and drop, slider | `dropped A on B`, slider moved to 51 | `#dndout` empty, slider stayed at 0, only `pointerdown HTML` and `click HTML` logged | 1 | A better on this fixture |
| Upload to a file input | `upload1.txt:13,upload2.txt:5000` | Identical | 1 | Identical |
| Upload to a plain div drop zone | Refused: `Element is not a file input. Found: <div>` | `{"ok":true,"mode":"drop",...}`, `#dropout` reads `dropped upload1.txt:13` | 1 | B only |
| Dynamic list after 1.5 s | Ref click reported success and did nothing twice, coordinate click worked | Ref click worked, `wait_for_page` returned `waitedMs:121, durationMs:983` | 1 | B better |
| Keyboard: ctrl+k, Tab, shift+Tab | ctrl+k failed on the first attempt and worked after a click. Tab never moved focus off BODY | All three worked first try, focus moved to `name` and back | 2 on A | B better |
| New tabs from `window.open` and `target=_blank` | Both captured into the group, both closable | Same | 1 | Both work |
| Console and network | `read_network_requests` returned nothing until armed by a first call. Console showed 590 messages spanning the whole multi-hour session | 3 `/api/` requests captured passively. Console showed 29 entries from the current load | 1 | B better here |
| Scroll and `scroll_to` | Works, needs a screenshot to know where to click | Works, returns exact element geometry and `inViewport` | 1 | B better |
| /slow, /redirect, /spa | Blocks until load. On `/spa`, ref clicks reported success and did nothing, coordinate worked | `wait_for_page` caught the 2 s SPA render, ref click worked immediately | 3 | B better |
| /big, 9000 interactive elements | `read_page interactive` stops at 63 nodes with no notice. `find "btn 2999"` found it exactly in about 5.0 s | Explicit `[truncated: showing 1172 of 6000 nodes, 270806 chars total]`. `find "btn 2999"` returned btn 0 to btn 19 in about 350 ms | 1 | Split. A's find won here, B's truncation message won |
| /dialog, click ok only | Clicked ok, no modal appeared | Same | 1 | Both work |
| `resize_window` | First call did not take effect, second and third did | Reported success both times, viewport stayed 1707x769 | 3 on A, 2 on B | A works, B reports a viewport that never changes |
| Screenshot cost | 1568x706 jpeg, no token estimate anywhere. `zoom` upscales a 400x300 region to 979x736 | 1568x707, `~1414 tokens` printed. `zoom` crops at native 400x300, `~154 tokens` | 1 | Different purposes. B prints cost, A magnifies |
| javascript edge cases | A 20000-char repeated string returned `[BLOCKED: Base64 encoded data]` | Returned in full | 3, see R section 9 | B correct |
| `browser_batch` with a bad ref | 4789 ms, failed cleanly at step 6, typed text landed | 3328 ms, failed cleanly at step 6, typed text did not land and the event log was empty | 1 | Both fail cleanly. B had a silent in-batch no-op |
| Per-call latency, `1+1` x10 | 28114 / 26643 / 25935 ms, median 26643 | 4695 / 4694 / 4572 ms, median 4694 | 3 each | B roughly 5.7x faster |

### 4.2 Throwaway sites and data modification

Source: `B-fixture-sites.md`. Every row is single-run per bridge unless the runs column says otherwise.

| Scenario | Claude in Chrome | chrome-mcp | Runs | Verdict |
|---|---|---|---|---|
| TodoMVC full CRUD | All steps worked | All steps worked through one `quick` script | 1 each | Both work |
| TodoMVC batched click, type, Enter | 1 silent no-op of 3 attempts, on the longest chain | 3 of 3 created the todo, but one in-script screenshot showed a pre-repaint frame | 3 each | A flaky, B works with a lying screenshot |
| `form_input` then a separate Enter | Worked | Worked | 1 each | Both work. React controlled inputs are not where either breaks |
| /checkboxes | `form_input` worked. A ref click on an on-screen checkbox no-op'd twice, coordinate worked | Both worked first try | 1 | B better |
| /dropdown by value and by text | Both worked | Both worked | 1 | Identical |
| /dynamic_loading/2 | Ref click on the on-screen Start button no-op'd, coordinate click worked | Ref click worked first try | 1 | B better |
| /dynamic_controls | 1 of 3 ref clicks no-op'd | All ref clicks worked | 1 | B better |
| /drag_and_drop | Swapped correctly all 3 runs | Swapped correctly all 3 runs | 3 each | Both work |
| /hovers | `find` surfaced all 3 hover-hidden links. `get_page_text` errored on the 404 target: `No text content found` | `find` surfaced only the visible link. `get_page_text` returned `Not Found` correctly | 1 | Split |
| /key_presses | The first 1 to 2 keypresses after a click needed a retry | Every attempt worked first try | 1 | B better |
| /upload | `file_upload` worked. The submit ref click no-op'd, coordinate worked | Both worked first try | 1 | B better |
| /infinite_scroll | 2 paragraphs before, 7 after | 2 before, 7 after | 1 | Identical |
| /nested_frames | Identical results | Identical results | 1 | Identical |
| /shadowdom tree | Shows rendered slot content only | Shows both fallback and slotted content, 14 nodes | 1 | B more complete |
| /large | `read_page interactive` returned zero elements with no notice. `find` succeeded first try | `read_page interactive` returned exactly the 2 real links. Default `find` failed with `among 2 searched` and needed `include_all: true` | 1 | Split |
| /tables sort | `find` worked, ref click no-op'd, coordinate worked | Default `find` failed, `include_all` worked, ref click worked first try | 1 | Split |
| /inputs arrow keys | No-op'd entirely, a coordinate retry reached 11 | Worked first try, reached 11 | 1 | B better |
| /horizontal_slider | 3.5 after anchoring | 3.5 after anchoring | 1 | Identical |
| /add_remove_elements | Needed 2 coordinate corrections, reached 3 | Ref clicks tracked the reflowing DOM, reached 3 | 1 | B better |
| /disappearing_elements | Read correctly on each load | Read correctly on each load | 3 loads | Identical, the variation is the site's own |
| /floating_menu | Hit News first try | The first coordinate click hit Home, the second hit News | 1 | Both work after a re-screenshot |
| /status_codes 404 and 500 | Both ref clicks no-op'd, coordinates worked | Both ref clicks worked first try | 1 | B better |
| /redirector | Ref click no-op'd, coordinate worked | Worked first try | 1 | B better |
| /slow navigate timing | About 7.7 s wall clock, no tool-reported duration | `durationMs: 392`, about 0.68 s wall clock | 1 | Single-run only, the site has a random delay, not conclusive |
| /typos | Read correctly every load | Read correctly every load | 3 loads | Identical |
| /windows new window | Ref click no-op'd, coordinate worked, the new tab auto-joined | Worked first try, the new tab auto-joined | 1 | B better |
| /entry_ad modal close | `find` found it, ref click no-op'd, coordinate worked | `find` found nothing, coordinate worked | 1 | Both close it |
| /notification_message | Click worked, `get_page_text` never included the banner a screenshot showed | Click worked, `get_page_text` included the banner | 1 | B better |
| /challenging_dom | Every click worked, stale refs errored clearly | Same | 1 | Identical |
| /forgot_password | `form_input` worked, the submit ref click no-op'd, coordinate reached the site's own 500 | Hit the `chrome-extension://` tab-death error, recovered by close and recreate, reached the same 500 | 1 | Both reach the same result |
| /iframe TinyMCE | The editor was rate-limited into read-only mode | Same | 1 | Untested, site quota |
| demoqa /text-box | `form_input` filled every field, submit worked first try | Same, plus ad-iframe text in the extraction | 1 | Both work |
| demoqa practice form | Every control filled. `get_page_text` on the results modal dropped the Gender and Hobbies values | Every control filled. `get_page_text` included every value | 1 | B better on extraction |
| demoqa /webtables | Not run, budget | Not run, budget | 0 | Untested |
| httpbin.org/forms/post | Identical echo JSON | Identical echo JSON | 1 | Identical |
| jqueryui /sortable | Reorder worked. `get_page_text` missed the iframe list | Reorder worked. `get_page_text` included the iframe list | 1 | B better here |
| jqueryui /autocomplete | Worked with plain `type` | `perKey: true` typed nothing and reported `{ok:true, typed:2}`. Plain `type` worked | 1 | A better, B has a bug |
| selenium web-form | Identical query string, including an empty `my-date=` | Same | 1 | Identical, shared date-field gap |
| Quill editor | Typed and bolded through the sandboxed iframe | Same | 1 | Identical |
| Cookie banners | No fresh banner could be reproduced, prior consent held | Same | 0 as scoped | Untested as scoped |

### 4.3 Real sites

Sources: `C-real-sites.md`, `C3-social-news.md`, `C4-google-notion.md`.

| Site and scenario | Claude in Chrome | chrome-mcp | Runs | Verdict |
|---|---|---|---|---|
| Wikipedia search and article | Enter did not submit. The search-result ref click no-op'd 2/2 and the TOC ref click 3/3. Coordinate clicks worked 2/2 | Every click worked first try. Navigate and wait 989 / 984 / 985 ms, median 985 | 3 each | B works, A partial |
| Wikipedia stale ref after `form_input` | Not hit | `ref ref_5 is no longer on the page. Re-read the page.` once, recovered with one `find` | 1 of 3 | B fails loudly and recovers |
| Hacker News comments link | No-op 2/3, worked 1/3 | Worked 3/3, click and wait 845 / 847 / 842 ms, median 845 | 3 each | A flaky, B consistent |
| GitHub repo nav tabs | Ref clicks no-op'd on 2 of 3 tabs, coordinate worked | All 3 ref clicks worked | 1 pass each | B better |
| GitHub `t` and `/` shortcuts | `key "slash"` had no effect, the literal `/` worked. `t` needed a second press while the page loaded | `K /` errored with `unknown key "/"`, `TK /` worked. `T` appended to the pre-filled box, producing `tREADME` | 1 pass each | Both have a punctuation gap, different workarounds |
| YouTube search and playback | Enter did not submit, the button click worked. The first result ref click worked. `k` toggled play and pause both directions | The button click worked. The first result click worked. `k` toggled play and pause | 1 pass each | B works, A partial |
| Google Search | Enter did not submit, a coordinate click on the button worked. No CAPTCHA | `F` plus `K Enter` in one `quick` script worked, `durationMs: 3055` for the wait. No CAPTCHA | 1 pass each | B works, A partial |
| Google Maps | Enter recentred the map and left a suggestion dropdown open | The button click landed on one resolved place | 1 pass each | Both work, different end states |
| Amazon search and product | Enter did not submit. `find` hard-failed: `400 prompt is too long: 234540 tokens > 200000 maximum`. `get_page_text` carried the category mega-menu and internal `Test:` debug strings | `find` did not locate the price element, returning a filter slider and footer links. The first product ref click no-op'd once of two attempts | 1 pass each | Both partial. A's find failure is total |
| old.reddit.com | Login wall 3/3 | Login wall 3/3, `durationMs` 626 / 903 / 904 | 3 each | Site-level, not a bridge difference |
| www.reddit.com feed | 3 posts before scroll, 24 after | 27 before, 27 after | 3 each | Both work, B's settle wait pre-loads the feed |
| CNN | `read_page interactive` 2464 chars and 39 nodes, all 3 runs | 309 nodes and about 34112 chars, all 3 runs, offscreen marked. Unfiltered `read_network_requests` exceeded the harness output cap | 3 each | B returns the real tree, A returns a viewport slice |
| The Verge | `read_page interactive` 1708 chars, all 3 runs | 343 / 341 / 340 nodes, 42345 / 42269 / 42114 chars | 3 each | Same pattern |
| x.com logged-out page | Screenshot and scroll worked 3/3 | `computer` failed 3/3 with the `chrome-extension://` error and poisoned the tab for later `navigate` | 3 each | A works, B fails reproducibly |
| LinkedIn feed | Full feed text 3/3 | `get_page_text` returned `(no text)` 3/3 while `read_page` returned 214 nodes and 17915 chars | 3 each | A works, B has a real extraction gap |
| Gmail inbox list | `get_page_text` returned only the unread badge summary. Per-row `read_page` recovered the 5 senders and subjects | One `quick` script returned all 12 rows with previews | 1 | B better |
| Gmail open message | Body truncated mid-sentence at about 450 chars. `navigate back` failed: `Cannot find a next page in history` | Full body, 900+ chars. `navigate back` succeeded, `durationMs: 6` | 1 | B better |
| Gmail j, k, Enter shortcuts | URL and title unchanged, no message opened | Same, `navigated: false` | 3 each | Both fail |
| Google Docs typing | Correct and in order all 3 runs | Correct and in order all 3 runs | 3 each | Both work |
| Google Docs content reads | `read_page`, `find` and `document.body.innerText` all blind to the typed text | Same | 3 each | Both blind, canvas editor |
| Notion sidebar page open | Ref click no-op'd 3 of 4 attempts, coordinate worked once | Ref clicks worked 2/2 | 4 on A, 2 on B | B better |
| Notion `get_page_text` | Full page text 3/3, about 1400 chars for the PC Gamer page | `(no text)` 3/3 while `read_page` exposed the same text as `text` children | 3 each | A works, B has the same gap as LinkedIn |

### 4.4 Bot detection

Source: `D-bot-detection.md`. No baseline without a bridge exists, because both bridges attach to the one real Chrome and there is no way to load a page in it without going through one of them.

| Signal or detector | Claude in Chrome | chrome-mcp | Runs |
|---|---|---|---|
| `navigator.webdriver` | `false` | `false` | 3 each |
| bot.sannysoft.com scored tests | All pass | All pass | 3 each |
| sannysoft raw `wOuterHeight` and `wOuterWidth` at load | `0` and `0` every run | `912` and `1707` every run | 3 each |
| CreepJS headless section | `chromium: true`, `25% like headless`, `0% headless`, `0% stealth` | Identical | 1 each |
| CreepJS FP ID | `f68cab865d26a8c8b9a3306b7f170fac76a1abeea64a2e30a024db3bc8e844b7` | Same | 1 each |
| browserleaks canvas signature | `867a67b06afca98b3db126e27a9c4d7f` | Same | 1 each |
| deviceandbrowserinfo.com `isBot` | `false` on the one run that completed, and the verdict never populated on 2 of 3 runs | `true` on all 3 runs | 3 each |
| deviceandbrowserinfo.com `isAutomatedWithCDP` | `false` | `true` on all 3 runs, every other flag `false` | 3 each |
| browserscan.net CDP and Dev Tool section | Normal | Normal | 1 each |
| `document.visibilityState` on the local probe | `hidden`, before and after a real trusted click | `visible` throughout | Cross-checked twice |
| `document.hasFocus()` at load | `false`, flips true after a click | `true` | Cross-checked twice |
| `outerWidth - innerWidth` at load on the local probe | `-1707`, self-corrects to `0` seconds later | `0`, correct immediately | Cross-checked twice |
| Inter-key intervals typing 19 characters | 0 to 1.2 ms, mostly 0.2 to 0.5 ms | `perKey` ramps 23 to 33 to 52 ms then settles at a regular 62 to 64 ms | 1 each |
| Mouse path between two clicks | 2 to 4 samples, a straight jump | 2 samples, a straight jump | 1 each |
| Click trust | `isTrusted=true`, `ptr=mouse` | Same | Many |
| Cloudflare nowsecure.nl | Passed automatically 3/3 | Passed 3/3 | 3 each |
| Cloudflare scrapingcourse demo | `You bypassed the Cloudflare challenge! :D` 3/3 | Same 3/3 | 3 each |
| reCAPTCHA v3 score | 0.9 on the 2 runs that worked. Run 1 threw `TypeError: grecaptcha.execute is not a function` | 0.9 on all 3 runs, resolved immediately | 3 each |
| DevTools infobar visible in a screenshot | Not testable, screenshots capture the viewport only | Same | Untested by design |

### 4.5 Performance

Medians from `R-repeat-performance.md`, three runs of each measurement per bridge, order alternated A-B, B-A, A-B. Wall clock includes agent turnaround for both bridges.

| Measurement | A median | B median |
|---|---|---|
| 10 separate `1+1` javascript calls | 27911 ms | 7927 ms |
| 10 `1+1` in one `browser_batch` | 9448 ms | 5614 ms |
| B `quick`, 10 `J 1+1` lines | not available | 3464 ms |
| 10 separate screenshots (timeouts of 10) | 109198 ms (3) | 8829 ms (0) |
| `read_page` all and interactive on two pages | 12116 ms | 10350 ms |
| `get_page_text` on two pages | 10454 ms | 8781 ms |
| `find`, two queries | 13735 ms | 6104 ms |
| `navigate` to four targets | 14392 ms | 9054 ms |
| Realistic form flow as one batch | 18294 ms | 17381 ms |
| Type 500 characters (success rate) | 18960 ms (1 of 3) | 9521 ms (2 of 3) |
| `'x'.repeat(200000)` | 7755 ms | 4642 ms |

Per-call latency, from the same file and from `A-local-site.md` section 24. A reports no per-call duration for `javascript_tool`. B's `durationMs` for `1+1` was 1 to 4 ms every call, so essentially all of B's per-call wall clock is transport and harness round trip rather than page execution. Dividing the medians by 10 gives roughly 2791 ms per call for A against 793 ms for B in the R session, and 2664 ms against 469 ms in the earlier `A-local-site.md` session. The two sessions agree on the ordering and differ on absolute figures by 10 to 20 percent, which is the run-to-run variance the R file reports.

B's tool-reported `navigate` durations, consistent across all three R runs: index.html 43 to 99 ms, /slow 4019 to 4022 ms matching the fixture's 4 s server delay, /redirect 36 to 43 ms with the resolved URL returned, example.com 29 to 79 ms.

### 4.6 Resilience

Source: `E-performance-resilience.md`, single-run per scenario unless stated.

| Scenario | Claude in Chrome | chrome-mcp | Runs |
|---|---|---|---|
| Screenshot after 45 s idle | Failed, 30000 ms CDP timeout | Succeeded, 786x507, ~509 tokens | 2 |
| Screenshot after about 7 to 8 min idle | Failed, same timeout | Succeeded | 1 |
| `javascript` after the same idle | Succeeded every time | Succeeded, `durationMs: 2` | 3 |
| Screenshot on a tab closed underneath | `Couldn't determine which page this action targets. Re-read tabs_context_mcp and try again.` | `No tab with id 177110633. It may have been closed. Call tabs_context to list current tabs.` | 1 |
| Navigate, screenshot and read_page in one batch | The screenshot returned the stale pre-navigation page while `read_page` in the same batch saw the new one | Both saw the new page | 1 |
| Page navigates itself mid-action, then a stale ref click | Reported `Clicked on element ref_12` with no effect and no error | `ref ref_12 is no longer on the page. Re-read the page.` | 1 |
| Stale ref after navigating away and back | `No element found with reference: "ref_12".` | `ref ref_12 is no longer on the page. Re-read the page.` | 1 |
| Click on /big with a DOM listener installed | `find` returned the exact ref, the click reported success, `window.__hit` stayed `false` | The click reported `{"ok":true,...,"durationMs":605}` and `window.__hit` was `true` | 1 |
| 8-second busy loop, batched and separate | The batch survived, 12620 ms | The batch survived, 8986 ms, `durationMs: 8003` on the loop | 1 |
| Cross-origin iframe in the tree | The iframe is absent from the tree. `find "example domain"` returned an unrelated same-page link with confident reasoning | The iframe is present as `iframe "https://example.com" [ref_36]`. `find` correctly reported no match | 1 |
| Three tabs created and navigated in batches | The third navigate was blocked: `Navigation to this domain is not allowed`, on a domain already visited in another tab | All three created and navigated in one batch, 1952 ms | 1 |
| Native host killed underneath the session | not applicable | The first screenshot after the kill succeeded in 401 ms, `npm run doctor` all green | 1 |

### 4.7 Recording, upload and tabs

Source: `F-gif-upload-tabs.md`.

| Scenario | Claude in Chrome | chrome-mcp | Runs | Verdict |
|---|---|---|---|---|
| GIF record and export | 4, 7 and 8 frames across three runs at 1120x1085. Run 1's file verified at 518098 bytes with a `GIF89a` header | 7 frames every run at 480x465. Run 1's file verified at 96310 bytes with a `GIF89a` header | 3 each | Both work |
| GIF elapsed-time field | Reports a real frame count | Reports `over 0.0s` on every recording, including one spanning 15 s | 5 recordings | B's field looks unimplemented |
| GIF export with zero frames | `Captured 0 frames`, export refused | Reports `Recorded 2 frames` and writes a minimal valid GIF | 1 each | Different behaviour, both defensible |
| GIF export twice | Refuses the second, buffer cleared | Refuses the second, buffer cleared | 1 each | Same semantics |
| Upload two fixtures to a file input | `upload1.txt:13,upload2.txt:5000` | Identical | 1 each | Identical |
| Upload a 12 MB file | Rejected client-side: `total upload size would exceed 10 MB` | Succeeded, `#fileout` read `big12.bin:12582912` | 1 each | B only |
| Upload a 30 MB file | Rejected at the same 10 MB ceiling | `Upload exceeds the 25MB limit.` | 1 each | Both reject, different ceilings |
| Upload to a plain div drop zone | No `coordinate` parameter exists in the schema | `{"ok":true,"mode":"drop","at":{"x":420,"y":459,"mapped":true},"files":1}` | 1 each | B only |
| Non-existent path error | `only files this session is allowed to read can be uploaded` | `No such file: <path>` | 1 each | B's message is more actionable for this case |
| `upload_image` from a screenshot | Worked, `image.png:52153` | Worked, plus a `path:"last"` shorthand A has no equivalent for | 1 each | Both work |
| Create 3 tabs, navigate, close the middle | Worked, context lists tabId, title, url | Worked, context also lists `windowId`, `active`, `status`, `groupTitle` | 1 each | Both work, B's listing is richer |
| Page-opened tab | Appeared automatically, `selectedTabId` stayed on the opener | Appeared automatically with `active:true` and `visibilityState:"visible"` | 1 each | Both adopt it |
| Cross-bridge tab id | `Couldn't determine which page this action targets.` | `Tab 177110669 is not in this session's tab group.` | 1 each | B's refusal names the reason |
| Resize to 1000x700, new tab inherits | `innerWidth:988`, `outerWidth:0` | `innerWidth:988`, `outerWidth:1001`, `outerHeight:700` | 1 each | Both inherit, A's JS context hides `outer*` |
| Foreground window title during work | Unchanged across all checks | Unchanged across all checks | 3 each | Neither steals OS focus |
| Tab activation during work | The probe read `visibility: hidden / hasFocus: false` every run | The probe read `visibility: visible / hasFocus: true` every run | 3 each | Confirms the design difference |
| `shortcuts_list` | `{"message":"No shortcuts found","shortcuts":[]}` | `{"shortcuts":[],"durationMs":0}` | 3 each | Both return an empty list, the execute path is untested |
| Cleanup and empty-group context | A prose string: `No tab group exists for this session.` | `{"tabGroupId":null,"tabs":[],"durationMs":1}` | 1 each | Both clean, B is machine-parseable |

## 5. Bugs found

Deduplicated across all ten evidence files. Where the same bug was seen by several agents, the entry lists every place it appeared.

### 5.1 Claude in Chrome bugs

**A1. Ref-based `computer left_click` reports success and fires no event.**
Reproduction: navigate to `https://the-internet.herokuapp.com/dynamic_loading/2`, call `read_page filter=interactive` to get the Start button's ref, then `computer left_click` that ref. The tool returns `Clicked on element ref_N` and the page does not change. A coordinate click on the same visible button works immediately.
Proof beyond absence of effect: on `/big`, with `document.addEventListener('click', e => { if (e.target.textContent==='btn 2999') window.__hit=true })` installed, `find` returned an exact-match ref, the click reported success, and `window.__hit` read `false` (`E-performance-resilience.md` section 16).
Reproduction count: 11 or more distinct elements in `B-fixture-sites.md` (checkboxes, Start, Remove, the upload submit, the Due header, the 404 and 500 links, the redirect link, Add Element, Click Here, the modal Close, Retrieve password), 3 of 3 on the Wikipedia TOC link and 2 of 2 on the search-result link, 2 of 3 on the Hacker News comments link with one success, 2 of 3 GitHub nav tabs (`C-real-sites.md`), 3 of 4 on Notion's sidebar (`C4-google-notion.md`), 3 separate cases on the local fixture (`A-local-site.md` scenarios 8, 12, 17), and both the Submit button and the `/big` listener test in `E-performance-resilience.md`. It is not deterministic per element: the same Hacker News link no-op'd twice and worked once.
Workaround that worked every time it was tried: take a screenshot, then click by the coordinate visible in it.

**A2. `Page.captureScreenshot` times out for 30 seconds.**
Reproduction: call `computer screenshot` ten times in a row on a static local page, or once on a tab left idle for 45 seconds or more.
Verbatim error: `Error capturing screenshot: CDP sendCommand "Page.captureScreenshot" timed out after 30000ms on tab <id>. The renderer may be frozen or unresponsive.`
Reproduction count: 10 of 30 calls across three runs of ten, at 3, 3 and 4 failures per run (`R-repeat-performance.md` section 2). 3 of 3 idle tests, two at 45 s and one at roughly 7 to 8 minutes (`E-performance-resilience.md` section 11 and the long-idle run). Twice more during Gmail keyboard testing, both immediately after a `key` action (`C4-google-notion.md` bug 4). Twice on one long-lived tab in `F-gif-upload-tabs.md` bug 2, where a sibling tab on the same URL screenshotted fine. `javascript_tool` on the same tab always worked immediately after the failure, so the tab is not actually frozen.

**A3. Enter does not submit a plain HTML search form.**
Reproduction: on Wikipedia, YouTube, Google Search or Amazon, set the search box with `form_input` or `computer type`, then send `computer key Return`. The URL does not change. A coordinate click on the adjacent search button works immediately.
Reproduction count: 4 sites, every attempt, using both text-entry methods (`C-real-sites.md` bug 3). On Google Maps, Enter was not a pure no-op: it recentred the map and opened a suggestion dropdown, so the failure is specific to native form submission on Enter rather than to Enter handling in general. Related and counted separately: Gmail's `j` then `Return` never opened a message on either bridge (`C4-google-notion.md` bug 5), and `Tab` never moved focus off BODY on the local fixture (`A-local-site.md` scenario 13).

**A4. The `javascript_tool` content filter withholds ordinary values.**
Two triggers, both false positives.
Trigger one, a long run of one repeated character: `'x'.repeat(200000)` and a 20000-char equivalent both returned `[BLOCKED: Base64 encoded data]` with the real value discarded rather than truncated. Reproduced verbatim 3 of 3 runs in `R-repeat-performance.md` section 9, and once each in `A-local-site.md` scenario 22 and `E-performance-resilience.md` section 9.
Trigger two, any page whose URL carries a query string: evaluating `location.href` or a `.href` array read returns `[BLOCKED: Cookie/query string data]`. `document.title` on the same tab at the same moment executes normally, which shows the filter keys off the page URL rather than the evaluated expression. Reproduced on a Wikipedia search-results page, a GitHub code-search page and an Amazon results page (`C-real-sites.md` bug 2), and separately on `document.cookie` at theguardian.com (`B-fixture-sites.md` bug 5).

**A5. `read_page filter=interactive` under-reports with no truncation notice.**
Reproduction: on `http://127.0.0.1:8765/big`, call `read_page filter=interactive`. It returned 63 nodes of 9000 in one session (`A-local-site.md` scenario 18) and 25 rows of 3000 in all three R runs, with no notice in the body and no total count. On `https://the-internet.herokuapp.com/large` it returned zero elements, not even the page's 2 real links (`B-fixture-sites.md`). On the local fixture it returned 14 nodes, all inside the form, dropping the shadow button, iframe button, far button, hover menu, upload, dynamic, network and dialog buttons that its own `filter=all` dump lists. On CNN and The Verge it returned roughly 39 and 40 nodes against B's 309 and 343, consistently across three runs each (`C3-social-news.md` section 2).

**A6. `find` fails outright on a dense page.**
Reproduction: navigate to `https://www.amazon.com/s?k=usb+c+cable`, then call `find` with any query.
Verbatim error: `400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 234540 tokens > 200000 maximum"}}`
No truncation, no partial list, no warning. Reproduced on Amazon only, not on Wikipedia's 630-result search page or GitHub's notification inbox (`C-real-sites.md` bug 4). Seen once.

**A7. `computer type` reports success and types nothing.**
Reproduction: click a text field by ref, then `computer type` a 500-character string. The tool echoes the full string back as if it worked, and the target field, along with every other field on the page, stays empty with zero events in the page's own log.
Reproduction count: 2 of 3 runs in `R-repeat-performance.md` section 8 and 1 of 1 in `E-performance-resilience.md` section 8. In both files the page's Probe block read `hasFocus: false` at the time.

**A8. `get_page_text` omits rendered text and can error on a minimal page.**
Reproduction of the error case: navigate to `https://the-internet.herokuapp.com/users/1`, whose only content is `<h1>Not Found</h1>`, and call `get_page_text`. Result: `No text content found. Page may contain only images, videos, or canvas-based content.` B returned `Not Found` correctly on the same page.
Reproduction of the omission case: a flash banner at `/notification_message`, the box labels at `/drag_and_drop` on one run, the Gender and Hobbies values in demoqa's results modal, and the jqueryui sortable iframe list, each visible in a screenshot taken at the same moment (`B-fixture-sites.md` bugs 3 and 4). Gmail's inbox list is the same class: `get_page_text` on `#inbox` returned only the unread-badge summary while B returned all 12 rows (`C4-google-notion.md` bug 1). Four or more distinct pages.

**A9. `get_page_text` includes instrumentation noise on Amazon.**
Reproduction: navigate to an Amazon search-results page and call `get_page_text`. The output carries the full category mega-menu of 60 or more entries, a keyboard-shortcuts legend, duplicated image-alt captions, and a trailing block of internal `Test: amzn-nv-flyout-healthy-choice` style debug strings. B's extraction of the identical URL had none of it (`C-real-sites.md` bug 5). Not reproduced on Wikipedia, GitHub or YouTube, where the two bridges were comparable. Seen once.

**A10. A screenshot inside a `browser_batch` can return a stale pre-navigation frame.**
Reproduction: run one batch of navigate to /slow, `computer screenshot`, `read_page`. The screenshot shows the previous page while the `read_page` in the same batch returns `heading "slow page"` (`E-performance-resilience.md` section 13). Seen once.

**A11. `browser_batch` can report a timeout while its actions execute anyway.**
Reproduction: run an 8-step batch containing two `computer screenshot` actions with clicks and waits between them.
Verbatim error: `The "browser_batch" tool did not respond in time. The Chrome extension is connected but the page may be loading, unresponsive, or waiting on a permission prompt in the extension side panel.`
A follow-up `stop_recording` reported 3 frames captured and `get_page_text` showed the full trusted-event log, proving every action ran (`F-gif-upload-tabs.md` bug 1). Seen once. An agent trusting the error would retry a sequence that already succeeded.

**A12. A fresh tab cannot navigate to a domain already visited in another tab.**
Reproduction: in one `browser_batch` create 3 tabs, then in a second batch navigate them to `index.html`, `/big` and `https://example.com`, where the last was already reached earlier in the session on a different tab.
Verbatim error: `actions[2] (navigate) failed: Navigation to this domain is not allowed (2 completed, 0 remaining)` (`E-performance-resilience.md` section 10). Seen once.

**A13. `resize_window`'s first call in a sequence can silently not take effect.**
Reproduction: call `resize_window` to 800x600, then read `innerWidth` and `innerHeight`. They stayed at 1707x769 while the tool reported success. A subsequent resize to 1400x900 took effect, and a second 800x600 attempt then worked (`A-local-site.md` scenario 20). Seen once, likely a completion race.

**A14. `find` confabulates a match rather than reporting none.**
Reproduction: on the local fixture, `find "example domain"` returned `ref_66: link "blank link" (href="https://example.com")` with the reasoning that the link's href contains example.com, not marked as low confidence, while the actual cross-origin iframe has no ref in A's tree at all. B returned `No elements matched "example domain" among 26 searched` (`E-performance-resilience.md` section 18). Seen once.

**A15. Async page scripts fail to complete more often on A.**
`deviceandbrowserinfo.com/are_you_a_bot` never populated its verdict on 2 of 3 runs, across 13 or more seconds of waiting and a reload, with a Rollbar-logged JS error during one stall. `recaptcha-v3-request-scores.php` threw `TypeError: grecaptcha.execute is not a function` on 1 of 3 runs and never requested a token. B produced a result on every run of both pages (`D-bot-detection.md` bugs 4 and 5).

### 5.2 chrome-mcp bugs

**B1. A `chrome-extension://` debugger-attach error kills a tab for `computer` and `navigate`.**
Verbatim error shape: `Cannot access a chrome-extension:// URL of different extension Frames: top <url>; frame N about:srcdoc; frame M <iframe url>. Debugger targets: worker* chrome-extension://nngceckbapebfimnlniiiahkandclblb/background.js; ...`
Reproduction, deterministic: on bridge B, navigate a tab to `https://x.com/home`, which redirects to `/` and renders a Google Identity Services sign-in-button iframe, then call `computer` with any action. It fails immediately, every time, 3 of 3 runs on 3 different fresh tabs (`C3-social-news.md` bug 1). Once triggered, a later `navigate` on the same tab fails identically, while `page_state`, `read_page`, `get_page_text` and `javascript` keep working on that same tab.
Reproduction, intermittent: on the local fixture page, which carries a `srcdoc` iframe and a cross-origin `example.com` iframe, after a period of interaction. Hit 3 times in `A-local-site.md` (tabs 177110451, 177110460, 177110464), once in `B-fixture-sites.md` at `/forgot_password` after roughly 30 navigations on the same tab with no cross-origin iframe open at the time, once in `E-performance-resilience.md` section 7, and twice in `R-repeat-performance.md` sections 7 and 8.
Workaround, confirmed every time: `tabs_close` the tab and `tabs_create` a fresh one. On x.com the new tab fails again the moment `computer` is called on the same page, so the trigger is the page rather than accumulated tab history.
`X-official-internals.md` part 1 section 3 identifies the cause and the official fix: another extension has injected an iframe whose src is its own `chrome-extension://` origin, and Chrome refuses the attach because of it. The official recovery, `stripExtensionInterference`, enumerates frames, counts iframes through open and closed shadow roots, removes the offending ones and retries up to 4 times.

**B2. `get_page_text` returns `(no text)` on LinkedIn and Notion.**
Reproduction on LinkedIn: navigate to `https://www.linkedin.com/feed`, wait for load, call `get_page_text`. The body is `url: https://www.linkedin.com/feed/` followed by `(no text)`. Reproduced 3 of 3 across fresh navigations while `read_page` on the same page returned 214 nodes and 17915 chars and a screenshot showed the feed rendered (`C3-social-news.md` bug 2).
Reproduction on Notion: navigate to any `app.notion.com/p/...` page and call `get_page_text`. Same `(no text)` result, 3 of 3, while `read_page` exposed the same prose as `text` children under `textbox` nodes, for example `"AccuKnox: Front-end engineer responsible for building the initial version of the app"` (`C4-google-notion.md` bug 2). A's `get_page_text` returned full text on both sites every time. Both DOM shapes use deeply nested custom-component text containers rather than plain paragraph or article markup.

**B3. A screenshot inside a batched call can render a stale pre-repaint frame.**
Reproduction: on TodoMVC React, in one `quick` script, click into the field, type, press Enter, then put `SS` on the last line. The screenshot shows an empty field and no todo list while a `read_page` from a later separate call shows the todo present. Also reproduced on a delete click followed immediately by `SS` (`B-fixture-sites.md` bug 2, two occurrences).
Workaround: insert `W` (`wait_for_page`) before the screenshot, or take the screenshot in a separate call. Both fixed it.
This is worse than a no-op, because the tool's own output contradicts what happened.

**B4. `computer type` with `perKey: true` can silently type nothing.**
Reproduction: on `https://jqueryui.com/autocomplete/`, click the Tags field, then `computer type` with `text: "ja"` and `perKey: true`. The tool returns `{ok:true, typed:2}`, the field stays empty and no suggestion dropdown appears. The identical call with `perKey` omitted works immediately on the same field (`B-fixture-sites.md` bug 6). Seen once, and it contradicts the option's own documented use case, which names autocompletes specifically.

**B5. The `quick` `K` command rejects punctuation keys.**
Reproduction: on any page, a `quick` script line `K /`. Result: `unknown key "/". Supported: 0,1,2,...`, a fixed list of named keys with no punctuation. Workaround: `TK /`, which accepts the literal character (`C-real-sites.md` bug 6). Seen once, on GitHub's global-search shortcut. A has the mirror-image gap: `computer key text="slash"` had no effect while the literal `/` worked.

**B6. The `quick` `T` command does not clear a pre-filled input.**
Reproduction: on GitHub, press `t` to open the file finder, which puts a literal `t` in the box, then run a `quick` line `T README`. The resulting query is `tREADME` and the finder reports no matches. Workaround: `K ctrl+a` first (`C-real-sites.md` bug 7). Seen once.

**B7. Ref-based clicks are not universally reliable.**
Reproduction: on an Amazon search-results page, `find` the first product's title link, then `C <ref>` in a `quick` script. The first attempt reported ok and left `location.href` unchanged. The second attempt, identical script and ref, worked immediately with `navigated: true` (`C-real-sites.md` bug 8). Seen once in the whole campaign against B, on the heaviest DOM tested. Every other B ref click across Wikipedia, Hacker News, GitHub, YouTube, Notion and the fixture sites worked first try.

**B8. Console and network buffers are not domain- or navigation-scoped.**
Reproduction: navigate one tab through several sites, then call `read_console_messages` without `clear:true`. It returns errors from every site the tab visited. On the first CNN measurement this produced 30 or more errors of which nearly all were old.reddit.com and reddit.com CORS and CSP errors (`C3-social-news.md` bug 3). Reproduced again in `E-performance-resilience.md` section 19, where B's buffer spanned every navigation the tab had made all session with navigation marker lines, against A's 5 messages scoped to the current load.
This is documented behaviour, and `X-official-internals.md` part 2 section 7 argues it is the better design, because the official rule wipes the buffer whenever one message's own URL hostname differs from the buffer's current domain. It is still a trap when the tool is used to answer what just happened on this page.

**B9. `read_network_requests` and large tree reads exceed the harness output cap.**
Reproduction: on CNN, call `read_network_requests` unfiltered. The result, 500 requests and 178499 characters, exceeded the harness maximum and was redirected to a saved file. Same on a combined `quick` `X` and `R` call on The Verge at 63262 characters across 702 lines, and on `read_page filter=interactive` for `/big`, which returned `result (50,163 characters across 1,156 lines) exceeds maximum allowed tokens` in 3 of 3 R runs. A never hit the ceiling in the same scenarios, because its defaults return far less (`C3-social-news.md` bug 4, `R-repeat-performance.md` sections 3 and 4).

**B10. `gif_creator stop` always reports `over 0.0s`.**
Reproduction: record anything and stop. Every one of 5 recordings reported `Recorded N frames over 0.0s at 480x465`, including runs that spanned 15 seconds with a `PAUSE 2` in the middle (`F-gif-upload-tabs.md` bug 3). Cosmetic. The exported GIFs themselves were valid multi-frame GIF89a files.

**B11. `left_click_drag` did not perform a real drag on the local fixture.**
Reproduction: on the fixture's HTML5 drag boxes and its range slider, call `computer left_click_drag`. The call reports the drag, `#dndout` stays empty and `#sliderval` stays at 0. The event log shows only `pointerdown HTML` and `click HTML` pairs, with no drop and no sustained movement (`A-local-site.md` scenario 10). A performed both correctly on the same fixture.
Counter-evidence: on `https://the-internet.herokuapp.com/drag_and_drop`, B's `left_click_drag` swapped the boxes correctly in 3 of 3 runs, and on jqueryui `/sortable` it reordered the list identically to A (`B-fixture-sites.md`). The failure is fixture-specific rather than general.

**B12. `resize_window` reports a viewport that never changes.**
Reproduction: call `resize_window` to 800x600, then read `page_state.viewport`. It stayed 1707x769 across both attempts (`A-local-site.md` scenario 20), and returned the identical `{"viewport":{"width":1707,"height":825}}` for two different requested sizes in `E-performance-resilience.md` section 2b.
Counter-evidence: in `F-gif-upload-tabs.md` section 4 a resize to 1000x700 did take effect, confirmed by `outerWidth:1001, outerHeight:700` read from the page. The `viewport` field B returns is the CSS layout viewport, which does not equal the requested outer window size, so the earlier scenarios were reading the wrong field. The defect is the reporting rather than the resize.

**B13. `find` needs a shorter query and `include_all: true` on large or deeply nested pages.**
Reproduction: on `https://the-internet.herokuapp.com/large`, `find "table cell containing 50.20"` returns `No elements matched ... among 2 searched` on a page with more than 9000 table cells. On `/tables`, `find "Due column header in table 1"` returns `among 18 searched`. A shorter query plus `include_all: true` found the target both times (`B-fixture-sites.md` bug 7). A's longer descriptive queries worked on both pages.
Related and not reproduced: `A-local-site.md` scenario 18 and `E-performance-resilience.md` section 16 report B's `find` returning only low-numbered buttons for `btn 2999` on `/big`. `R-repeat-performance.md` section 5 re-ran the equivalent query three times and the correct element was the top hit every time, so the single-run claim that B's find is unreliable there does not survive repeats. What does hold across every run is that B returns up to 20 hits and the ones below the top are noise.

### 5.3 Bugs both bridges share

**S1. A button inside an open shadow root cannot be activated by a synthetic click.**
Reproduction: on the fixture's Shadow DOM section, click the open-shadow button, by coordinate on A or by ref on B. On both bridges the event log shows `pointerdown open-host`, which proves the down-event landed inside the shadow tree, followed by `click SECTION`, an ancestor outside it. `#shadow-out` stays empty. Reproduced 3 or more times on A and twice on B (`A-local-site.md` scenario 6). This looks like Chrome or CDP retargeting behaviour rather than a defect in either bridge.

**S2. Google Docs content is invisible to every structural tool on both bridges.**
Reproduction: type into a Google Doc, then call `read_page`, `find`, or evaluate `document.body.innerText`. All three return only UI chrome and the ruler tick numbers on both bridges. A screenshot is the only verification path (`C4-google-notion.md` section 2c, 3 runs each). Docs renders on a canvas with no real text nodes, so this is the editor's design rather than a bridge defect.

**S3. Gmail's `j`, `k`, `Enter` and `u` shortcuts do not register on either bridge.**
Reproduction: on `#inbox`, press `j` then `Return`. Neither the URL nor the title changes on either bridge, verified with `tabs_context` and `page_state`. 3 of 3 runs on both (`C4-google-notion.md` bug 5).

**S4. Element refs are not stable across a fresh navigate on either bridge.**
Reproduction: read refs, navigate to the same URL, then reuse a ref. On both bridges a `find` or `read_page` immediately after `navigate` can return different ref numbers than a read before it, so refs captured before a batch's own `navigate` step cannot be reused later in that batch (`E-performance-resilience.md` closing list, `R-repeat-performance.md` section 7). B numbers refs from `ref_1` after every fresh navigation, and A's numbering drifts within a session (`A-local-site.md` scenario 23).

**S5. `document.title` reads stale on client-side-routed pages immediately after a click.**
Reproduction on A: click GitHub's Pull requests tab, then evaluate `document.title`. It returns the previous page's title while `location.href` already reflects `/pulls`. Reproduction on B: click a YouTube video result, then evaluate `document.title` in the same `quick` step. It returns `YouTube` while a DOM read of `ytd-channel-name` in the identical expression returns the new channel name (`C-real-sites.md` bug 9). Not a functional failure, and a trap for any caller using `document.title` as its only check that a navigation happened.

**S6. A native date input set through `form_input` does not survive form serialization.**
Reproduction: on `selenium.dev/selenium/web/web-form.html`, set the date field with `form_input`, which reports `{ok:true, value:"2026-01-15"}` on both bridges, then submit. The query string carries an empty `my-date=` on both (`B-fixture-sites.md` section 6). Identical on both bridges, so it is a property of assigning a string to a native date input rather than a bridge difference.

## 6. What a site can see

Source: `D-bot-detection.md`. No unautomated baseline exists for this browser, so every figure below is one bridge against the other rather than against a human session.

**The one decisive signal is CDP detection, and it catches B.** `deviceandbrowserinfo.com/are_you_a_bot` returned `isBot: true` on all three of B's runs, and in every case the only true flag in the JSON was `isAutomatedWithCDP: true`. Every other signal in that payload, including webdriver, Selenium markers, Playwright markers, headless Chrome markers and WebGL and client-hint consistency, was `false`. A's one run that completed returned `isBot: false` with `isAutomatedWithCDP: false`. The comparison is limited by A's own unreliability on that page: its verdict never populated on 2 of 3 runs, so A has one data point against B's three. `X-official-internals.md` part 1 section 14 records that A also issues `Runtime.enable` on every attached tab and never disables it, which is the classic CDP tripwire, so the difference is likely in how the detector probes rather than in whether A uses CDP.

**Vendors disagree about CDP.** browserscan.net has a section named for Chrome DevTools Protocol detection and reported Normal for B in the same session where deviceandbrowserinfo flagged it. CreepJS reported `chromium: true`, `25% like headless`, `0% headless`, `0% stealth` for both bridges and did not distinguish them.

**Visibility and window geometry are where A leaks.** On the local probe, A reported `document.visibilityState: hidden` at load and still `hidden` after a real, trusted, coordinate-driven click, while B reported `visible` throughout. `document.hasFocus()` started `false` on A and `true` on B. A tab firing events while reporting itself hidden is not a state a human-driven tab is ever in.

`window.outerWidth` and `outerHeight` read as `0` in scripts running at page load on A, on both bot.sannysoft.com (3 of 3 runs, in the raw `PHANTOM_WINDOW_HEIGHT` fields) and the local fixture. They self-correct to `1707` and `912` when re-read seconds later through `javascript_tool`. Any detector computing `outerHeight > innerHeight` in an inline script near the top of the page, a common headless heuristic, sees A come back negative. B reported correct values immediately on every run.

**Typing cadence differs in kind.** A's coordinate-driven `type` delivered 19 keydowns at 0 to 1.2 ms intervals, mostly 0.2 to 0.5 ms, which is not simulated typing at all. B's `perKey: true` ramps 23, 33 then 52 ms and settles into a very regular 62 to 64 ms band. B's magnitude is human-scale, and its low variance is itself a tell to a keystroke-dynamics classifier.

**Neither bridge produces a mouse path.** Both emit start and end mousemove samples with a straight jump between click targets, on every scenario tested. Both produce `isTrusted: true` clicks with correct `screenX` and `screenY` and `pointerType: "mouse"`.

**Challenge pages did not separate them.** Cloudflare's managed challenge passed automatically on nowsecure.nl and on `scrapingcourse.com/cloudflare-challenge`, 3 runs per bridge on each, with no checkbox shown and no CAPTCHA solved. Google reCAPTCHA v3 scored 0.9, the most human-like value, on all 3 of B's runs and on the 2 of A's runs where the loader initialized. Neither bridge triggered a CAPTCHA or an unusual-traffic interstitial on Google Search.

**What is identical.** `navigator.webdriver` is `false` on both. Canvas fingerprint, WebGL vendor and renderer, plugin list, userAgent and userAgentData are byte-identical between bridges on every site tested, which is expected, since both drive the same physical Chrome.

## 7. Caveats

**Version gap.** All findings describe chrome-mcp extension 0.1.7, the build loaded in the user's Chrome. The source tree was at 0.1.9 during the campaign, because another session was editing it. Any behaviour fixed between 0.1.7 and 0.1.9 still appears as a bug here. `X-official-internals.md` reads the current source tree, so its citations may point at code that did not run during the live tests.

**Concurrent edits.** The other session's edits to the source tree mean the static analysis in `X-official-internals.md` and the live behaviour in the other nine files are not guaranteed to describe the same build.

**Single-run items.** Everything listed as single-run in the method table is one observation rather than a rate. That covers every scenario in `B-fixture-sites.md` outside TodoMVC batching and `/drag_and_drop`, the GitHub, YouTube, Google and Amazon passes in `C-real-sites.md`, most of `E-performance-resilience.md` sections 10 to 20, the upload sub-cases and the tab create and close chain in `F-gif-upload-tabs.md`, and the structural scenarios flagged in `A-local-site.md`. Bugs A6 and A9 through A14, and B4 through B7 and B10, each rest on a single occurrence and say so in section 5.

**Wall-clock inflation.** Every timing includes the agent's own turnaround between tool calls, which is why 10 evaluations of `1+1` cost seconds rather than milliseconds on both bridges. The ratios are the finding. B's own `durationMs` figures, 1 to 4 ms for `1+1` and 4019 ms for a 4-second server delay, are the only server-side measurements available, and A reports no per-call duration at all.

**Agent budget.** Several groups traded depth for breadth and said so at the point of the reduction. `B-fixture-sites.md` skipped demoqa `/webtables`, jqueryui `/droppable`, `/datepicker` and `/selectmenu`, and `/exit_intent`. `C-real-sites.md`'s first pass did not reach Reddit, CNN, The Verge, x.com, LinkedIn, Gmail, Docs or Notion, which a later pass covered. `E-performance-resilience.md` ran most scenarios once and its sections 1 to 9 are superseded by `R-repeat-performance.md`.

**Ground rules that removed coverage.** No credentials, no sign-in, no CAPTCHA solving, no purchases, and nothing that changes the user's real accounts. That excluded `/basic_auth`, `/digest_auth` and `/login` on the-internet, `/context_menu` and `/javascript_alerts` (an unhandled modal freezes both extensions), and every write action on GitHub, LinkedIn, Gmail and Notion.

**Prior consent and login state.** The Chrome profile already carried a consent decision for theguardian.com and bbc.com, so the cookie-banner scenario could not be run as scoped and is marked untested rather than passing. old.reddit.com was login-walled for this account on both bridges. x.com was not authenticated in this profile despite the signed-in premise, so both bridges saw the logged-out interstitial. GitHub, LinkedIn, Gmail, Google Docs and Notion were fully signed in, and GitHub's notification count differed by 1 between the two reads because the inbox is live, not because the bridges disagreed.

**Things the agents said they could not determine.**

- No unautomated baseline exists for bot detection. Both bridges attach to the one real Chrome, so there is no way to load a probe page in it without going through one of them (`D-bot-detection.md` opening note).
- CreepJS's trust score renders as a canvas image the text extractor does not capture, so no numeric score was read on either bridge.
- `arh.antoinevastel.com/bots/areyouheadless` returned `502 Bad Gateway` for both bridges. `fingerprint.com/products/bot-detection` is a marketing page with no live verdict.
- The DevTools infobar cannot be seen in either bridge's screenshots, which capture the page viewport only, so whether it was displayed was not tested (`D-bot-detection.md` section 7).
- `F-gif-upload-tabs.md` section 5 could not test whether either bridge steals OS foreground focus, because Chrome was already the foreground window for the whole session and no other application was ever brought forward.
- `F-gif-upload-tabs.md` section 7 records that A's `tabs_context_mcp(createIfEmpty:true)` added a tab to the existing window rather than opening a new one, which contradicts the brief's framing that A opens its own window. `Get-Process chrome | Where-Object MainWindowTitle` counted 1 window before and after.
- `shortcuts_execute` is untested on both bridges, because neither had any saved shortcut on this machine.
- Whether Chrome objects to a specific frame or target in the `chrome-extension://` failure was not established live. `X-official-internals.md` part 1 section 3 answers it from the official extension's own recovery code.
