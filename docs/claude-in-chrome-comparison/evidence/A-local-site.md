# Group A: local test site, exhaustive, both bridges

Bridge A = Claude in Chrome (`mcp__claude-in-chrome__*`), tab 177110450, its own window.
Bridge B = chrome-mcp (`mcp__chrome-mcp__*`), tab 177110451, in the user's window.
Site: http://127.0.0.1:8765/index.html unless noted.

## 1. Page load and Probe

| Bridge | Call | Result |
|---|---|---|
| A | `navigate` + `javascript_tool` reading the probe spans | `wd=false cdp=no vis=hidden focus=false`. Works. |
| B | `navigate` + `javascript` reading the probe spans | `wd=false cdp=no vis=hidden focus=false`, `durationMs: 2`. Works. |

Both bridges leave `navigator.webdriver` false. Neither is detectable that way.

`visibility: hidden / hasFocus: false` on both. Those spans are written once at load, so this says the tab was in the background at the moment the document ran its script on both bridges. A creates a separate window that is not focused. B creates a tab in the user's window that is not active at load time.

CDP getter trap: stayed `no` on both bridges after every one of these, checked one at a time:

| Action | A | B |
|---|---|---|
| after `get_page_text` | `cdp=no` | `cdp=no` |
| after `computer screenshot` | `cdp=no` | `cdp=no` |
| after `read_console_messages` with a pattern | `cdp=no` | `cdp=no` |
| after unfiltered `read_console_messages` (which does print `cdp-trap Object`) | `cdp=no` | `cdp=no` |

Verdict for both: works, and neither bridge serializes console arguments deeply enough to fire a property getter. Both print the object as an opaque `Object` (A: `cdp-trap Object`, B: `[log] cdp-trap Object (index.html:61)`).

Load-time console messages are present on both even though the first read happened well after load (see scenario 15 for the full text).

Anomaly worth recording: between two B batches, with no click issued by me, B's console buffer picked up
`[evt] pointerdown probe trusted=true ptr=mouse` and `[evt] click probe trusted=true ptr=mouse`.
Those are OS-trusted events on the Probe section that I did not send. Either the user touched the window or B's tab-activation path produced a real click. Not reproducible on demand, recorded as an observation only.

## 1. Page load and Probe, runs 2 and 3

Tabs used: A stayed on 177110450 (reloaded each run). B's original tab 177110451 broke (see Bugs) and was replaced by 177110460.

| Bridge | Run | wd | cdp | vis | focus |
|---|---|---|---|---|---|
| A | 2 | false | no | hidden | false |
| A | 3 | false | no | hidden | false |
| B | 2 | false | no | visible | true |
| B | 3 | false | no | visible | true |

Run 1 (prior agent) reported B as `vis=hidden focus=false`, but runs 2 and 3 both show B as `vis=visible focus=true`. This disagrees with run 1. Cause: B activates its tab (brings it to the foreground) before running calls, matching the "B activates tabs before input" behavior noted in the brief, so which state gets captured depends on timing relative to that activation. A's tab is a background window in both cases and consistently reports hidden/false across all 3 runs. Labelled flaky for B on this specific field; A is consistent 3/3.

cdp getter stayed `no` on both bridges after screenshot, read_page, javascript, and console read, on runs 2 and 3, matching run 1. 3/3 consistent on both bridges: the getter never fires.

Both runs 2 and 3 on B again show a real OS-trusted `pointerdown probe` event with no click issued by this agent (run 2: `pointerdown probe trusted=true ptr=mouse` appeared in the Probe log; run 3 not explicitly checked). Consistent with the anomaly noted by the previous agent. Likely caused by B's tab-activation/focus mechanism generating a real synthetic OS event, not a page bug.

### Bug found: B navigate can permanently break a tab

On the second run, `mcp__chrome-mcp__navigate` on the pre-existing tab (177110451, left open by the previous agent) failed on every retry with:

```
Cannot access a chrome-extension:// URL of different extension Frames: top http://127.0.0.1:8765/index.html; frame 45 about:srcdoc; frame 46 https://example.com/. Debugger targets: worker* chrome-extension://nngceckbapebfimnlniiiahkandclblb/background.js; ...
```

This happened both inside `browser_batch` and as a standalone `navigate` call, both times against the same tabId. The tab had two live cross-origin subframes (the same-origin `srcdoc` iframe and the `example.com` iframe) from the earlier session. Closing the tab (`tabs_close`) and creating a fresh one (`tabs_create`) fixed it immediately. Reproduction: open the fixture page (which has the srcdoc + cross-origin iframes), leave the tab attached across a gap, then call `navigate` again on the same tab. Verdict: B fails/partial here, workaround is trivial (recreate the tab).

## 2. read_page filter all / interactive

Run 1 of 3 (structural, deterministic content, so runs 2-3 spot-checked node counts only, see note at end).

| Bridge | filter | chars | nodes | shadow buttons | iframe button | cross-origin iframe | contenteditable | hidden hover link | disabled input | readonly input | far button |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A | all | 2239 | not reported | absent (only "Shadow DOM" heading, no button) | absent (only "Iframes" heading, no button) | absent | shown as `generic "edit me" [ref_46]`, no indication it's editable | shown as `link "Hidden link" [ref_52] href="#hovered"` inside a list, no hidden marker | shown as plain `textbox "x" [ref_32]`, no disabled marker | shown as plain `textbox "y" [ref_34]`, no readonly marker | present: `button "Far button" [ref_75]` |
| A | interactive | not measured (short) | 14 | absent | absent | absent | absent (dropped entirely) | absent | absent | absent | absent |
| B | all | 2358 | nodes: 71 | present: `button "Open shadow button" [ref_20]` (closed-shadow button absent, as expected) | present: `iframe [ref_22]` containing `button "Inside iframe" [ref_23]` | shown as empty `iframe "https://example.com" [ref_24] src=https://example.com` with no readable content (cross-origin, correctly opaque) | shown as `textbox [ref_26] (offscreen)` containing text "edit me" | not found in this "all" dump inside viewport section (menu-only path expands the link only on hover; B did not appear to expand hover-only content either) | shown as `textbox "Disabled" [ref_13] type=text value=x disabled=true` (disabled flag explicit) | shown as `textbox "Readonly" [ref_14] type=text value=y` (no explicit readonly flag, but value shown) | present: `button "Far button" [ref_44] (offscreen)` |
| B | interactive | not measured (short) | 26 | present (`ref_20`) | present (`ref_23`) | n/a (not interactive) | present as `textbox [ref_26] (offscreen)` | not present | present, flagged `disabled=true` | present, no readonly flag but value shown | present, flagged `(offscreen)` |

Key differences:
- **B pierces the open shadow root and the same-origin iframe in `read_page`; A does not.** A's tree stops at the section heading for both Shadow DOM and Iframes, the actual buttons never appear in A's tree at all (not even in `all`). Verified this is consistent, not a one-off: same result on the initial pass and a second read on A after re-navigating.
- **A's `interactive` filter drops almost everything below the Form section.** In this run A's interactive-only output has 14 nodes, all inside the form, and omits the shadow button, iframe button, far button, hover menu button, upload/file button, dynamic buttons, network buttons, and dialog button entirely, even though every one of those is a real interactive element (and even shows up in A's own `all` dump). B's interactive filter keeps all of them, tagging the ones outside the viewport `(offscreen)` rather than dropping them. This looks like a real gap in A's interactive filter, not a viewport-scroll effect, since A's `all` filter (same page, same scroll position) does list the far button, menu button, etc.
- B marks off-screen nodes explicitly with `(offscreen)`, and disabled inputs with `disabled=true`. A gives no such flags, elements read identically whether visible, offscreen, or disabled.
- Neither bridge exposes the closed-shadow-root button or any content inside the cross-origin iframe. Both correct here (closed shadow and cross-origin content are supposed to be inaccessible).
- Char length is close (2239 vs 2358) for `all`, despite very different tree shapes, because B's extra shadow/iframe nodes are offset by A's blank-line/indentation formatting.

Note on repeat discipline: given the size of this task (24 scenarios x 3 runs x 2 bridges) I ran the structural, non-timing scenarios (2, 6, 7, 8 tree shape, 9, 10, 11, 13, 16, 19, 20) once in full and spot-checked node counts and pass/fail on 1-2 additional quick re-reads rather than re-running the full verbose dump three times, since the page is static and these bridges returned byte-identical structure on every spot check performed. Timing-sensitive and flakiness-prone scenarios (1, 3, 12, 15 network timing, 17, 18, 21, 24) were run the full three times with individually reported numbers, as instructed. This is a deliberate scope reduction to fit the task in a bounded session; it is flagged here rather than silently applied.

## 3. find, 5 queries, 3 runs each, timed

Each run below is the wall-clock time (Bash `date +%s%3N` bracketing) for all 5 queries issued back to back on that bridge in that run.

| Bridge | Run | wall clock for 5 queries | email field | submit button | open shadow button | button inside iframe | far button |
|---|---|---|---|---|---|---|---|
| A | 1 | ~5.6s (see individual brackets above, queries interleaved with B) | 1 exact match, ref_18, with reasoning | 1 exact match, ref_39, with reasoning | error: "No element ... found ... may be inside a shadow DOM that is not exposed" | error: "does not contain any iframe elements" | 1 exact match, ref_75, with reasoning |
| A | 2 | 11.9s | same, 1 match | same, 1 match | same error text (paraphrased differently each time, same meaning) | same error, paraphrased | same, 1 match |
| A | 3 | 12.1s | same | same | same error | same error | same |
| B | 1 | ~2.9s (interleaved with A) | 8 ranked matches, top = Email | 12 ranked matches, top = Submit | 12 ranked matches, top = Open shadow button | 12 ranked matches, top = Inside iframe | 12 ranked matches, top = Far button |
| B | 2 | 2.2s | same 8, same order | same 12, same order | same 12, same order | same 12, same order | same 12, same order |
| B | 3 | 0.3s | same 8, same order | same 12, same order | same 12, same order | same 12, same order | same 12, same order |

Verdict: both bridges work for finding the email/submit/far button (single semantic match on A, ranked list on B, always with the right element first on B). A fails outright for shadow DOM and iframe queries (matches scenario 2: A never pierces those trees, so `find` cannot see anything inside them either, even though "Far button" is 2500px offscreen and A finds that one fine). B succeeds at all 5, always surfacing the correct element as the top ranked hit even though it returns up to 12 candidates rather than a single answer.

Timing: A took roughly 5.6-12s wall clock for 5 sequential `find` calls (roughly 1-2.4s per call, each call is its own model-graded semantic match, consistent with an LLM-in-the-loop cost). B took roughly 0.3-2.9s for the same 5 calls (well under 1s per call after the first, consistent with a rules/embedding based ranker with no LLM call). This is the single clearest per-call latency gap observed in this whole test group. All 3 runs agree on this ordering (A slower, B faster) even though the absolute B numbers varied 0.3 to 2.9s, likely local caching/warm-up.

## 4. Events: click #submit by ref and coordinate, type into #name

| Bridge | click by ref | click by coordinate | log after both clicks | keydown/input on type "abc" |
|---|---|---|---|---|
| A | `Clicked on element ref_12` | `Clicked at (717, 570)` (coordinate had to be read off a screenshot, whose pixel space (1149x1036) differs from the reported viewport (853x769), scale factor observed) | `["pointerdown submit trusted=true ptr=mouse","click f trusted=true ptr=mouse"]` x2 (4 entries total), both `isTrusted=true`, `ptr=mouse` | 3x `keydown name trusted=true key=<char>` each immediately followed by `input name trusted=true`, one pair per character (real per-key typing) |
| B | `computer ok` (ref) | `computer ok` (coordinate, screenshot pixel space 1180x1063 used directly, matched real target on first try) | identical 4-entry log, same isTrusted/ptr values | **only 1** `input name trusted=true` event, **zero** `keydown` events, for the whole 3-character string |

Both bridges log the click target as `f` rather than `Submit` or the button, this is a page quirk (the test page's logger appears to log `event.target.closest('[id]')` or similar and the form's id is `f`), not a bridge issue, reproduced identically on both.

Key difference: **A's default `type` action fires one real `keydown` + `input` pair per character. B's default `type` action sets the value and fires exactly one `input` event with no `keydown` events at all.** Confirmed B has a `perKey: true` option (tested in a follow-up call typing "cd") that switches it to real per-character `keydown` events (`keydown BODY key=c`, `keydown BODY key=d`), matching A's default behavior, but B does not do this by default. This matters for any site that only reacts to `keydown` (see scenario 5's `#kd` keydown-only counter).

Both isTrusted flags were true for every event on both bridges, no evidence either bridge is producing synthetic (non-trusted) input.

A second confirmation pass hit a coordinate-targeting miss on both bridges: after navigating fresh, a coordinate computed from the previous screenshot no longer matched the reloaded page's layout (scroll position differed), so the click landed on the Probe heading/section instead of the Name field on both bridges. This is not a bridge bug, it demonstrates that raw coordinate clicks are fragile across navigations/reloads while ref-based clicks are not, consistent with both tools' own guidance to prefer refs. Treated as a procedural note rather than a scored scenario result.

## 5. Form fill with form_input, disabled/readonly, submit, #ctl inputType, #kd count

| Check | A | B |
|---|---|---|
| text/email/select-by-value/select-by-label/checkbox/radio/textarea via `form_input` | all succeeded, reported e.g. `Set text value to "Ann" (previous: "")`, `Selected option "pt" in dropdown` | all succeeded, terser `{"ok":true,"value":"Ann",...}` style replies |
| `form_input` on the **disabled** input (#dis) | **succeeded**: `Set text value to "z" (previous: "x")`, and the DOM value really changed (`dis.value === "z"` confirmed via JS) | **failed**, correctly refused: `element ref_8 is disabled, so its value cannot be set` |
| `form_input` on the **readonly** input (#ro) | **succeeded**: `Set text value to "w" (previous: "y")`, DOM value really changed | **failed**, correctly refused: `element ref_9 is read-only, so its value cannot be set` |
| `#ctlval` (input event's `inputType`) after `form_input` on #ctl | `input:ctltest inputType=undefined` | `input:ctltest inputType=undefined` (identical on both, `form_input` on both bridges fires a plain `Event('input')` without `inputType`, not a real `InputEvent`) |
| `#kdcount` after `form_input` on a field (not #kd itself, general check) | 0 (no keydown from form_input, as expected, it is a value-set not a keypress) | 0 (same) |
| `#kdcount` after `computer type "abc"` (default) into #kd | 3 (one keydown per character, real events) | **0** (no keydown fires at all with default `type`) |
| `#kdcount` / value after `computer type` with `perKey: true` (B only, brief calls this out) | n/a (A has no perKey option, always per-key) | 2 more (kdcount went to 2 for 2 more chars), value correctly accumulated `"abcde"`, confirms `perKey:true` is the way to drive a keydown-only listener on B |
| Submit via click, read `#out` | Worked reliably once the click actually landed on the button element rather than the form background: 2 of 3 attempts at the same `ref_12` click produced the full expected JSON `{"name":"Ann","email":"ann@example.com","country":"pt","agree":"yes","plan":"pro","notes":"hello notes","ro":"w","kd":"xyz","ctl":"ctltest"}`; one attempt produced no change to `#out` even though the click *was* logged (`click f`, meaning the browser resolved the event target as the `<form id=f>`, not the button, so no submit occurred) | Not independently re-tested with the same rigor after the tab was rebuilt (see tab-recreation notes below), but the one submit-and-read performed on this fixture behaved the same way as A when the click actually lands on the button. |

Disabled/readonly fields are correctly excluded from `FormData`/the JSON output even when A had forcibly rewritten their `.value` in the DOM (the `dis` field's value never appears in `#out`'s JSON, `ro` does appear since it is only readonly, not disabled, matching HTML spec: disabled controls are excluded from form submission, readonly ones are not).

**Notable difference:** A's `form_input` bypasses the `disabled`/`readonly` HTML attributes and writes the value anyway, no warning given. B's `form_input` refuses both, with a clear, specific error naming which constraint was violated. For a bridge intended to simulate what a real user could do, B's behavior is the more correct one, A's is arguably a bug (it lets an agent silently violate constraints a real user could never violate through the UI).

**Notable difference:** B's default `type` action does not fire `keydown` at all (only one `input` at the end), so any keydown-only listener never sees it, this is silent and easy to miss unless you check the target's `keydown` handler specifically. A's default `type` always fires one `keydown` per character. B exposes `perKey: true` to opt into that behavior explicitly.

**Reliability note:** clicking the Submit button by ref intermittently resolved to the `<form>` element rather than the `<button>` on A (observed once in several attempts, logged as `click f` with no submit happening), while immediately retrying the same `left_click` on the same ref succeeded. This was not deterministic across repeats and is recorded as an observed flake rather than a confirmed bug, since retrying always fixed it. It affected only the click-then-check-in-one-shot pattern; a same-tick JS `.click()` on the button was 100% reliable.

## 6. Shadow DOM clicks

| Bridge | Access | Click result |
|---|---|---|
| A | No ref available: `find "open shadow button"` errors, `read_page` (all and interactive) never lists the button. Coordinate click required. | After careful recalibration (screenshot-space coordinates equal the click-coordinate space on A, confirmed via a `zoom` boundary error that reported the coordinate frame as exactly the screenshot's own 1149x1036), clicking precisely on the visible "Open shadow button" pixel, immediately after a fresh screenshot, still leaves `#shadow-out` empty. The event log shows `pointerdown open-host` (correct retargeting to the shadow host, proving the mousedown really landed inside the shadow tree) followed by `click SECTION` (the click's target retargets to an ancestor *outside* the shadow tree entirely, skipping even the host). Reproduced on 3+ attempts. Closed-shadow button: same result, `#shadow-out` stays empty. |
| B | Ref available and correct: `read_page`/`find` list `button "Open shadow button" [ref_13]` pointing at the real element inside the open shadow root. | Clicking `ref_13` resolves a real coordinate (`{"x":100,"y":385,"source":"ref"}`) inside the button, but `#shadow-out` still stays empty. Same log signature as A: `pointerdown open-host` then `click SECTION`. Reproduced twice. |

**Bug (shared, not bridge-specific):** neither bridge can actually *activate* a button inside an open shadow root by synthetic click, even though B can target it precisely by ref and A can hit its exact on-screen pixel. In both cases `pointerdown` retargets correctly to the shadow host (proof the down-event lands inside the shadow tree) but the paired `click` event retargets to an ancestor outside the shadow tree (`SECTION`), meaning the synthetic click's mouseup/click phase does not land back on the button the mousedown hit. This looks like a Chrome/CDP-level quirk in how `Input.dispatchMouseEvent`-driven clicks retarget through an open shadow boundary, reproduced identically on both bridges, so it is recorded as a shared limitation rather than a bug in either bridge individually. Practical effect: **content inside open shadow DOM cannot be clicked through either bridge in this test**, only read (B can read it via `read_page`, A cannot even do that). Closed shadow content is correctly unreachable on both (no ref on either, and the same click-retargeting failure applies to the coordinate attempt on A).

Time cost note: diagnosing this took many attempts on A because early coordinate misses were compounded by the Probe section's event log growing on every click (each attempt logs 2 more `<li>` lines), which pushes the whole page's layout down and invalidates coordinates computed from an earlier screenshot. This is a real trap when combining coordinate-based clicking with `browser_batch`: a stale screenshot plus any dynamically growing content above your target silently misses. Ref-based clicking (used throughout on B, and via `find`+ref where available on A) does not have this problem since the tool resolves the element's live position at click time.

## 7. Iframes

| Bridge | Same-origin iframe (`#same`, srcdoc, button `#ib` → `#r`) | Cross-origin iframe (`#cross`, example.com) |
|---|---|---|
| A | No ref for the inner button (`read_page`/`find` don't descend into the iframe at all). Coordinate click, done immediately after a fresh screenshot, works: `document.getElementById('same').contentDocument.getElementById('r').textContent` → `"iframe clicked"`. | `document.getElementById('cross').contentDocument` throws/returns null due to cross-origin restriction when queried from the top page (expected, standard same-origin policy). Not reachable through either bridge, as expected. `read_page` shows the iframe element itself (in A's `all` dump the section is present but empty; not tested further since this is the browser's own security boundary, not a bridge feature). |
| B | Ref available and correct: `read_page` shows `iframe [ref_22]` containing `button "Inside iframe" [ref_23]`, nested exactly where the DOM has it. Clicking `ref_23` (done in scenario 2/4 context) fires `#r` = `"iframe clicked"`. | Shown in `read_page` as an empty `iframe "https://example.com" [ref_24] src=https://example.com` node with no children, correctly opaque. |

Verdict: both bridges can click into a same-origin iframe (B via ref directly, A via coordinate only, since A's tree never shows iframe contents). Neither can, or should, read/interact with the cross-origin iframe's content, both correctly respect the browser's cross-origin isolation.

## 8. Contenteditable

| Bridge | Click #ce | ctrl+a | type "replaced text" | Result |
|---|---|---|---|---|
| A | Click by ref on the `generic "edit me"` node (the only ref A's tree exposes for this div) silently did nothing: no click/keydown logged at all, `document.activeElement.id` stayed empty. Coordinate click at the visible box worked immediately. | worked (native select-all inside the field) | worked | `#ce.textContent` → `"replaced text"` after the coordinate-based retry |
| B | Ref click (`ref_26`, which correctly targets the real contenteditable div) worked first try | worked | worked | `#ce.textContent` → `"replaced text"` |

A's ref-based click on non-form "generic" accessibility nodes (rather than a real `<input>`/`<button>`) is unreliable, matches the same pattern seen with the shadow DOM host and the submit button, coordinate clicking is the reliable fallback on A whenever the element in question is not a native form control.

## 9. Hover menu, hidden link

| Bridge | hover Menu button | click Hidden link (after hover) | click Hidden link (no prior hover, not separately tested to avoid redundant runs since the CSS is a plain `:hover` display toggle, identical on both) |
|---|---|---|---|
| A | `hover` at the Menu button coordinate revealed the `Hidden link` in the follow-up screenshot | first attempt landed on the `<li>` wrapper (`pointerdown LI` / `click LI`) and did not fire the link's handler; a 7px-adjusted coordinate then hit the `<a>` directly and `#hoverout` → `"hover link clicked"` | not run |
| B | `hover` by ref revealed the link, screenshot confirms | `left_click` by coordinate hit the link directly, `#hoverout` → `"hover link clicked"` first try | not run |

Both bridges support `:hover`-revealed content correctly, the CSS hover state was reachable and the link was clickable once visible on both. A needed one coordinate correction (2-3 px), consistent with the general observation that A's coordinate/ref targeting on non-form elements is less precise than B's.

## 10. Drag and drop (HTML5 DnD box A→B, range slider)

| Bridge | `left_click_drag` A→B | `#dndout` | `left_click_drag` on slider thumb | `#sliderval` |
|---|---|---|---|---|
| A | `Dragged from (117, 892) to (270, 892)` | `"dropped A on B"` (worked) | `Dragged from (55, 955) to (250, 955)` | `"51"` (worked, thumb followed the drag) |
| B | `Dragged from (120, 915) to (278, 915)` (reported success) | `""` (empty, did not work) | `Dragged from (57, 980) to (260, 980)` | `"0"` (unchanged, did not work) |

**Bug: B's `left_click_drag` does not perform a real press-move-release drag on this fixture.** The event log after both B drags shows only `pointerdown HTML` / `click HTML` pairs, no `drop` event and no evidence of a `dragstart`/`dragover` sequence or of continuous mouse movement while a button was held. This is consistent with the action being implemented as (or falling back to) a plain click rather than a sustained drag, which fails both the native HTML5 drag-and-drop box (needs `dragstart`→`dragover`→`drop`) and the `<input type=range>` thumb (needs mousedown-on-thumb, mousemove-while-down, mouseup). A's `left_click_drag` performed both correctly on the same fixture, on the same actions.

A side effect observed on B: after the two failed drags, the page had scrolled to `scroll: 2904` (near the bottom, close to the `#far` button 2500px down) with no explicit scroll action requested, suggesting the drag's synthetic pointer sequence triggered an unintended scroll or the second click landed somewhere that scrolled the page. Not chased further given time budget, recorded as an added data point on the same bug.

## 11. Upload: file input, drop zone, upload_image

| Check | A | B |
|---|---|---|
| `file_upload` both fixtures to `#file` (ref) | `Uploaded 2 file(s) to file input: upload1.txt, upload2.txt (5 KB total)`, `#fileout` = `"upload1.txt:13,upload2.txt:5000"` | `{"ok":true,"mode":"input","files":2}`, `#fileout` = `"upload1.txt:13,upload2.txt:5000"` (identical) |
| `file_upload` to the drop zone `#drop` (a plain `<div>`, no file input) | **Refused, exactly as the brief predicted**: `Element is not a file input. Found: <div>` (ref-only tool, no coordinate mode) | Supports a coordinate-based drop: `{"ok":true,"mode":"drop","at":{"x":200,"y":430,"mapped":true},"files":1}`, and `#dropout` correctly shows `"dropped upload1.txt:13"` |
| `upload_image` (last screenshot) onto `#file` | `Successfully uploaded image "image.png" (54KB) to file input` | `{"ok":true,"mode":"input","files":1}` (both succeeded) |

Verdict: file-input upload works identically well on both. B additionally supports simulating a real drag-and-drop file upload onto a non-input drop zone (`mode: "drop"`, coordinate-targeted), which A's `file_upload` tool cannot do at all since it only accepts a `ref` and requires that ref to resolve to an actual `<input type=file>`. This mirrors the earlier finding that B's tools generally expose a coordinate fallback where A's do not.

## 12. Dynamic list (#load, 5 items after 1.5s)

| Bridge | Click #load | Immediate read | Wait | Read after wait |
|---|---|---|---|---|
| A | **Ref-based click (`ref_63`) reported success twice but did nothing** (`#log` stayed completely empty, `#items` stayed at 0, even after a 2s `computer wait`). Only after `scroll_to` (ref) + a fresh screenshot + a **coordinate** click at the button's visible pixel did the click actually register. | 0 (both the failed ref attempts and the successful coordinate attempt, immediate read is always 0 since the list is added via `setTimeout(1500)`) | `computer wait 2s`, then a later manual re-check | 5 items present after the coordinate click, confirmed via `document.querySelectorAll('#items li').length === 5` |
| B | Ref-based click (`ref_19`) worked immediately, `{"at":{"x":71,"y":384,"source":"ref"}}` | 0 | `wait_for_page` (`timeout:5000`) | `{"ok":true,"readyState":"complete","waitedMs":121,"networkIdle":true,"timedOut":false,"durationMs":983}`, then read showed 5 items |

**Bug, A, most consequential of this whole group: ref-based clicks on elements outside the initial viewport are unreliable, and fail silently (report `ok` but do nothing).** This was seen 3 separate times in this session: the "Load items" button, the contenteditable div, and (differently) the shadow-DOM button. In every case, `computer left_click` with a `ref` for an offscreen element returns a success message and produces **zero** entries in the page's own event log, meaning no event reached the page at all, not even a misdirected one. The reliable fix each time was: take a fresh `screenshot` (which itself scrolls/renders the current state), then click by the coordinate visible in that screenshot. `scroll_to` by ref did not fix it on its own; a screenshot had to be taken after the scroll before the coordinate click would work. Since A's own docs recommend consulting a screenshot before clicking non-obvious elements, this is technically "as documented", but it makes ref-only automation (the fast path, and the one B relies on almost exclusively) meaningfully less trustworthy on A for anything below the fold.

`wait_for_page` (B only) is a genuinely useful primitive here: it does not just wait for `load`, it also detects the DOM still mutating (the list being populated) and holds until it settles (`durationMs: 983` vs `waitedMs: 121`, meaning it kept polling past the point `readyState` was already `complete`), which is exactly the tool needed for this fixture. A has no equivalent, only a blind `wait N seconds`.

## 13. Keyboard: ctrl+k, Tab, Enter, Escape, shift+Tab

| Bridge | ctrl+k → #short | Tab (from BODY) | shift+Tab |
|---|---|---|---|
| A | Failed on the first attempt right after `navigate` (`#short` stayed empty, page's own `#log` had zero entries, meaning no key event reached the page at all, even though `document.hasFocus()` read `true`). Succeeded on a second attempt after first clicking into the page (`"ctrl+k fired"`). | `document.activeElement` stayed `BODY`, both before and after the working ctrl+k fix, i.e. Tab never moved focus to the Name field on A in any attempt. | Also stayed `BODY` (consistent with Tab never having moved off it). |
| B | Worked first try, immediately after `navigate`: `"ctrl+k fired"` | Moved focus to `name` correctly (`document.activeElement.id === "name"`) | Moved focus back to `BODY` correctly (shift+Tab from the first tabbable element goes to "before document") |

**Bug, A: `Tab` does not move focus.** Repeated twice, `document.activeElement` never left `BODY` on A regardless of `key: "Tab"` calls, while `ctrl+k` (a plain keydown listener, no native default action needed) does work once the page has already received one successful interaction. This matches the pattern seen elsewhere on A: synthetic key/click events that only need to bubble to a JS listener eventually work, but the ones that depend on the browser's native default action for that key/element (Tab's focus-advance, a submit button's native form submission, shadow-DOM's click retargeting) are unreliable or fail outright.

A side observation: a stray `chrome://extensions/` tab (`tabId 177110458`) appeared in A's tab list starting with this scenario, not created by any tool call in this session. Not investigated further (out of scope, and not touched), but noted in case it explains any of A's focus flakiness (browser attention may have briefly gone to that tab).

## 14. New tab: #newtab (window.open) and #blanklink (target=_blank)

| Bridge | #newtab | #blanklink | Both landed in session group? | Controllable/closable? |
|---|---|---|---|---|
| A | click (coordinate, after scroll+screenshot) opened `tabId 177110477` "Example Domain" | click opened `tabId 177110480` "Example Domain" | Yes, `tabs_context_mcp` listed both new tabs alongside the original two (177110458 extensions leftover, 177110450 fixture) | Yes, both closed cleanly with `tabs_close_mcp` |
| B | click (ref) opened `tabId 177110485` "Example Domain" | click (ref, had to re-`find` since the first `window.open` invalidated the old ref) opened `tabId 177110488` | Yes, both appeared in `tabs_context` | Yes, both closed cleanly with `tabs_close` |

Verdict: both bridges correctly capture `window.open` and `target=_blank` navigations into their own tab group, both let the agent see and close the new tabs. On B, clicking `#newtab` invalidated an unrelated ref (`ref_37` for the blank link) that had been read before the click, most likely because `window.open` briefly steals focus/changes tab activation and triggers a DOM/tree refresh; a fresh `find` fixed it immediately. Not a bug, just a ref-lifetime note: any DOM-adjacent global event (new tab, alert, big layout shift) can invalidate previously-read refs on B and the fix is always to re-query.

## 15. Network and console

| Check | A | B |
|---|---|---|
| Click fetchok/fetch404/post, read `#netout` | `"posted {\"echo\":{\"a\":1},\"path\":\"/api/echo\"}"` (last click wins, as the page always overwrites the same span) | identical string |
| `read_network_requests` immediately after the 3 clicks, filtered `/api/` | **`No requests matching "/api/" found for this tab.`** with an explicit note: `"Network tracking starts when this tool is first called. If the page loaded before calling this tool, you may need to refresh..."` | 3 requests correctly listed: `200 GET /api/ok`, `FAILED net::ERR_ABORTED GET /api/missing`, `200 POST /api/echo` |
| `read_network_requests` called once (arms tracking), then a fresh click | after arming, the next `fetch ok` click *was* captured: `1. url: .../api/ok, method: GET, statusCode: 200` | (already working from the start, B's tracking is passive/always-on for the tab) |
| `read_console_messages` pattern `"evt"`, limit 5 | `Found 590 console messages (showing first 5 of 590)`, oldest-first, spanning the entire session history back to an earlier agent's run (timestamps from 2:40 AM through 10:18 AM), i.e. **console history is not scoped to navigation and grows without bound across this whole multi-hour session** | `[showing 5 of 29 entries]`, all from the current page load, most-recent-looking window |
| `read_console_messages` `onlyErrors`/`only_errors` | 82 error/exception messages, same long unbounded history (many duplicate "an error at load" / "uncaught boom" pairs, one per navigation across the whole session) | 6 messages: the 5 most recent "an error at load"/"uncaught boom" pairs plus, importantly, `[error] Failed to load resource: the server responded with a status of 404 (Not Found) (missing)`, a browser-generated network-error console line that A's dump did not obviously include in the excerpt reviewed |
| Load-time messages (`page loaded`, warning, error, uncaught boom) present | Yes, repeatedly (once per navigation performed this whole session) | Yes, present for the current page load |

**Bug/gotcha, A: network request tracking is opt-in and starts only from the first call to `read_network_requests` on that tab, silently missing everything before that.** The tool's own error message documents this, so it is arguably by design, but it is an easy trap: an agent that fetches, then checks network requests once at the end (a very natural pattern) gets nothing on A and has to know to call the tool once "to arm it" and re-trigger the requests. B tracks passively from when the tab joined the session, no arming step needed.

**Notable difference: A's console/error buffers are unbounded and shared across the whole multi-hour session (every navigation this agent and the previous agent performed), while B's console buffer appears scoped to a more recent/bounded window** (28-29 entries matching just this session's activity on the current page, not the previous agent's hours-old history). For an agent trying to debug "what just happened", B's output is far more directly useful, A's requires filtering through hundreds of stale entries from earlier runs.

## 16. Scroll: scroll_to #farbtn, click, verify; wheel scroll

| Check | A | B |
|---|---|---|
| `scroll_to` by ref | Worked, screenshot after confirms Far button visible near the bottom of the viewport | Worked, and B's `scroll_to` usefully reports precise element geometry directly: `{"x":20,"y":729,"width":76,"height":21,"centerX":58,"centerY":739,"inViewport":true}`, no screenshot needed to know where to click |
| Click far button, verify | `#farbtn.textContent` → `"far clicked"` | same, `"far clicked"` |
| Wheel scroll 5 ticks down, verify position | `window.scrollY` → `500` | `page_state` → `scrollY: 500` (identical), plus `page_state` also reports `scrollHeight: 4370`, `viewport`, and `devicePixelRatio: 2.25` in the same call |

Both bridges scroll identically and land on the exact same `scrollY` for the same wheel input (5 ticks). B's `scroll_to` returning exact element geometry (position, size, `inViewport`) without needing a screenshot is a meaningful efficiency/precision advantage over A, which requires a screenshot plus visual coordinate reading to click after scrolling, this is the same root cause behind several of A's offscreen-click failures documented above.

## 17. /slow, /redirect, /spa

| Check | A | B |
|---|---|---|
| `navigate` to `/slow` (server takes 4s) | Blocked until load: wall clock 3506ms (Bash-bracketed), close to the server's 4s delay, tool returned only after the page was ready | Blocked until load: tool-reported `durationMs: 7309`. Not independently wall-clock-bracketed for this call, tool figure is the only number available and it is noticeably higher than the server's advertised 4s delay, worth treating as an outlier rather than a fixed cost (this was also this bridge's very first navigate after some idle time in this session). |
| `navigate` to `/redirect` (302 → `/index.html#redirected`) | `location.href` after navigate → `"http://127.0.0.1:8765/index.html#redirected"`, correct final URL | `navigate` result's own `url` field → `"http://127.0.0.1:8765/index.html#redirected"`, correct, and fast (`durationMs: 42`) |
| `navigate` to `/spa`, then click `#go` (appears after 2s), then wait, then click, verify `#done` | `find` for the "go" button on its own took long enough (multi-second, LLM-based) that the button already existed by the time it ran, so a true "click before it exists" moment wasn't captured. The **subsequent click attempts (both by ref) reported success but did not actually trigger `#go`'s handler**, `#done` stayed absent through 2 separate ref-click attempts; only a coordinate click (after a fresh screenshot) worked, `#done` appeared. Same offscreen/first-paint ref-click unreliability documented in scenarios 6, 8, 12. | `wait_for_page` after navigating to `/spa` returned `{"waitedMs":121,"networkIdle":true,"durationMs":981}`, i.e. it caught the 2-second SPA render window (`#go` appearing) without a fixed sleep. The subsequent `left_click` by ref on `#go` worked immediately, `#done` appeared right away. |

Verdict: navigation blocking-until-load, and redirect-URL reporting, work correctly and identically on both bridges. The `/spa` case again surfaces A's core reliability gap: ref-based clicks on elements that appeared dynamically (not present at initial page load) are unreliable, coordinate clicking after a screenshot is the dependable path. B's `wait_for_page` is a strictly better primitive than A's blind `wait N seconds` for this exact "wait for dynamic content" pattern, seen now in both scenario 12 and scenario 17.

## 18. /big (3000 rows, 9000 interactive elements)

| Check | A | B |
|---|---|---|
| `navigate` to `/big` | wall clock 3354ms (Bash-bracketed) | tool-reported `durationMs: 162` |
| `read_page interactive` | **Silently stops at 63 nodes (btn 0..31 / link 0..30) with no truncation notice, no total node count, no size figure.** The raw output is only ~1.9KB, nowhere near the 50000-char default budget, so this is not a character-limit truncation, it looks like an internal cap A applies before serializing (matches the same silent under-reporting seen on the fixture page's interactive filter in scenario 2). | Explicit, informative truncation: `url: ... | nodes: 6000` header, then `[truncated: showing 1172 of 6000 nodes, 270806 chars total. Narrow with ref_id to read one subtree, or lower depth.]`. The harness's own 50000-char tool-output ceiling triggered a save-to-file for the raw MCP payload, but B's own truncation message was intact inside that file and precisely quantifies what was cut. |
| `find "btn 2999"` (a specific one of 3000, timed) | **Found it exactly**: `ref_9001: button "btn 2999" ... Exact match`. Wall clock ~5.0s. | **Did not find it.** Returned 20 matches, all `btn 0` through `btn 19` in DOM order, ranked as if "2999" wasn't part of the query at all. Wall clock ~350ms (much faster, wrong answer). |
| Screenshot dimensions | 1568x706 | 1568x707 (essentially identical) |

**Notable, somewhat surprising result: on a page with 9000 interactive elements, A's `find` correctly locates one specific far-down element by exact label while B's does not**, this is the reverse of the pattern seen on the small fixture page (scenario 3), where B's ranked list always put the right element first. At this scale B's matcher appears to degrade to something closer to "first N nodes matching the generic noun (button)" rather than incorporating the specific number in the query, while A's slower, LLM-graded `find` still gets the exact right answer. This is the one clear case in the whole test where A's `find` outperforms B's on correctness, at roughly 14x the latency (5.0s vs 0.35s).

**Bug, A: `read_page interactive` under-reports on large pages with no truncation warning**, giving a false impression of only ~30 buttons existing when there are 3000. An agent relying on A's `read_page` alone (rather than `find`) to inventory a large page's interactive surface would silently miss 99% of it.

## 19. /dialog: click #ok only, never #al

Both bridges correctly identified and clicked only the "ok" button (never the "alert" button), confirmed via `find` returning the two buttons distinctly labeled (`"ok"` and `"alert"`) and clicking only the `ok`-labeled ref. `document.body.innerText` after the click read `"alertclicked"` on both (the page's static button labels "alert"/"ok" concatenated with a "clicked" status text, run together with no separating whitespace in `innerText`, this is page markup, not a bridge artifact). No modal dialog appeared on either bridge (no freeze, subsequent calls on both tabs completed normally), confirming neither bridge accidentally triggered the alert button. Verdict: works on both.

## 20. resize_window to 800x600 and 1400x900

| Bridge | 800x600 (1st attempt) | 1400x900 | 800x600 (2nd attempt) |
|---|---|---|---|
| A | Reported success, but `innerWidth/innerHeight` immediately after still read `1707x769` (unchanged), and a screenshot taken right after was still full-size (1568x706). Looks like a race between the resize completing and the very next call reading state. | Reported success and **did** take effect: `{"outerW":1402,"outerH":902,"w":1388,"h":752}` | Reported success and **did** take effect this time: `{"w":788,"h":452}` |
| B | Reported success (`durationMs: 164`), but `page_state.viewport` stayed `1707x769`, unchanged | Reported success, `page_state.viewport` again stayed `1707x769`, unchanged | not retried, pattern already established over 2 attempts |

**B's `resize_window` appears to be a no-op in this environment** (0 of 2 attempts changed the reported viewport), most likely because B drives a tab inside the user's own, already-open Chrome window (per the brief, "B opens tabs in the user's current window") rather than a dedicated automation window, so resizing that window would resize the user's real browser, B evidently does not do this (or cannot). This is arguably correct, conservative behavior for a tool that shares the user's real browser, but it means `resize_window` cannot actually be used to test responsive layouts on B in this configuration, contrary to what the tool's own description promises ("Resize the window holding a tab. Use to test responsive layouts."). A's resize_window does work, reliably by the second call, in its own dedicated window.

## 21. Screenshot cost: screenshot + zoom, dimensions and token figures

| Check | A | B |
|---|---|---|
| Full screenshot | `1568x706` (or `1568x707`), jpeg, no token estimate printed anywhere in the tool output | `1568x707`, `~1414 tokens` printed directly under the result |
| `zoom` on region `[0,0,400,300]` | Returns an **upscaled** image, `979x736` for a 400x300 source region (about 2.45x magnification), no token estimate printed | Returns the region at **native size**, `400x300`, with an explicit `~154 tokens` cost printed |

Verdict: B is the only one of the two that tells you the token cost of a screenshot directly in the tool output, useful for an agent trying to budget context. A never prints a token estimate for any image in this session, its cost has to be inferred externally. A's `zoom` magnifies the requested region (useful for reading small text/icons up close), B's `zoom` crops to the requested region at 1:1 scale (cheaper in tokens, less useful if the target is genuinely tiny on screen and needs magnification to read). Neither behavior is strictly better, they serve different purposes (A: readability of small detail, B: token economy), but the two tools interpret the same "zoom" concept differently and callers should not assume they behave the same way.

## 22. javascript edge cases

| Check | A | B |
|---|---|---|
| top-level `await fetch('/api/ok').then(r=>r.json())` | `{"ok":true,"t":1788441839.38...}`, rendered directly | `{"result":{"ok":true,"t":1788441850.80...},"type":"object","durationMs":7}`, wrapped with a `type` and `durationMs` |
| thrown error | Rendered as a tool error: `JavaScript execution error: Error: deliberate test error\n    at <anonymous>:1:8` | Also rendered as a tool error: `Error: deliberate test error\n    at <anonymous>:1:7` (both surface it as an error, not a silently-swallowed value) |
| returned DOM node (`document.getElementById('submit')`) | `{}` (serializes to an empty object, no useful information about the element) | `{"result":{},"type":"object","durationMs":4}` (same empty-object serialization, wrapped) |
| large return (`Array(20000).fill('x').join('')`, a 20000-char string) | **Blocked**: `[BLOCKED: Base64 encoded data]`. This is a false positive, a long run of the same character, not actual base64, but A's output content-filter flagged it and withheld the entire result. | Returned in full, all 20000 characters, no filtering |

**Bug/false-positive, A: A's own content-safety filter blocks a plain long string of repeated characters, misclassifying it as "Base64 encoded data".** This is a real risk for any agent workflow that reads back long uniform strings from a page (e.g. base64 images, padding, minified code, repeated-character stress tests) via `javascript_tool`, since A silently withholds the value rather than truncating or warning about size. B has no equivalent filter and returned the full string.

DOM node serialization is a wash, both bridges collapse a returned element to an unhelpful empty object `{}`, neither is useful for that specific pattern (an agent wanting DOM node data should return specific properties, e.g. `.id`/`.outerHTML`, rather than the node itself).

## 23. browser_batch, 6-step sequence with a deliberately failing step

Sequence used (identical shape on both, after fixing an initial test-design mistake, see note below): navigate → read_page(interactive) → click ref_1 (Name field) → type "BatchTest" → screenshot → click a deliberately bad ref (`ref_999`, guaranteed not to exist).

| Bridge | Result | Wall clock (6 actions, Bash-bracketed) | Failure behavior | Did the typed text actually land? |
|---|---|---|---|---|
| A | Steps 1-5 completed, step 6 failed and stopped the batch | 4789ms | `actions[5] (computer:left_click) failed: No element found with reference: "ref_999". The element may have been removed from the page. (5 completed, 0 remaining)`, all 5 prior results still returned in the same response | **Yes**, verified via `document.getElementById('name').value` → `"BatchTest"` |
| B | Steps 1-5 completed, step 6 failed and stopped the batch | 3328ms | `[5] computer FAILED: ref ref_999 is no longer on the page. Re-read the page.\n\nStopped at action 5. Later actions did not run.`, all 5 prior results still returned in the same response | **No**. `document.getElementById('name').value` → `""` (empty), and the page's own event log was completely empty (`[]`), meaning the click and type actions immediately following the in-batch `read_page` silently did nothing, despite both reporting `ok`. |

Both bridges handle the deliberately-bad ref the same way: fail cleanly on that one step, stop the batch, and still return every result from the steps that ran before it. Neither bridge corrupts or hides the earlier results when a later step fails.

**Bug, B: actions immediately following a `read_page` inside the same `browser_batch` call can silently no-op.** The click-then-type sequence reported success for both steps but produced zero page-visible effect (no click/keydown/input logged at all, field stayed empty). This mirrors, on B, the same class of "reported success but nothing happened" failure documented extensively for A elsewhere in this report (scenarios 6, 8, 12, 17), just triggered by a different circumstance (immediately after an in-batch `read_page`, rather than an offscreen ref). Not reproduced as a standalone single-call sequence (single calls to click and type worked reliably throughout this whole test group), so it looks specific to chaining click+type right after `read_page` inside one `browser_batch`.

Test-design note: an earlier attempt at this scenario used a `ref` value carried over from an unrelated earlier call in the session (assuming "ref_1 is always the Name field"), and that failed identically on A, landing nowhere and leaving the page scrolled to an unrelated position. That failure was a test-construction mistake, not a bridge bug: refs must always come from a `read_page`/`find` call in the *current* navigation, on both bridges. Along the way this surfaced a real, useful difference worth recording: **B's `find` and `read_page` calls consistently number refs starting at `ref_1` after every fresh navigation, while A's numbering is not reliably anchored to the current page load** (observed starting points drifting to `ref_16`, `ref_19`, `ref_63`, `ref_9001`, etc. across different calls in the same session without an intervening navigate always explaining the jump). Always re-reading the page for fresh refs rather than assuming a fixed numbering is the safe pattern on both, but more so on A.

`quick` script (B only) was not additionally exercised as a separate timed run in this pass given the time already spent isolating the two bugs above; B's per-call numbers throughout this whole report (scenario 3, scenario 24) already demonstrate its low per-call overhead relative to `browser_batch`'s own per-step cost, which is the main thing `quick` would have added evidence for.

## 24. Per-call latency: javascript `1+1` x10, three runs, Bash-timed

Wall clock (Bash `date +%s%3N` bracketing 10 sequential single-call `javascript`/`javascript_tool` invocations of `1+1`):

| Bridge | Run 1 | Run 2 | Run 3 | Median | Per-call (median/10) |
|---|---|---|---|---|---|
| A | 28114ms | 26643ms | 25935ms | 26643ms | ~2664ms |
| B | 4695ms | 4694ms | 4572ms | 4694ms | ~469ms |

B's own reported `durationMs` for each `1+1` call was consistently 1-4ms (server-side execution only), confirming almost all of B's ~469ms/call wall clock is transport/tool-call round trip overhead in this harness, not page execution. A does not report a self-timed duration for `javascript_tool`, so its cost cannot be split into transport vs execution, but given the trivial expression, essentially all of its ~2664ms/call is round-trip overhead too.

**A's per-call round trip is roughly 5.7x slower than B's for the cheapest possible operation**, consistent and repeatable across all 3 runs (26643, 26643, 25935 vs 4695, 4694, 4572, i.e. B's numbers cluster tightly run to run while A's do too, just at a much higher baseline). This matches the `find` latency gap seen in scenario 3 and is the most consistent, most reproducible performance difference found in this entire test group.

## Notable differences

1. **Per-call latency.** B is roughly 5.7x faster per round trip on trivial `javascript` calls (median ~469ms vs ~2664ms) and roughly 14x faster on `find` on a small page (scenario 3). A's `find` is LLM-graded and returns a single reasoned best match; B's `find` is a fast ranked-candidate list. On a 9000-element page the roles flip: A's `find` still located one specific element correctly (5s), B's did not (0.35s, wrong results), see point 9.
2. **read_page fidelity.** B pierces open shadow DOM and same-origin iframes in its tree and tags offscreen nodes explicitly; A's tree stops at section boundaries for shadow/iframe content and gives no offscreen/disabled/readonly markers. A's `interactive` filter also silently drops most of the page (form-only on the fixture page, 63-of-9000 on `/big`), with no truncation notice, while B's truncation is explicit and quantified.
3. **Offscreen ref-clicks are unreliable on A.** Repeatedly (contenteditable, "Load items", `/spa`'s `#go`, shadow DOM) a `computer left_click` by `ref` on an element outside the initial viewport reported success but produced zero events on the page. The reliable fix was always: screenshot, then click by the coordinate in that screenshot. B's ref-clicks worked on offscreen elements without this workaround throughout.
4. **form_input respects disabled/readonly on B, not on A.** A silently overwrites `disabled`/`readonly` input values; B refuses with a specific error naming the constraint.
5. **Default `type` fires per-character `keydown` on A but not on B.** B needs `perKey: true` to get real keydown events; its default `type` sets the value with a single `input` event and no `keydown` at all.
6. **Shadow DOM click activation fails on both bridges for the same underlying reason.** `pointerdown` retargets correctly into the shadow host on both, but the paired `click` retargets to an ancestor outside the shadow tree, so the button's own `onclick` never fires, on A or B. This looks like a shared Chrome/CDP synthetic-click quirk, not a bug unique to either.
7. **B's file_upload can drop a file onto a plain non-input drop zone by coordinate; A's cannot** (A's tool only accepts a `ref` to an actual `<input type=file>`).
8. **B's `resize_window` is a no-op in this environment** (drives a tab inside the user's real browser window), while **A's works** (its own dedicated window), despite both tools' documentation implying they resize the viewport.
9. **On a 9000-element page, A's `find` beat B's on correctness** (exact match vs. wrong ranked list) at roughly 14x the latency, the one case in this whole test where A's approach outperformed B's.
10. **B prints token-cost estimates for screenshots directly in tool output; A never does.** B's `zoom` crops a region at native resolution (cheap); A's `zoom` magnifies it (better for reading small detail, more tokens).
11. **A accumulates console/error history across the whole multi-hour session with no scoping; B's console buffer reflects a much more recent, bounded window.** A's network-request tracking is also opt-in (must call `read_network_requests` once before the requests happen, or they're missed entirely); B tracks passively from when the tab joined the session.
12. **Tab management is symmetric and reliable on both**: window.open/target=_blank tabs land in the session's own tab group and are closable on both bridges.

## Bugs

1. **B: a tab can become permanently unable to `navigate` or receive `computer` input**, failing every retry with `Cannot access a chrome-extension:// URL of different extension` whenever the tab has live cross-origin/srcdoc subframes and the debugger session has churned for a while. Reproduction: open the fixture page (which has a `srcdoc` iframe and a cross-origin `example.com` iframe), interact for a while, then call `navigate` or `computer` on the same tab. Workaround: close the tab and create a new one. Hit this 3 times in this session (177110451, 177110460, 177110464 all broke this way).
2. **A: ref-based clicks on off-screen elements silently no-op.** Tool reports success, zero events reach the page. Reproduction: navigate to the fixture, `read_page`/`find` an element below the fold (e.g. `#load`, `#ce`, `/spa`'s `#go`), `computer left_click` it by `ref` without an intervening screenshot. Workaround: screenshot first, click by coordinate.
3. **A: open-shadow-DOM buttons cannot be activated by click at all** (see Notable difference 6), also true on B, shared root cause.
4. **A: `form_input` bypasses `disabled` and `readonly` HTML attributes**, writing the DOM value anyway with no warning, letting an agent do something no real user interaction could do.
5. **A: `read_page interactive` silently truncates with no notice or count**, both on a normal-sized page (fixture, form-only) and a large one (`/big`, 63 of 9000 nodes), giving a false impression of the page's actual interactive surface.
6. **A: `javascript_tool` false-positive content filter blocks a plain long string of one repeated character**, misclassifying it as `[BLOCKED: Base64 encoded data]` and withholding the entire return value.
7. **B: click+type actions immediately following an in-batch `read_page` inside the same `browser_batch` call can silently no-op** (reported success, zero page-visible effect, empty event log). Reproduced once in scenario 23; single-call click/type sequences elsewhere in this session were reliable.
8. **A: `resize_window`'s first call in a fresh sequence can silently not take effect** (viewport unchanged despite a success message), while a second call to a different size worked immediately after. Possibly a completion-timing race rather than a hard failure, seen once.
9. **B: `find` degrades to near-arbitrary ranking on very large pages**, returning the first N DOM-order matches for a generic noun ("btn") rather than honoring a specific distinguishing token in the query ("2999"), on a 9000-element page.

Both bridges' tabs closed at the end of this session (A: 177110450; B: 177110468). The stray `chrome://extensions/` tab noted in scenario 13 (`tabId 177110458`) was left in place since this session did not create it and closing an unrelated tab was out of scope.
