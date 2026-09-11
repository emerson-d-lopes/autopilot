# Checks on the user's Chrome, extension 0.1.35, 2026-09-04

Driven through `tools/mcp-client.js --browser bz04vrv3f` (the new host code), profile `Profile 3 "Emerson Lopes"`.

| Check | Result |
|---|---|
| `list_connected_browsers` | One row: profile directory, display name, account email, `sessions: linkedin.com, github.com, google.com`. Pass |
| `select_browser({site: "linkedin.com"})` | Picked Profile 3. Pass |
| `select_browser({account: "emerson.fr.lopes@gmail.com"})` | Picked Profile 3. Pass |
| Two browsers connected, no selector | `profile_ambiguous` listing both, with the hint. Pass |
| `get_page_text` on linkedin.com/feed | Returns text (750 chars) with `container: body, textNodes: 28, rejectedHidden: 383, fallback: true`. A `javascript` read of `document.querySelector('main').innerText.length` on the same tab gave 8989 and `document.visibilityState` was `visible`. Partial: the fallback works, the hidden-node filter still rejects visible content |
| `get_page_text` on notion.so | Redirected to notion.com/pt marketing page. The profile holds no Notion session cookie now (`sessions` lists none), so the Notion check cannot run in this profile. Deferred |
| Origin transition warning | Present on the first call after switching from linkedin.com to notion.com and back. Pass |

## Write rehearsal on GitHub, a private repository, allow mode

The user declined the LinkedIn flows. Confirm mode was not switched on in the user's extension, so the run exercised the write path in allow mode. Driven through `tools/mcp-client.js --browser bz04vrv3f`, session `ghrehearsal`.

| Step | Call | Result |
|---|---|---|
| Open issues/new | `tabs_create`, `wait_for_page`, `find "issue title field"`, `find "submit new issue button"` | Page opened. `find` ranked toolbar buttons above the title textbox and did not return the Create button: ranking miss. `read_page` gave `textbox "Add a title" [ref_24]`, `textbox "Markdown value" [ref_35]`, `button "Create ( )" [ref_46]` |
| Create the issue | `form_input` title, `form_input` body, `left_click ref_46`, `wait_for_page`, `page_state` | Both inputs `effects: applied, valueChanged: true`. The click ran a 250 ms window (Create is not submit-shaped in the classifier), `page_state` then showed `/issues/14`. Issue created |
| Post a comment | `form_input` on `textbox "Add a comment"`, click `button "Comment"` | First click refused with `ref_stale`: the button re-rendered from disabled to enabled. Re-read gave a new ref, click `effects: applied` with 86 mutations, `get_page_text` showed the comment. Comment is not submit-shaped either, so the window was 250 ms |
| Open the comment menu | click `button "More options" [ref_90]` | Refused: `covered by tooltip <span>`, no click sent. After Escape and `scroll_to`, the click opened the close-issue options instead, since that ref was the close button's menu. The comment's menu is `button "Actions for emerson-d-lopes's comment"`, found in the full tree |
| Delete the comment | click `menuitem "Delete" [irreversible]`, then the modal's `button "Delete" [irreversible]` | First click: 3000 ms window, 40 mutations (GitHub's modal), `effects: unknown` with empty submit evidence. Second click: `effects: applied`, `submit.fired: ["2xx from the site"]` with three 200 responses listed. `get_page_text` no longer contains the comment |
| Close the issue | click `button "Close issue"` | `effects: applied`, focus moved to `Reopen issue`, page text reads Closed. `gh issue view 14` reports `state: CLOSED, comments: 0` |

Observations for the fix list:

- `Create`, `Comment`, `Close issue` and `Delete` on GitHub are not in `SUBMIT_WORDS`, so their clicks get the 250 ms window and the navigation or network evidence lands after it. Create and Comment should count as submit-shaped, and Close issue as irreversible-with-undo (`Reopen issue`).
- A click that opened a modal (40 mutations, focus moved to Cancel) reported `effects: unknown`. When the watch saw mutations and a focus change, `applied` is the truthful value even when the submit evidence is empty.
- `find` on the new-issue page returned 20 toolbar buttons for "issue title field" and nothing for "submit new issue button" while both controls were in the tree. The exactness bonus from the first bug pass does not help when the query names a role rather than a label.
- The `ref_stale` refusal on a re-rendered button and the covered-element refusal on a tooltip both did their job: no click went to the wrong element.
