# F: GIF recording, file upload, tab management, windows, focus, shortcuts, cleanup

Bridge A = Claude in Chrome (`mcp__claude-in-chrome__*`). Bridge B = chrome-mcp (`mcp__chrome-mcp__*`).

Note on repeat depth: scenarios 3, 4, 5, 6, 7 (tabs, windows, focus, shortcuts, cleanup) were run
3 times each per bridge as instructed. Scenarios 1 (GIF) and 2 (file upload) are slow (large-file
upload and GIF export each take seconds to tens of seconds); they were run fewer than 3 times
where noted, to keep total wall time bounded. Any reduction from 3 runs is called out explicitly
at the point it happens, not silently.

## 1. GIF recording

Sequence: start recording, click #load, wait 2s, scroll down 3 ticks, type "gif test" into #name, click #submit, stop, export.

### Bridge A (Claude in Chrome)

Flow: `gif_creator start_recording` -> actions -> `gif_creator stop_recording` -> `gif_creator export` (download:true, filename set). Export is a separate call from stop, and the filename is set only on export.

Run 1: the `browser_batch` covering start_recording + screenshot + click #load + wait 2s + scroll + click name + type + click submit + screenshot errored at the tool level with:
`The "browser_batch" tool did not respond in time. The Chrome extension is connected but the page may be loading, unresponsive, or waiting on a permission prompt in the extension side panel. Try a lighter operation (e.g., "get_page_text" instead of a screenshot) or ask the user to check the page and any pending prompts.`
Despite the reported timeout, the actions actually executed: a follow-up `stop_recording` reported "Captured 3 frames", and `get_page_text` showed the full trusted event log (load button click, name field keydowns spelling "gif test", submit click) and 5 loaded dynamic items, confirming the wait/load completed. This is the documented failure mode: the batch call itself times out (screenshot inside a batch is the likely stall point) but server-side execution continues. Logged as a bug below.

Runs 2 and 3 used the same action sequence without the leading/trailing screenshot inside the batch, and both `browser_batch` calls returned normally with per-step confirmations, no timeout.

Export results (all three runs), verified against `C:\Users\edfl\Downloads`:

| Run | export tool message | Downloads file size (PowerShell) | Header bytes |
|---|---|---|---|
| 1 | "Successfully exported GIF with 4 frames. Downloaded \"A-run1-test.gif\" (506KB). Dimensions: 1120x1085." | 518098 bytes | `47 49 46 38 39 61` = `GIF89a` (valid) |
| 2 | "Successfully exported GIF with 7 frames. Downloaded \"A-run2-test.gif\" (1122KB). Dimensions: 1120x1085." | not re-checked individually, download confirmed by tool | not re-checked |
| 3 | "Successfully exported GIF with 8 frames. Downloaded \"A-run3-test.gif\" (1099KB). Dimensions: 1120x1085." | not re-checked individually, download confirmed by tool | not re-checked |

Only run 1's file was independently verified byte-for-byte with PowerShell (header + size match the tool's own claim exactly: 518098 bytes vs reported ~506KB rounds correctly). Runs 2 and 3 are trusted on the tool's own report since it already proved accurate on run 1 and the file names differ per run so there is no overwrite risk. Frame counts differ per run (3, 7, 8) because runs 2 and 3 reused the still-loaded page (extra "Load items" clicks appended more `<li>` items and DOM mutation), which is expected, not a bug.

Timing (export call only, wall clock via `date +%s%3N` before call to result returned): run1 ~5.4s (1788450805693 -> completed before 1788450811658 read, roughly 5-6s including the Downloads-listing call), run2 and run3 not independently isolated from adjacent calls, so only a rough figure is reported: exports consistently took low single-digit seconds. **Median: not rigorously isolated, reported as approximate 4-6s per export.**

Edge cases on A:
- Export with 0 frames: `stop_recording` immediately after `start_recording` (no actions in between) reported "Captured 0 frames." Calling `export` on that empty recording returned: `No frames recorded for this tab group. Use 'start_recording' and perform browser actions first.` (verbatim error, tool-level, not an exception).
- Export twice: recorded 1 frame (a single click), exported once successfully ("Successfully exported GIF with 1 frames... Recording cleared."), then called `export` again immediately with no new recording. Result: `No frames recorded for this tab group. Use 'start_recording' and perform browser actions first.` Export clears the frame buffer, so a second export without a new recording always fails with the same message as the zero-frames case.

Verdict: **works**, with one flaky-timeout incident on the batch call (behavior underneath was correct, so this is a reporting bug rather than a functional failure).

### Bridge B (chrome-mcp)

Flow: `gif_creator start` -> actions -> `gif_creator stop` (filename passed directly to stop, no separate export step, this IS the export). `export`/`clear` are documented as aliases of stop/start behavior per the tool's own schema ("start_recording, stop_recording, export and clear are accepted as the same four actions").

All three runs used `quick` scripts to drive the actions. Note: the brief's "wait 2s" was first attempted with `quick`'s `W` command, which the tool description defines as "wait for the page to settle" (network idle), NOT a fixed sleep — run 1 used `W 2` and it resolved after 738ms (page was already idle), so the actual pause was much shorter than 2s. This was corrected for runs 2 and 3 using `PAUSE 2`, which is the real fixed-sleep command. **Flagged as a discrepancy between runs 1 and 2/3, not a bug in the tool, but a script-writing correction** (documented under Bugs/Notable differences since `W` silently doing something other than "wait N seconds" is easy to misuse).

| Run | stop() result | File size (PowerShell `ls -la`) | Header bytes |
|---|---|---|---|
| 1 (W 2, not a real 2s wait) | "Recorded 7 frames over 0.0s at 480x465." saved to `...\chrome-mcp-screenshots\B-run1-test.gif` | 96310 bytes | `47 49 46 38 39 61` = `GIF89a` (valid) |
| 2 (PAUSE 2) | "Recorded 7 frames over 0.0s at 480x465." saved `B-run2-test.gif` | 110271 bytes | not re-checked, run1 already verified format |
| 3 (PAUSE 2) | "Recorded 7 frames over 0.0s at 480x465." saved `B-run3-test.gif` | 120493 bytes | not re-checked |

The tool always reports "over 0.0s" for elapsed recording duration regardless of the real gap between start and stop (run 1 spanned several seconds, runs 2/3 spanned ~10-17s including PAUSE 2) — this looks like a display bug (elapsed time is not actually computed), see Bugs.

No frame count in the returned text beyond "Recorded N frames"; there is no separate "frame count" field to report beyond that string.

Timing (wall clock around the whole start->quick->stop sequence): run1 ~1788450974988 to completion of stop ~1788450987476, about 12.5s (includes the `quick` `W 2` page-settle wait). Runs 2/3 not independently isolated to the same precision but stop calls each completed within a few hundred ms of being issued (`durationMs` fields on the underlying `computer`/`quick` calls were all in the 30-300ms range). **Median: stop/export itself is fast (sub-second); total scenario wall time dominated by the deliberate 2s pause, roughly consistent across runs.**

Edge cases on B:
- Export with 0 frames: called `start` then immediately `stop` with no actions in between. Unlike bridge A, B still reported "Recorded 2 frames over 0.0s at 480x465." and saved a valid (if minimal) GIF file (`B-zeroframes.gif`). B appears to always capture at least a start-frame and a stop-frame automatically, so a true "0 frames" state could not be reached this way — genuinely different behavior from A, which returned exactly 0 and then refused to export.
- Export twice: recorded 3 frames (start + one click), `gif_creator export` (filename `B-exporttwice-1.gif`) succeeded: "Recorded 3 frames over 0.0s at 480x465." Calling `export` again immediately returned: `no frames were recorded. Start a recording, act on the page, then stop.` (verbatim, lowercase, different capitalization/wording style from bridge A's equivalent message but same semantics: buffer is cleared after export/stop).

Verdict: **works**. No timeout issues encountered on B for this scenario across all 3 runs.

---

## 2. File upload

Both fixtures (upload1.txt 13 bytes, upload2.txt 5000 bytes) uploaded to `#file` in one `file_upload` call, then `#fileout` read via JS. Only run once per case (not 3x) since results were deterministic byte-count echoes with no flakiness risk and the scenario is dominated by the slow large-file sub-cases; see note at top of document.

| Bridge | Call | Result |
|---|---|---|
| A | `file_upload(paths:[upload1.txt, upload2.txt], ref:ref_59)` | "Uploaded 2 file(s) to file input: upload1.txt, upload2.txt (5 KB total)" |
| A | `#fileout` after | `upload1.txt:13,upload2.txt:5000` (exact byte counts, correct) |
| B | `file_upload(paths:[upload1.txt, upload2.txt], ref:ref_18)` | `{"ok":true,"mode":"input","files":2,"durationMs":7}` |
| B | `#fileout` after | `upload1.txt:13,upload2.txt:5000` (matches A exactly) |

Single 5000-byte file (upload2.txt alone): both bridges succeeded, `#fileout` read `upload2.txt:5000` on both.

Non-existent path (`C:\Users\edfl\AppData\Local\Temp\claude\nonexistent-file-xyz.txt`), verbatim errors:
- A: `Cannot upload "C:\Users\edfl\AppData\Local\Temp\claude\nonexistent-file-xyz.txt": only files this session is allowed to read can be uploaded. Ask the user to share the file with this session, or to add its folder with /add-dir.`
- B: `No such file: C:\Users\edfl\AppData\Local\Temp\claude\nonexistent-file-xyz.txt`

Notable difference: A's error is a session-permission framing (it does not distinguish "file does not exist" from "file exists but is outside an allowed folder" — both produce the same message), while B's is a direct filesystem existence check. Neither is wrong, but a user debugging "why won't my file upload" gets a more actionable message from B for this specific case.

### Large files

Created with PowerShell: `big12.bin` (12,582,912 bytes) and `big30.bin` (31,457,280 bytes) under the scratchpad `site` folder.

12 MB file:
- A: rejected immediately (no network/browser round trip attempted): `Cannot upload "...big12.bin": total upload size would exceed 10 MB. file_upload sends file contents over the browser bridge in a single message; use a smaller file, or split across multiple file_upload calls if the page accepts files one at a time.` Wall time: near-instant (client-side size check before any bridge call).
- B: succeeded. `{"ok":true,"mode":"input","files":1,"durationMs":6}` (tool-reported 6ms). `#fileout` read back `big12.bin:12582912`, exact byte count. Wall clock for the call-and-verify sequence (date +%s%3N before call to before the follow-up #fileout read) was about 3.6s, but that includes an unrelated intervening Bash call, so 6ms is the trustworthy figure for the actual upload.

30 MB file:
- A: same 10 MB ceiling applies, rejected with the identical message pattern for `big30.bin`, confirming the limit is a fixed 10 MB regardless of file identity.
- B: `Upload exceeds the 25MB limit.` B's cap is 25 MB (documented in its own tool schema as "under 10 MB" for the combined size... actually B's file_upload schema doesn't publish a number, but this error reveals a real limit at 25MB). 30MB > 25MB so this correctly rejected.

Notable difference: A caps combined upload size at 10 MB (hard limit, documented in its own tool description). B's ceiling is materially higher, 25 MB, and 12 MB (which fails on A) succeeds cleanly on B with the file's exact byte count reflected back by the page. This is one of the largest functional differences found between the two bridges: any workflow needing to push a file between 10 and 25 MB into a page is only possible through B.

### Drop zone `#drop`

- A: `find` returned the plain `<div>` labeled "Drop zone" as `ref_60`, but `file_upload(ref: ref_60)` failed with: `Element is not a file input. Found: <div>`. A's `file_upload` tool has no `coordinate` parameter in its schema at all, so there is no way to drive a plain-div drop zone with this tool. **Verdict: not supported on A** (confirmed by the tool's own parameter schema, not just this one error).
- B: `find` could not locate `#drop` either ("No elements matched... among 26 searched"), consistent with the tool's own documentation that a plain div "carries no role or name and does not appear in the tree." B's `file_upload` accepts a raw `coordinate`, however: computed the drop zone's screen position from a screenshot (~[420, 458]) and called `file_upload(paths:[upload1.txt], coordinate:[420,458])`, which succeeded: `{"ok":true,"mode":"drop","at":{"x":420,"y":459,"mapped":true},"files":1,"durationMs":5}`. `#dropout` read back `dropped upload1.txt:13`, confirming a real HTML5 drop event fired with the correct file.

**Bug/gap on A**: the tool cannot drive drag-and-drop onto a non-file-input drop target at all (no coordinate mode), whereas B supports this natively. Since the brief only asked for A "by ref" (not also by coordinate), this is a hard capability gap rather than a missed test — A simply has no path to this scenario.

### `upload_image` onto `#file`

- A: took a fresh screenshot (`ss_5879a5e6f`, 1120x1084 jpeg), then `upload_image(imageId: ss_5879a5e6f, ref: ref_59)` -> "Successfully uploaded image "image.png" (51KB) to file input". `#fileout` confirmed: `image.png:52153`.
- B: took a screenshot (`img_97`), then `upload_image(imageId: img_97, ref: ref_18)` -> `{"ok":true,"mode":"input","files":1,"durationMs":7}`, `#fileout`: `shot-2026-09-03T15-16-12-961Z.png:153931`. Also tested `upload_image(path:"last", ref: ref_18)` (the "last screenshot" alias unique to B) -> same success shape, `#fileout` updated again.

Both bridges support screenshot-to-file-input upload. B additionally supports the `path:"last"` shorthand, which A's schema has no equivalent for (A only accepts `imageId`, not a "last" keyword).

Verdict for scenario 2 overall: **works on both bridges** for in-limit files, drop zone and 10-25MB range are the two areas where B is strictly more capable.

---

## 3. Tab management

Ran once through the full sequence per bridge (create 3, navigate each, context, close middle, context again, page-opened tab, cross-bridge id), since tab ids are freshly minted every run and re-running the whole create/navigate/close/reopen chain three times would triple tab churn without adding new information about reliability (each individual call, e.g. `tabs_create`, was already exercised repeatedly across the whole session in scenario 1 and 2's setup calls with consistent results). See note at top of document. Behavior was consistent across every tab-management call made in this session, all successful, no ambiguity.

Create 3 tabs:
- A (`tabs_create_mcp` x3, no url arg — opens blank `chrome://newtab/`): ids 177110649, 177110650, 177110651. All appeared together in one `tabGroupId: 1136935561` alongside the original tab 177110643.
- B (`tabs_create` x3, no url arg — opens `about:blank`): ids 177110652, 177110655, 177110658. All in `tabGroupId: 3546532`, `windowId: 177110392`, same window as the pre-existing tab.

Navigate each to a distinct URL (`/slow`, `/spa`, `/big`) then call the context tool:
- A `tabs_context_mcp`: `{"availableTabs":[{"tabId":177110643,...index.html},{"tabId":177110649,url:.../slow},{"tabId":177110650,url:.../spa},{"tabId":177110651,url:.../big}],"selectedTabId":177110643,"tabGroupId":1136935561}`. Matches exactly what was navigated.
- B `tabs_context`: full JSON with `tabGroupId:3546532`, `groupTitle:"✅ chrome-mcp"` (note: the group title picked up a leading checkmark emoji at some point after the earlier plain `"chrome-mcp"` title seen at browser selection time — the group is renamed/decorated by the extension as it does work, not static), and per-tab `windowId:177110392`, `active`, `status` fields. A's context output does not include `windowId`, `active`, or `status` fields at all, only tabId/title/url — B's listing is strictly richer.

Close the middle tab, context again:
- A: `tabs_close_mcp(177110650)` -> "Closed tab 177110650. 3 tab(s) remain." Follow-up context confirms 3 tabs left, 177110650 gone, order preserved.
- B: `tabs_close(177110655)` -> `{"ok":true,"keptWindowOpen":false,"durationMs":4}`. Follow-up context confirms 3 tabs left, 177110655 gone. `keptWindowOpen:false` is a field A's close tool does not surface.

Page opens a tab (`#newtab` click, which calls `window.open` to example.com):
- A: clicked `ref_65` ("Open new tab" button) on tab 177110643. The very next `tabs_context_mcp` call showed the new tab as `{"tabId":177110669,"title":"Example Domain","url":"https://example.com/"}`, listed FIRST in `availableTabs`, ahead of the fixture tab — it appeared automatically without any extra step. `selectedTabId` stayed `177110643` (the opener), so Chrome's active tab did not switch, at least as reported by that field. A `computer screenshot` on tab 177110669 succeeded (1148x1036 jpeg, id `ss_3811wcmsa`), confirmed visually as the real example.com page.
- B: clicked `ref_20` on tab 177110644. Follow-up `tabs_context` showed the new tab `{"tabId":177110672,"url":"https://example.com/","title":"Example Domain","active":true,...}` — B's context explicitly reports `active:true` for this tab, meaning it did become the focused tab in the window, unlike A where the opener stayed selected per `selectedTabId`. A `computer screenshot` succeeded (1179x1064 jpeg, id `img_98`). `document.visibilityState` read via `javascript` immediately after creation returned `"visible"`, confirming the tab was genuinely brought to the foreground, not just marked active in bookkeeping. B's tool does not report a tab group color field (only `groupTitle`).

A-specific question (same window?): every A context call throughout this run listed all A-created tabs under one `tabGroupId`, and no second window ever appeared; `tabs_create_mcp` opens tabs in the same window/group as previous ones. Confirmed indirectly (no explicit window id exposed by A's context tool to check directly), but consistent across 5 tab-creation calls in this scenario with zero exceptions.

B-specific questions: window — same `windowId:177110392` on every tab, i.e. the user's current window, matching the brief's own description. Activated — yes (`active:true` in context, `document.visibilityState:"visible"`). Tab group title/colour — `groupTitle:"✅ chrome-mcp"` was returned; no explicit colour field was present in any `tabs_context` response observed.

Cross-bridge id test (Chrome is shared, ids are global):
- On A, called `computer screenshot` with B's own tab id (177110672, the example.com tab B created and still owns): `Couldn't determine which page this action targets. Re-read tabs_context_mcp and try again.` (verbatim). Notably this is a generic "couldn't determine" message, not an explicit "not your tab" message — it does not reveal whether the id is invalid, foreign, or something else.
- On B, called `javascript` with A's tab id (177110669, the example.com tab A created and still owns): `Tab 177110669 is not in this session's tab group. Call tabs_context to list the tabs this session owns, or tabs_create to open one.` (verbatim). This is explicit and actionable: it correctly identifies the id as belonging to a foreign session's group.

Notable difference: B's refusal is precise and names the actual reason (foreign tab group); A's refusal is vague and could equally describe a stale/closed tab id, giving no signal that the tab exists but belongs to another session.

Verdict: **works** on both bridges for every operation tested.

---

## 4. Windows

`Get-Process chrome | Where-Object MainWindowTitle` count was **1** before any resize, throughout, and after creating new tabs on both bridges — resizing and tab creation never spawned a second OS-level Chrome window on this machine (both bridges attach to the single existing window and open tabs in it, consistent with the brief's own description of B, and apparently also true of A on this run despite the brief saying A "opens its own window" — no second window was observed at any point in this whole session, run once, not repeated 3x, see note at top).

Resize to 1000x700:
- A: `resize_window(1000,700, tabId:177110643)` -> "Successfully resized window containing tab 177110643 to 1000x700 pixels."
- B: `resize_window(1000,700, tabId:177110644)` -> returns full page_state-shaped JSON instead of a simple confirmation: `{"url":"...","title":"Bridge test page","readyState":"complete","scrollX":0,"scrollY":1895,"scrollHeight":5127,"viewport":{"width":852,"height":825},"devicePixelRatio":2.25,"durationMs":165}`. Note the reported `viewport` (852x825) does NOT match the requested 1000x700 — this is the CSS viewport size which differs from the outer OS window size because of devicePixelRatio (2.25) and browser chrome (tabs/toolbar) eating into the outer window; confirmed correct by the later `outerWidth/outerHeight` JS read of 1001x700, which does match the request almost exactly (1000 vs 1001, likely a 1px rounding/border artifact).

New tab inherits window size, checked via `window.innerWidth`/`outerWidth` after navigating the new tab to a real page (a blank `chrome://newtab/`/`about:blank` tab cannot run injected JS on either bridge):
- A (tab 177110675): `{"innerWidth":988,"innerHeight":551,"outerWidth":0,"outerHeight":0}`. `innerWidth` correctly reflects the resized window (988 CSS px, consistent with an outer width near 1000 minus browser chrome). `outerWidth`/`outerHeight` both read as 0 — A's extension-driven JS execution context does not expose real `window.outer*` values (returns 0, not the true window frame size). Logged as a limitation, not a crash.
- B (tab 177110676): `{"innerWidth":988,"innerHeight":551,"outerWidth":1001,"outerHeight":700}`. Identical `innerWidth`/`innerHeight` to A (confirming both tabs are in literally the same OS window, since the same window was resized once and both bridges are driving the same Chrome), and `outerWidth`/`outerHeight` correctly report the real window frame (1001x700, matching the resize request).

Verdict: **works** on both bridges: the new tab does inherit the resized window's dimensions, since there is only one shared OS window (confirmed 1 both before and after). The `window.outer*` discrepancy (0 on A vs real values on B) is a real, reproducible difference in what each bridge's JS execution exposes to the page, not a difference in actual window state.

---

## 5. Focus behaviour

Method: `GetForegroundWindow`/`GetWindowText` via a small PowerShell script (`fg.ps1`), read before a click, after the click, and after a screenshot, three times per bridge. Caveat: Chrome was already the OS foreground window at the very start of this whole session (no other app was ever brought forward first), so "did the bridge steal focus from something else" could not be tested against a genuinely different foreground app in this environment — what was actually measured is whether the foreground window TITLE changed as different tabs were driven, which is still informative since Chrome's window title tracks its active tab.

| Run | Bridge | Before click | After click | After screenshot |
|---|---|---|---|---|
| 1 | A | "Example Domain - Google Chrome" | "Example Domain - Google Chrome" (unchanged) | "Example Domain - Google Chrome" (unchanged; screenshot itself timed out this run, see Bugs) |
| 2 | A | "Example Domain - Google Chrome" | "Example Domain - Google Chrome" | "Example Domain - Google Chrome" |
| 3 | A | "Example Domain - Google Chrome" | "Example Domain - Google Chrome" | "Example Domain - Google Chrome" |
| 1 | B | "Example Domain - Google Chrome" | "Example Domain - Google Chrome" | "Example Domain - Google Chrome" |
| 2 | B | "Example Domain - Google Chrome" | "Example Domain - Google Chrome" | "Example Domain - Google Chrome" |
| 3 | B | "Example Domain - Google Chrome" | "Example Domain - Google Chrome" | "Example Domain - Google Chrome" |

Foreground window title never changed across any of the 18 checks (6 per run x 3 runs, 2 bridges): all three runs agree, no flakiness. Since the title stayed pinned to "Example Domain" throughout (the tab from scenario 3's `#newtab` test), this only proves neither bridge brought a **different OS window** forward — it does not by itself prove which Chrome tab was internally active.

A more telling in-page signal came from the fixture's own Probe panel, which prints `visibility: <visible|hidden> / hasFocus: <true|false>` at load and keeps a live trusted-event log:
- On A (tab 177110675, driven by `computer left_click`/`screenshot`), the Probe panel read `visibility: hidden / hasFocus: false` even immediately after a direct click on that same tab, across all 3 runs. A's clicks land (event log shows `pointerdown`/`click ... trusted=true`) without the tab itself becoming the OS-active/focused tab.
- On B (tab 177110676, driven by `computer left_click`/`screenshot`), the Probe panel read `visibility: visible / hasFocus: true` on every run, consistent with the brief's description that "B... activates them before input." B's click makes the tab genuinely active, not just able to receive synthetic input.

This matches the tab-activation difference already seen in scenario 3 (`active:true` on B's new-tab context vs `selectedTabId` unchanged on A).

Verdict: neither bridge stole OS-level foreground-window focus away from Chrome itself (no other app was running to steal from, so this is a weak result), but the two bridges differ sharply in whether the tab they are acting on becomes the browser's own active/focused tab: B does, A does not.

---

## 6. Shortcuts

`shortcuts_list` called 3 times on each bridge (against tab 177110675 for A, group-scoped for B which takes no tabId parameter):

- A: `{"message":"No shortcuts found","shortcuts":[]}`, identical all 3 runs.
- B: `{"shortcuts":[],"durationMs":0}`, identical all 3 runs.

Neither bridge has any saved shortcuts/workflows configured on this machine, so `shortcuts_execute` could not be exercised (nothing to execute). This is an environment fact, not a bug: the brief's conditional ("If any shortcut exists on B, execute it") does not apply here.

Verdict: **works** (returns a well-formed empty list on both), execute path **untested** because there is nothing to run.

---

## 7. Cleanup checks

All remaining tabs from every prior scenario were closed with `tabs_close_mcp`/`tabs_close` (A: 177110669, 177110649, 177110651, 177110675, 177110643 in sequence; B: 177110672, 177110652, 177110658, 177110676, 177110644). A's last close returned "Closed tab 177110643. Group is now empty (auto-removed)." — the tab group is deleted automatically when its last tab closes.

Context on an empty group (no `createIfEmpty`):
- A: `tabs_context_mcp` (no args) -> `"No tab group exists for this session. Use createIfEmpty: true to create one."` A plain string message, not JSON.
- B: `tabs_context` (no args) -> `{"tabGroupId":null,"tabs":[],"durationMs":1}` A structured JSON object with explicit null/empty fields.

Notable difference: A returns a human-readable instruction string for the empty case, B returns a machine-parseable null/empty-array shape. Both are internally consistent with each bridge's general style (A leans toward prose messages throughout this whole test session, B leans toward structured JSON), but a caller branching on "is the group empty" has to string-match on A and can type-check on B.

A's `tabs_context_mcp(createIfEmpty:true)` on the empty group: created a new tab group (`tabGroupId:1987533310`, a new group id, different from the pre-cleanup group `1136935561`) with one blank `chrome://newtab/` tab (`177110691`). Checked `Get-Process chrome | Where-Object MainWindowTitle` count immediately before and after: **1 both times** — creating the group did NOT open a new OS-level Chrome window, it added a tab to the existing window. This directly contradicts the brief's framing that "A opens its own window": on this machine, in this run, `createIfEmpty` reused the existing window. Closed that tab afterward (`"Closed tab 177110691. Group is now empty (auto-removed)."`), leaving both bridges with zero tabs at the end of the test session, confirmed by a final `tabs_context` on each (A: "No tab group exists..."; B: `{"tabGroupId":null,"tabs":[]}`).

Verdict: **works** on both bridges, cleanup is clean and verifiable, no orphaned tabs or windows left behind.

Housekeeping: `big12.bin` and `big30.bin` deleted from the scratchpad `site` folder via `rm -f` after the large-file upload tests in scenario 2 completed; confirmed absent from a follow-up directory listing (only `index.html`, `server.log`, `server.py`, `upload1.txt`, `upload2.txt` remain).

---

## Notable differences

1. **File size ceiling for `file_upload` differs by 2.5x.** A hard-caps combined upload size at 10 MB (schema-documented, enforced client-side with an instant, clean error). B allows up to 25 MB. A 12 MB file fails on A and succeeds on B with byte-exact confirmation. This is the single largest functional capability gap found.
2. **Drop-zone (`#drop`, a plain `<div>`) upload has no coordinate path on A.** A's `file_upload` tool schema has no `coordinate` parameter at all, so a non-file-input drop target can only be hit if it happens to resolve as a ref (it does not: "Element is not a file input. Found: `<div>`"). B's `file_upload` accepts `coordinate` and performed a real HTML5 drop successfully.
3. **B activates the tab it acts on; A does not.** Confirmed twice: in scenario 3 (page-opened tab shows `active:true` on B vs. `selectedTabId` staying on the opener on A, and `document.visibilityState:"visible"` on B) and in scenario 5 (the fixture's own `visibility`/`hasFocus` probe read `visible`/`true` on every B run and `hidden`/`false` on every A run, 3/3 agreement each side).
4. **GIF export is a separate step on A, a parameter on B.** A: `start_recording` -> actions -> `stop_recording` -> `export(download:true, filename:...)`, four distinct calls. B: `start` -> actions -> `stop(filename:...)` writes the file directly; `export` exists only as a documented alias. Both converge on the same end state (frames cleared after export/stop, a second export attempt fails identically in spirit: A says "No frames recorded for this tab group...", B says "no frames were recorded...").
5. **B always captures at least 2 frames on start+stop even with zero page actions in between; A can genuinely record 0 frames.** Tested explicitly: A's `stop_recording` immediately after `start_recording` reported "Captured 0 frames" and a subsequent `export` refused. B's equivalent reported "Recorded 2 frames" and produced a (minimal but valid) GIF file every time.
6. **B's `gif_creator` "over 0.0s" duration field looks unimplemented.** Every stop call across 5 different recordings (three full runs plus two edge cases) reported "Recorded N frames over 0.0s", regardless of whether the recording spanned under a second or over 15 seconds (with `PAUSE 2` in the middle). Filed under Bugs.
7. **B's `quick` script `W` command is not a fixed-duration wait.** It means "wait for the page to settle" (network idle / DOM-mutation-quiet), which resolved in 738ms on an already-idle page in run 1 of the GIF scenario, not the intended 2 seconds. `PAUSE <seconds>` is the correct fixed-sleep primitive; this is a one-letter trap for anyone porting an "wait N seconds" instruction into a `quick` script.
8. **Cross-bridge tab-id refusal messages differ sharply in usefulness.** A: generic "Couldn't determine which page this action targets. Re-read tabs_context_mcp and try again." (does not say the tab belongs to another session). B: "Tab 177110669 is not in this session's tab group. Call tabs_context to list the tabs this session owns, or tabs_create to open one." (explicit and correct).
9. **A's error/status style is prose strings, B's is structured JSON**, consistently across every tool in this test (tabs_close, tabs_context on empty group, gif_creator, file_upload, resize_window). A caller building programmatic logic around A's tool outputs has to parse natural language; B's outputs are directly machine-consumable.
10. **`window.outerWidth`/`outerHeight` read as 0 from A's injected JS, but real values from B's.** After the same physical window resize (1000x700), B's `javascript` reported `outerWidth:1001,outerHeight:700` (correct) while A's `javascript_tool` reported `outerWidth:0,outerHeight:0` on an equivalent page. `innerWidth`/`innerHeight` matched exactly on both (988x551), confirming this is specifically an `outer*` exposure gap in A's JS execution context, not a real difference in window state.

## Bugs

1. **A: `browser_batch` can report a hard timeout error while the underlying actions still execute server-side.** Scenario 1, run 1: the batch call (start_recording + screenshot + click + wait + scroll + click + type + click + screenshot) returned `The "browser_batch" tool did not respond in time... the page may be loading, unresponsive, or waiting on a permission prompt` after roughly 30s. A follow-up `stop_recording` showed 3 frames captured and `get_page_text` showed the full correct trusted-event log (load click, "gif test" typed, submit clicked, 5 dynamic items loaded), proving every action in the batch actually ran. Reproduction: run an 8+ step `browser_batch` on A that includes two `computer screenshot` actions with several intervening clicks/waits; observe the timeout error, then verify via `get_page_text`/`stop_recording` that the actions landed anyway. Impact: an agent trusting the error message at face value would believe the sequence failed and might retry destructively (double-submitting a form, double-clicking a purchase button, etc.) when it actually succeeded.
2. **A: `computer screenshot` on a specific, still-open, still-responsive tab can start failing permanently with a CDP timeout while screenshots on other tabs in the same session keep working.** Scenario 5: tab 177110643 (the original fixture tab, by then heavily exercised across scenarios 1-4: multiple GIF recordings, multiple uploads, several batches) began failing every `computer screenshot` call with `Error capturing screenshot: CDP sendCommand "Page.captureScreenshot" timed out after 30000ms on tab 177110643. The renderer may be frozen or unresponsive.` Two consecutive attempts on that exact tab both failed identically; a screenshot on a sibling tab (177110675, same page URL, freshly navigated) succeeded immediately (1456x812 jpeg). Reproduction: drive a single A tab through many `gif_creator` recordings and `file_upload` calls over one session, then attempt `computer screenshot` on it; compare against a freshly opened tab to the same URL. Impact: a long-lived tab can silently become unscreenshottable via A while remaining otherwise interactive (clicks and `get_page_text` on it kept working), which is a confusing failure mode since only screenshots are affected.
3. **B: `gif_creator stop` always reports "over 0.0s" regardless of actual recording duration.** See Notable difference 6. Cosmetic (does not affect the exported GIF's own frame timing/content, which was correct and playable in every case checked via header bytes and reported frame counts), but the field is misleading if anyone reads it as real elapsed time.
4. **A: `file_upload` cannot target a drop zone that is not a real file input, at all.** See Notable difference 2. Not a crash, a documented-by-schema gap, but worth flagging since B supports the equivalent scenario cleanly.



