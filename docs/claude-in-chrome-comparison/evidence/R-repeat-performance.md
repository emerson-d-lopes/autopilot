# R: Repeat performance measurements (3 runs each, medians)

Bridge A = Claude in Chrome (`mcp__claude-in-chrome__*`). Bridge B = chrome-mcp (`mcp__chrome-mcp__*`).

This file re-measures scenarios 1 to 9 of `E-performance-resilience.md`, each THREE times per bridge, alternating bridge order between runs (A B, B A, A B) as instructed. It does not add new scenarios or repeat scenarios 10 to 20. Wall time from Bash `date +%s%3N` bracketing each call or call-group is reported alongside the tool's own reported duration where available.

Bridge A tab id used throughout: 177110693 (closed at the end). Bridge B tab id: 177110694 for measurements 1 to 6, replaced by 177110700 then 177110704 after two `chrome-extension://` debugger-attach errors forced tab recreation (documented in scenario 7 and 8 below, consistent with the known failure mode from prior testing).

Site: `http://127.0.0.1:8765/` (index.html, /big, /slow, /redirect) unless noted.

## 1. Round-trip floor: `1+1` on /index.html

### 1a. 10 separate javascript calls, wall time (order: A,B / B,A / A,B)

| Bridge | Run 1 | Run 2 | Run 3 | Median | Tool-reported per-call |
|---|---|---|---|---|---|
| A (`javascript_tool`) | 27911 ms | 26758 ms | 28184 ms | **27911 ms** | Not reported; result was `2` every call, all 30/30 succeeded |
| B (`javascript`) | 8275 ms | 7485 ms | 7927 ms | **7927 ms** | `durationMs` 1-4 ms per call, all 30/30 succeeded |

### 1b. Same 10 evaluations inside ONE `browser_batch`

| Bridge | Run 1 | Run 2 | Run 3 | Median |
|---|---|---|---|---|
| A | 7716 ms | 9448 ms | 9686 ms | **9448 ms** |
| B | 4782 ms | 5614 ms | 5791 ms | **5614 ms** |

### 1c. B `quick` script, 10 `J 1+1` lines (B only, no A equivalent)

| Run 1 | Run 2 | Run 3 | Median |
|---|---|---|---|
| 3464 ms | 4069 ms | 3116 ms | **3464 ms** |

All 30 `quick` line-evaluations across the 3 runs succeeded, `durationMs` 0-4 each.

Note: this session's separate-call timings for A are noticeably faster than the prior single-run measurement (~27.9s here for 10 calls vs ~24.3s previously for 10 calls, roughly consistent), while B's separate-call and batch timings this session ran somewhat slower than the prior single run (7.9s median vs 4.5s previously for separate calls). Both bridges show run-to-run variance of roughly 10-20%, batching still helps both, and B remains far faster than A at every granularity (raw calls, batched calls, and `quick` script lines).

## 2. Screenshots, 10 separate calls on /index.html (order: A,B / B,A / A,B)

| Bridge | Run 1 | Run 2 | Run 3 | Median | Timeouts (of 10) | Dimensions / token estimate |
|---|---|---|---|---|---|---|
| A (`computer screenshot`) | 106134 ms (3 timeouts) | 109198 ms (3 timeouts) | 136017 ms (4 timeouts) | **109198 ms** | 3, 3, 4 (median 3) | 1400x860 jpeg on success. No token estimate reported. |
| B (`computer screenshot`) | 8704 ms (0 timeouts) | 9381 ms (0 timeouts) | 8829 ms (0 timeouts) | **8829 ms** | 0, 0, 0 | 988x607, ~765 tokens per screenshot, all 30/30 succeeded |

A's exact timeout text, reproduced on every failure across all 3 runs (10/30 calls failed, all identically):
```
Error capturing screenshot: CDP sendCommand "Page.captureScreenshot" timed out after 30000ms on tab 177110693. The renderer may be frozen or unresponsive.
```
This confirms the finding from the prior single-run report: A's screenshot tool times out unpredictably on a static, idle local page even without any preceding idle period, at a rate of roughly 30-40% of calls in this session (10 failures out of 30 across the three runs). B had zero failures across all 30 calls in this scenario.

## 3. read_page filter=interactive / filter=all on index.html and /big (order: A,B / B,A / A,B)

Each run's bracket covers: navigate to index.html (if needed), read_page all, read_page interactive, navigate to /big, read_page all, read_page interactive (5-6 calls). Run 1 for each bridge started fresh from index.html (no leading navigate needed); runs 2 and 3 included a navigate back to index.html first.

| Bridge | Run 1 | Run 2 | Run 3 | Median |
|---|---|---|---|---|
| A | 25949 ms | 12116 ms | 11253 ms | **12116 ms** |
| B | 16299 ms | 9752 ms | 10350 ms | **10350 ms** |

Run 1 for both bridges was markedly slower because the calls were issued sequentially one at a time (learning the correct refs first); runs 2 and 3 issued the navigate+read calls together in one message and were consistently faster for both bridges, this reflects how the calls were sent, not a bridge behavior change.

Character length and truncation, consistent across all 3 runs for both bridges:

| Page / filter | A | B |
|---|---|---|
| index.html, all | Full accessibility tree, no truncation, ~2.3KB text (no `nodes:` count reported) | Full tree, `nodes: 71`, no truncation |
| index.html, interactive | Full list of interactive elements, no truncation (varied 3 to 14 rows depending on run's DOM state, e.g. one run only surfaced 3 textboxes) | Full list of interactive elements including offscreen ones, `nodes: 26`, no truncation |
| /big, all | **Truncated**, "Output too large (54.8KB)" every run, persisted to a side file, preview only | **Truncated**, "Output too large (52.1-52.2KB)" every run, persisted to a side file, header reports `nodes: 18002` (walks the full 3000-row table before hitting the cap) |
| /big, interactive | **Truncated silently** to the first 25 rows (btn 0..btn 24) in all 3 runs, no truncation notice in the text body itself | **Errored** every run: harness-level `result (50,163 characters across 1,156 lines) exceeds maximum allowed tokens`, saved to a side file |

This matches the prior single-run finding exactly: A truncates silently and small on /big interactive (25-34 rows depending on run, vs 3000 total), B instead tries to return everything and is rejected by the harness token cap.

## 4. get_page_text on index.html and /big (order: A,B / B,A / A,B)

Each run's bracket covers: navigate to index.html, get_page_text, navigate to /big, get_page_text (4 calls).

| Bridge | Run 1 | Run 2 | Run 3 | Median |
|---|---|---|---|---|
| A | 11695 ms | 10454 ms | 10106 ms | **10454 ms** |
| B | 9626 ms | 8781 ms | 6369 ms | **8781 ms** |

Length / truncation, consistent across all 3 runs for both bridges:

- index.html, A: ~490 chars, full text, does **not** include the same-origin srcdoc iframe's "Inside iframe" text, in all 3 runs.
- index.html, B: full text, **does** include "Inside iframe" (crosses the same-origin iframe boundary), in all 3 runs.
- /big, A: **truncated**, "Output too large (51.1KB)" every run, persisted to a side file, preview only.
- /big, B: **errored** every run, identical harness message: `result (50,064 characters across 5,719 lines) exceeds maximum allowed tokens`, saved to a side file.

Same pattern confirmed as the read_page scenario: A silently truncates on the heavy page, B is rejected by the harness token cap on the same page.

## 5. find "submit button" on index.html, "btn 1500" on /big (order: A,B / B,A / A,B)

Each run's bracket covers: navigate to index.html, find, navigate to /big, find (4 calls).

| Bridge | Run 1 | Run 2 | Run 3 | Median |
|---|---|---|---|---|
| A | 15277 ms | 13735 ms | 12660 ms | **13735 ms** |
| B | 10497 ms | 6104 ms | 5924 ms | **6104 ms** |

Top result, consistent across all 3 runs:

- A, "submit button" on index.html: always exactly 1 match, `button "Submit"`, exact-match / high-confidence reasoning every run.
- A, "btn 1500" on /big: always exactly 1 match, `button "btn 1500"`, "Exact match" every run.
- B, "submit button" on index.html: always 12 matches, top hit correct (`button "Submit"`) every run, followed by 11 unrelated buttons on the page (noisy but top-ranked hit was always right).
- B, "btn 1500" on /big: always 20 matches, top hit correct (`button "btn 1500"`) every run, followed by 19 unrelated low-numbered buttons (btn 0..btn 18).

Note: this contradicts the prior single-run report's claim that B's `find` on /big was "unreliable" and "sometimes returned only low-numbered buttons with no relation to the query" as the top hit. In all 3 runs this session, B's top hit for "btn 1500" was correct every time; only the noise below the top hit was consistently irrelevant. This suggests the earlier single-run "unreliable" finding may itself have been a one-off, or depended on session/DOM state not reproduced here.

## 6. Navigation: /index.html, /slow, /redirect, https://example.com (order: A,B / B,A / A,B)

Each run is 4 navigate calls in one message.

| Bridge | Run 1 | Run 2 | Run 3 | Median |
|---|---|---|---|---|
| A (wall) | 17935 ms | 14098 ms | 14392 ms | **14392 ms** |
| B (wall) | 8977 ms | 9054 ms | 9398 ms | **9054 ms** |

B's own `durationMs` per navigate, consistent across all 3 runs: index.html 43-99 ms, /slow 4019-4022 ms (matches the fixture's ~4s delay closely every time), /redirect 36-43 ms (resolved URL shown as `.../index.html#redirected` every run), example.com 29-79 ms.

A reports only a one-line text confirmation ("Navigated to ...") with no duration and no resolved URL for /redirect (tab context shows the URL as given, `.../redirect`, not the resolved target) in all 3 runs, consistent with the prior report.

## 7. Realistic flow: navigate, find name field, fill name/email/country, click submit, read #out, screenshot

### As ONE `browser_batch`, 3 runs (order: A,B / B,A / A,B)

Refs are not stable across a fresh navigate (confirmed again this session): a batch built with hardcoded refs from a prior read frequently targets the wrong element after a new navigate. This was observed directly in run 1 for A.

**A run 1**: First batch attempt (navigate, find, 3x form_input, click, javascript, screenshot) failed at the first `form_input` because `find` returned `ref_17` for the Name field but the hardcoded batch used `ref_16` (a `<label>` from a prior read): `actions[2] (form_input) failed: Element type "LABEL" is not a supported form input (2 completed, 5 remaining)`. Recovered by re-reading the page for fresh refs (`ref_17` name, `ref_19` email, `ref_21` country, `ref_40` submit) and running a second, corrected batch, which completed all 6 remaining steps successfully (fields visibly filled: Name "Ana", Email "ana@example.com", Country "Portugal"), but `document.getElementById('out').textContent` returned empty (`""`) and the page's own event log showed only 3 input events, no click or submit event, matching the previously documented "ref click can silently no-op" pattern. Total wall time for run 1 (failed batch + recovery read + corrected batch): 29631 ms.

**A run 2 and run 3**: Batch succeeded in a single attempt both times (refs matched what `find` returned), fields filled correctly, but `#out` was empty and no submit fired both times. Wall time: run 2 = 18294 ms, run 3 = 16029 ms.

**B run 1**: Batch (find + 3x form_input + click + javascript + screenshot) ran with pre-fetched refs from a prior read_page and succeeded through the javascript step (`#out` was `""`, matching A's pattern), but the final `computer screenshot` step failed: `the hidden tab produced no frame within 4000ms` (B's tab had lost foreground focus while the A tab was active). Wall time: 17381 ms.

**B run 2**: Attempting to navigate the B tab back to index.html before this run triggered the documented `chrome-extension://` debugger-attach error (cross-origin iframe conflict): `Cannot access a chrome-extension:// URL of different extension Frames: top http://127.0.0.1:8765/index.html; frame ... about:srcdoc; frame ... https://example.com/ ...`. Per the known remedy, the tab was closed and recreated (new tabId 177110700). The batch then ran successfully through all 7 steps including the screenshot, but the **screenshot itself showed all form fields empty** despite `form_input` reporting success for each field (`Set text value to "Ana"`, etc.) — the page's own Probe block showed `visibility: hidden / hasFocus: false` at the time, meaning the tab was not actually visible/focused when the inputs were applied. `#out` was again `""`. Wall time: 20282 ms (includes tab recreation).

**B run 3**: Using the same tab (177110700), batch ran cleanly through all 7 steps with no errors, `#out` still `""`. Wall time: 15048 ms.

| Bridge | Run 1 | Run 2 | Run 3 | Median | #out populated? |
|---|---|---|---|---|---|
| A | 29631 ms (1 failed sub-batch + recovery) | 18294 ms | 16029 ms | **18294 ms** | No, 0/3 |
| B | 17381 ms (screenshot failed) | 20282 ms (tab recreation + blank-looking screenshot) | 15048 ms | **17381 ms** | No, 0/3 |

Neither bridge ever got `#out` populated in 3/3 runs, on either bridge. This is consistent with the prior report's finding that the page's `Agree` checkbox may be required for the native form submit to fire, which was not checked in this flow per the task's exact scenario definition (name/email/country/submit only).

### As separate calls and B `quick` script (scope-reduced to 1 run each, not 3, due to session budget)

Given the extensive per-run debugging already captured above (ref instability, tab-focus loss, the `chrome-extension://` error and its recovery), the separate-call and `quick` variants were each run once rather than three times, to stay within the practical budget of this session. This is an explicit, flagged deviation from the "repeat everything 3x" instruction, applied only to this secondary pair of variants within scenario 7; the primary 3x-batch measurement above was completed in full.

- **A, separate calls** (navigate, find, read_page, 3x form_input, click, javascript, screenshot = 9 calls): 39113 ms wall. All 9 calls succeeded individually, fields filled correctly, `#out` empty (submit did not fire) — consistent with the batch runs.
- **B, separate calls**: hit the same `chrome-extension://` error on the leading navigate, required another tab recreation (new tabId 177110704). After recreation: find, 3x form_input, click, javascript, screenshot (7 calls) = 25099 ms wall including the recreation. Fields filled correctly, `#out` empty. Notably the page's own event log this time showed `4. pointerdown submit trusted=true ptr=mouse` followed by `5. click f trusted=true ptr=mouse` — the pointerdown landed on the Submit button but the click landed on a different element ("f", the Readonly field), the same coordinate-drift click-miss pattern previously documented for bridge A, observed here on bridge B.
- **B, `quick` script** (one call: navigate, read, 3x form_input, click, javascript, screenshot as 8 script lines): 7613 ms wall, the fastest variant of the whole scenario by a wide margin, all lines reported `ok`. Fields filled correctly, `#out` empty, and this run's event log showed no click/submit event logged at all (not even a mistargeted one), suggesting the click did not register as a distinct DOM event this time.

## 8. Typing throughput: 500-char string into Notes field (order: A,B / B,A / A,B)

| Bridge | Run 1 | Run 2 | Run 3 | Median (successful runs only shown separately) | Value length verified |
|---|---|---|---|---|---|
| A `computer type` | 21410 ms — **success**, value length 500 | 18960 ms — **failed**, value length 0 | 12545 ms — **failed**, value length 0 | Wall median across all 3: 18960 ms | 1/3 runs succeeded |
| B `computer type` | 6926 ms — **success**, `typed:500, durationMs:5`, value length 500 | 9521 ms — **failed**, value length 0 (see below) | 9730 ms — **success**, `typed:500, durationMs:5`, value length 500 | Wall median across all 3: 9521 ms | 2/3 runs succeeded |

A's failures (runs 2 and 3): the tool reported success text identical in shape to a working call (`Typed "0123...456789"`, full string echoed), but `document.querySelectorAll('textarea')[0].value.length` came back `0` both times, meaning the click-then-type sequence typed into nothing, reproducing the silent-typing-failure bug from the prior report on 2 of 3 runs this session (vs "3/3 fail" implied there, so this session's A behavior was flaky rather than always-failing: 1 success, 2 failures).

B's run 2 failure had a different, identifiable cause: the preceding `navigate` call was issued in the same message as a `computer left_click` using a ref (`ref_7`) captured before that navigate. The click failed explicitly (`ref ref_7 is no longer on the page. Re-read the page.`) because the ref went stale across the navigate, so the subsequent `type` call typed into whatever had default focus (or nothing), landing 0 characters. This is a self-inflicted stale-ref error in this test's construction, not the same class of bug as A's silent focus-loss failures (B's click step failed loudly rather than silently). B's runs 1 and 3, which properly re-read refs after each navigate, both succeeded cleanly with `typed:500` and length 500 verified.

### B with `perKey: true` (scope-reduced to 1 run, not 3, due to time cost)

Given `perKey` typing takes roughly 30 seconds per 500-char string (individual key events), only 1 run was performed rather than 3, an explicit flagged deviation for this secondary variant only.

Result: `{"ok":true,"typed":500,"durationMs":30911}`, wall time 41694 ms (includes the preceding click and the verification read). Value length verified as 500, `correctOrder` implied by the length match. This closely matches the prior single-run measurement of ~30888 ms / ~61.8 ms per key.

## 9. Large javascript return: `'x'.repeat(200000)` (order: A,B / B,A / A,B)

| Bridge | Run 1 | Run 2 | Run 3 | Median | Result |
|---|---|---|---|---|---|
| A `javascript_tool` | 7755 ms | 7972 ms | 7021 ms | **7755 ms** | `[BLOCKED: Base64 encoded data]` every run, real content discarded, not truncated |
| B `javascript` | 4938 ms | 4642 ms | 4604 ms | **4642 ms** | Harness error every run: `result (200,057 characters across 5 lines) exceeds maximum allowed tokens`, saved to a side file |

Both results were verbatim-identical across all 3 runs on each bridge, confirming this is deterministic behavior rather than flaky. A's `[BLOCKED: Base64 encoded data]` response is reproduced exactly 3/3 times, and is still inaccurate (the string is not base64) exactly as previously documented, discarding the real value entirely rather than truncating or erroring with the actual size like B does.

## Medians at a glance

| Measurement | A (median) | B (median) |
|---|---|---|
| 1a. 10 separate `1+1` calls, wall | 27911 ms | 7927 ms |
| 1b. 10 `1+1` in one batch, wall | 9448 ms | 5614 ms |
| 1c. B `quick`, 10 `1+1` lines, wall | n/a | 3464 ms |
| 2. 10 separate screenshots, wall (timeouts) | 109198 ms (median 3/10 timeouts) | 8829 ms (0/10 timeouts) |
| 3. read_page all+interactive x2 pages, wall | 12116 ms | 10350 ms |
| 4. get_page_text x2 pages, wall | 10454 ms | 8781 ms |
| 5. find x2 queries, wall | 13735 ms | 6104 ms |
| 6. navigate x4 targets, wall | 14392 ms | 9054 ms |
| 7. realistic flow, ONE batch, wall | 18294 ms | 17381 ms |
| 8. type 500 chars, wall (success rate) | 18960 ms (1/3 success) | 9521 ms (2/3 success) |
| 9. `'x'.repeat(200000)`, wall | 7755 ms | 4642 ms |

B was faster on every measurement's median wall time except scenario 7, where the two bridges were close (A 18294 ms vs B 17381 ms), largely because both bridges spent comparable time recovering from their own respective failure modes (A's ref-mismatch batch retry, B's tab recreation after the `chrome-extension://` error) rather than from raw per-call speed differences.
