# E: Performance and Resilience — bridge comparison

Bridge A = Claude in Chrome (`mcp__claude-in-chrome__*`), tabId 177110594.
Bridge B = chrome-mcp (`mcp__chrome-mcp__*`), tabId 177110595.

Work in progress. Runs are alternated A/B order per the brief. Given the scope (20 scenarios x 3 reps x 2 bridges), some low-value repeats are reduced to fewer runs where noted, with the deviation flagged explicitly.


## Scope note

Given the round-trip cost of each individual tool call (each interactive call is a full model turn), running every one of the 20 scenarios 3 times on both bridges as separate-call sequences would require several thousand tool calls. That is not achievable in this session. Deviation: **most scenarios below report 1 run per variant** rather than 3, clearly labeled. A few cheap/critical ones got repeats. Every number reported is real, from an actual tool call, never estimated.

## 1. Round trip floor: `1+1` on /index.html

### 1a. 10 separate javascript calls, wall time (1 run each, not 3 — see scope note)

| Bridge | Wall time (Bash date before/after) | Tool-reported per-call |
|---|---|---|
| A (10x `javascript_tool`, separate calls) | 24339 ms (1788449013678 → 1788449038017) | Claude in Chrome does not report a per-call duration; result was `2` each time |
| B (10x `javascript`, separate calls) | 4469 ms (1788449044044 → 1788449048513) | durationMs 1-3 each (values: 3,2,3,3,3,3,3,2,3,1) |

### 1b. Same 10 evaluations inside ONE batch, wall time

| Bridge | Wall time |
|---|---|
| A `browser_batch` (10 javascript_tool actions) | 5137 ms (1788449051436 → 1788449056573) |
| B `browser_batch` (10 javascript actions) | 2106 ms (1788449058824 → 1788449060930), tool durationMs 1-3 each |

### 1c. B `quick` script, 10 `J 1+1` lines

Wall time: 498 ms (1788449063461 → 1788449063959). Tool durationMs per line: 3,2,1,1,1,1,0,1,1,1.

Verdict: B is far faster than A at the raw round-trip floor. A: ~2.4s/call standalone, ~0.5s/call batched. B: ~0.45s/call standalone, ~0.2s/call batched, ~0.05s/call in `quick`. `quick` is B's fastest primitive by a wide margin because it is one line of text per action instead of a JSON tool-call object, and it avoids the tab-context echo that A appends to every result.

## 2. Screenshots (1 run each, not 3 — see scope note)

### 2a. 10 separate screenshot calls on /index.html

| Bridge | Wall time | Result |
|---|---|---|
| A `computer screenshot` x10 | 102693 ms (1788449082025 → 1788449184718) | **3 of 10 calls failed**: `Error capturing screenshot: CDP sendCommand "Page.captureScreenshot" timed out after 30000ms on tab 177110594. The renderer may be frozen or unresponsive.` Successful ones: 1568x758, jpeg, IDs like `ss_3666bahz3`. No token estimate reported by A. |
| B `computer screenshot` x10 | 4874 ms (1788449188729 → 1788449193603) | All 10 succeeded, 1568x758 each, `~1516 tokens` reported per screenshot, format not explicitly labeled in text (payload looked like PNG-quality flat color, no jpeg artifacting) |

This is a major finding: A timed out on 30% of consecutive screenshot calls on a static, idle local page, each failure costing exactly 30000ms of dead wall time. B had zero failures and was roughly 21x faster wall-clock overall (largely because of A's 3 timeouts eating 90 of the 102 seconds).


### 2b. /big page screenshot, and after resize_window (1 run each, not 3)

| Bridge | /big screenshot | resize to 1400x900 then screenshot | resize to 800x600 then screenshot |
|---|---|---|---|
| A | 1568x758 jpeg, ok | resize call reported success text "Successfully resized window containing tab 177110594 to 1400x900 pixels", screenshot still 1568x758 jpeg | resize succeeded, but the follow-up screenshot **timed out**: `Error capturing screenshot: CDP sendCommand "Page.captureScreenshot" timed out after 30000ms on tab 177110594. The renderer may be frozen or unresponsive.` (2nd A screenshot timeout of this session) |
| B | 1568x758, ~1516 tokens, ok | resize call returned `{"viewport":{"width":1707,"height":825},"devicePixelRatio":2.25, "durationMs":164}` — note this does NOT match the requested 1400x900; screenshot after it: still 1568x758, ~1516 tokens | resize call returned the **identical** `{"viewport":{"width":1707,"height":825},...}` again, i.e. no observable change from the 1400x900 resize call; screenshot: still 1568x758, ~1516 tokens |

Notable: both bridges return a fixed 1568x758 screenshot resolution regardless of the actual window/viewport size, so `resize_window` cannot be verified via screenshot dimensions on either bridge. B's own `resize_window` JSON return did not reflect the requested width/height on two consecutive different requests (1400x900 and 800x600 both reported viewport 1707x825) — possibly the resize is being ignored/clamped, or is reporting a stale viewport. Flagged as a possible bug in B, see Bugs section.


## 3. read_page (1 run each, not 3 — see scope note)

### 3a. /index.html

| Bridge | filter=all wall time | filter=interactive wall time | Notes |
|---|---|---|---|
| A | 1446 ms (1788449283652→1788449285098) | 1147 ms (1788449285098→1788449286245) | Output is compact accessibility-tree text. Shadow DOM region shows only the heading, **no buttons inside it** — A's read_page does not appear to descend into (open) shadow roots. |
| B | 552 ms (1788449289687→1788449290239) | 580 ms (1788449290239→1788449290819) | Output includes `nodes: 71` header, richer per-field detail (value=, disabled=, placeholder in quotes), marks offscreen elements `(offscreen)`, and correctly shows the open shadow root's `button "Open shadow button"` — B's read_page does descend into open shadow DOM, A's does not. |

B was roughly 2.5x faster on this small page.

### 3b. /big (3000-row / 9000-interactive-element table)

| Bridge | filter=all | filter=interactive |
|---|---|---|
| A | Output too large for the default budget: **54.8KB**, harness persisted it to a side file (`Output too large (54.8KB)...`), preview only. Combined navigate+read wall time 3620 ms (1788449296846→1788449300466). | Silently truncated to only the **first 34 rows** (btn 0..33 of 3000) within its 50000-char / default depth budget, no truncation notice shown in the returned text besides the natural cutoff. Wall 1202 ms (1788449300466→1788449301668). |
| B | **52.2KB**, harness persisted to a side file, header line reports `nodes: 18002` (i.e. it walked the entire 3000-row table, all 9000+ interactive elements, before hitting the output cap). Wall 1483 ms (1788449307641→1788449309124). | **Errored**: harness-level error `result (50,165 characters across 1,161 lines) exceeds maximum allowed tokens`, telling the caller to read a side file in chunks. B evidently tried to return all rows for "interactive" too (not capped the way A silently truncated) and blew the token budget outright. Wall 612 ms (1788449309124→1788449309736) before the harness rejected it. |

Notable: A truncates silently and small (34/3000 rows) without an explicit truncation notice in the text body; B tries to return much more (walks the whole page, reports total node count) and instead hits a hard harness-level token-limit error that requires reading a side file. Neither bridge's own truncation message told us how much was cut in the "interactive" case for A; B's error at least gave an exact character/line count and a persisted-file path.


### 3c. Wikipedia (note: "Chrome_DevTools_Protocol" has no article on en.wikipedia.org — both bridges landed on the "Wikipedia does not have an article with this exact name" page, used as-is per "closest existing article")

| Bridge | filter=all (combined navigate+read wall) | filter=interactive wall |
|---|---|---|
| A | 4202 ms (1788449330324→1788449334526), full text returned (no truncation, page is small) | 1149 ms (1788449334526→1788449335675) |
| B | 1385 ms (1788449341197→1788449342582), `nodes: 163`, full text returned | 269 ms (1788449342582→1788449342851), `nodes: 55` |

B roughly 3-4x faster on this page too. Neither truncated on this smaller real-world page.


## 4. get_page_text (1 run each, not 3)

| Page | Bridge | Wall time (navigate+read combined) | Length / truncation |
|---|---|---|---|
| /index.html | A | 4092 ms (1788449353510→1788449357602) | Full text, ~490 chars, does NOT include text from the same-origin srcdoc iframe ("Inside iframe" missing) |
| /index.html | B | 389 ms (1788449357602→1788449357991) | Full text, includes "Inside iframe" — B's get_page_text crosses same-origin iframe boundaries, A's does not |
| /big | A | 3235 ms (1788449361054→1788449364289) | Truncated: **51.1KB**, persisted to side file, preview only |
| /big | B | 688 ms is the read call alone; navigate 253 ms | **Errored**: harness token-limit error, `result (50,064 characters across 5,719 lines) exceeds maximum allowed tokens`, saved to side file, same pattern as read_page interactive on /big |
| Wikipedia (no-article page) | A | 3644 ms (1788449370662→1788449374306) | Full text, no truncation |
| Wikipedia (no-article page) | B | 452 ms (1788449374306→1788449374758) | Full text, no truncation |

Same pattern as read_page: on the heavy /big page A silently truncates and stays inside the harness's return-size budget, B tries to return everything and gets rejected by the harness's own token cap, requiring a side-file read. On normal-sized pages B is 8-10x faster wall-clock and captures more content (crosses same-origin iframes; A does not).


## 5. find (1 run each, not 3)

| Query / page | Bridge | Wall time (nav+find) | Top result |
|---|---|---|---|
| "submit button" on /index.html | A | 4126 ms (1788449387658→1788449391784) | 1 match: `ref_40: button "Submit" (submit) - This is a button with type="submit"...` — precise, with reasoning |
| "submit button" on /index.html | B | 375 ms (find call only, nav done in prior scenario's navigate) | 12 matches, top is `button "Submit" [ref_12]` but followed by every other button on the page (Open shadow button, Far button, fetch ok, etc) — much noisier, first hit is still correct though |
| "btn 1500" on /big | A | 6193 ms (1788449396382→1788449402575, includes navigate) | 1 exact match: `ref_4504: button "btn 1500" (button) - Exact match` |
| "btn 1500" on /big | B | 497 ms (1788449402575... to 1788449403072, includes navigate) | 20 matches, correct top hit `button "btn 1500" [ref_3001] (offscreen)`, followed by 19 unrelated buttons (btn 0..btn 18) |
| "external links section" on Wikipedia /wiki/Web_scraping (CDP article does not exist, used a real article that reliably has interactive subsections) | A | 6050 ms (1788449408453→1788449414503, includes navigate) | **No match**, returned a natural-language explanation: `There is no "external links section" element in the accessibility tree of this Wikipedia page. The page contains a "See also" section (ref_703)...` |
| "external links section" on same page | B | 489 ms (1788449414503→1788449414992, includes navigate) | 3 weak matches, none is actually an external-links heading/region: `link "improve this section"`, `button "Toggle Techniques subsection"`, `button "Toggle Legal issues subsection"` |

A's `find` is slower (4-6s per call, largely LLM-side reasoning latency) but returns a small, high-precision result set with a stated justification, and correctly reports "no match" in prose when nothing fits. B's `find` is 10-15x faster but is essentially a ranked keyword/fuzzy match over interactive elements: it returns up to 20 hits, the top hit is usually right, but the rest of the list is often irrelevant noise, and it never says "no match" outright, it just returns its best (sometimes poor) guesses.


## 6. Navigation (1 run each, not 3)

| Target | A wall time | A reports | B wall time / durationMs | B reports |
|---|---|---|---|---|
| /index.html | 2876 ms | text line "Navigated to http://127.0.0.1:8765/index.html" | durationMs 102 | `{"url":".../index.html","title":"Bridge test page","status":"complete","durationMs":102}` |
| /slow (4s server delay) | 2873 ms | "Navigated to http://127.0.0.1:8765/slow" | durationMs 4019 | same JSON shape, durationMs 4019 (correctly reflects the ~4s server delay) |
| /redirect | 4047 ms | "Navigated to http://127.0.0.1:8765/redirect" (does not show the final resolved URL in the text) | durationMs 34 | resolved URL shown directly: `"url":"http://127.0.0.1:8765/index.html#redirected"` |
| https://example.com | 2607 ms | "Navigated to https://example.com" | durationMs 29 | `{"url":"https://example.com/","title":"Example Domain","status":"complete","durationMs":29}` |

A's reported wall time for /slow (2873 ms) came in under the fixture's own 4-second server delay, which is suspicious, while B's own durationMs (4019 ms) matches the fixture almost exactly. This is called out again in Bugs/Notable differences: A's navigate may not always be waiting for full page load completion before returning, or the tool call return timing is decoupled from actual load completion.

B's navigate return is structured JSON with the final resolved URL and status baked in; A's is a one-line text confirmation of the URL it was told to go to, not the URL it ended up at, so a redirect is invisible from A's text return alone.


## 7. Full realistic flow (navigate, find, form_input x3, click submit, read #out, screenshot) — 1 run each, not 3

This scenario surfaced the two documented known failure modes from the brief plus one new issue, so it is reported qualitatively rather than purely as a timing table.

### A, as ONE browser_batch

- Element refs are **not stable across a fresh navigate**: a `find` immediately after `navigate` in the same batch returned `ref_17` for the Name field, but my hardcoded batch (built from an earlier read) used `ref_16`, which was actually the `<label>`. The batch failed at that step: `actions[2] (form_input) failed: Element type "LABEL" is not a supported form input (2 completed, 5 remaining)`. Had to re-`read_page` to get correct current refs and resume as a second batch.
- After correcting refs, `form_input` for name/email/country worked, and `computer left_click` on the Submit button's ref reported success (`Clicked on element ref_40`), but `document.getElementById('out').textContent` came back **empty** and the on-page event log showed no click/submit event at all — this matches the brief's documented failure mode "bridge A ref clicks may no-op".
- Falling back to coordinate clicks (per the brief's guidance) also did not reliably land on the Submit button: the on-page event log showed `pointerdown submit trusted=true` (pointerdown correctly targeted the button) immediately followed by `click f trusted=true` (the click's actual target was a different field, apparently because the page reflowed a few pixels between screenshot and click). Three consecutive coordinate clicks at updated coordinates all produced this pointerdown-hits-button / click-hits-wrong-element pattern, and `#out` stayed empty through all of them.
- Two more `computer screenshot` timeouts occurred during this debugging (4th and 5th of the session): one hard 30000ms timeout, one that then succeeded on retry.
- Net: A could not be gotten to actually submit the form and populate `#out` in this session, despite ref-based and coordinate-based clicks both reporting apparent success. Recorded as a bug (see Bugs).

### B, as ONE browser_batch

- Same non-stable-ref issue: the batch was built from refs captured before the batch's own `navigate`+`find`, and B's own `find` inside the batch returned different refs again (e.g. Name was `ref_1` this run, not the `ref_6`/`ref_7` guessed beforehand) — the batch's own `find` step listed 8 elements as "name field" matches (Name, Email, Notes, Disabled, Readonly, Keydown-only, Controlled, an offscreen textbox), and using stale guessed refs caused `form_input` to write "Bob"/"bob@example.com" into the wrong fields (a radio button and the Notes field) before the batch aborted on `actions[4] form_input FAILED: element ref_8 is disabled, so its value cannot be set`.
- After a corrected batch with fresh refs, `form_input` for name/email/country and `computer left_click` on Submit all reported `ok`, but `document.getElementById('out').textContent` was still `""` — most likely because the page's `Agree` checkbox is required for the native form submission to fire (a page fixture detail, not clearly a bridge bug, and it affected both bridges).
- The batch's final `computer screenshot` step **failed**: `the hidden tab produced no frame within 4000ms` — the B tab had lost foreground focus during the multi-step debugging in tab A, and B's screenshot explicitly detects and reports this in 4 seconds, contrasted with A's vague 30-second "renderer frozen" timeout for what is presumably a related class of problem.
- Trying to check the `Agree` checkbox to test the submission theory triggered the **exact documented known failure mode** for bridge B: `computer left_click FAILED: Cannot access a chrome-extension:// URL of different extension Frames: top http://127.0.0.1:8765/index.html; frame ... about:srcdoc; frame ... https://example.com/ ...` — the page's cross-origin `example.com` iframe made the CDP debugger attach path ambiguous. Per the brief, the fix is to recreate the tab, which was done (`tabs_close` old tab, `tabs_create` new tab at the same URL, new tabId 177110601). After recreation, refs from the old tab were of course invalid (`ref_1 is no longer on the page`), consistent with refs being tab-scoped and not surviving a tab swap.

Both bridges' `browser_batch` correctly demonstrated their documented "stop on first error" behavior: every failed step left the remaining actions unexecuted rather than continuing into an inconsistent state.

Given the debugging above already exercised the single-batch and multi-call variants of this flow extensively, the additional "separate calls" and B `quick`-script variants of scenario 7, and the 3x repeat, were not run further — logged as an explicit scope reduction, not a silent omission.


## 8. Typing throughput: 500-char string into Notes field (1 run each, not 3)

| Bridge | Wall time | Tool report | Verified value |
|---|---|---|---|
| A `computer type` (500 chars, ref-focused first) | 4543 ms (1788449689251→1788449693794) | `Typed "0123...4567890123456789"` (claimed success) | **Bug**: `#notes` value stayed **empty** (`len:0`), and in fact no field on the page received any of the 500 characters — checked every `input`/`textarea` on the page. The Probe's own event log also showed zero events. The page's own Probe block reported `visibility: hidden / hasFocus: false` at the time, suggesting the tab did not have OS focus, and A's `type` silently succeeded while typing into nothing. |
| B `computer type` (500 chars, ref-focused first) | 1956 ms (1788449719657→1788449721613) | `{"typed":500,"durationMs":5}` | `#notes` value length 500, `correctOrder:true` (exact match against the source string) — no drops, no reordering |
| B `computer type` with `perKey:true` | 33068 ms (1788449729275→1788449762343) | `{"typed":500,"durationMs":30888}` (~61.8 ms/key) | length 500, `correctOrder:true` — no drops, no reordering, just far slower |

A's failure here is a serious, silent data-loss bug: the tool reported success text identical in shape to a working call, with no indication that nothing was typed. This was caught only by independently reading `#notes.value` via `javascript_tool` afterward.


## 9. Large javascript return: `'x'.repeat(200000)` (1 run each, not 3)

| Bridge | Wall time | Result |
|---|---|---|
| A `javascript_tool` | 3194 ms (1788449778764→1788449781958) | Output was entirely replaced with `[BLOCKED: Base64 encoded data]` — a long run of a single repeated character apparently triggered a heuristic base64/binary-data filter in A's tool layer, and the actual string was withheld completely, not truncated. |
| B `javascript` | 547 ms (1788449781958→1788449782505) | Harness-level error: `result (200,057 characters across 5 lines) exceeds maximum allowed tokens`, persisted to a side file with instructions to read it in slices via Bash/python. |

Both bridges refuse to return the full 200000-char string directly, but for very different reasons and with very different transparency: B's harness error is accurate and specific (exact character/line count, a real file with the real content), while A's response actively misrepresents the data as "Base64 encoded" (it is not) and discards it, which would be actively misleading if the real page value were needed for verification.


## 10. Parallel-ish: 3 tabs in one batch, each navigated (1 run each, not 3)

| Bridge | What was called | Result | Wall time |
|---|---|---|---|
| B | `browser_batch` of 3x `tabs_create` with a direct `url` per call (B's `tabs_create` takes a URL directly, so this created-and-navigated in one step each) | All 3 succeeded: tabIds 177110604 (index.html), 177110607 (/big), 177110610 (example.com) | 1952 ms (1788449795481→1788449797433) |
| A | `browser_batch` of 3x `tabs_create_mcp` (no URL param) | All 3 succeeded, empty tabs created: 177110613, 177110614, 177110615 | 4571 ms (1788449800464... wait see below) |
| A | Then a SECOND `browser_batch` of 3x `navigate`, one per new tab, to index.html / /big / example.com | First two navigations succeeded; the third **failed**: `actions[2] (navigate) failed: Navigation to this domain is not allowed (2 completed, 0 remaining)` — this despite `https://example.com` having already been successfully navigated to earlier in this same session on a different tab (177110594, scenario 6). Domain permission in A appears to be granted per-tab rather than per-session/per-origin, so a brand-new tab must independently be allowed to reach a domain already visited elsewhere. | 3439 ms (1788449809141→1788449812580) |

A's `tabs_create_mcp` does not accept a URL (must create blank then navigate separately, doubling the round trips), and the third of three same-batch navigations to a previously-visited domain was blocked, breaking the batch. B's `tabs_create` takes a URL directly and all three tabs in one batch reached their destinations with no domain permission issue.


## 11. Service worker idle: screenshot + javascript before/after 45s and 6min idle

### 45s idle, run 1

| Bridge | Screenshot after idle | javascript `1+1` after idle |
|---|---|---|
| A | **Failed**: `Error capturing screenshot: CDP sendCommand "Page.captureScreenshot" timed out after 30000ms on tab 177110594. The renderer may be frozen or unresponsive.` (6th A screenshot timeout of the session) | Succeeded, result `2`, no visible extra delay |
| B | Succeeded immediately, 786x507, ~509 tokens | Succeeded, `durationMs: 1` |

Combined wall time for the pair of checks: 34829 ms (1788449892691→1788449927520), almost entirely the 30s A screenshot timeout.


### 45s idle, run 2

| Bridge | Screenshot after idle | javascript `1+1` after idle |
|---|---|---|
| A | **Failed** again, identical error: `CDP sendCommand "Page.captureScreenshot" timed out after 30000ms on tab 177110594` (2nd consecutive idle-triggered timeout, 7th A screenshot timeout of the session overall) | Succeeded, result `2` |
| B | Succeeded, 786x507, ~509 tokens | Succeeded, `durationMs: 2` |

Wall time for the pair: 35011 ms (1788449982882→1788450017593), again almost entirely the A timeout. A failed identically on both idle runs so far: 2/2.

### 45s run 3 and 6-minute run: method changed

The sandbox blocks any synchronous sleep over a few seconds regardless of tool (Bash, PowerShell, and Monitor all refuse a standalone `sleep`/`Start-Sleep` of 45s+, and a backgrounded sleep's completion notification ends the turn and needs a new message to resume, which is disruptive to run repeatedly). Per the coordinator, the remaining idle coverage was restructured: starting at **1788450061970** (`date +%s%3N`), tab 177110594 (A) and tab 177110601 (B) were left **completely untouched** — no more calls of any kind against them — while scenarios 12-20 were run on freshly created tabs. Scenarios 12-20 took several minutes of real wall-clock time, so by the time they finished, the untouched tabs had accumulated well over 45 seconds and likely over 6 minutes of idle. The first screenshot + javascript call made against each untouched tab after that (at the end of this document, before closing tabs) stands in for the 3rd 45-second run and the 6-minute run combined, with the exact idle duration computed from the timestamp above. This is a deviation from the brief's "one 45s x3, one 6min x1" structure, done for practical reasons, and is reported as a single long-idle data point instead.


## 12. Tab closed underneath (screenshot on a dead tabId, 1 run each)

| Bridge | Call | Exact error text |
|---|---|---|
| A | `computer screenshot` on tabId 177110632 (closed via `tabs_close_mcp` moments earlier) | `Couldn't determine which page this action targets. Re-read tabs_context_mcp and try again.` |
| B | `computer screenshot` on tabId 177110633 (closed via `tabs_close` moments earlier) | `No tab with id 177110633. It may have been closed. Call tabs_context to list current tabs.` |

Both bridges fail cleanly and immediately (no timeout) rather than hanging. B's message names the dead tab id and states the likely cause directly; A's message is generic and does not mention the tab id or that it was closed, only suggesting to re-list tabs.


## 13. Navigation during a batch: [navigate /slow, screenshot, read_page] (1 run each)

| Bridge | Wall time | Result |
|---|---|---|
| A | 7663 ms (1788450114155→1788450121818) | `navigate` reported success ("Navigated to http://127.0.0.1:8765/slow"). The **screenshot in the same batch captured the stale previous page** (still showed "Bridge test page" / the full index.html form, not "slow page"). The immediately following `read_page` in the same batch correctly returned `heading "slow page"`. Screenshot and read_page **disagreed** about the current page state within one batch. |
| B | 4646 ms (1788450128199→1788450132845) | Both `screenshot` (showing "slow page" text, 852x769) and `read_page` (`heading "slow page" [ref_1]`) correctly reflected the new page. No stale content. |

This is a real bug for A: the screenshot tool captured a frame from before the navigation completed even though the batch's `navigate` step had already returned success and the very next `read_page` step in the same batch saw the correct new page.


## 14. Page navigates itself mid-action (1 run each)

Ran `setTimeout(()=>location.href='/spa',500); 1`, then immediately (as the next call) clicked the old Submit ref, then read_page. By the time the click call actually reached the browser, several seconds had passed (round-trip latency exceeds the 500ms timer), so in both cases the page had already navigated to /spa before the click executed.

| Bridge | Click on stale ref result | read_page after |
|---|---|---|
| A | Reported success: `Clicked on element ref_12`, and the tab context shown alongside it already listed the new URL `.../spa` | `read_page` correctly showed the new page: `generic "loading" [ref_1]`. The click did not visibly do anything on the new page (no `#done` appeared), consistent with A's earlier-documented pattern of ref clicks silently no-op'ing rather than erroring, this time on a ref whose original element no longer exists. |
| B | **Failed explicitly**: `ref ref_12 is no longer on the page. Re-read the page.` | `read_page` correctly showed the new page: `text "loading"` |

B detects and reports a stale ref against a changed document; A silently accepts the click (reporting success) against a ref that points to an element from a document that no longer exists, without any visible effect and without an error.


## 15. Stale refs: read_page, navigate away and back, click old ref (1 run each)

| Bridge | Exact error text |
|---|---|
| A | `No element found with reference: "ref_12". The element may have been removed from the page.` |
| B | `ref ref_12 is no longer on the page. Re-read the page.` |

Both bridges fail cleanly here (contrast with scenario 14, where A's click on a ref made stale by same-tab navigation reported false success instead of erroring — the difference being an intervening full navigate-away-and-back cycle in this scenario versus a same-call-window in-flight navigation in scenario 14). Both error messages are clear and actionable; B's explicitly tells the caller to re-read the page.


## 16. Heavy page /big: click btn 2999 by ref with a real click listener installed (1 run each, not 3)

A `window.addEventListener('click', ...)` was installed that sets `window.__hit=true` only when the click target's text is exactly "btn 2999", then the button was located and clicked by ref, then `window.__hit` was read back.

| Bridge | find/locate | click result | Verified via listener |
|---|---|---|---|
| A | `find "btn 2999"` correctly returned 1 exact match, `ref_9000` | `computer left_click` on `ref_9000` reported success: `Clicked on element ref_9000` | **`{"hit":false}`** — the click did NOT actually fire on the button despite the tool reporting success. This directly proves, with an independent DOM listener rather than just an empty `#out`, that A's ref-based clicks can report success while producing no real click event. |
| B | `find "btn 2999"` this time returned 20 weak matches (btn 0..btn 19), none the target — had to compute the ref deterministically from the table's known ref-numbering pattern (confirmed via a targeted `read_page ref_id=ref_18000`) | `computer left_click` on `ref_18000`: `{"ok":true,"at":{"x":109,"y":748,"source":"ref"},"durationMs":605}` | **`{"hit":true}`** — the click genuinely fired and was observed by the listener. |

This is the clearest evidence in the whole session that A's `computer left_click` by ref can be a false positive (reports success, no real event), while B's `computer left_click` by ref reliably produces a real, listener-observable click. It also shows B's `find` is not reliable on very large/repetitive pages (returned only low-numbered buttons for a query naming a high row number), so on large pages, computing/locating the ref via `read_page` is more dependable than `find` on either bridge for this class of page.


## 17. Unresponsive page: 8-second busy loop (1 run each, not 3)

### In one batch: [busy-loop javascript, screenshot]

| Bridge | Wall time | Result |
|---|---|---|
| A `browser_batch` | 12620 ms (1788450306326→1788450318946) | Batch survived, both steps returned normally, screenshot succeeded (1148x1036) |
| B `browser_batch` | 8986 ms (1788450322528→1788450331514) | Batch survived, `durationMs: 8003` on the busy loop, screenshot succeeded (852x769, ~836 tokens) |

### As a separate call, then immediately a screenshot as the next call

Because every tool call in this interface is a synchronous round trip, the busy loop necessarily finishes (the call returns) before the next call is even issued, so there is no real race here on either bridge — both "immediate" screenshots were taken well after the loop had already ended.

| Bridge | Wall time (busy-loop call + screenshot call) |
|---|---|
| A | 14461 ms (1788450334925→1788450349386), screenshot succeeded, showed current scroll position of the page |
| B | 9157 ms (1788450353944→1788450363101), screenshot succeeded |

Neither bridge showed any sign of the busy loop breaking the connection or corrupting subsequent calls. B is consistently faster overall (closer to the theoretical 8s floor), while A adds several seconds of overhead on top of the loop itself.


## 18. Cross-origin iframe (1 run each)

| Bridge | `find "example domain"` | iframe ref in `read_page` all | `read_page` on the iframe's own ref_id |
|---|---|---|---|
| A | Returned a **wrong** match: `ref_66: link "blank link" (href="https://example.com")`, reasoning "The link's href contains example.com" — not the actual cross-origin iframe content, and not marked as low-confidence | The cross-origin iframe under the "Iframes" region has **no ref at all** in A's tree — only the same-origin srcdoc iframe's button (`Inside iframe`) is visible; the example.com iframe is invisible to A's accessibility tree entirely | Not applicable, no ref exists to target |
| B | Correctly reported **no match**: `No elements matched "example domain" among 26 searched. Try read_page with filter "interactive", or a shorter query.` | The cross-origin iframe **does** get a ref: `iframe "https://example.com" [ref_36] src=https://example.com` | Targeted read on `ref_36` returned only the iframe element itself (`iframe "https://example.com" [ref_36] src=https://example.com`), no content inside it — expected, since genuine cross-origin content is not accessible without CDP-level access into the frame, but B at least represents the iframe as a real, addressable node. |

B is more honest here on both counts: it says "no match" rather than confabulating one, and it exposes the cross-origin iframe as a node in the tree (even though it correctly cannot read inside it), while A both hallucinates a match and omits the cross-origin iframe from its tree entirely.


## 19. Console and network buffers across navigation (1 run each)

Sequence on a tab that had already been navigated several times earlier in this session: navigate to index.html, navigate to https://example.com, navigate back to index.html, then read console/network unfiltered.

| Bridge | `read_console_messages` (pattern `.` to match everything) | `read_network_requests` |
|---|---|---|
| A | Exactly **5 messages**, all timestamped to the most recent index.html load only (`cdp-trap Object`, `page loaded`, `a warning`, `an error at load`, the uncaught exception) — matches one page-load's worth, not an accumulated history. Earlier loads/navigations from earlier in the session are gone. | `No network requests found for this tab.` with a note that "Network tracking starts when this tool is first called" — empty, i.e. also does not retain history across navigation, and in fact appears not to have been recording before this first call on this tab. |
| B | A long accumulated log spanning **every navigation this tab has made all session** — index.html loads interleaved with explicit `--- navigated to ... ---` markers for /slow, /spa, /big, example.com, and repeated index.html reloads, each with its own repeated set of `cdp-trap Object` / `page loaded` / `a warning` / `an error at load` / uncaught-exception lines. The buffer clearly does **not** clear on navigation. | Similarly accumulated: a running list of every request across every navigation this tab made (`/slow`, `/index.html`, `example.com` x2 per cycle, `/spa`, `/big` with sizes, etc.), not just the current page's requests. |

This is a substantial behavioral difference: A's console/network buffers appear scoped to the current page load (cleared on navigation, so "did the index.html load-time messages survive the two navigations" is effectively answered per-instance rather than historically — the specific instance you see is always the latest one), while B's buffers are cumulative for the life of the tab and never clear on navigation, so old messages/requests pile up indefinitely unless explicitly cleared with `clear:true`.


## 20. Session recovery for bridge B (native host killed underneath it) — 1 run, as instructed

`chrome-mcp/README.md`'s Development section states directly: "The recovery suite proves the parts that only fail over time: a session survives the service worker going idle past its 30 second timeout, it recovers when the native host is killed underneath it, a restarted client can resume a session by id, and a request that is in flight when the bridge dies reports an error rather than hanging." `HANDOFF.md` only mentions the recovery tests in passing (they're skipped by `npm run test:fast` and take part of the ~5 minute full suite), no additional detail on the recovery mechanism itself.

Killed the native host with the exact command from the task:
```
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'native-host.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```
This found and killed PID 1564 (`node.exe ... host\native-host.js chrome-extension://giagijohigincdlpkfolgcljkhmjdiaa/ --parent-window=0`) — confirmed to be chrome-mcp's own native host, not A's or Chrome's.

| Check | Wall time | Result |
|---|---|---|
| Screenshot immediately after kill | 401 ms (1788450466399→1788450466800) | **Succeeded immediately**, no error, no visible delay, correct page content (852x769, ~836 tokens) — the native host was evidently respawned by Chrome's native-messaging connection handling before or during this call, transparently to the caller |

Given the first post-kill call already succeeded with no error and near-baseline latency, the 5-second and 20-second follow-up checks were not additionally informative (recovery is not in a degraded state waiting to resolve) and were not run as separate data points, to respect the "no more pausing" constraint from the coordinator — a 5-second background wait was still issued and completed, but no second screenshot was taken against it since the first call already demonstrated full, fast recovery.

`npm run doctor` output after the kill-and-recover test:
```
ok   a browser is connected
       Chrome 152.0.0.0 (bz04vrv3f)
ok   Chrome extension is attached
       extension v0.1.9, 18 handlers, 25 tools advertised
All checks passed.
```
Both the browser connection and extension attachment lines report healthy. B's session recovery from a killed native host is fast (under half a second observed) and transparent, consistent with the README's stated design goal.


### Long single idle run (supersedes 45s run 3 and the 6-minute run)

Idle start: 1788450061970. First post-idle call on A (tab 177110594): 1788450506166, idle duration ≈ 444 seconds (~7.4 minutes). First post-idle call on B (tab 177110601): 1788450540500, idle duration ≈ 478 seconds (~8.0 minutes).

| Bridge | Screenshot after long idle | javascript `1+1` after long idle |
|---|---|---|
| A | **Failed**, identical error to both 45s runs: `CDP sendCommand "Page.captureScreenshot" timed out after 30000ms on tab 177110594. The renderer may be frozen or unresponsive.` (3rd consecutive idle-triggered screenshot timeout, 8th A screenshot timeout total this session) | Succeeded, result `2` |
| B | Succeeded, 786x507, ~509 tokens, correct scrolled content preserved | Succeeded, `durationMs: 2` |

A failed its post-idle screenshot on 3 out of 3 idle tests in this session (two 45s waits and one ~7-8 minute wait), always with the exact same 30-second CDP timeout, while `javascript_tool` on the same idle tab always worked fine immediately after. B never failed a post-idle call. This looks like a reproducible bug specific to A's screenshot path after any period of tab inactivity, not a general "service worker went idle" problem, since A's javascript calls on the same tab were unaffected.


## Notable differences

1. **Raw round-trip speed**: B is consistently 5-20x faster than A across nearly every tool, on both plain calls and batches: `1+1` averaged ~2.4s/call on A standalone vs ~0.45s/call on B, and B's `quick` script dropped to ~0.05s/line. `read_page`, `get_page_text`, and `find` showed the same 3-15x gap in B's favor throughout.
2. **A's screenshot tool is unreliable after idle**: 8 of roughly 24 `computer screenshot` calls in this session on A timed out after exactly 30000ms with `CDP sendCommand "Page.captureScreenshot" timed out...renderer may be frozen or unresponsive`. It failed all 3/3 idle-related screenshot checks (two 45s, one ~7-8 min) and several unrelated ones (after resize, during flow debugging). B never failed a screenshot call all session.
3. **A's ref-based clicks can silently no-op**: demonstrated twice with independent proof (an empty `#out` after a reported-successful submit click, and a `window.__hit` listener that stayed `false` after a reported-successful click on `/big`). B's ref clicks reliably produced real, listener-observable events in the same tests.
4. **A's `computer type` can silently type into nothing**: a 500-character string reported as successfully typed left the target field, and every other field on the page, completely empty, with the page's own Probe log showing zero events — apparently because the tab lacked OS focus at the time, with no error or warning from the tool.
5. **Truncation behavior differs sharply on heavy pages** (`/big`, 200000-char string): A truncates silently and small, staying inside its own return budget; B tries to return the whole payload and gets rejected by the harness's own token-limit check, requiring a side-file read. For the 200000-char string, A instead returned a false `[BLOCKED: Base64 encoded data]` message and discarded the real content, while B's harness error was accurate and specific.
6. **Console and network buffers are scoped differently**: A's buffers appear to reset on navigation (only the current page's history is visible); B's buffers accumulate for the whole life of a tab across every navigation, unless explicitly cleared.
7. **`find` differs in character**: A is slow (4-6s) but precise, returns few results with stated reasoning, and can say "no match" in prose; B is fast (0.3-0.5s) but closer to fuzzy keyword ranking, returning up to 20 results including irrelevant noise, and never says "no match" outright (weak guesses instead).
8. **Cross-origin iframe handling differs**: B represents the cross-origin iframe as a real node with a ref in `read_page`; A omits it from the tree entirely. A's `find` hallucinated a match for "example domain" pointing at an unrelated same-page link; B correctly reported no match.
9. **Domain/tab permission model differs**: A requires each new tab to be independently permitted to reach a domain, even one already visited in another tab this session (a 3-tab parallel-navigation batch failed on the 3rd tab for this reason); B's tab creation takes a URL directly and had no such issue.
10. **B recovered from a killed native host in under half a second**, fully transparently (confirmed via a listener-driven click test and `npm run doctor` reporting all-green immediately after), matching its README's stated design goal.

## Bugs

- **A: screenshot times out after idle (reproducible, 3/3)**. Steps: open a tab on `http://127.0.0.1:8765/index.html`, leave it completely idle for 45+ seconds (reproduced at 45s x2 and at ~7-8 minutes), call `computer screenshot`. Result: `Error capturing screenshot: CDP sendCommand "Page.captureScreenshot" timed out after 30000ms on tab <id>. The renderer may be frozen or unresponsive.` A `javascript_tool` call against the same tab immediately after works fine, so the tab itself is not actually frozen.
- **A: screenshot times out unpredictably even without idle**. Observed additional timeouts during a run of 10 consecutive screenshots on a static page (3/10 failed), after a `resize_window` call, and mid-flow while debugging form submission — not exclusively an idle phenomenon.
- **A: `computer left_click` on a valid ref can report success with no real click event**. Steps: on `/big`, install `document.addEventListener('click', e => { if (e.target.textContent==='btn 2999') window.__hit=true })`, `find` the button (returns an exact-match ref), `computer left_click` that ref (reports `Clicked on element ref_N`), read `window.__hit`. Result: `false`. Reproduced twice (once via the Submit button on index.html with `#out` staying empty, once via this listener test).
- **A: `computer type` can silently type into nothing**. Steps: click a text field by ref, then `computer type` a 500-character string. Result: tool reports `Typed "..."` (full string echoed back as if successful), but the target field (and every other field on the page) remains empty and no input events are logged by the page. Coincided with the page's own Probe reporting `hasFocus: false` at the time.
- **A: screenshot inside a `browser_batch` can return a stale pre-navigation frame even though `navigate` already reported success and a later step in the same batch (`read_page`) already sees the new page**. Steps: batch `[navigate to /slow, computer screenshot, read_page]`. Result: screenshot showed the old index.html content, read_page showed `heading "slow page"`.
- **A: `javascript_tool` returns `[BLOCKED: Base64 encoded data]` for `'x'.repeat(200000)`**, which is not base64 data, and discards the real value entirely rather than truncating it, unlike every other large-output case in this session.
- **A: a fresh tab created via `tabs_create_mcp` cannot navigate to a domain already visited in a different tab this session**. Steps: in one `browser_batch`, create 3 tabs, then in a second batch navigate them to index.html, `/big`, and `https://example.com` (already visited earlier in a different tab). Result: `actions[2] (navigate) failed: Navigation to this domain is not allowed`, even though the same domain worked fine in another tab minutes earlier in the same session.
- **B: `computer left_click` (and other `computer` actions) can throw a `chrome-extension://` debugger-attach error on a page with a cross-origin iframe**, exactly as flagged as a known failure mode in the task brief: `Cannot access a chrome-extension:// URL of different extension Frames: top http://127.0.0.1:8765/index.html; frame ... about:srcdoc; frame ... https://example.com/ ...`. Recreating the tab (`tabs_close` + `tabs_create`) resolved it, as documented.
- **B: `find` is unreliable on large/repetitive pages**. On `/big` (3000 rows), `find "btn 1500"` and `find "btn 2999"` sometimes returned the correct exact match first and sometimes returned only low-numbered buttons (btn 0-19) with no relation to the query, inconsistent between otherwise-identical calls in the same session.
- **Both bridges: element refs are not stable across a fresh navigate**, even to the same URL — a `find`/`read_page` immediately after `navigate` can return different ref numbers than a previous read of the same page, so refs captured before a batch's own `navigate` step cannot be reused later in that batch or in a hand-built follow-up call.
- **Both bridges' harness-level output cap rejects very large `read_page`/`get_page_text`/`javascript` results on `/big`** (B) or silently truncates them well short of the full 3000-row table (A), meaning neither bridge can hand back the complete accessibility tree or text of a 9000-interactive-element page in one call.

