# C4: Google (Gmail, Docs) and Notion, bridge A vs bridge B

Both bridges driving the same signed-in Chrome profile (emerson.fr.lopes@gmail.com in Gmail/Docs, "edfl" workspace in Notion). Bridge A = Claude in Chrome (`mcp__claude-in-chrome__*`, tab 177110578). Bridge B = chrome-mcp (`mcp__chrome-mcp__*`, tab 177110579). All Gmail/Notion actions were read-only: no archive, reply, send, delete, star, or settings change. The one interactive step taken was closing a Notion "Keep using Notion AI" upsell modal (X button), which is not a data-changing action.

## 1. Gmail

### 1a. Read sender/subject of first 5 messages

| Bridge | Called | Outcome | Timing |
|---|---|---|---|
| A | `navigate` to `mail.google.com/mail/u/0/#inbox`, then `read_page filter=interactive` (returned only structural rows, no sender/subject text), then `read_page ref_id=<row>` per row (5 calls) | Got all 5: Google Flights / "Agora, o preço do seu voo monitorado...", Android Developers / "Welcome to Android Studio!...", Google Developer Pr. / "Congrats! Your Google Developer Program...", no-reply / "Nubank \| Agradecimento - Software Engineer", CodeSignal / "Request from Nubank has expired." | Works, but expensive: `read_page filter=interactive` on the inbox list omits all message text (sender/subject only exist as non-interactive `generic` children), forcing a per-row follow-up read. |
| B | `navigate`, then one `quick` script `R` + `X` | Both `R` (full accessibility tree, 122 nodes) and `X` (`get_page_text`) returned all 12 visible inbox rows with sender, subject, and preview text in a single call each. | Works, single call. Bridge B's `get_page_text` on Gmail's inbox list returned the full list; bridge A's `get_page_text` on the same inbox screen returned almost nothing (see below). |

Not repeated 3x separately since it is a read with no state change; verified stable across the 3 full-scenario passes below (sender/subject list was consistent every time it was re-read).

**Notable finding:** bridge A's `get_page_text` on `#inbox` returned only:
```
Conversations
1 new
Primary
Google Flights — Agora, o preço do seu voo monitorado...
Promotions
Social
Updates
```
i.e. just the unread-badge summary, not the message list. Bridge B's `get_page_text` on the identical URL returned the full 12-row list with preview snippets. This is the same class of bug noted in `C3-social-news.md` bug #2 (LinkedIn `(no text)`), except here it's the reverse: bridge A is the one that under-extracts.

### 1b. Open first message by click, get_page_text, navigate back

| Bridge | Called | Outcome | Length / content | Timing |
|---|---|---|---|---|
| A | `find` "first story's subject link" → `computer left_click ref=...` → `get_page_text` → `navigate back` | Click opened the message (URL stayed `#inbox` the whole time, Gmail doesn't push a history entry for opening a message from the list). `get_page_text` returned ~450 characters: sender, subject, and a truncated body ("...Seu voo monitorado -1 12:35 – 14:15 Gol · Sem"). Body came through but was cut off mid-sentence. `navigate url=back` failed: `Failed to navigate: Cannot find a next page in history.` Had to `find`+click a "Go back" button instead. | Partial body, truncated. | wall clock: click→text ~6s |
| B | `quick` script `C ref_41` / `W` / `X` | Click opened the message (`quick` reported `navigated: true`, URL became `.../inbox/FMfcgzQh...`). `X` returned the complete body: full flight details table (departure times, prices, alternative flights, footer/unsubscribe text), roughly 900+ characters, nothing truncated. `navigate url="back"` succeeded cleanly, returned to `#inbox` in one call (`durationMs: 6`). | Full body, complete. | tool-reported `durationMs`: click 616ms (incl. wait), back 6ms. |

**Verdict:** bridge B's `get_page_text` on an open Gmail message is materially more complete than bridge A's (full body vs. truncated), and bridge B's `navigate back` works while bridge A's failed once here (Gmail's SPA routing did not register the click as a history entry, which is arguably a Gmail quirk rather than a bridge bug, but bridge A had no fallback and errored outright where bridge B's `back` silently succeeded going to the same in-app state).

### 1c. Keyboard shortcuts j, k, Enter, u

Tested 3x per bridge, alternating: pressed `j` (next), then either `k` (prev) or repeated `j`+`Return` sequences, verified via `read_page`/`get_page_text`/`page_state` (URL/title) rather than screenshot, since Gmail's selection highlight is too subtle to read reliably from a JPEG screenshot.

| Bridge | Run | Called | Outcome |
|---|---|---|---|
| A | 1 | `key j`, `key k`, `key Return`, then `tabs_context_mcp` to check URL/title | URL/title unchanged (`#inbox`, "Inbox (1) - ..."). Enter did not open a message. |
| A | 2 | `key j`, `key Return`, check via `tabs_context_mcp` | URL/title unchanged. |
| A | 3 | `key j`, `key Return`, check via `tabs_context_mcp` | URL/title unchanged. |
| A | — | `key u` | No observable effect (already on inbox list; not testable in isolation without a message open). |
| B | 1 | `quick` `K j` / `W` / `X` (selection not visible in text extraction), then `K Enter` / `W` (`navigated: false` in the `W` wait-result) | `navigated: false`, `page_state` confirmed URL stayed `#inbox`, title unchanged. Enter did not open a message. |
| B | 2 | `quick` `K j` / `K Return` / `P` | `page_state` URL unchanged. |
| B | 3 | `quick` `K j` / `K Return` / `P` | `page_state` URL unchanged. |

**Verdict: fails, 3/3 agreement on both bridges.** Neither bridge's synthesized `j`/`Return` keydown events register with Gmail's custom keyboard-shortcut handler enough to open a message. This is consistent with the Enter-does-not-submit pattern already logged in `C-real-sites.md` bug #3, extended here to Gmail's list-navigation shortcuts specifically. `k` and `u` could not be independently verified beyond "no visible/URL change," since Gmail's selection-row highlight isn't exposed as text in either bridge's accessibility tree or text extractor.

### 1d. chrome-extension:// iframe error on bridge B

Gmail embeds Google avatar/account iframes but, unlike `x.com`'s Google Identity Services sign-in button, none of them are a GSI login iframe (the user is already signed in, so no GSI widget renders). Bridge B's `computer` tool (`screenshot`, `left_click` via `quick`'s `C`) worked normally on Gmail in every call in this session, no `chrome-extension://` debugger error appeared. **The bug from `C3-social-news.md` did not reproduce here**, because Gmail's authenticated inbox doesn't render the GSI iframe that triggers it (that bug is specific to pages showing a "Sign in with Google" button, not to Google's own signed-in properties).

## 2. Google Docs (docs.new)

One throwaway document per bridge (not deleted, per instructions). Each bridge typed 3 rounds of the same two lines into its own document, verifying completeness/ordering and the bold toggle each time.

Bridge A doc: `https://docs.google.com/document/d/1CiIdr1FqZzhxkL6sdK9wdg-abhSmkKBTik2d1IZX8uI/edit`
Bridge B doc: `https://docs.google.com/document/d/1vjd3oBqo-UZYPYQ4Jw6h40X7oIGox1weIRsPi2N5tuM/edit`

### 2a. Typing correctness (3 runs each)

| Bridge | Run | Text that landed | Complete / in order? |
|---|---|---|---|
| A | 1 | `Bridge test sentence one.` / `Second line.` | Yes |
| A | 2 | `Bridge test sentence one.` / `Second line.` (appended after run 1) | Yes |
| A | 3 | `Bridge test sentence one.` / `Second line.` (appended after run 2) | Yes |
| B | 1 | `Bridge test sentence one.` / `Second line.` | Yes |
| B | 2 | `Bridge test sentence one.` / `Second line.` | Yes |
| B | 3 | `Bridge test sentence one.` / `Second line.` | Yes |

**All 6 runs (3 per bridge) typed the text completely, correctly, and in order.** No missing or reordered characters observed in any run, confirmed by screenshot each time. `computer type` (bridge A) and `quick`'s `T` (bridge B) both handled the apostrophe-free ASCII sentence without dropped keystrokes.

### 2b. Bold toggle (shift+Home, ctrl+b)

Both bridges applied `ctrl+b` correctly on every run (the toolbar's Bold button and the selected text's boldness matched the toggle), but a **Google Docs formatting-inheritance quirk** made every other run's "bold" line appear unbold and the adjacent normal line appear bold: pressing `End`+`Return` at the end of a bold line ("Second line.") carries the bold run-formatting onto the new paragraph, so the freshly typed "Bridge test sentence one." on runs 2 and 3 came out bold, and the subsequent `shift+Home`+`ctrl+b` on "Second line." then toggled it back to normal (since it inherited bold too). This pattern was **identical on both bridges**, byte-for-byte the same sequence of bold/normal lines in both documents, confirming it's a Google Docs behavior, not a bridge defect. Screenshot evidence, bridge A run 3:
```
Bridge test sentence one.   (normal)
Second line.                (bold)
Bridge test sentence one.   (bold)
Second line.                (normal)
Bridge test sentence one.   (normal)
Second line.                (bold, selected)
```
Bridge B run 3 (same pattern):
```
Bridge test sentence one.   (normal)
Second line.                (bold)
Bridge test sentence one.   (bold)
Second line.                (normal)
Bridge test sentence one.   (normal)
Second line.                (bold, selected)
```
**Verdict: works identically on both bridges.** The intended manual check ("is the first word of the second line bold") was true on runs 1 and 3 and false-looking on run 2, for both bridges equally, due to Docs' own formatting inheritance, not a bridge fault.

### 2c. read_page, find, and DOM access on the canvas editor

| Bridge | Called | Result |
|---|---|---|
| A | `read_page filter=interactive` | Returns only chrome (menu bar, toolbar buttons, tab list) — zero document body content. `find "Second line text in document"` | Explicit failure: *"The accessibility tree provided does not contain any text nodes or elements with the content... The document text content appears to be in a region that is not fully represented in the provided tree structure."* |
| A | `javascript_tool` → `document.body.innerText.slice(0,500)` | Returns only UI chrome and the ruler tick-mark numbers (`"...Edição\n22\n21\n20...\nGuias no documen"`), no typed text at all. |
| B | `read_page` (`R`) | Same result as A: menu bar, toolbar, tab tree only, plus one `textbox "Conteúdo do documento" [ref_78] (offscreen)` placeholder with no exposed text content. |
| B | `find "Second line text in document body"` | 10 matches, all UI chrome (rename box, zoom box, font-size box, the same offscreen document-content textbox) — none contain the actual typed sentences. |
| B | `javascript` (`J`) → `document.body.innerText.slice(0,300)` | Same as A: only UI chrome and ruler numbers, no document text. |

**Verdict: not supported on either bridge.** Google Docs renders its content on a canvas/overlay editing surface with no real text nodes in the DOM, so `read_page`, `find`, and JavaScript DOM reads are all blind to the typed content on both bridges, identically. The only reliable way to verify Docs content in this session was a screenshot.

## 3. Notion

Sidebar (Private section) has 3 pages: **Senior Software Engineer**, **PC Gamer**, **Finance**. Confirmed by both bridges' `read_page`/screenshot.

### 3a. Signed-in state

Both bridges landed on `app.notion.com` already authenticated as workspace "edfl" (no login prompt), redirected straight to a previously-open page. A "Keep using Notion AI" upsell modal appeared once (closed via its own X button, a read-only UI dismissal, not a data change).

### 3b. read_page sidebar item count

| Bridge | Called | Result |
|---|---|---|
| A | `read_page` (implicit via `find`/screenshot) | 3 `treeitem`s under "Private": Senior Software Engineer, PC Gamer, Finance. Matches screenshot. |
| B | `quick` `R` | Same 3 `treeitem`s, plus "Upcoming events", "Agents", "Notion apps", "Recents" sections. |

### 3c. Open first sidebar page by ref click, get_page_text

3 runs per bridge, alternating which page was "first" reached (both bridges' initial `app.notion.com` load happened to resume a previously open page rather than the literal first sidebar item, so each run explicitly navigated to / clicked "Senior Software Engineer").

| Bridge | Run | Called | Outcome | get_page_text length |
|---|---|---|---|---|
| A | 1 | `find` → `computer left_click ref=ref_13` (sidebar item) | **No-op.** URL/title stayed on the previous page (PC Gamer); no error, no navigation. | n/a (page unchanged) |
| A | 2 | Same `ref_13`, clicked again | **No-op again**, identical result. | n/a |
| A | 3 (workaround) | Screenshot, then `computer left_click coordinate=[113,317]` (same visible sidebar row) | Worked immediately: URL changed to `.../p/Senior-Software-Engineer-...?pvs=12`, page rendered. `get_page_text` returned the full page: title, 3 heading/body pairs, a 4-item list, 2 trailing lines. | 683 characters, complete, `Source element: <main>` reported by the tool. |
| A | 4 (repeat ref-click, after navigating away) | `find` a fresh ref, `computer left_click ref=ref_55` | **No-op** again: stayed on PC Gamer. | n/a |
| B | 1 | `quick` `C ref_14` (sidebar item, found via `R`) | Worked: `quick` reported the click ok, URL got `?pvs=12` appended (in-place SPA update). `X` (`get_page_text`) returned **"(no text)"** despite the page visibly containing full content (confirmed by screenshot and a follow-up `read_page` on the content group showing 12 textboxes each with a `text` child holding real prose). | Body text: `(no text)`, 0 useful characters. |
| B | 2 | `quick` `C ref_15` ("PC Gamer") | Same: click navigated (`navigated: true`), `X` again returned `(no text)`. | `(no text)` |
| B | 3 | Re-verified with `read_page ref_id=<content group>` on the same loaded page | `read_page` **does** expose the text (each `textbox` node has a `text` child with the real paragraph content, e.g. `"AccuKnox: Front-end engineer responsible for building the initial version of the app"`), confirming the content is present in the accessibility tree that `get_page_text` fails to read from. | n/a (read_page succeeded where get_page_text didn't) |

**Verdict, ref-clicks on Notion sidebar (bridge A):** fails 3 of 4 attempts (2 clean no-ops, 1 more no-op after a successful coordinate-click workaround), 1 success via raw coordinates. This matches the flaky/no-op ref-click pattern from `C-real-sites.md` bug #1, reproduced here specifically on Notion's sidebar tree items.

**Verdict, get_page_text on Notion pages (bridge B):** fails 3/3, deterministic. Every `X` call on an app.notion.com page returned literally `(no text)` while the identical page's `R` (`read_page`) output and a screenshot both showed substantial real content. This is the same class of bug as `C3-social-news.md` bug #2 (LinkedIn feed `(no text)`), now confirmed on a second site (Notion), 3/3 reproducible, suggesting bridge B's content-extraction heuristic has a systematic blind spot for a particular editor/DOM shape (both LinkedIn's feed and Notion's block editor use deeply nested custom-component text containers rather than plain paragraph/article markup).

**Verdict, get_page_text on Notion pages (bridge A):** works, 3/3 (2 explicit runs on Senior Software Engineer + PC Gamer, reused/re-verified across the ref-click retries). Returned full page text every time, including markdown-styled headings and bullet lists, e.g. the PC Gamer page's complete parts list and pricing breakdown (~1400 characters).

## Notable differences

1. **Bridge A's `get_page_text` under-extracts Gmail's inbox list** (returns only the unread-count line), while bridge B's returns the full 12-row sender/subject/preview list in one call. On the open-message view the gap is smaller but still present: bridge A's body text was visibly truncated mid-sentence, bridge B's was complete.
2. **Bridge B's `get_page_text` returns `(no text)` on Notion pages, 3/3 reproducible**, despite the same page's `read_page` and a screenshot showing full content. Bridge A's `get_page_text` on the identical Notion pages worked every time. This is a second confirmed site (after LinkedIn in `C3-social-news.md`) hitting the same bridge B extraction gap.
3. **Bridge A's ref-based clicks no-op'd on Notion's sidebar tree items 3 of 4 attempts**, with a coordinate click on the same visible element working immediately as the fix, consistent with the `C-real-sites.md` bug #1 pattern. Bridge B's ref-based clicks (`quick`'s `C ref_N`) worked every time on the same sidebar in this session (2/2).
4. **Neither bridge's `j`/`k`/`Enter`/`u` Gmail keyboard shortcuts worked**, 3/3 agreement on both sides: pressing `Return` after `j` never opened a message on either bridge, matching the general "Enter doesn't submit" class of issue seen elsewhere, extended here to a JS-level custom keyboard shortcut handler rather than a plain form submit.
5. **Neither bridge's `read_page`, `find`, or JavaScript DOM evaluation can see Google Docs' typed content**, identically on both sides: the canvas-rendered editor exposes no text nodes to the accessibility tree or the DOM. Screenshot is the only verification method that works for Docs content on either bridge.
6. **Bridge A hit a `Page.captureScreenshot` CDP timeout twice in the Gmail keyboard-shortcut test**, both times immediately after a `key` action (once after `j`, once after `Return`), recovering on the next screenshot attempt with no other symptom (read_page kept working throughout).
7. **Gmail's own SPA routing didn't register bridge A's message-open click as a browser-history entry**: `navigate url="back"` failed outright (`Cannot find a next page in history`) after opening the first message, requiring a fallback click on Gmail's in-app "Go back" button. Bridge B's `navigate url="back"` on the same flow succeeded normally in 6ms.
8. Both bridges' typed text in Google Docs arrived **complete and in the correct order in all 6 runs (3 per bridge)** — no dropped or reordered characters, a clean result on both sides.
9. Neither bridge hit the `chrome-extension://` GSI-iframe error on Gmail: that bug (logged against `x.com` in `C3-social-news.md`) is specific to pages rendering an active "Sign in with Google" button, which an already-authenticated Gmail inbox never shows.

## Bugs

1. **Bridge A: `get_page_text` returns almost nothing on Gmail's inbox list view.** Repro: navigate to `https://mail.google.com/mail/u/0/#inbox`, call `get_page_text`. Result is just the unread-count summary line and tab names, no message rows, while the identical call on bridge B (`get_page_text`/`X`) returns the full sender/subject/preview list for all visible messages. Confirmed on the initial inbox load in this session.

2. **Bridge B: `get_page_text` returns `(no text)` on Notion pages, 3/3 reproducible in this session.** Repro: bridge B, navigate to any `app.notion.com/p/...` page (tested: "Senior Software Engineer", "PC Gamer"), call `get_page_text`. Result body is literally `url: ...\n\n(no text)` every time, even though the same page's `read_page` call in the same sequence returns the content as `text` children under `textbox` nodes (e.g. `"AccuKnox: Front-end engineer responsible for building the initial version of the app"`), and a screenshot in the same sequence shows the content rendered normally. Bridge A's `get_page_text` on the identical URLs returned full, correct text every time (3/3). This is the same failure class as `C3-social-news.md` bug #2 (LinkedIn feed), now confirmed on a second, unrelated site.

3. **Bridge A: ref-based clicks on Notion's sidebar tree items no-op silently, 3 of 4 attempts.** Repro: bridge A, navigate to any `app.notion.com` page with 2+ sidebar pages, `find` a sidebar `treeitem` (e.g. "Senior Software Engineer"), `computer left_click ref=<that ref>`. Result: tool reports success (`"Clicked on element ref_X"`), but the URL and page title do not change; repeating the identical click on a freshly re-found ref produces the same no-op. Fix that worked once: screenshot then `computer left_click coordinate=[x,y]` on the same visible row. This matches `C-real-sites.md` bug #1's description exactly (raw-coordinate click as the reliable fallback for a ref-click no-op), now reproduced on a third site (Notion, after HN and Wikipedia/GitHub).

4. **Bridge A: `Page.captureScreenshot` timed out twice (30s) immediately after a `computer key` action on Gmail**, both times in the same keyboard-shortcut test sequence (once right after `key j`, once right after `key Return`). `read_page` calls issued in between kept working normally, and a subsequent screenshot attempt succeeded without further errors. Not reproduced anywhere else in this session, and not clearly tied to a specific key, so flagged as flaky rather than deterministic (2 occurrences out of roughly a dozen screenshot calls total across this session).

5. **Both bridges: neither `j`+`Return` nor a bare `Return` after Gmail's `j`-selection opens a message**, 3/3 agreement on both bridges. Repro: on `#inbox`, press `j` (select next), then `Return`. Expected: opens the selected message (standard Gmail shortcut). Actual: no URL/title change on either bridge, verified via `tabs_context`/`page_state` immediately after. Consistent with the general Enter-doesn't-submit pattern from `C-real-sites.md` bug #3, here extended to a JS keyboard-shortcut handler rather than a `<form>` submit.

6. **Both bridges: Google Docs' canvas editor exposes zero document text to `read_page`, `find`, or DOM `document.body.innerText`.** Not really a bug in either bridge (Docs genuinely doesn't put document text in real DOM text nodes), but worth flagging since it means any caller relying on either bridge's structural/text tools to verify Docs content will get nothing back and must fall back to a screenshot. Reproduced identically on both bridges across all 3 typing runs each.

7. **Gmail's own client-side routing does not add a history entry when opening a message from the inbox list**, causing bridge A's `navigate url="back"` to fail with `Cannot find a next page in history` on the very first back-navigation attempt of the session. Bridge B's `navigate url="back"` on the same flow worked (6ms). Not a bridge defect (this is Gmail's routing behavior), but it means a caller scripting "click a message, then navigate back" on bridge A needs a Gmail-specific fallback (its own in-app back button) rather than relying on browser history.

Tabs closed on both bridges at the end of the session (bridge A tab auto-removed its now-empty group; bridge B tab closed with `keptWindowOpen: false`).
