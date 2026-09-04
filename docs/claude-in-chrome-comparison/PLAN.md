# Plan: make chrome-mcp better and more reliable than Claude in Chrome, with profiles and real writes

Written 2026-09-03 from [REPORT.md](REPORT.md) and [IMPROVEMENTS.md](IMPROVEMENTS.md). Item codes (R1, S1, F1, D1, P1) refer to IMPROVEMENTS.md, which carries the evidence, the file and function for each change, and the effort estimate. Items introduced by this plan carry new codes (C for the call contract, M for multi-profile, W for write actions).

Three requirements shape it.

1. Reliability is a hard requirement. A session never loses a tab, every call ends in a verified success or a structured error, and a silent no-op is a bug.
2. Several Chrome profiles can be connected at once, and the agent can tell which one to drive by name, account or by which site it is signed into.
3. Modifying real data on signed-in sites is a supported use case: sending a LinkedIn message, editing a profile, posting, changing settings. It is supported with verification, an audit trail and a confirmation step for actions that cannot be undone.

## Definition of done

Column A is Claude in Chrome 1.0.90 as measured in the campaign. Column B is chrome-mcp 0.1.7 as measured. Rows without a measurement are new requirements.

| Area | Metric | A measured | B measured | Target |
|---|---|---|---|---|
| Reliability | Tabs lost to a refused debugger attach on x.com, 3 runs | 0 | 3 | 0, and if a tab is ever unrecoverable it is replaced and the result says so |
| Reliability | Calls that reported success with no effect, whole campaign | 20 or more | 2 | 0 unflagged: a click, type or submit with no observable change returns that fact |
| Reliability | Screenshot timeouts in 30 calls | 10 | 0 | 0 |
| Reliability | `get_page_text` returns content on LinkedIn feed and Notion pages, 3 runs each | 6 of 6 | 0 of 6 | 6 of 6 |
| Reliability | In-batch screenshot after a mutating click shows the post-click state | untested | 0 of 2 | 2 of 2 |
| Reliability | `perKey` types into jqueryui autocomplete | not applicable | 0 of 1 | 3 of 3 |
| Reliability | Session survives an `alert()` and a `beforeunload` | no | no | yes, with the dialog text in the result |
| Reliability | Every error carries a code, a cause, a recovery hint and a side-effect flag | no, prose strings | partly | yes, all tools |
| Reliability | Native host killed mid-call | untested | recovered in 401 ms after the call | the in-flight call completes or returns an error naming the loss |
| Profiles | Two profiles on one machine are distinguishable in `list_connected_browsers` | pick from a list, user-named at pairing | identical names | profile directory, display name, account email and signed-in sites |
| Profiles | `select_browser` by site session | no | no | `select_browser({site: "linkedin.com"})` picks the profile holding a session there |
| Profiles | A tool call names its browser | no | session-wide choice only | per-call `browser` argument, session default kept |
| Writes | Send a LinkedIn message, edit a LinkedIn profile field, post a comment, 3 runs each | untested | untested | 3 of 3 with the effect verified by re-reading the page |
| Writes | Irreversible action without confirmation in `confirm` mode | not applicable | possible | refused with a confirmation token, then allowed once |
| Writes | Audit trail of every write | none | journal, unredacted | journal entry with correlation id, target, before and after evidence, redacted values |
| Speed | 10 separate `1+1` calls, wall median | 27911 ms | 7927 ms | under 7000 ms |
| Speed | 10 screenshots, wall median | 109198 ms | 8829 ms | under 6000 ms |
| Tokens | Full-viewport screenshot on CNN | not printed | PNG, about 1516 tokens | JPEG at the same dimensions with several times fewer bytes on the wire, and under 1100 tokens at `scale: 0.85` (the token estimate is a function of pixel dimensions, so format alone cannot lower it) |
| Tokens | `read_page interactive` on CNN and The Verge returns inline | yes, by under-reporting | no | yes, with an explicit truncation line |
| Detectability | deviceandbrowserinfo.com `isAutomatedWithCDP` with console capture off | false | true | measured after D1 and documented either way |
| Safety | Password typed through `computer type` appears in the journal or a result | not applicable | yes | no |
| Parity | GIF export carries click rings and labels | yes | no | yes |
| Parity | Semantic `find` query resolves | yes, 5 to 12 s | no | yes, local first, model escalation on a low score |

The "Where chrome-mcp is already ahead, keep it" table in IMPROVEMENTS.md is turned into tests in Phase 0 so a regression fails a run.

## Constraints every phase works under

- Background mode from 0.1.9 stays: tabs open unselected, nothing activates a tab or focuses a window. Any retry that would raise a window uses `cdp.wake` instead. A repaint wait cannot use `requestAnimationFrame` on a hidden tab, so it waits for a screencast frame that postdates the last input event.
- Bump `version` in `extension/manifest.json` on every change under `extension/`. `npm run doctor` printing the version is how a reload is proven.
- Test against reality. Each step ends by driving a real browser through the page the evidence names, and STATUS.md says what was run.
- No full-suite gate during development. Run the touched test file and the live check.
- Another session edits this repo. HANDOFF.md is updated at the end of each phase with what landed, the build it shipped in, and the live checks.
- All campaign findings describe build 0.1.7. Phase 0 re-checks them on the current build before any fix is written.

## Phase 0: baseline and harness

1. Reload the extension, run `npm run doctor`, record the version.
2. Move the campaign fixture into the repo: `test/fixtures/campaign/index.html` and a Node port of `server.py` with the routes `/slow`, `/big`, `/redirect`, `/spa`, `/dialog`, `/api/ok`, `/api/missing`, `/api/echo`. Add a page with a password field, a `beforeunload` handler, an `overflow:hidden` body with an inner scroll container, and a LinkedIn-shaped message composer (a contenteditable inside a form with a Send button that enables on input) so write flows can be rehearsed offline.
3. `test/campaign.test.js`: the "already ahead" table as assertions.
4. `tools/bench.js` and `npm run bench`: the nine measurements from `R-repeat-performance.md`, three runs each, medians and `durationMs`, one JSON row per run under `.bench/`.
5. Re-run the six chrome-mcp bugs from REPORT.md section 5.2 on the current build. Record in STATUS.md which reproduce. Drop from later phases any that do not.

Exit: a baseline bench file, `test/campaign.test.js` passing, STATUS.md listing the reproduced bugs with the build number.

## Phase 1: the call contract, so no call can fail silently

This phase is new relative to IMPROVEMENTS.md and comes before the individual bug fixes, because the fixes in Phase 2 are verified against it.

### C1. One result shape for every tool

Every tool returns `{ok, effects, evidence, warnings}` on success and `{ok: false, error: {code, message, cause, hint, effects, retryable}}` on failure.

- `effects` is `none`, `applied` or `unknown`. `unknown` is returned only when the tool cannot tell, and Phase 2 works to make that rare. A caller that sees `unknown` on a write must re-read before retrying.
- `evidence` is what proved the success: the navigation that started, the DOM mutation count, the focus change, the value read back, the new tab id.
- `code` comes from a fixed catalogue in `host/errors.js`, shared by the extension and the host, with one entry per failure class: `tab_gone`, `tab_replaced`, `attach_refused`, `attach_recovered`, `renderer_throttled`, `dialog_open`, `ref_stale`, `ref_covered`, `element_disabled`, `no_effect`, `nav_failed`, `origin_changed`, `origin_blocked`, `confirmation_required`, `host_lost`, `timeout`, `output_truncated`, `browser_unknown`, `profile_ambiguous`.
- `hint` says what to do next in one sentence, the way the existing dead-tab and foreign-tab messages already do.

Where: `host/errors.js` new, `host/mcp-server.js` result marshalling, `extension/src/lib/tools.js` every handler, `host/schemas.js` descriptions updated to describe the shape. Effort: large, because it touches every tool. Priority: highest, since every later acceptance test reads these fields.

### C2. A tab is never lost

Policy, applied in `extension/src/lib/cdp.js` `attach` and in the batch runner:

1. On a refused attach, run the recovery from R1 (remove foreign `chrome-extension://` iframes, retry up to 4 times with a 75 ms settle).
2. If still refused, detach, wait 250 ms, reattach once.
3. If still refused, and the tab is a session tab, open a replacement tab at the same URL in the same group, unselected, transfer the session record, close the dead tab, and return `code: tab_replaced` with `{oldTabId, newTabId, url}` and the warning that page state such as form input is gone. The call that triggered it is retried on the new tab only when `effects` of the original was `none`.
4. If the tab is not a session tab, return `attach_refused` with the frame list, which the code already gathers.

Acceptance: 50 consecutive `computer` calls across x.com, the local fixture with iframes, and a page where the dev browser's second extension injects a `chrome-extension://` iframe, with zero calls ending in a dead tab. Every replacement is visible in the journal.

### C3. Every input is verified

After any `click`, `type`, `key`, `form_input`, `scroll`, `drag` or `file_upload`, the content script reports what changed within a window (250 ms default, 1000 ms after a click that started a navigation): DOM mutations, focus, value, scroll offset, navigation start, new tab. The tool result carries it as `evidence`. When nothing changed, the result is `ok: true, effects: none, warnings: ["no observable change within 250ms"]`. Merges R8, R9, R13 and R15 from IMPROVEMENTS.md.

Acceptance: the `/big` listener test returns `changed: true`, an inert element returns the warning, a wheel scroll on an `overflow:hidden` body falls back to `scrollBy` and reports the offset, the 500-character type into a hidden tab lands 3 of 3.

### C4. Retry policy by side effect

A retry table in `host/mcp-server.js`: reads retry up to 3 times on `renderer_throttled`, `timeout` and `host_lost`. Inputs with `effects: none` retry once. Inputs with `effects: unknown` or `applied` never retry automatically. Writes marked irreversible (Phase 6) never retry. The table is printed by `npm run doctor`.

### C5. Dialogs, foreign debuggers and freezes are results, not hangs

R6 (JavaScript dialogs, including `beforeunload` with a `force` on `navigate`), R12 (foreign attach as a distinct error), and a freeze path: when a CDP command exceeds its timeout, wake the tab through `cdp.wake`, retry once, then return `timeout` with `hint: "the renderer did not respond, reload the tab with navigate"` rather than blocking for 30 s the way Claude in Chrome's screenshot does.

### C6. The host never loses a result

R10 (offscreen keepalive) and R11 (result queue with TTL and a generation counter). Acceptance: kill the native host during a 4 s `/slow` navigate, the call returns the navigation result after reconnect or `host_lost` naming what was lost. Idle 10 minutes, then one screenshot inside 1 s.

### C7. Correlation ids and the journal

Every call gets an id that appears in the result, in the journal, in the popup's recent calls and in every error. The journal records `effects` and `evidence` per call. With F1 and F3 applied, values from sensitive fields are redacted and files rotate.

Exit for Phase 1: `test/campaign.test.js` asserts the result shape on every tool, the 50-call tab-loss run passes, the resilience suite has the host-kill and idle cases, and no tool in `host/schemas.js` describes a prose-only result.

## Phase 2: the six measured bugs and the read tools

| Step | Item | Acceptance | Verification |
|---|---|---|---|
| 2.1 | R1 inside C2 | x.com `computer screenshot` 3 of 3 on fresh tabs | Live on the user's Chrome |
| 2.2 | R3, screencast-frame wait before an in-batch screenshot | TodoMVC add and delete show the post-click state 3 of 3 with no `W` | Live, hidden tab |
| 2.3 | R2, `get_page_text` fallback to `body` with a container report | LinkedIn feed and two Notion pages, 3 of 3 each | Live, signed in |
| 2.4 | R5, `perKey` into an iframe input | jqueryui autocomplete shows suggestions 3 of 3 | Live |
| 2.5 | R7, adopted tabs in the click result | `#blanklink` returns the new tab id | Live on the fixture |
| 2.6 | R14, batch pre-validation | Bad ref in item 5 runs nothing | `test/e2e.test.js` |
| 2.7 | S4, `read_page` budget and `max_chars` on `quick` `R` | CNN and The Verge return inline with a truncation line, `/big` returns the first rows plus the count not shown | Live |
| 2.8 | S5, S6, output caps for network, console and javascript | CNN unfiltered network read returns inline with `total` and `returned`, `'x'.repeat(200000)` returns 50 KB plus a note | Live and bench 9 |
| 2.9 | S7, `quick` `K` punctuation and `TR` | GitHub `/` and `t` flows work from `quick` | Live on GitHub |
| 2.10 | P5, `find` scope on large pages | `/large` and `/tables` resolve without `include_all` | Live |
| 2.11 | P9, `resize_window` reports outer and viewport sizes | Result carries both | Live |

Exit: all six bugs closed on the current build, the reliability rows of the scorecard met.

## Phase 3: multiple Chrome profiles

Chrome loads one extension instance per profile, so each profile already appears as its own browser in the registry. What is missing is identity and selection.

### M1. Identify the profile behind each connection

In `host/native-host.js`, at startup, walk the process tree to the parent `chrome.exe` (on Windows the chain is chrome.exe, cmd.exe wrapper, node.exe, read through `Get-CimInstance Win32_Process` ParentProcessId, on macOS and Linux through `ps -o ppid=`). Read `--profile-directory` from its command line, defaulting to `Default`, and `--user-data-dir` when present. Read `Local State` under the user data dir, `profile.info_cache[<dir>]`, for `name`, `user_name` and `gaia_name`. Send all of it in the registry record.

In the extension, add the `identity` permission and call `chrome.identity.getProfileUserInfo({accountStatus: "ANY"})` in the hello frame, which returns the Chrome-signed-in email without a prompt. Add a user-set label in `chrome.storage.local`, editable from the options page (P3).

`list_connected_browsers` then prints, per browser: id, label, profile directory, profile name, account email, Chrome version, whether it is on this machine (registry host name equals `os.hostname()`), and whether it is the development browser.

### M2. Which sites each profile is signed into

Add the `cookies` permission. On `list_connected_browsers` and on demand, the extension checks a small table of session cookies (`linkedin.com` `li_at`, `github.com` `logged_in` and `user_session`, `google.com` `SID`, `x.com` `auth_token`, `notion.so` `token_v2`, `reddit.com` `reddit_session`, `amazon.com` `x-main`, `mail.google.com` through `google.com`) and reports `sessions: ["linkedin.com", "github.com"]`. For a site outside the table, `sessions_for(url)` reports whether any cookie for that registrable domain is marked secure and httpOnly with an expiry beyond the session, which is the shape a login cookie has, and says the check is heuristic.

### M3. Selection by name, account or site

`select_browser` accepts `browserId`, `label`, `profile` (directory or display name), `account` (email) or `site` (a domain). A `site` match with two candidates returns `profile_ambiguous` listing both. Every page tool accepts an optional `browser` argument that overrides the session default for that call, so one session can read one profile and write in another without switching. `tabs_context` groups its listing by browser.

### M4. Configuration and defaults

`CHROME_MCP_BROWSER` in the MCP server env and a `--browser` argument select the default at startup, so a Claude Code project can pin a profile in its MCP config. `npm run doctor` prints every connected profile with its sessions.

### M5. Development browser is not a profile

The Chrome for Testing browser keeps its own marker in the registry (`.browsers/dev-browser-id` already does this) and is excluded from `site` selection unless asked for by id.

Acceptance: with two profiles open, `list_connected_browsers` shows two distinct rows with names and sessions, `select_browser({site: "linkedin.com"})` picks the right one 3 of 3, a `read_page` with `browser` set reads from the other profile without changing the session default, and a third profile with no LinkedIn session is never chosen for it. Tests: `test/registry.test.js` new, using a fake `Local State` and a fake process tree.

## Phase 4: write actions on signed-in sites

The campaign never sent anything. This phase makes sending, editing and posting reliable, verified and auditable.

### W1. A real editor path

P12 from IMPROVEMENTS.md, made concrete: `form_input` on a contenteditable delegates to a real click to focus, `ctrl+a` when replacing, then CDP `Input.insertText`, which fires `beforeinput` and `input` with the `inputType` rich editors expect. `computer type` gains `replace: true`. Verified against the fixture composer, LinkedIn's message box, LinkedIn's post composer, GitHub's comment box (a textarea, the control case), and Notion's block editor.

### W2. Submit verification

After a click on a submit-shaped control (a `button[type=submit]`, a button named Send, Post, Save, Publish, Reply, or an Enter in a composer), the evidence window extends to 3 s and looks for: the composer emptied, a new node containing the sent text, a network request with a 2xx to the site's API, a toast, or a navigation. The result's `evidence` names which. If none fires, `effects: unknown` and a hint to re-read.

### W3. Irreversible-action classification

A classifier in `extension/src/content/agent.js` marks a control as irreversible when its accessible name or the form's action matches send, post, publish, delete, remove, pay, purchase, confirm order, transfer, unsubscribe, or when the page is in the permissions blocklist's payment category. The classification is a warning on `read_page` (`[irreversible]` after the name) so the model knows before it clicks, and it feeds W4.

### W4. Confirmation modes

A fourth permission mode, `confirm`, next to the existing three. In it, a click on an irreversible control returns `confirmation_required` with a token, the control's name, the page origin and a screenshot id showing the state about to be submitted. The same call repeated with `confirm: <token>` within 2 minutes performs it. Two ways to approve:

- In the client, by the agent passing the token back after the user says yes. This is the default and needs nothing new in Chrome.
- In the browser, optionally: the extension shows a Chrome notification with Allow and Deny buttons (`chrome.notifications` with `buttons`), and the pending call resolves on the click. The options page turns this on. Background mode is preserved because a notification does not focus a tab.

A site allow-list in the options page grants write actions without confirmation on named origins, for a user who has decided LinkedIn messaging is routine.

### W5. Before and after evidence

For every irreversible action the journal stores the correlation id, the origin, the control name, a screenshot before, and the `evidence` after. Values typed into the composer are stored only when the journal's redaction switch is off and the field is not sensitive under F1. `npm run log` shows writes in their own column.

### W6. Rehearsed flows

Three flows are scripted as `quick` shortcuts and rehearsed live, three runs each, with the effect verified by re-reading the page and, where the site offers it, by reading the sent item back through its own UI:

1. Send a LinkedIn message to a connection: open messaging, pick the thread, type, send, verify the message appears in the thread with the right text.
2. Edit a LinkedIn profile field: open the profile, open the headline editor, replace the text, save, verify the new headline renders, then restore the original the same way.
3. Post a GitHub issue comment on a repository the user owns, verify it appears, then delete it through the UI, which exercises the irreversible classifier twice.

The user chooses the recipient, the field and the repository before the run, and the run is done with the user present, since these are real writes to real accounts.

### W7. Undo where the site allows it

For actions the site can reverse (a LinkedIn profile edit, a GitHub comment, a Notion block), the result carries an `undo` hint naming the control that reverses it. For actions it cannot (a sent message), the result says so, which is also what the `[irreversible]` mark on `read_page` says beforehand.

Acceptance: the three flows pass 3 of 3, `confirm` mode blocks the first attempt and allows the tokened retry, the journal shows each write with before and after evidence, and a run with the journal redaction switch on stores no message text.

## Phase 5: speed and tokens

| Step | Item | Acceptance |
|---|---|---|
| 5.1 | S1, JPEG with a byte budget, `format` and `quality` on the schema | CNN screenshot under 1100 tokens at unchanged dimensions |
| 5.2 | S2, downscale inside CDP with `clip.scale`, decode and verify | 10 screenshots median under 6000 ms |
| 5.3 | S3, documented `scale` with the full-resolution coordinate frame | Half-scale screenshot, then a click from its coordinates lands correctly |
| 5.4 | Transport floor | 10 `1+1` calls under 7000 ms wall, `durationMs` 1 to 4 ms. Profile `host/ipc.js` framing first if it is not |

## Phase 6: safety and privacy

| Step | Item | Acceptance |
|---|---|---|
| 6.1 | F1, sensitive field redaction in the tree, `form_input` results and the journal | Password value reads `[value redacted]` everywhere |
| 6.2 | F2, credential-shaped redaction in javascript results, keyed on value shape | `document.cookie` redacted, `location.href` with a query string returned intact |
| 6.3 | F3, journal rotation and redaction switch | Old files pruned at host start, redact mode stores no argument strings |
| 6.4 | F6, domain-transition grant | A redirect to another origin is noted in `allow` mode and requires a grant in `grant` mode |
| 6.5 | F4, acting indicator with a Stop button | Visible on the driven tab, absent from screenshots, Stop halts a running batch |
| 6.6 | F5, plan mode | One approval for a declared domain list |

## Phase 7: detectability

| Step | Item | Acceptance |
|---|---|---|
| 7.1 | D1, `Runtime.enable` only when console capture is requested | A CDP trace of a session without `read_console_messages` shows no `Runtime.enable` |
| 7.2 | Re-run deviceandbrowserinfo.com, browserscan, sannysoft and CreepJS, 3 runs, capture off | The verdict is recorded either way and appended to `evidence/` |
| 7.3 | D5, README states the measured outcome | Read the README |
| 7.4 | D2, D3, D4 | Random cursor id, jittered `perKey` cadence, interpolated mouse path inside the existing hover gap |

## Phase 8: parity and polish

P1 GIF overlays, P2 real elapsed time, P6 `find` model escalation through MCP sampling with a capped tree, P4 in-browser confirm for `switch_browser` (which M3 partly supplies), P7 caret, P8 back and forward wait, P10 `force` and zoom chords, P11 upload filename normalization.

## Phase 9: certify

Re-run the campaign groups from `evidence/BRIEF.md` on both bridges, three runs, on the new build, plus the three write flows from W6 and a two-profile selection test. Write a dated second REPORT.md with the two scorecards side by side. The claim is made only when every row is met, and any row not met returns to its phase with the new measurement attached.

## Work that does not need an extension reload

These land in `host/` and can proceed while the user's Chrome runs an older build: C1 result marshalling and the error catalogue, C4 retry table, C6 result queue, C7 correlation ids, M1 process-tree and `Local State` reading, M3 and M4 selection and defaults, S5 and S6 caps, F2 and F3, P6 sampling, `tools/bench.js`. Start each phase with its host-side items.

## Effort

| Phase | Content | Rough total |
|---|---|---|
| 0 | Baseline and harness | 1 to 2 days |
| 1 | Call contract | 4 to 5 days |
| 2 | Measured bugs and read tools | 3 days |
| 3 | Profiles | 2 to 3 days |
| 4 | Write actions | 4 to 5 days, plus the supervised rehearsals |
| 5 | Speed and tokens | 1 to 2 days |
| 6 | Safety | 3 to 4 days |
| 7 | Detectability | 1 day |
| 8 | Parity | 3 to 4 days |
| 9 | Certify | 1 day of agent time |

About five working weeks for one person. Phases 1, 3 and 4 are the ones that change what the tool can be trusted with, and they are ordered first for that reason.

## Handoff after each phase

Update HANDOFF.md with the items that landed, the build version, the live checks and their outcome, and the scorecard rows now met. Update STATUS.md's bug list and parity table. Mark each IMPROVEMENTS.md item done with its version so the evidence and the fix stay linked.
