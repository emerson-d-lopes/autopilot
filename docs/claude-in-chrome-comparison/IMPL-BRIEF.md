# Implementation brief for plan agents

You are implementing part of [PLAN.md](PLAN.md) in `C:\Users\edfl\workspace\chrome-mcp`. Read PLAN.md, then the items you own in [IMPROVEMENTS.md](IMPROVEMENTS.md) (they carry file and function locations read from the 0.1.9 source), then README.md, STATUS.md, HANDOFF.md and SPEC.md at the repo root. Read the source files you will touch in full before editing.

## Ground rules

- You work in a git worktree on your own branch. Commit on that branch as you go with plain descriptive messages. Never touch `main`, never push, never open a PR.
- Bump `version` in `extension/manifest.json` once per branch if you changed anything under `extension/`. Read the current value first. Increment the patch number. Say the new value in your final report.
- Background mode is a design rule: nothing activates a tab or focuses a window, ever. Hidden tabs are woken with `cdp.wake`. Do not reintroduce `chrome.tabs.update({active: true})` or `chrome.windows.update({focused: true})` anywhere.
- Do not run the full test suite as a gate. Run the test files you touch with `node --test test/<file>` and add tests for what you build. Browser-driven test files skip themselves when no bridge is listening, which is expected in a worktree.
- Live verification against a browser is done AFTER merge by a separate pass, not by you. Your job is correct code, unit tests, and precise notes on what the live pass must check. Write those notes in your final report under "Live checks required".
- Shell escaping strips backslashes from regexes when patching through `node -e`. Use the Edit tool or write patch files.
- Do not delete or rewrite existing tests. Do not change tool names or argument names in `host/schemas.js`, only add.
- Keep chrome-mcp's measured advantages intact (IMPROVEMENTS.md, "Where chrome-mcp is already ahead, keep it"). If a change would alter one of them, stop and say so in the report instead.

## Writing rules for any prose you produce (STATUS.md entries, comments, commit messages, reports)

No em dashes. No semicolons in prose. No "not X but Y" constructions. No restating. No empty emphasis or puffery. Plain descriptive headings in sentence case. No filler connectives (moreover, furthermore, additionally, notably, simply, finally). No AI stock vocabulary (robust, seamless, leverage). No idioms. Straight ASCII quotes. Say what you ran when you claim something works, and say when something is untested.

## Result contract every tool must satisfy after Phase 1 (C1)

Success: `{ok: true, effects: "none"|"applied"|"unknown", evidence: {...}, warnings: [...], id}`.
Failure: `{ok: false, error: {code, message, cause, hint, effects, retryable}, id}`.
Codes live in `host/errors.js` and are the single source: `tab_gone`, `tab_replaced`, `attach_refused`, `attach_recovered`, `renderer_throttled`, `dialog_open`, `ref_stale`, `ref_covered`, `element_disabled`, `no_effect`, `nav_failed`, `origin_changed`, `origin_blocked`, `confirmation_required`, `host_lost`, `timeout`, `output_truncated`, `browser_unknown`, `profile_ambiguous`. If your track needs a code that is not listed, add it to the catalogue and say so.
Existing result fields (`durationMs`, `navigated`, token estimates, `tabId`, `url`, `status`) stay where they are. The contract adds fields, it does not remove any.

## Final report format

1. Branch name and the commit list.
2. Files changed, one line each on what changed.
3. Tests added or changed, and the exact `node --test` commands you ran with their pass and fail counts.
4. New manifest version, if any.
5. Live checks required: a numbered list, each naming the page, the call, and the expected result, so the verification pass can run them without reading your code.
6. Anything you could not finish, and why.
