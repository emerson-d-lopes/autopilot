# Baseline: chrome-mcp bugs re-run on 0.1.9

Phase 0, items 1 and 5 of PLAN.md. This re-runs the six chrome-mcp bugs named in PLAN.md Phase 0 item 5, plus the related bugs REPORT.md section 5.2 groups with them (B4, B5, B6, B10, B12, and the B2 text-extraction check), against the current source build on the development browser, not the user's own Chrome.

## Environment

- Chrome for Testing: 152.0.0.0, confirmed both from `npm run doctor` (`Chrome 152.0.0.0 (bwlhg5ra0)`) and from `navigator.userAgent` in the dev browser tab (`Chrome/152.0.0.0`).
- Extension: v0.1.9, 18 handlers, 25 tools advertised, per `npm run doctor`.
- Node: v24.15.0 (`node --version`), fnm default, matching the node binary the native host wrapper points at.
- Date and time of the run: 2026-09-03, starting 16:23 local (UTC-03:00).
- Two browsers were connected throughout: the user's own Chrome (`bz04vrv3f`) and the development browser (`bwlhg5ra0`). All calls in this report went to `bwlhg5ra0` after `select_browser`. The user's own Chrome was never navigated or otherwise touched.

## Setup

`npm run doctor` on the untouched repo showed one browser connected, `bz04vrv3f`, already at extension v0.1.9. `node tools/browser.js` was started in the background, and `.browsers/dev-browser-id` read back `bwlhg5ra0`. Doctor was polled until it listed both browsers; both reported `extension v0.1.9, 18 handlers, 25 tools advertised`. `select_browser` was called with `bwlhg5ra0`, and every scenario below ran in tabs created in that session's tab group on that browser.

## B1: `chrome-extension://` attach refusal on x.com

Reproduction from REPORT.md: navigate to `https://x.com/`, then call `computer` with any action (a fresh screenshot on a fresh tab). Documented as deterministic, 3 of 3 in the campaign.

- Run 1: fresh tab, `navigate` to `https://x.com/` (succeeded, title "X. It's what's happening / X"), `computer screenshot`. Result: a normal screenshot of the X sign-in page. No error.
- Run 2: tab closed, new tab created at `https://x.com/`, `computer screenshot`. Same result, sign-in page rendered cleanly.
- Run 3: tab closed, new tab created at `https://x.com/`, `computer screenshot`. Same result again.

Verdict: does not reproduce on 0.1.9, 0 of 3. The x.com page rendered in the dev browser did not show a Google Identity Services sign-in-button iframe in any of the three screenshots, only X's own native sign-in buttons (phone, Google, Apple, email). REPORT.md's B1 names that GIS iframe specifically as the trigger for the `chrome-extension://` frame Chrome refuses to attach through. Its absence here, likely because the dev browser's profile and installed-extension set differ from the user's real Chrome, means this run cannot rule the underlying attach-refusal defect in or out. It only shows the specific x.com trigger did not fire in this profile.

## B2 sanity check: `get_page_text`

The original bugs (`(no text)` on LinkedIn and on Notion) could not be reproduced in the dev browser because it is not signed in to either service. Per task instructions, `get_page_text` was instead run once each on two pages as a sanity check that the tool still extracts text at all on 0.1.9.

- `https://news.ycombinator.com`: `get_page_text` returned the full front page, 30 numbered story rows with points, submitter, age, and comment counts, plus the footer links. Not `(no text)`.
- `https://en.wikipedia.org/wiki/Chromium_(web_browser)`: `get_page_text` returned the article body (infobox fields, then prose starting "Chromium is a free and open-source web browser project..."), truncated at 24711 chars total. Not `(no text)`.

Verdict: `get_page_text` works normally on both pages. This is not a reproduction of B2, which is specific to LinkedIn's and Notion's deeply nested custom-component text containers, and remains untested here for that reason.

## B3: in-batch stale screenshot on TodoMVC

Reproduction: on `https://todomvc.com/examples/react/dist/`, in one `quick` script, click the new-todo field, type text, press Enter, then put `SS` on the last line.

- Run 1: script `C ref_11 / T Buy milk / K Enter / SS`. The returned screenshot showed the empty input field placeholder and no todo list. A follow-up `get_page_text` on the same tab (no new action) showed `Toggle All Input` and `Buy milk`, confirming the todo existed the whole time the stale screenshot was returned.
- Run 2: fresh navigate, script `C ref_11 / T Buy eggs / K Enter / SS`. Same result: screenshot empty, todo not shown.
- Run 3: fresh navigate, script `C ref_11 / T Buy bread / K Enter / SS`. Same result again, screenshot showed only the focus caret in the empty field.

Verdict: reproduces on 0.1.9, 3 of 3, exact match to REPORT.md's B3. A screenshot taken as the last line of a batch that just performed a DOM-mutating action can render a stale pre-repaint frame while the tool reports success.

## B4: `perKey` typing on jQuery UI autocomplete

Reproduction: on `https://jqueryui.com/autocomplete/`, click the Tags field, `computer type` with `text: "ja"` and `perKey: true`.

- Run 1: field click, then `type perKey:true text:"ja"`, tool returned `{ok:true, typed:2}`. Screenshot showed `ja` in the field with the Java / JavaScript dropdown open.
- Run 2: field cleared (`ctrl+a`, `Delete`), same typed call. The screenshot taken immediately after showed only `j` in the field with no dropdown, while `find` on the same element in between reported `value=ja` in the accessibility tree. A second screenshot taken with no further action showed `ja` and the dropdown, matching the accessibility tree. This is the B3 stale-frame pattern surfacing here, not the B4 symptom (field stays empty).
- Run 3: field cleared again, same typed call. Screenshot showed `ja` and the dropdown immediately.

Verdict: does not reproduce on 0.1.9, 0 of 3 for the documented symptom (silent no-op, field stays empty, `typed:2` returned but nothing landed). `perKey` typing populated the field and triggered the dropdown in all three runs. One run's immediate screenshot was stale in the B3 sense, not empty in the B4 sense, and a second screenshot on the same run confirmed the correct state.

## B5: `quick` `K /` rejects punctuation keys

Reproduction: on `https://github.com`, a `quick` script line `K /`.

- Run 1: `K /` failed: `unknown key "/". Supported: 0, 1, 2, ... f9, ...`. Script stopped at line 1.
- Run 2: identical failure, identical message.
- Run 3: identical failure, identical message.

Verdict: reproduces on 0.1.9, 3 of 3, exact match to REPORT.md's B5.

## B6: `quick` `T` and a pre-filled GitHub input

Reproduction as documented: on GitHub, press `t` to open the file finder (which is supposed to put a literal `t` in the box), then run a `quick` line `T README`, expecting the resulting query to be the concatenation `tREADME`.

- Run 1: on `https://github.com/torvalds/linux`, `TK t` then `W` then `T README`. `page_state` showed the page had navigated to `.../tree/master?search=1`, a full page navigation rather than an inline overlay. Reading the "Go to file" input's `.value` via `javascript` returned `""`, not `t` and not `tREADME`.
- Run 2: fresh navigate to the repo, `K t` then `W` (which itself reported `navigated: true`) then `T README`. Same result: input value `""`.
- Run 3: fresh navigate to the repo, `K t` then `T README` with no `W`. Same result: input value `""`.

A manual control (click directly into the "Go to file" box with `computer left_click`, then `computer type text:"README"`) populated the box correctly (`value: "README"`), confirming the box itself accepts normal typed input and the tool is not globally broken on this page.

Verdict: the originally documented symptom (literal `t` left in the box, `T README` appending to give `tREADME`) does not reproduce on 0.1.9, 0 of 3, because GitHub's file finder has since changed from an inline overlay that retains the keystroke to a full page navigation to `?search=1`. A different defect shows up in its place, 3 of 3: pressing `t` triggers a navigation, and the `quick` `T` command's typed text is lost entirely, landing on neither the old page nor the new one, even when a `W` wait is inserted before it. The box ends up empty rather than containing `README`. This looks like the same underlying gap the plan's C2 and C3 items are meant to close (a `T` immediately after a navigation-triggering key has nothing reliable to target), but it is not the bug as REPORT.md describes it, so it should be treated as a new, unconfirmed-against-history finding rather than a straight reproduction.

## B10: `gif_creator stop` elapsed time

Reproduction: start a recording, drive the page for several seconds with distinct actions, stop.

- Run 1: start, click the TodoMVC field, type "Test task one", Enter, wait 6s (wall clock, confirmed by `waitedMs: 6012` on the wait call), stop. Result: `Recorded 5 frames over 0.1s at 480x428.`
- Run 2: same pattern, "Test task two", wait 8s (`durationMs: 8006`). Result: `Recorded 5 frames over 0.1s at 480x428.`
- Run 3: same pattern, "Test task three", wait 10s (`durationMs: 10018`). Result: `Recorded 5 frames over 0.1s at 480x428.`

Verdict: reproduces on 0.1.9, 3 of 3. The reported elapsed time does not track the actual recording span (6 to 10 seconds of wall clock in these runs) and stayed fixed near zero (`0.1s`, versus REPORT.md's `0.0s`) regardless of how long the recording actually ran. Cosmetic, matching REPORT.md's assessment: the exported GIF files themselves were written successfully each time.

## B12: `resize_window` reporting

Reproduction: call `resize_window` to a target size, then check whether the window and the reported viewport actually changed.

- Run 1: `resize_window` to 800x600. Tool's own reply and a following `javascript` read of `window.outerWidth/outerHeight/innerWidth/innerHeight` gave `{outerWidth:868, outerHeight:912, innerWidth:856, innerHeight:763}`, and the tool's `viewport` field read `{width:856, height:763}`, matching neither the requested 800x600 nor changing from the window's prior state.
- Run 2: `resize_window` to 1000x700. Identical readback: `{outerWidth:868, outerHeight:912, innerWidth:856, innerHeight:763}`, `viewport` still `{856,763}`.
- Run 3: `resize_window` to 600x500. Identical readback again: `{outerWidth:868, outerHeight:912, innerWidth:856, innerHeight:763}`, `viewport` still `{856,763}`.

Verdict: reproduces on 0.1.9, 3 of 3, and more completely than REPORT.md's original finding. REPORT.md's B12 concluded the resize itself worked and only the reported `viewport` field was wrong (a counter-example there showed `outerWidth` actually changing to 1001x700 after a request for 1000x700). In this run, across three different requested sizes, neither the reported `viewport` nor the actual window `outerWidth`/`outerHeight` changed at all in the dev browser: the window stayed at 868x912 the whole time. Whether this is a regression or a difference in how the dev browser's window is managed (it may not be a normal top-level Chrome window Windows will resize the same way) is not established by this run alone.

## Summary table

| Bug | 0.1.7 result (REPORT.md) | 0.1.9 result (this run) |
|---|---|---|
| B1: `chrome-extension://` attach refusal on x.com | Reproduces, 3 of 3, deterministic | Did not reproduce, 0 of 3. The GIS sign-in iframe that triggers it did not render in the dev browser's profile, so the underlying defect is neither confirmed nor ruled out here |
| B2: `get_page_text` returns `(no text)` on LinkedIn / Notion | Reproduces, 3 of 3 on each site | Untested (dev browser not signed in). Substitute sanity check on Hacker News and Wikipedia: `get_page_text` returned full text both times, no `(no text)` |
| B3: stale screenshot inside a batch on TodoMVC | Reproduces, 2 occurrences noted | Reproduces, 3 of 3 |
| B4: `perKey` typing silently types nothing on jQuery UI autocomplete | Seen once | Did not reproduce, 0 of 3. Field populated and dropdown opened every time; one run's immediate screenshot was stale (the B3 pattern) but a second screenshot on the same run showed the correct state |
| B5: `quick` `K /` rejects punctuation keys | Seen once | Reproduces, 3 of 3, identical error text |
| B6: `quick` `T` does not clear a pre-filled GitHub input | Seen once (`tREADME` concatenation) | Original symptom did not reproduce, 0 of 3, because GitHub's file finder now navigates instead of showing an inline overlay. A different symptom reproduced 3 of 3 instead: the `T` text is lost entirely and the box stays empty |
| B10: `gif_creator stop` always reports `over 0.0s` | Reproduces, 5 of 5 recordings, cosmetic | Reproduces, 3 of 3, cosmetic (reported `0.1s` instead of `0.0s`, still unrelated to the true 6 to 10 second span) |
| B12: `resize_window` reports a viewport that never changes | Reproduces the reporting bug; a counter-example showed the actual resize did take effect | Reproduces, 3 of 3, and here the actual window size did not change either across three requested sizes, not only the reported field |

## Notes for later phases

- B1 needs to be re-tried against a page or trigger that reproduces reliably in the dev browser's own profile (for example, deliberately loading a second extension that injects a `chrome-extension://` iframe, as PLAN.md's C2 acceptance criterion already plans to test against) before it can be dropped or kept for Phase 2 with confidence.
- B4 and B6 no longer reproduce in their originally documented forms. Per PLAN.md Phase 0 item 5, bugs that do not reproduce are candidates to drop from later phases, but B6's replacement symptom (typed text lost after a navigation-triggering key) looks like a live instance of the same class of defect Phase 1's C2 and C3 are meant to fix, so it is worth keeping as a tracked case even though it is not the literal bug from REPORT.md.
- The development browser (`bwlhg5ra0`) was left running after this session, as required for the verification pass. It was not stopped.
