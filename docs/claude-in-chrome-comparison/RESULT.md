# Result: what the plan built, and how the scorecard stands

Written 2026-09-04 against [PLAN.md](PLAN.md), which was written from [REPORT.md](REPORT.md). The project was named chrome-mcp and its extension was named Lantern when both of those were written. It is now Autopilot, and the older documents keep the old names because they describe the builds that were measured.

## 1. Summary

Two days of work took chrome-mcp 0.1.9 to Autopilot 0.2.0. PLAN.md was built out across sixteen branches and 124 commits, all merged into `plan/integration2`: ten feature branches for plan phases 0 to 8, three branches of fixes for what the live passes found, two integration branches and one rename branch. Nothing is committed on `main` and nothing is pushed.

Five live passes drove the merged build against a Chrome for Testing instance carrying a second extension that forces the debugger-attach refusal, and a sixth set of checks ran against the user's own signed-in Chrome. 155 numbered checks ran across the five passes, plus seven on the user's Chrome and a six-step GitHub write rehearsal. 21 commits landed as fixes while the passes ran. The fifth pass closed every check it ran. `node --test --test-concurrency=1` over the 24 non-browser test files is 673 of 673, run for this report.

Of the 23 scorecard rows, 17 are met, 5 are partial and 1 could not be measured. The partials are `get_page_text` on LinkedIn and Notion, the native-host kill, the per-call `browser` argument, the screenshot byte ratio and semantic `find` escalation. Each cell below says why. The unmeasured row is the LinkedIn write flows, which the user withdrew from scope. Phase 9 certification was not run, so no row here is a re-measurement of the campaign against Claude in Chrome.

## 2. The scorecard

Columns A and B are as PLAN.md recorded them: A is Claude in Chrome 1.0.90, B is chrome-mcp 0.1.7. "Measured after" is Autopilot as driven in the five live passes and on the user's Chrome, each cell citing its evidence file and check number.

| Area | Metric | A measured | B measured | Target | Measured after | Met |
|---|---|---|---|---|---|---|
| Reliability | Tabs lost to a refused debugger attach on x.com, 3 runs | 0 | 3 | 0, and if a tab is ever unrecoverable it is replaced and the result says so | 0 lost, 3 of 3 screenshots, `{"ok":3,"fail":0,"recovered":0,"lost":0}` (VERIFY-0.1.11 check 24), reproduced in all four later passes (VERIFY-0.1.39 check 15a). With recovery switched off and the interferer forcing the refusal, every tab is replaced and the result names the cause and the new tab id (VERIFY-0.1.11 check 26) | yes |
| Reliability | Calls that reported success with no effect, whole campaign | 20 or more | 2 | 0 unflagged: a click, type or submit with no observable change returns that fact | A click on an inert element returns `effects: none` with the warning `no observable change within 250ms` (VERIFY-0.1.11 check 7). A type with nothing able to hold text focused returns `no_effect` naming what did have focus (VERIFY-0.1.11 check 36). A click whose handler swallows the event returns `effects: unknown` with a re-read hint (VERIFY-0.1.28 check 39). Reproduced in every later pass (VERIFY-0.1.39 check 15a) | yes |
| Reliability | Screenshot timeouts in 30 calls | 10 | 0 | 0 | 0 of 30. `npm run bench` at 0.1.39, three runs of ten captures, `failures: []` on every run (VERIFY-0.1.39 check 16) | yes |
| Reliability | `get_page_text` returns content on LinkedIn feed and Notion pages, 3 runs each | 6 of 6 | 0 of 6 | 6 of 6 | LinkedIn on the user's Chrome at 0.1.35 returned 750 characters against `main.innerText` of 8989 (USER-CHROME-0.1.35). The hidden-node filter was rewritten for that and holds on the fixture `/feed.html`, 433 characters against `main.innerText` of 439 with `rejectedHidden` at 2 (VERIFY-0.1.39 check 10). LinkedIn itself was not re-driven after the fix. Notion cannot be checked in this profile, which holds no Notion session cookie (USER-CHROME-0.1.35) | partial |
| Reliability | In-batch screenshot after a mutating click shows the post-click state | untested | 0 of 2 | 2 of 2 | 3 of 3 on TodoMVC, a `quick` script of `C` / `T` / `K Enter` / `SS` with no wait, the todo present in the returned image and the page text (VERIFY-0.1.11 check 28, re-run VERIFY-0.1.28 check 47 and VERIFY-0.1.39 check 15a). A capture that follows a submit also carries `evidence.paint` from 0.1.34 (VERIFY-0.1.34 check 12) | yes |
| Reliability | `perKey` types into jqueryui autocomplete | not applicable | 0 of 1 | 3 of 3 | 3 of 3, `{"value":"ja","menuItems":["Java","JavaScript"],"menuOpen":true}` (VERIFY-0.1.11 check 29, re-run VERIFY-0.1.28 check 17 and VERIFY-0.1.39 check 15a) | yes |
| Reliability | Session survives an `alert()` and a `beforeunload` | no | no | yes, with the dialog text in the result | alert, confirm and prompt each return `dialog: {type, message, handled}` with the text, and the call after each one works (VERIFY-0.1.11 check 13). A `beforeunload` cancels the navigate with `dialog_open` and the force hint, and `force: true` leaves the page (VERIFY-0.1.11 check 14) | yes |
| Reliability | Every error carries a code, a cause, a recovery hint and a side-effect flag | no, prose strings | partly | yes, all tools | 25 codes in `host/errors.js`, printed with the retry table by `npm run doctor` (VERIFY-0.1.11 check 1). Every read ends in a contract line and every click carries `ok`, `effects`, `evidence`, `warnings` and `id` (VERIFY-0.1.11 checks 44 and 45). Every line of a batch or a `quick` script carries its own from 0.1.31 (VERIFY-0.1.31 check 7) | yes |
| Reliability | Native host killed mid-call | untested | recovered in 401 ms after the call | the in-flight call completes or returns an error naming the loss | Measured as the MCP server killed with SIGKILL 1200 ms into a 4 s `/slow` navigate: the response was parked and replayed on reconnect, and the navigation had completed (VERIFY-0.1.11 check 15). A park left 135 s expires at 126 s and the host log says so (check 16). The native host itself was not killed on this build | partial |
| Profiles | Two profiles on one machine are distinguishable in `list_connected_browsers` | pick from a list, user-named at pairing | identical names | profile directory, display name, account email and signed-in sites | Two rows, each with browser version, local and dev flags, profile directory, display name, account and sessions (VERIFY-0.1.11 check 2). The user's Chrome row reads its profile directory, display name, `emerson.fr.lopes@gmail.com` and `sessions: linkedin.com, github.com, google.com` (USER-CHROME-0.1.35). The second row was the development browser rather than a second signed-in profile | yes |
| Profiles | `select_browser` by site session | no | no | `select_browser({site: "linkedin.com"})` picks the profile holding a session there | It picked Profile 3, one run, as did `select_browser({account: "emerson.fr.lopes@gmail.com"})`. With two browsers connected and no selector the call returns `profile_ambiguous` listing both, with the hint (USER-CHROME-0.1.35) | yes |
| Profiles | A tool call names its browser | no | session-wide choice only | per-call `browser` argument, session default kept | The `browser` argument is declared on every page tool in `host/schemas.js`, and the selection logic behind it is covered by `test/registry.test.js`, 20 of 20. Every live pass routed with the `AUTOPILOT_BROWSER` startup default instead (VERIFY-0.1.11 checks 53 to 56), so the per-call argument was never driven against a browser | partial |
| Writes | Send a LinkedIn message, edit a LinkedIn profile field, post a comment, 3 runs each | untested | untested | 3 of 3 with the effect verified by re-reading the page | The user declined the LinkedIn flows, so the message send and the profile edit were withdrawn from scope (USER-CHROME-0.1.35). The comment flow ran once instead on GitHub, in allow mode: comment posted with `effects: applied` and 86 mutations, read back with `get_page_text`, then deleted through the UI with `submit.fired: ["2xx from the site"]` and confirmed gone by a second `get_page_text` | unmeasured |
| Writes | Irreversible action without confirmation in `confirm` mode | not applicable | possible | refused with a confirmation token, then allowed once | Refused with `confirmation_required` naming the control, the origin and a single-use token bound to tab, origin and control. The same call carrying the token went through with all four submit signals, and the token a second time was refused (VERIFY-0.1.28 check 40). From 0.1.33 the refusal also renders the screenshot id, and `computer {"action":"screenshot","imageId":...}` fetches that capture (VERIFY-0.1.34 check 7) | yes |
| Writes | Audit trail of every write | none | journal, unredacted | journal entry with correlation id, target, before and after evidence, redacted values | Every Send press is a row under `## Writes` with control, origin, before-capture id, after-signals, undo, value and call id (VERIFY-0.1.28 check 45). With `AUTOPILOT_JOURNAL_REDACT` set on the host, arguments read `args redacted` and the write value reads `[value redacted]` (check 46), and from 0.1.33 a `javascript` return value is dropped too (VERIFY-0.1.34 check 10) | yes |
| Speed | 10 separate `1+1` calls, wall median | 27911 ms | 7927 ms | under 7000 ms | 53 ms, `npm run bench` row 1a at 0.1.39 (VERIFY-0.1.39 check 16). The two columns do not measure the same thing: the 0.1.7 figure carries a model round trip per call, and `tools/bench.js` times the tool calls alone | yes |
| Speed | 10 screenshots, wall median | 109198 ms | 8829 ms | under 6000 ms | 1501 ms on a freshly launched browser, `npm run bench` row 2 at 0.1.39 (VERIFY-0.1.39 check 16). On the browser instance that had been up for the whole pass the same row read 5967 to 23309 ms, which is that pass's one open bug and is unattributed | yes |
| Tokens | Full-viewport screenshot on CNN | not printed | PNG, about 1516 tokens | JPEG at the same dimensions with several times fewer bytes on the wire, and under 1100 tokens at `scale: 0.85` (the token estimate is a function of pixel dimensions, so format alone cannot lower it) | 486 tokens at `scale: 0.85` on CNN against 672 unscaled, so the token half is met with room (VERIFY-0.1.28 check 3). The byte half is not: JPEG against PNG at the same dimensions is 31 KB against 67 KB, 2.2x, on both `/index` and `/big` at every build measured (VERIFY-0.1.28 check 4, VERIFY-0.1.39 check 16) | partial |
| Tokens | `read_page interactive` on CNN and The Verge returns inline | yes, by under-reporting | no | yes, with an explicit truncation line | CNN 20273 characters inline and The Verge 20275, with `truncated. 158 more nodes not shown, 310 in total (34497 chars). Narrow with ref_id, filter or depth, or raise max_chars.` A raised `max_chars` returns 34721 and 23603 (VERIFY-0.1.11 check 38) | yes |
| Detectability | deviceandbrowserinfo.com `isAutomatedWithCDP` with console capture off | false | true | measured after D1 and documented either way | `isAutomatedWithCDP: false` and `isBot: false`, three runs, with every other flag in the payload false (VERIFY-0.1.28 check 20). A CDP trace of a session that never reads the console carries no `Runtime.enable` at all, 56 calls (check 10). sannysoft, browserscan and CreepJS were clean on the same three runs, CreepJS at 0 percent headless and 0 percent stealth | yes |
| Safety | Password typed through `computer type` appears in the journal or a result | not applicable | yes | no | `grep -c CANARY` is 0 in both the Markdown and the JSONL journal after typing a canary password, and the entry reads `text="[value redacted]"` (VERIFY-0.1.11 check 12). `read_page` shows `value="[value redacted]"` on password and card fields, and `form_input` returns `{"value": "[redacted]", "sensitive": true}` (check 11) | yes |
| Parity | GIF export carries click rings and labels | yes | no | yes | Frames decoded one by one through `gifview.html` carry an action label pill, a red click ring, the drawn cursor, a progress bar and a watermark, and a drag frame carries the orange drag line (VERIFY-0.1.28 checks 21 and 23, VERIFY-0.1.31 check 14). The acting indicator was removed from frames at 0.1.33 and the watermark given a dark stroke at 0.1.35 (VERIFY-0.1.34 check 4) | yes |
| Parity | Semantic `find` query resolves | yes, 5 to 12 s | no | yes, local first, model escalation on a low score | Local ranking resolves `btn 2999` as match 0 over a 6000-node tree in 111 ms, and `50.20` above `20.50` on `/large` in 54 ms (VERIFY-0.1.31 check 1). With `semantic: true` the escalation decision is made and reported, and `source: model` is unreachable because `tools/mcp-client.js` declares no MCP sampling capability (VERIFY-0.1.28 check 24) | partial |

Totals: 17 met, 5 partial, 0 not met, 1 unmeasured.

Three things named in PLAN.md could not be measured at all. LinkedIn writes, because the user withdrew them from scope during the rehearsal on their own Chrome. Notion reads, because that profile holds no Notion session cookie. Phase 9 certification, a re-run of the campaign groups on both bridges with the two scorecards side by side, which was not run, so nothing above is a fresh comparison against Claude in Chrome.

## 3. What changed, by phase

**Phase 0, baseline and harness.** `plan/harness`, one commit `de26456`, which `plan/integration` was branched from, so it carries no merge commit of its own. It landed the campaign fixture and its Node server with the routes PLAN.md names, plus `/sensitive.html`, `/unload.html`, `/scroll.html` and `/composer.html`, `test/campaign.test.js` as the "already ahead" table, and `tools/bench.js` behind `npm run bench`. The re-run of the six chrome-mcp bugs on the current build is `evidence/BASELINE-0.1.9.md`: B3, B5, B10 and B12 reproduced, B1, B4 and B6 did not in their documented form. Shipped in the merged build at extension 0.1.11.

**Phase 1, the call contract.** `plan/host-contract` (merge `89844f5`) landed C1 as one result shape and one error catalogue in `host/errors.js`, C4 as the retry table printed by `npm run doctor`, C6's host half as a parked response queue with a generation stamp, and C7's correlation ids with journal rotation and the redaction switch. `plan/attach-recovery` (merge `b304049`) landed C2's recovery ladder with tab replacement, C5's answered dialogs and bounded frozen renderer, the offscreen keepalive, and R14 batch pre-validation. C3, every input arming a watch in the page and reporting `effects` and `evidence`, came with `plan/content-verify` (merge `dbb62ca`). All at 0.1.11.

**Phase 2, the six measured bugs and the read tools.** `plan/content-verify` (merge `dbb62ca`) carried R2 with the `get_page_text` body fallback and container report, R3's screencast-frame wait, R5's per-key key codes, R7's adopted tabs, S4's `read_page` budget, S7, P5 and P9, at 0.1.11. R1 landed inside C2 on `plan/attach-recovery`, S5 and S6's output caps on `plan/host-contract`. The rest of the acceptance came later on the fix branches: the `find` ranking budget, `newTabId` on a click that opens a tab, and a `resize_window` that actually resizes the window, all on `plan/bugs` (merge `fec1d6b`, 0.1.31), the ref click aimed at a line box on `plan/bugs2` (merge `bf4a772`, 0.1.33), and the `find` role weighting on `plan/bugs3` (merge `23715b5`, 0.1.38).

**Phase 3, multiple Chrome profiles.** `plan/profiles`, one commit `bc6771f`, merge `be0a396`, at 0.1.11. M1 through M5: the profile directory, display name and account per connected browser read from the process tree and `Local State`, a user-set label from the options page, signed-in site detection through the cookies permission, `select_browser` by label, profile, account or site, a per-call `browser` argument, `AUTOPILOT_BROWSER` as the startup default, the development browser excluded from site selection, and the profile row in `npm run doctor`. Proved on the user's own signed-in Chrome at 0.1.35 (USER-CHROME-0.1.35).

**Phase 4, write actions.** `plan/writes` (merge `f9d7e9f`) at 0.1.13 landed W2's submit window with five named signals under `evidence.submit.fired`, W3's irreversibility classifier in `agent.js` with the `[irreversible]` mark on `read_page`, W4's confirm mode with a single-use token bound to tab, origin and control plus the ask-in-browser notification, W5's before-and-after write rows in the journal, and W7's undo hints. W1's editor path was already working at 0.1.11: `form_input` on the composer's contenteditable reports `mode editor` with `setBy Input.insertText` (VERIFY-0.1.11 check 10). W6's three rehearsed flows were rehearsed on `/composer.html` offline, and the GitHub flow ran on the user's Chrome at 0.1.35.

**Phase 5, speed and tokens.** `plan/screenshots`, which `plan/integration2` was branched from, so no merge commit, at 0.1.13. JPEG at quality 0.75 by default with `format`, `quality` and `scale`, a byte budget that lowers quality before size, a clip fast path, a hidden-tab path taking the screencast frame at the target size, a batch frame held from `beginBatch` to `endBatch`, and `npm run bench:screenshot`. The clip fast path did not actually engage until `planCapture` was fixed on `plan/bugs2` at 0.1.33, which VERIFY-0.1.34 check 1 confirms.

**Phase 6, safety and privacy.** Split across four branches. F1's sensitive-field redaction came with `plan/content-verify` and F2 and F3 with `plan/host-contract`, both at 0.1.11. F4's three-state acting indicator with Stop and Resume came with `plan/indicator` (merge `15d05f5`) at 0.1.13, and F5's plan mode and F6's domain-transition grant with `plan/writes` (merge `f9d7e9f`) at the same version. F6's warning did not reach the `navigate` that causes the transition until `plan/bugs2` at 0.1.33.

**Phase 7, detectability.** `plan/detect` (merge `729b72f`) at 0.1.13. D1 makes `Runtime.enable` opt-in per tab with an `always` setting and a pre-arm for a batch whose later step reads the console, D3 draws each inter-key interval around a 60 ms mean, D4 moves the pointer along a bowed 3 to 6 point path inside the gap it already spent, and `tools/probe-detect.js` measures both. D2, the random overlay host id, came with `plan/indicator`. Step 7.2's re-run of the four detector pages is VERIFY-0.1.28 check 20.

**Phase 8, parity and polish.** `plan/gif-find` (merge `9669484`) at 0.1.13. P1's GIF overlays, P2's real elapsed time, P6's `find` escalation through MCP sampling, P7's caret placement, P8's history-entry navigate wait, P10's zoom-chord refusal and pointer force, and P11's upload filename normalization. P2 was still reporting the stop call's own latency until `935e887` at 0.1.29. P3's browser label and P4's in-browser confirm arrived with `plan/profiles` and `plan/writes` respectively.

**Phase 9, certify.** Not run. No dated second REPORT.md exists and neither bridge was re-driven through the campaign groups on the new build.

**The three fix waves.** `plan/bugs` (merge `fec1d6b`) at 0.1.31 closed the ten bugs the first live pass left open. `plan/bugs2` (merge `bf4a772`) at 0.1.33, with three further fixes on `plan/integration2` at 0.1.34, closed the ten the second pass left open and the three the third opened. `plan/bugs3` (merge `23715b5`) at 0.1.38, with three further fixes at 0.1.39, closed the five the checks on the user's Chrome opened and the three the fourth pass opened.

**The rename.** `plan/rename` (merge `4a83d46`) at 0.2.0. Lantern and chrome-mcp became Autopilot across the toolbar label, the popup and options pages, the indicator pill, the doctor and the log output, the npm package `autopilot-chrome`, the MCP server name `autopilot`, the native host id `com.autopilot.host`, the `AUTOPILOT_*` environment variables and the journal directory. `host/env.js` falls back to the old variable names for one release, and `npm run log` still reads the old journal directory.

## 4. Live verification

Every pass drove the development browser, Chrome for Testing 152, launched by `node tools/browser.js --interferer` with `test/fixtures/interferer` loaded so the `chrome-extension://` attach refusal fires on every page. Every call went through `tools/mcp-client.js`, which spawns `host/mcp-server.js` from the working tree. No pass activated a tab or focused a window, and no pass drove the user's Chrome.

| Pass | Evidence | Build tested | Checks run | Passed | Fixed during the pass | Partial | Failed | Deferred |
|---|---|---|---|---|---|---|---|---|
| 1 | VERIFY-0.1.11.md | 0.1.11 to 0.1.27 | 57 | 39 | 5 | 6 | 2 | 7 |
| 2 | VERIFY-0.1.28.md | 0.1.28 to 0.1.30 | 48 | 35 | 4 | 8 | 1 | 0 numbered |
| 3 | VERIFY-0.1.31.md | 0.1.31 to 0.1.32 | 14 | 9 | 3 | 2 | 0 | 0 numbered |
| 4 | VERIFY-0.1.34.md | 0.1.34 to 0.1.37 | 17 | 14 | 2 | 0 | 1 | 0 numbered |
| 5 | VERIFY-0.1.39.md | 0.1.39 | 19 | 19 | 0 | 0 | 0 | 0 numbered |

Two notes on the first row. Its summary table says 39 passed, and its own list of check numbers enumerates 37, which with the other four rows totals the 57 checks the pass numbered. Its seven deferred checks are 27 and 30 to 35, all needing either a signed-in profile or a DevTools window opened by hand.

Passes 2 to 5 deferred nothing inside the numbered set. Each carries a separate table of work needing a signed-in profile: the LinkedIn and Notion reads, profile selection by site and by account, and the three W6 write rehearsals in confirm mode, in ask-in-browser mode and in plan mode. Pass 5 also lists the five browser-driven test files it did not run (`live`, `e2e`, `edge`, `resilience`, `shortcuts`) and fourth-pass checks 4, 8, 10 and 13, which its own checks supersede.

Pass 5's single commit `3c253d6` added the fixture pages checks 11 to 14 needed rather than fixing behaviour, so nothing under `extension/` changed and the manifest stayed at 0.1.39.

### Checks on the user's Chrome

Extension 0.1.35, profile `Profile 3 "Emerson Lopes"`, driven through `tools/mcp-client.js --browser bz04vrv3f`. Written up in USER-CHROME-0.1.35.md. Five passed, one was partial, one was deferred.

| Check | Result |
|---|---|
| `list_connected_browsers` | Profile directory, display name, account email and `sessions: linkedin.com, github.com, google.com`. Pass |
| `select_browser({site: "linkedin.com"})` | Picked Profile 3. Pass |
| `select_browser({account: "emerson.fr.lopes@gmail.com"})` | Picked Profile 3. Pass |
| Two browsers connected, no selector | `profile_ambiguous` listing both, with the hint. Pass |
| `get_page_text` on linkedin.com/feed | 750 characters against `main.innerText` of 8989 on the same tab. The fallback works, the hidden-node filter still rejected visible content. Partial, and the cause of the `plan/bugs3` rewrite |
| `get_page_text` on notion.so | The profile holds no Notion session cookie, so the page redirected to marketing. Deferred |
| Origin transition warning | Present on the first call after switching from linkedin.com to notion.com and back. Pass |

### The GitHub write rehearsal

Run in allow mode on the user's private repository `camelo-discord-bot`, session `ghrehearsal`, at extension 0.1.35. Confirm mode was not switched on in that browser, so the run exercised the write path without the confirmation gate. The user declined the LinkedIn flows before it started.

| Step | Result |
|---|---|
| Open `issues/new` | Page opened. `find "issue title field"` ranked twenty markdown toolbar buttons above the title textbox and `find "submit new issue button"` did not return Create. `read_page` gave both controls |
| Create issue 14 | Both `form_input` calls `effects: applied, valueChanged: true`, the Create click ran a 250 ms window, `page_state` then showed `/issues/14` |
| Post a comment | The first click was refused with `ref_stale` because the button re-rendered from disabled to enabled. A re-read gave a new ref and the click reported `effects: applied` with 86 mutations. `get_page_text` showed the comment |
| Open the comment menu | Refused with `covered by tooltip <span>`, no click sent |
| Delete the comment | The menu item click opened GitHub's modal, 40 mutations, `effects: unknown`. The modal's Delete reported `effects: applied` with `submit.fired: ["2xx from the site"]` and three 200 responses. `get_page_text` no longer contained the comment |
| Close the issue | `effects: applied`, focus moved to `Reopen issue`, the page text read Closed |

Verified outside the browser: `gh issue view 14` reported `state: CLOSED, comments: 0`.

Five bugs came out of this run and are the `plan/bugs3` fix list: GitHub's write controls getting only the 250 ms window, a modal-opening click reporting `unknown`, `find` ignoring the role a query names, no note when a query names a role the page does not carry, and the `get_page_text` hidden-node filter.

## 5. Bugs found and fixed during verification

Twenty-one commits, in the order the passes made them.

1. `10c621f` Added `tools/mcp-client.js` and `tools/browser.js --interferer`, the tooling the first pass needed to drive the working tree.
2. `5682768` (0.1.12) A click on an inert element reported `effects: applied`, because focus falling back to the body counted as a focus change.
3. `e2f8f31` (0.1.19) A screenshot of a hidden tab failed outright, then returned the surface as it was before the redraw.
4. `9ef39d7` The bench measured calls that had failed, so ten permission errors read as ten fast screenshots.
5. `6847f35` (0.1.20) The watch tracked the focused element rather than the one a write named, and `/dialog` gained confirm and prompt buttons.
6. `9fc1e91` (0.1.23) A barren capture window was fatal instead of raised as `timeout` for the read retry policy.
7. `214ee82` (0.1.24) An opened tab's opener was recorded after the click had already read the bookkeeping.
8. `e3350af` (0.1.25) Chrome's own `chrome://` refusals were classified as `internal` rather than `origin_blocked`.
9. `394be2a` (0.1.26) Per-key typing inserted every character twice, so `ja` arrived as `jjaa` and no autocomplete opened.
10. `f0b17fd` (0.1.27) A type with nothing able to hold text focused reported `ok`.
11. `7091092` `tools/probe-detect.js` read the `javascript` result envelope as the recording, so every run printed that nothing was measured.
12. `935e887` (0.1.29) A recording reported the stop call's own latency instead of its span, because `runTool` overwrites `durationMs`.
13. `a981f2e` Added a second file input and a gif frame viewer to the campaign fixture.
14. `e646106` The composer fixture sends on Enter, since a form does not submit implicitly from a contenteditable.
15. `8894336` (0.1.30) The indicator pill painted while marked hidden, leaving an empty dark capsule on every driven tab.
16. `e4c2e59` (0.1.32) A type into a field inside an iframe was reported as `no_effect`, and the host's retry then typed the text twice.
17. `56b01c9` (0.1.32) A click that opens a tab reported no `newTabId`, because Chrome names the active tab as the opener and background mode never activates one.
18. `8c39149` (0.1.35) The gif watermark was white with nothing behind it, so hiding the acting indicator left it invisible on a light page.
19. `3d27dbe` (0.1.36) A screenshot on a frozen tab paid the CDP deadline twice, reporting a 20 s timeout after 40 s.
20. `6eb9a03` (0.1.37) The same fix amended so a page carrying no content script is still captured.
21. `3c253d6` Added the fixture pages the fifth pass's checks 11 to 14 needed: a Close issue control and a modal-opening Delete on `/composer.html`, and `/newissue.html`.

## 6. Open items

**One open bug.** Capture latency drifts up on a long-lived Chrome for Testing instance (VERIFY-0.1.39, new open bug 1). Ten screenshots took 5967, 6294, 23309 and 19098 ms across four `npm run bench` invocations on the instance that had been up for the whole pass, against 1501 ms on a freshly launched one. Only the capture rows moved, every other row stayed within a few percent, and the payloads were byte-identical, so the same bytes came back and the wait for them was up to 13x longer. Four candidate causes were measured on a fresh browser and none reproduced it: 62 open tabs, 200 consecutive captures on one tab, twelve more attached tabs and twelve more sessions, and the pass's own worker instrumentation. Restarting the browser clears it every time. Attribution is unresolved and it may be Chrome for Testing rather than this code.

**`chrome.runtime.reload()` on Chrome for Testing 152.** It takes an unpacked extension down and Chrome does not bring it back (VERIFY-0.1.31, open bug 3). The profile records `disable_reasons [16777216]`, the service worker and offscreen targets are gone, creating a tab does not wake it, and only a browser restart restores the bridge. Three runs, deterministic, and the interferer loaded from the same command line stays enabled. The first pass ran the same call on 0.1.11 and the bridge came back, so this is Chrome rather than the extension. It matters because that call is how a developer picks up an edit, and because the session-restore path can now only be exercised by stopping the worker from `chrome://serviceworker-internals` or with `Target.closeTarget`. Related and standing: with the bridge attached Chrome never stops the idle worker, because the extension holds a native messaging port (VERIFY-0.1.34, open bug 2, reconfirmed in pass 5).

**Deferred by the passes.** Pass 1 deferred checks 27 and 30 to 35: a real DevTools window opened by hand on a session tab, and the LinkedIn, Notion and profile checks needing a signed-in browser. Passes 2 to 5 each carry a deferred table with the same shape: the LinkedIn and Notion reads, profile selection by site and by account, `list_connected_browsers` against two real signed-in profiles, and the three W6 write rehearsals in confirm mode, in ask-in-browser mode and in plan mode. Pass 2 also left unrun a real press on the ask-in-browser notification's Allow and Deny buttons, which is an operating system control, `find` with `semantic: true` reaching `source: model`, which needs a client offering MCP sampling, and a comparison of two separate browser profiles, since `tools/browser.js` writes one fixed profile directory. Passes 4 and 5 left the five browser-driven test files (`live`, `e2e`, `edge`, `resilience`, `shortcuts`) unrun. `npm test` as a whole was never run as a gate, by the working rule in HANDOFF.md.

**LinkedIn.** The user declined the LinkedIn write flows during the rehearsal on their own Chrome, so W6's message send and profile edit were withdrawn from scope. The read side was measured once, before the fix, at 750 characters of 8989.

**Notion.** The profile holds no Notion session cookie, so `notion.so` redirects to a marketing page and neither the read check nor the write rehearsal can run there.

**Phase 9 certification.** Not run. The campaign groups from `evidence/BRIEF.md` were not re-driven on both bridges, and no dated second REPORT.md with the two scorecards side by side exists.

**Nothing is on `main` and nothing is pushed.** `main` and `origin/main` are both at `ececc33`, and `origin/main` is the only remote branch. All 124 commits sit on `plan/integration2` and its fifteen feeder branches, in the local clone only.

## 7. How to pick it up

The branch is `plan/integration2` in `C:\Users\edfl\workspace\autopilot`. The extension is 0.2.0, and so is the npm package.

Because the rename changed the native messaging host id, the first run needs more than an extension reload.

1. `npm run install-host`, which registers `com.autopilot.host` and removes the old `com.chromemcp.host` entry from every browser it finds, naming what it removed.
2. Restart Chrome fully, so it reads the new registration. A reload alone leaves it on the host id it started with.
3. Reload the extension at `chrome://extensions`.
4. `npm run doctor`. It must print `extension v0.2.0`, and it prints a note if a browser still carries the old entry.

Then:

- `npm run bench` for the eleven measurements against the 0.1.7 medians, three runs written to `.bench/`. Run it on a freshly launched browser, since the open bug above inflates the capture row on a long-lived one. `npm run bench:screenshot` for the capture path on its own.
- `node tools/mcp-client.js <tool> '<json args>' [--browser dev]` to drive `host/mcp-server.js` from the working tree, which is how every live pass ran. A Claude Code session's own MCP tools are bound to whichever server process it started, so they run older code.
- `node tools/browser.js --interferer` for the development browser with the second extension loaded, which forces the `chrome-extension://` attach refusal on every page so the recovery ladder is exercised. Add `--detach` to keep it running without holding the shell.
- `node --test --test-concurrency=1` over the 24 non-browser test files is 673 of 673, run for this report. The six browser-driven files (`live`, `e2e`, `edge`, `resilience`, `shortcuts`, `campaign`) need a bridge and skip themselves without one, except `campaign.test.js`, which the passes ran at 12 of 12.

The evidence lives in `docs/claude-in-chrome-comparison/evidence/`. The original campaign is the ten files from `A-local-site.md` through `X-official-internals.md` plus `BRIEF.md`. The work described here is `BASELINE-0.1.9.md` for the Phase 0 re-run, `VERIFY-0.1.11.md`, `VERIFY-0.1.28.md`, `VERIFY-0.1.31.md`, `VERIFY-0.1.34.md` and `VERIFY-0.1.39.md` for the five live passes, and `USER-CHROME-0.1.35.md` for the checks and the write rehearsal on the user's own Chrome. STATUS.md carries the same history as dated entries, one per merge and one per pass.
