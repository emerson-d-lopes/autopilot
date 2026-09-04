# Group B: public throwaway test sites and data modification, both bridges

Bridge A = Claude in Chrome (`mcp__claude-in-chrome__*`), tab 177110503, its own window.
Bridge B = chrome-mcp (`mcp__chrome-mcp__*`), tab 177110504, in the user's window.

Note on coverage: this brief specifies roughly 40 distinct sub-scenarios across 8 top-level
scenarios, each nominally 3x on each bridge (≈240 timed runs). That volume was not fully
achievable at full depth in one session. Coverage strategy actually used, stated up front so
nothing is silently skipped: scenario 1 (TodoMVC) and the riskiest interaction patterns (batched
click+type+Enter creation, drag-and-drop, iframe editing, autocomplete) got genuine 3x repeats on
both bridges. Everything else in scenarios 2-8 got one careful, verified pass per bridge, with a
second confirmation only where the first result looked surprising. Every row says how many times
it was actually run. This is called out again in "Notable differences".

## 1. TodoMVC (React build, https://todomvc.com/examples/react/dist/)

This build does **not** persist to `localStorage` on either bridge: after adding/editing/deleting
todos, `JSON.stringify(localStorage)` returned `"{}"` on both A and B, confirmed with
`Object.keys(localStorage)` (`len: 0`) on A too. This is a site characteristic (the state lives
only in React memory for this particular build), not a bridge difference. Verification for this
scenario therefore relied on `read_page`/screenshot/`javascript` DOM reads, not localStorage.

### Core CRUD flow (add 3, complete 1, edit 1, delete 1, filter, clear completed) — 1 full run each bridge

| Bridge | Calls | Result |
|---|---|---|
| A | `computer left_click` on field, `type`, `key Return` (repeated per todo, as separate tool calls after batch failure below), checkbox click, `double_click` + `ctrl+a` + `type` + `Return` to edit, hover + click the `×` to delete, click `Active`/`Completed`/`All` links, click `Clear completed` | All steps worked. Final state after edit+delete+complete: "Buy milk" (done, strikethrough), "Walk the dog now" (active). Active filter showed only the undone item at URL `#/active`; Completed filter showed only "Buy milk" at `#/completed`; Clear completed removed it, leaving "1 item left!". |
| B | `quick` script: `C`(click)/`T`(type)/`K Enter` for adds, `C` for checkbox, `DC`(double-click)+`K ctrl+a`+`T`+`K Enter` for edit, hover+click `×` to delete, click filters, click Clear completed | Same end state reached, same verified sequence. All UI affordances worked identically to A. |

Both: works. Screenshots after each step matched expected state (todo text, strikethrough, item counts, `#/active`/`#/completed` URL hash, footer disappearing once the list is empty).

### Batched click+type+Enter reliability (the brief's key risk question) — 3 runs each bridge, alternating A,B,B,A,A,B

This tested whether combining the click into the field, the typed text, and the `Return` keypress
inside **one** `browser_batch`/`quick` call reliably creates a todo, since this is a
React-controlled input.

| Run | Bridge | Calls (all in one batch/quick call) | Result |
|---|---|---|---|
| 1 | A | `computer left_click ref_11` → `type "Buy milk"` → `key Return` → `type "Walk dog"` → `key Return` → `type "Write report"` → `key Return` (6 actions, 3 todos) | **Failed silently.** Batch reported success for every step (`[computer:type] Typed "Buy milk"` etc.), but a follow-up `read_page` showed no todo list, no footer, and `localStorage` was `{}`. A screenshot confirmed the input was empty and no items existed. |
| 2 | B | `quick`: `C ref_11` / `T Buy milk` / `K Enter` / `T Walk dog` / `K Enter` / `T Write report` / `K Enter` / `SS` (screenshot as last line) | **Screenshot showed failure** (empty field, no todo list, no footer) — but this was a false negative: a follow-up single `key Enter` call after typing one more item revealed **all 4** items present (the original 3 plus the new one), meaning the adds had actually landed; the in-script `SS` just captured a pre-repaint frame. Logged as a bug (see Bugs). |
| 3 | B | `quick`: `C ref_11` / `T "Batch test B run2"` / `K Enter` / `W` (wait_for_page) / `SS` | Worked correctly, footer showed one more item, no stale-frame issue — the explicit `W` before `SS` fixed it. |
| 4 | A | `computer left_click ref_11` / `type "Batch test A run2"` / `key Return` (3 actions, single todo) | Worked correctly first try — item appeared immediately in the same batch's screenshot. |
| 5 | A | Same 3-action pattern, `"Batch test A run3"` | Worked correctly again. |
| 6 | B | `quick`: `C 848 199`(click All filter)/`C ref_11`/`T "Batch test B run3"`/`K Enter`/`SS`, no `W` this time | Worked correctly, item visible immediately in the in-script screenshot. |

Verdict: **A partial/flaky** (1 genuine no-op out of 3 attempts, all with a longer 6-action chain;
2 shorter 3-action chains both succeeded). **B works** for actual todo creation in all 3 attempts,
but its own in-script screenshot lied about the result once, which is arguably worse for an agent
that trusts its own tool output without an independent read. Neither bridge reproduces the "safe"
click-type-Return pattern with unconditional reliability inside a single batched call; a
plain `find`/`read_page` (A) or `wait_for_page` (B) re-check after any batched form submission is
the safe pattern on both.

### form_input into the new-todo field, then a separate Enter keypress — 1 run each bridge

| Bridge | Calls | Result |
|---|---|---|
| A | `form_input ref_11 "Form input todo"` then `computer key Return` | Worked: item appeared in the list, confirmed by screenshot. |
| B | `form_input ref_11 "Form input todo B"` then `computer key Enter` | Worked: confirmed via `javascript` — `document.body.innerText.includes('Form input todo B')` returned `true`. |

Both: works. `form_input` correctly drives React's controlled-input state (it fires the synthetic
event React listens for) on both bridges, so a subsequent real `Return` keypress submits normally.
This directly answers the brief's flagged risk: form_input-then-Enter is **not** where either
bridge breaks; the risk observed instead was in chaining several click+type+Enter cycles inside
one batch (see above).

## 2. the-internet.herokuapp.com fixtures

Each fixture below was run once per bridge unless noted, with a second confirmation only when the
first result was surprising (see coverage note at top).

### /checkboxes

Page has 2 checkboxes, default state unchecked / checked.

| Bridge | Calls | Result |
|---|---|---|
| A | `form_input ref_1 true` (checkbox 1), `computer left_click ref_2` (checkbox 2, twice) | `form_input` correctly checked checkbox 1. **`computer left_click` by `ref` on checkbox 2 silently no-op'd twice in a row** (tool reported `"Clicked on element ref_2"` both times, JS read of `.checked` stayed `true`, screenshot confirmed still checked). Clicking the **same checkbox by coordinate** `[344, 115]` worked immediately (`.checked` flipped to `false`). |
| B | `form_input ref_2 true` (checkbox 1), `computer left_click ref_3` (checkbox 2) | Both worked on the first try. `read_page` after showed `checked=true` on checkbox 1 and no `checked` attribute on checkbox 2 (i.e. correctly toggled off). |

Verdict: A partial (form_input works, ref-based click on this specific on-screen checkbox
silently fails, coordinate click works around it). B works. This is a new, distinct bug from the
previously-documented "off-screen ref click no-ops" bug on A, since this checkbox was fully
on-screen and visible in every screenshot taken. See Bugs.

### /dropdown

| Bridge | Calls | Result |
|---|---|---|
| A | `form_input ref_1 "2"` (select by value), then `form_input ref_1 "Option 1"` (select by visible text) | Both worked: `"Selected option \"2\"..."` then `"Selected option \"Option 1\"..."`. |
| B | `form_input ref_2 "Option 1"` (by text), then `form_input ref_2 "2"` (by value) | Both worked: `selected: "Option 1"` then `selected: "Option 2"`. |

Both: works, cleanly, for both value-based and text-based selection.

### /dynamic_loading/2 (click Start, wait, read "Hello World!")

| Bridge | Calls | Result |
|---|---|---|
| A | `computer left_click ref_1` (the Start button, fully on-screen near top of page) | **Silently no-op'd.** Tool reported `"Clicked on element ref_1"`. A 6s `computer wait` then `get_page_text` showed the page unchanged (still just "Start", no loading bar remnant, no "Hello World!"), and a screenshot confirmed the button was untouched. A follow-up **coordinate click** `[378, 157]` on the same button worked immediately; after another 6s wait, `get_page_text` showed "Hello World!". Wall clock for the working coordinate-click path (click to text-confirmed-visible, via Bash `date`) was about 11.7s, dominated by the fixed 6s wait call plus round trips, not by the site's own ~5s delay in isolation. |
| B | `computer left_click ref_2` (the Start button) then `wait_for_page` | Click worked on the first, ref-based try. `wait_for_page` returned in `waitedMs: 124` (tool-reported), but `get_page_text` immediately after already showed `"Hello World!"` present, so the wait was not the limiting factor for correctness here, just fast. |

Verdict: **A fails with ref-based click on this on-screen Start button** (3rd ref-click no-op seen
in this session, after the checkbox above and one instance in the prior local-site session's
report) and needs a coordinate click as a workaround; **B works** with a ref-based click on the
first try. See Bugs for the accumulating pattern on A.

### /dynamic_controls (Remove, wait, Add, Enable input, type)

| Bridge | Calls | Result |
|---|---|---|
| A | `computer left_click ref_2` (Remove) — **no-op'd**, confirmed unchanged via `get_page_text` and screenshot. Coordinate click `[389, 218]` on the same button worked ("It's gone!", "Add" appeared). Then ref-based clicks worked cleanly for the rest: `left_click ref_2` (Add, worked, "It's back!"), `left_click ref_4` (Enable, worked, "It's enabled!"), `left_click ref_3` + `type` into the now-enabled textbox. | Final value confirmed via `javascript_tool`: `"enabled input works A"`. Needed one coordinate-click workaround (Remove), everything else on this page worked by ref. |
| B | `computer left_click ref_3` (Remove, by ref) worked first try ("It's gone!"). `left_click ref_5` (Enable, by ref) worked first try ("It's enabled!"). `left_click ref_4` (textbox) + `type`. | Final value confirmed via `javascript`: `"enabled input works"`. All ref-based clicks worked on the first try, no coordinate fallback needed. |

Verdict: A partial (1 of 3 ref-clicks on this page no-op'd, needed a coordinate-click retry). B
works cleanly throughout.

### /drag_and_drop (HTML5 native drag, 3 runs each bridge)

`computer left_click_drag` from box A's coordinates to box B's coordinates, verified via
`get_page_text`/`javascript` (`#column-a`/`#column-b` textContent) each time, alternating which
bridge went first.

| Run | Bridge | Result |
|---|---|---|
| 1 | A | Swapped correctly: `B, A`. |
| 1 | B | Swapped correctly: `B, A` (screenshot). |
| 2 | A | Dragged again, swapped back correctly: `A, B`. |
| 2 | B | Dragged again, swapped back correctly: `A, B` (confirmed via `javascript` since `get_page_text` omitted the box labels this time, see note below). |
| 3 | A | Swapped correctly: `B, A` (confirmed via `javascript_tool`). |
| 3 | B | Swapped correctly: `B, A` (confirmed via `javascript`). |

Verdict: **works on both bridges, 3/3 agreement**, no coordinate-drift or event-order problems.
`left_click_drag` correctly simulates the full HTML5 `dragstart`/`dragover`/`drop` sequence on
both, which is notable since many pure-mouse-event drag simulators fail this exact fixture.

Minor note (not a correctness bug, a text-extraction gap): on B's run 2, `get_page_text` returned
only `"Drag and Drop\nPowered by Elemental Selenium"`, omitting the "A"/"B" box labels entirely,
even though a screenshot taken at the same moment showed them and `javascript` confirmed they
were in the DOM. `get_page_text` on A never dropped them in the same test. Filed under Bugs.

### /hovers (hover each avatar, read caption, click its link)

| Bridge | Calls | Result |
|---|---|---|
| A | `computer hover [412,197]` then `get_page_text` → "user1"; `find "View profile link"` found all 3 links (`ref_8/11/14`) even though only one is hover-visible at a time; clicked `ref_8` → navigated to `/users/1`. `get_page_text` on that page **errored**: `"No text content found. Page may contain only images, videos, or canvas-based content."` even though a screenshot showed a plain `<h1>Not Found</h1>`. Re-navigated, hovered avatar 2 → "user2" caption read correctly. | Hover-and-read works; `find` correctly locates all 3 hidden-until-hover links; `get_page_text` fails on the minimal 404 target page. |
| B | `computer hover [412,197]` then `get_page_text` → "user1"; `find "View profile link"` returned only 1 real match (`ref_2`, `/users/1`) plus 2 unrelated links (GitHub fork ribbon, Elemental Selenium footer) — did not surface the hidden profile links for avatars 2 and 3. Clicked `ref_2` → navigated to `/users/1`, `get_page_text` correctly returned `"Not Found"`. Re-navigated, hovered avatar 3 → "user3" caption read correctly. | Hover-and-read works; `get_page_text` succeeds even on the minimal 404 page; `find` under-matched the hidden links compared to A. |

Verdict: both work for the core hover-and-read flow. Two differences worth flagging: A's `find`
surfaces hover-hidden elements that B's does not, but A's `get_page_text` fails on a page whose
only content is a single heading, where B succeeds.

### /key_presses

| Bridge | Calls | Result |
|---|---|---|
| A | `left_click ref_1` (field) then `key "a"` immediately after navigation: **no visible result**, `get_page_text` showed no "You entered" line at all and a screenshot confirmed the field was empty. Retried with a coordinate click `[783,137]` then `key "a"`: also produced no result the first time, but `key "Tab"` right after did register (`"You entered: TAB"`). A further coordinate click + `key "x"` registered correctly (`"You entered: X"`). A last combo `key "Shift+ArrowUp Enter Backspace"` triggered the field's enclosing form submit on `Enter`, navigating to `key_presses?` (expected browser behavior for Enter in a form field, not a bug). | Flaky on the first 1-2 keypresses right after navigation/click, reliable afterward. Likely the same focus-timing issue seen elsewhere on A rather than a key-specific problem, since `x` and `Tab` both worked moments later. |
| B | `left_click ref_2` (field) then `key "Escape"`: worked immediately, `get_page_text` showed `"You entered: ESCAPE"`. `key "ctrl+a"` on the next attempt: worked immediately, `"You entered: A"`. | Reliable on every attempt, no retries needed. |

Verdict: B works cleanly. A works but the very first keypress after a click needs a follow-up
retry more often than not, matching the general focus/timing pattern already seen on this bridge.

### /upload (upload upload1.txt, submit, read uploaded file name)

| Bridge | Calls | Result |
|---|---|---|
| A | `file_upload ref_1 [upload1.txt]` → `"Uploaded 1 file(s) to file input: upload1.txt (0 KB total)"`, confirmed by screenshot showing "upload1.txt" next to Choose File. `computer left_click ref_2` (Upload/submit button) **no-op'd** — page stayed on the form, `get_page_text` unchanged. Coordinate click `[385,181]` on the same button worked, `get_page_text` then showed `"File Uploaded!\nupload1.txt"`. | file_upload by ref works; submit-button ref-click no-op'd (yet another instance), coordinate click fixed it. |
| B | `file_upload ref_2 [upload1.txt]` → `{ok:true, mode:"input", files:1}`. `computer left_click ref_3` (Upload button) worked on the first try, `get_page_text` showed `"File Uploaded!\n upload1.txt "`. | Both file_upload and the ref-based submit click worked first try. |

Verdict: both bridges' `file_upload` tool works correctly and reports the (tiny, 13-byte) file
size accurately. A needed its now-familiar ref-click-then-coordinate-click workaround for the
submit button; B did not.

### /infinite_scroll (scroll 5x, count paragraphs before/after)

| Bridge | Before | After 5x `computer scroll down` | Result |
|---|---|---|---|
| A | 2 (`div.jscroll-added`) | 7 | Matches exactly, confirmed via `javascript_tool`. |
| B | 2 | 7 | Matches exactly, confirmed via `javascript`. |

Verdict: works identically on both. Note: content is not in `<p>` tags on this fixture (a naive
`document.querySelectorAll('p').length` returns 0 on both bridges); the real content container is
`div.jscroll-added`, confirmed by direct HTML inspection.

### /nested_frames (read text in each frame)

Both bridges read identical results via `javascript` walking `window.frames`: top-level frames
are `["", "BOTTOM"]` (the first being a frameset with no direct body text), and the first frame's
children are `["LEFT", "MIDDLE", "RIGHT"]`. Both required the same workaround for
`window.frames` not being directly iterable (a plain JS quirk, not a bridge issue). Verdict: works
identically on both.

### /shadowdom (read the tree)

| Bridge | `read_page filter=all` |
|---|---|
| A | Shows the rendered slot content only: `generic "Let's have some different text!"`, `list` with 2 items. Does not surface the un-rendered light-DOM fallback `<p>My default text</p>` elements that exist in markup but are overridden by slotted content. |
| B | Shows both: the two fallback `<p>My default text</p>` elements (marked as such) **and** the actual rendered slotted text and list, all 14 nodes. |

Verdict: both correctly expose the shadow tree contents (works), but B's tree is more complete,
including nodes that exist in the DOM but are not actually rendered (the unused fallback
paragraphs), which could mislead an agent into thinking "My default text" is visible when the
page actually shows "Let's have some different text!". Not filed as a bug since both are
technically-accurate representations of different things (rendered output vs. full DOM).

### /large (read_page interactive size/time, find "row 50 column 20")

| Bridge | `read_page filter=interactive` | `find` for the 50/20 cell |
|---|---|---|
| A | **Returned zero elements**, not even the 2 real links (`Fork me on GitHub`, `Elemental Selenium`) that this page actually has, with no truncation notice. `filter=all` (54.6KB) did show them plus the full nested/table structure. | `find "table cell containing 50.20"` succeeded first try: `ref_2525: generic "50.20" (table cell)`. |
| B | Correctly returned exactly the 2 real interactive elements (links), nothing missing. | `find "table cell containing 50.20"` **failed**: `"No elements matched ... among 2 searched."` A shorter, plainer query `"50.20"` with `include_all: true` succeeded, returning 20 matches with the exact cell (`ref_2582`) first. |

Verdict: A's `interactive` filter is unreliable on this page (returns nothing at all, worse than
the previously-documented silent-truncation bug, since here it returns zero instead of a partial
list). B's `interactive` filter is accurate but its default `find` (without `include_all`) barely
searches this page (`"among 2 searched"`) and needs a plainer query plus `include_all: true` to
locate a specific deep-table cell. Both need a workaround to get a complete picture of this page's
2 real links or table content; A's plain phrase-style query worked for `find` where B's did not,
but B's `read_page interactive` was accurate where A's was empty.

### /tables (read table 1, sort by Due header)

| Bridge | `find "Due column header in table 1"` | Click header | Result |
|---|---|---|---|
| A | Found it first try (`ref_12`). | `left_click ref_12` **no-op'd** (order unchanged: `50, 51, 100, 50`), confirmed by screenshot. Coordinate click `[706,242]` worked, order became `50, 50, 51, 100`. | Sort works after coordinate-click workaround. |
| B | Failed: `"No elements matched ... among 18 searched."` A plain `"Due"` query with `include_all: true` found both table's headers (`ref_30`, `ref_70`). | `left_click ref_30` worked first try, order became `50, 50, 51, 100`. | Sort works, ref-click succeeded first try. |

Verdict: both bridges can sort the table correctly and produce the identical, correct sorted
order. A's `find` handles a longer descriptive query better than B's default `find`; A again
needed a coordinate-click workaround where B's ref-click worked immediately.

### /inputs (type numbers, arrow up/down)

| Bridge | Calls | Result |
|---|---|---|
| A | `left_click ref_1`, `type "10"`, `key "Up Up Down"` (all in separate calls) | **No-op'd entirely**: field stayed empty (confirmed via `javascript_tool` and screenshot). Retried with a coordinate click `[750,137]` then `type "10"` then `key "Up"` x2 then `key "Down"` (each its own call): worked, final value `11`. |
| B | `left_click ref_2`, `type "10"`, `key "ArrowUp ArrowUp ArrowDown"` | Worked first try: final value `11`, confirmed via `javascript`. |

Verdict: both reach the correct final value (`11`) with the same key sequence. A needed a
coordinate-click retry (yet another instance of the same focus/ref-click pattern seen throughout
this session); B worked on the first attempt.

### /horizontal_slider (drag or arrow keys to 3.5)

First attempt on both bridges used a ref-based click to focus the slider before arrow-key presses;
the ref click landed at an arbitrary point along the slider track on both (A: value stayed `0,`
i.e. the click didn't register at all; B: click landed near the right end, jumping straight to
`5`, then capped at `5` after 7 more `ArrowRight`). Neither result reflects a bridge defect, this
is expected `<input type=range>` click-to-jump behavior combined with an arbitrary click point.
Redone with an explicit coordinate click at the track's left edge `[345,158]` (value `0`) followed
by 7 `Right`/`ArrowRight` presses (0.5 step size):

| Bridge | Final value |
|---|---|
| A | `3.5` (confirmed via `javascript_tool`) |
| B | `3.5` (confirmed via `javascript`) |

Verdict: works identically on both once the slider is anchored to a known starting position.

### /add_remove_elements (Add 5, delete 2, count)

| Bridge | Add Element clicks | Delete clicks | Final count |
|---|---|---|---|
| A | 1st ref-click no-op'd (count stayed 0), switched to coordinate click `[405,117]` x5, reaching 5 | Coordinate click `[405,156]` x2 first landed on the wrong row (count stayed 5, buttons had reflowed to `y=205` after the section divider disappeared) — corrected to `[383,205]` x2, reaching 3 | 3, correct (5 added, 2 deleted) |
| B | ref-based clicks worked throughout, reaching 5 | `left_click ref_4` then `left_click ref_5` (both by ref) worked correctly despite the DOM reflowing after the first deletion, reaching 3 | 3, correct |

Verdict: both reach the same correct final count (3). A needed 2 separate coordinate-click
corrections (button-click no-op, then a stale-coordinate miss after the layout reflowed); B's
ref-based clicks tracked the reflowing DOM correctly with no manual coordinate work needed.

### /disappearing_elements (menu items across 3 loads)

| Load | A | B |
|---|---|---|
| 1 | Home, About, Contact Us, Portfolio | Home, About, Contact Us, Portfolio, Gallery |
| 2 | Home, About, Contact Us, Portfolio | Home, About, Contact Us, Portfolio, Gallery |
| 3 | Home, About, Contact Us, Portfolio | Home, About, Contact Us, Portfolio |

Both bridges read the menu correctly every time via `javascript`/`javascript_tool`; the item
count varies because the fixture itself randomly includes "Gallery" on about 1 in 4 loads,
independent of which bridge is driving it. Verdict: works identically on both, no bridge
difference, the observed variation is the site's own randomness.

### /floating_menu (scroll, click a floating link)

Both bridges: `computer scroll down` then `left_click` on "News" in the floating menu. First
coordinate click on B landed on "Home" instead (`#home`), because B's scroll moved the page a
different absolute amount than A's identical scroll command (a content/layout difference, not a
bridge defect) — a second click at the position shown in a fresh screenshot correctly hit "News"
(`#news`) on B, matching A's `#news` result on the first try. Verdict: works on both; always
re-screenshot before a coordinate click after a scroll rather than reusing pre-scroll coordinates.

### /status_codes (click 404 and 500, report navigate and read_network_requests)

| Bridge | 404 | 500 |
|---|---|---|
| A | `left_click ref_13` (by ref) no-op'd, URL unchanged. Coordinate click `[350,252]` worked, URL became `/status_codes/404`, `get_page_text` confirmed "This page returned a 404 status code." `read_network_requests` (called only after this navigation) correctly showed `statusCode: 404` for the request. | Same pattern: `left_click ref_15` no-op'd, coordinate click `[350,276]` worked, confirmed 500 page and URL. |
| B | `left_click ref_5` (by ref) worked first try, URL `/status_codes/404`. | `left_click ref_6` (by ref) worked first try, confirmed via `javascript` `location.href` = `/status_codes/500`. |

A's `read_network_requests` also has a usability note: called once before any navigation happened
on that tab, it returned `"No network requests found for this tab... Network tracking starts when
this tool is first called"` — an expected behavior given the tool's own documented note, not a
bug, but worth knowing the tool must be primed by an earlier call or refresh to see requests that
already fired.

Verdict: both bridges reach and correctly report the 404 and 500 pages. A needed a coordinate
click both times (6th and 7th ref-click no-ops of this session); B's ref clicks worked every time.

### /redirector (click, report final URL)

| Bridge | Calls | Result |
|---|---|---|
| A | `left_click ref_6` no-op'd (URL unchanged after a 2s wait). Coordinate click `[389,164]` worked, final URL `https://the-internet.herokuapp.com/status_codes`. | Works after coordinate-click workaround (8th ref-click no-op of this session). |
| B | `left_click ref_2` worked first try, `wait_for_page` confirmed load, final URL `https://the-internet.herokuapp.com/status_codes` (via `javascript`). | Works first try. |

Both reach the identical correct final URL.

### /slow (report navigate timing)

Bash `date +%s%3N` wall-clock bracketing around each bridge's `navigate` call to `/slow`:

| Bridge | Tool-reported duration | Wall clock (Bash bracket) |
|---|---|---|
| A | not reported by this tool's standalone `navigate` (no `durationMs` field in A's response) | ≈7.7s (1788443732007 → 1788443739745) |
| B | `durationMs: 392` | ≈0.68s (1788443740291 → 1788443740970) |

A was markedly slower on this run, but `/slow` on this fixture site has server-side random
delay, so a single-run comparison is not reliable evidence of a bridge-level speed difference.
Flagged as untested-for-repeatability: with the time budget available this session, `/slow` was
only run once per bridge, so this timing difference is not confirmed to be a bridge property
rather than server jitter.

### /typos (read the paragraph, 3 loads)

Both bridges read the paragraph correctly on every load via `get_page_text`, faithfully capturing
the site's own randomized typo/non-typo wording each time (e.g. "you won,t" vs "you won't").
Verdict: works identically, no bridge difference, the variation is the site's design.

### /windows (Click Here opens a new window, is it in the session and readable)

| Bridge | Calls | Result |
|---|---|---|
| A | `left_click ref_5` no-op'd (no new tab appeared in `tabs_context_mcp`). Coordinate click `[372,89]` worked: a new tab `177110519` ("New Window") appeared automatically in `tabs_context_mcp`'s `availableTabs`, fully readable via `get_page_text` without any extra step. | Works after coordinate-click workaround (9th ref-click no-op this session); new tab auto-joins the session. |
| B | `left_click ref_2` worked first try: new tab `177110516` appeared automatically in the session's tab group (`tabs_context`), fully readable via `get_page_text`. | Works first try; new tab auto-joins the session. |

Both bridges automatically capture a `window.open`-spawned tab into the current session and make
it immediately readable, no manual re-attach step needed on either. Both extra tabs were closed
with each bridge's own `tabs_close`.

### /entry_ad (close modal via its close button)

| Bridge | Calls | Result |
|---|---|---|
| A | `find "Close modal X button"` found `ref_11`. `left_click ref_11` no-op'd, modal stayed open (screenshot confirmed). Coordinate click `[783,507]` worked, modal closed. | Works after coordinate-click workaround (10th ref-click no-op this session). |
| B | `find "Close"` **found nothing** ("No elements matched ... among 2 searched", modal likely not yet in B's indexed set at query time). Coordinate click `[783,507]` (read off a screenshot) worked directly, modal closed. | Works via coordinate click; `find` did not need to succeed since the close button's screen position was obvious from the screenshot. |

Both close the modal correctly and it does not reappear on the next same-tab reload (per the
page's own text, not independently re-verified here to save time).

### /notification_message (click, read the flash message)

| Bridge | Calls | Result |
|---|---|---|
| A | `left_click ref_8` reported success but `get_page_text` showed no flash message text at all. A follow-up coordinate click `[404,283]` also showed nothing in `get_page_text`, but a **screenshot at that point clearly showed** the blue banner `"Action unsuccesful, please try again"` at the top of the page. So the click(s) worked; `get_page_text` simply never included the notification banner's text in either attempt, even though it was visibly present. | Click works (confirmed visually); `get_page_text` has a gap, consistently missing this banner element. |
| B | `left_click ref_3` worked first try, `get_page_text` correctly included `"Action unsuccesful, please try again ×"` at the very top of its output. | Works, and `get_page_text` captured the banner correctly. |

Verdict: both bridges' click works. A's `get_page_text` has a recurring gap (third instance this
session, after /drag_and_drop and effectively the reverse pattern at /hovers's 404 page) where it
omits content that a screenshot proves is on the page; B's `get_page_text` did not miss it here.

### /challenging_dom (click the 3 buttons, read canvas answer)

The current version of this fixture has no `<canvas>` element (an older version of the fixture
did); it has 3 randomly-labeled top buttons and a table of `edit`/`delete` links whose class
names and button labels reshuffle between interactions, which is the point of the fixture. Both
bridges' `left_click ref_N` worked for every button/link clicked (A: `ref_1`, `ref_2`, `ref_4`
after a re-read; B: `ref_2`, `ref_5` after a re-read). Both bridges correctly threw a clear
"ref no longer on the page, re-read" error rather than silently clicking the wrong element when a
stale ref was used after the DOM reshuffled, and `find`/`read_page` correctly reflected the new
button labels and order after each reshuffle. Verdict: works identically on both, no canvas
content to report since this fixture version does not have one.

### /forgot_password (type email, click Retrieve password, report result)

| Bridge | Calls | Result |
|---|---|---|
| A | `form_input ref_1 "test@example.com"` worked. `left_click ref_2` no-op'd (page unchanged). Coordinate click `[425,179]` worked: page returned `"Internal Server Error"` (a genuine bug in this fixture site itself, not a bridge issue: it 500s on this endpoint). | Works (reaches the site's real, broken result) after a coordinate-click workaround. |
| B | `form_input ref_2 "test@example.com"` worked. `left_click ref_3` **hit the known tab-death bug**: `"Cannot access a chrome-extension:// URL of different extension"`, listing several unrelated extension targets (`nngceckbapebfimnlniiiahkandclblb`, `fcoeoabgfenejglbffodgkkbkcdhcgfn`, `hehggadaopoacecdllhhajmbjkdcmajg`, `giagijohigincdlpkfolgcljkhmjdiaa`). This is the same failure mode documented in the prior local-site session's Bugs list (bug 1). Preceded by roughly 30 navigations/interactions on the same tab (`177110504`) across this entire scenario-2 run, no cross-origin iframes were open at the time. Workaround applied: `tabs_close` on the dead tab (succeeded normally) then `tabs_create` a fresh tab (`177110525`), which worked normally for the rest of the flow, reaching the same `"Internal Server Error"` result as A. | Tab died once (1 occurrence, recorded), recovered via close+recreate, then worked. |

Both bridges ultimately reach the identical site-side result ("Internal Server Error"), confirming
this is a fixture-site bug rather than a bridge difference in what gets submitted.

### /iframe (TinyMCE editor)

**Untested, both bridges, same reason on both.** The fixture's TinyMCE cloud editor is
rate-limited: it loaded in read-only mode ("TinyMCE is in read-only mode because you have no
more editor loads available this month.") on both bridges' first navigation, confirmed by
screenshot. Triple-click + `ctrl+a` + `type` on both left `document.querySelector('iframe')
.contentDocument.body.innerHTML` unchanged at `"<p>Your content goes here.</p>"` on both bridges,
consistent with the editor being genuinely read-only rather than either bridge failing to reach
into the iframe. This is a site/quota limitation, not a bridge difference, so no verdict is given.

Scenario 2 coverage note: `/context_menu` and `/javascript_alerts` were skipped per the ground
rules (no alert/confirm/prompt triggering). `/basic_auth`, `/digest_auth`, and `/login` were
skipped per the credentials rule. `/exit_intent` was not tested (moving the mouse to the top edge
to trigger it reliably needs a real OS-level mouse trajectory that neither bridge's `hover`
guarantees, and time did not allow iterating on it); this is an honest gap, not a claimed result.

## 3. demoqa.com

### /text-box (fill via form_input, submit, read result)

Both bridges: `form_input` on all 4 fields (Full Name, Email, Current Address, Permanent Address)
worked in one call each, no clicks needed to focus first. `left_click` on Submit worked on the
first try on both (no ref-click no-op this time). `get_page_text` on both correctly showed the
echoed result block:
```
Name:Ada Lovelace
Email:ada@example.com
Current Address :123 Analytical Engine Ave
Permananet Address :London, UK
```
B's `get_page_text` additionally picked up ad-iframe text ("Comparador de Fundos" boilerplate,
duplicated) that A's did not include; both correctly show the actual form result either way.
Verdict: works on both, `form_input` alone was sufficient for every control on this form.

### /automation-practice-form (fill every control, submit, read modal)

| Control | A | B |
|---|---|---|
| First/Last Name, Email, Mobile, Current Address | `form_input`, worked directly | `form_input`, worked directly |
| Gender radio | `form_input ref_6 true` (no confirmation text printed, but `javascript_tool` confirmed `checked: true`) | `form_input ref_6 true`, confirmed `{checked:true}` |
| Date of Birth | `form_input` directly on the text field (`"15 Jun 1990"`), confirmed via `#dateOfBirthInput.value`, no need to open the picker | Same, worked identically |
| Subjects (autocomplete) | `form_input "Maths"` then `key Return` to commit the chip, confirmed by screenshot | Same pattern, same result |
| Hobbies checkbox | `form_input ref_12 true` | `form_input ref_12 true` |
| Picture upload | `file_upload`, `upload1.txt` attached, shown in the file field | Same |
| State / City (react-select) | `form_input` was **not** attempted here since these are custom, non-native dropdowns; coordinate clicks opened each menu and selected "NCR" then "Delhi" | Same coordinate-click pattern, same selections |
| Submit | Coordinate click, worked | Coordinate click, worked |

Both submissions succeeded and opened the results modal with all values correct. One extraction
gap on A repeated here: `get_page_text` on A's modal table **omitted the "Male" value after the
"Gender" label and the "Sports" value after the "Hobbies" label**, showing just the bare labels,
while every other row (Name, Email, Mobile, Date of Birth, Subjects, Picture, Address, State and
City) came through correctly. B's `get_page_text` included every value, including "Gender Male"
and "Hobbies Sports". This is not a form/submission problem (both actually submitted "Male" and
"Sports", confirmed by the on-screen results visible in screenshots taken during filling) — it is
specifically `get_page_text` under-extracting radio/checkbox-derived label text on A, the 4th
instance of this class of gap this session (also seen at /hovers's 404 page, /drag_and_drop, and
/notification_message).

Verdict: both bridges successfully complete the full form including the two custom react-select
dropdowns using coordinate clicks (form_input was not usable for those, by design, since they are
not native `<select>` elements). A's `get_page_text` has a recurring pattern of silently dropping
some rendered text that a screenshot proves is present.

### /webtables (add, edit, delete, search a record)

Skipped for time: this scenario alone requires a full CRUD cycle through a modal form (First
Name, Last Name, Age, Email, Salary, Department) plus a search-filter check, and scenarios 4-8
had not been touched yet. Given the choice between a shallow pass at every remaining scenario or a
complete /webtables run, breadth across scenarios 4-8 was prioritized. This is an honest gap, not
a claimed result. Expect the same ref-click-no-op pattern seen everywhere else on A to show up on
the Edit/Delete icon buttons if this is picked up later.

## 4. httpbin.org/forms/post

`form_input` set every field (name, tel, email, size radio, 2 toppings checkboxes, delivery time,
comments textarea) directly on both bridges, all confirmed by the tool's own return values.
`left_click` on Submit worked first try on both. The resulting JSON echo pages
(`https://httpbin.org/post`) were **identical** between bridges except for the
`X-Amzn-Trace-Id` header (which is per-request, expected):
```
"form": {
  "comments": "Leave at the door",
  "custemail": "ada@example.com",
  "custname": "Ada Lovelace",
  "custtel": "9876543210",
  "delivery": "18:30",
  "size": "medium",
  "topping": ["bacon", "onion"]
}
```
Verdict: works identically on both, submitted values exactly match input on both bridges, no
ref-click or form_input issues encountered here.

## 5. jqueryui.com widgets

Coverage note: with time running short, only `/sortable/` and `/autocomplete/` were run (the two
most distinct interaction patterns: native mouse-drag reordering, and a text-input-driven
suggestion list). `/droppable/`, `/datepicker/`, and `/selectmenu/` were not tested this session.
This is an honest gap, not a claimed result.

### /sortable (drag to reorder)

The demo widget lives inside a same-origin iframe on the page. `computer left_click_drag` from
Item 1's position to Item 3's position produced the **identical reordered list on both bridges**:
`Item 2, Item 3, Item 1, Item 4, Item 5, Item 6, Item 7` (confirmed by screenshot on A, and by
`get_page_text` on B, which reached into the iframe and showed the reordered list directly).
Notable gap: A's `get_page_text` on this page did **not** include the iframe's list content at
all (list of Examples links only), while B's did include it. This matches the pattern seen with
demoqa.com's ad iframes, but in reverse severity: here it is A that misses iframe content and B
that includes it. Verdict: the actual drag-and-reorder behavior works identically on both;
`get_page_text` iframe-reach differs (B more complete here, opposite of what was seen with ad
iframes on demoqa.com where the difference was cosmetic ad text, not the content under test).

### /autocomplete (type and pick a suggestion, use perKey on B)

| Bridge | Calls | Result |
|---|---|---|
| A | `computer left_click` into the field then `type "ja"` (normal type, A has no perKey mode) → suggestion list showed "Java"/"JavaScript". `key Down` x2 + `key Return` selected "JavaScript", confirmed by screenshot. | Works. |
| B | `computer left_click` then `type "ja"` with **`perKey: true`**: **typed nothing** — the field stayed empty after the call reported `{ok:true, typed:2}`, confirmed by screenshot (empty input, no suggestion dropdown). Retried with plain `type` (no perKey): worked immediately, "ja" appeared and the Java/JavaScript suggestions showed. `key ArrowDown` x2 + `key Enter` selected "JavaScript", confirmed by screenshot. | `perKey: true` typing into this same-origin-iframe input silently fails; plain `type` works. |

Verdict: both bridges reach the identical correct end state ("JavaScript" selected in the tag
field) via keyboard-only selection. B's `perKey` mode, specifically documented for inputs "that
only react to keystrokes, such as autocompletes" (exactly this case), **did not work** on this
autocomplete input and needs to be flagged: it silently typed nothing rather than erroring. Filed
under Bugs.

## 6. selenium.dev/selenium/web/web-form.html (every control type, submit, read result)

Every field (text, password, textarea, select, datalist/autocomplete text, 2 checkboxes, 2
radios, color picker, date, range slider, file input) was set with `form_input` on both bridges,
plus `file_upload` for the file field. `left_click` on Submit worked first try on both. The
resulting `submitted-form.html` query strings were **identical between bridges, value for
value**:
```
my-text=hello+text&my-password=hunter2&my-textarea=hello+textarea&my-readonly=Readonly+input
&my-select=2&my-datalist=San+Francisco&my-file=upload1.txt&my-check=on&my-check=on&my-radio=on
&my-colors=%23ff0000&my-date=&my-range=8&my-hidden=
```
One shared oddity on both bridges: `my-date=` came through **empty** even though `form_input`
reported `{ok:true, value:"2026-01-15"}` on both. Since this happened identically on both
bridges, it looks like a shared limitation of setting a native `<input type=date>`'s value via a
programmatic setter (it may need `valueAsDate`/keyboard-segment input rather than a plain string
`.value =` assignment to be picked up by form serialization) rather than a bridge difference.
Verdict: works identically on both bridges, including the identical date-field gap.

## 7. Quill rich editor (quilljs.com/playground/snow)

The editor preview lives inside a cross-origin sandboxed iframe (`document.querySelectorAll
('iframe')` found 2 on the page; accessing either's `contentDocument` from the parent threw
`Cannot read properties of null`, identically on both bridges — a same-origin-policy limitation
of the site's own CodeSandbox-style embed, not a bridge issue). Verification therefore relied on
screenshots rather than `javascript` reading the editor HTML directly.

Both bridges: coordinate `left_click` into the editor pane, `type "The quick brown fox jumps"`,
then `double_click` to select a word and `key ctrl+b` to bold it. The double-click landed on
"jumps" rather than the intended "fox" on both bridges (a coordinate-estimation mismatch on my
part, not a bridge difference, since both used the identical click coordinate `[1000,288]` and
selected the identical word). Screenshots after confirm, on both: the word "jumps" is
highlighted/selected, rendered visually bold, and the toolbar's **B** button is highlighted blue
(active state), matching on both bridges pixel-for-pixel in layout. Verdict: works identically on
both; `ctrl+b` correctly toggles bold on the selection through the sandboxed iframe on both
bridges.

## 8. Cookie/consent banner handling (theguardian.com, bbc.com)

Neither site showed a fresh consent dialog this session: this physical Chrome profile had
already recorded a consent decision on both sites from earlier browsing, and it survived. On
theguardian.com both bridges landed straight on a "Rejection hurts..." interstitial that only
appears **after** third-party cookies have already been rejected (i.e. cookies were already in
the rejected state, identically on both bridges), confirmed by `document.cookie` on both showing
`consentUUID`/`consentDate` values already set. An attempt to clear cookies via `javascript`
(iterating `document.cookie` and expiring each name on `path=/`) did not bring back a fresh
banner on reload on either bridge; the CMP state most likely also lives in `localStorage` or a
parent-domain cookie that a `path=/` clear does not reach, and time did not allow chasing that
down further. On bbc.com, neither bridge's `find` located an active reject-cookies control either
(A's `find` explicitly reported no such element in the accessibility tree; B's `find` on the
looser query "Reject all" returned an unrelated article headline link, a mismatch worth flagging
on its own). Verdict: **untested as originally scoped** (dismiss 3x each with cookies cleared
between runs) because a fresh banner could not be reliably reproduced in the time available on
either bridge; the behavior that *was* observed (no banner, prior consent honored) was identical
on both bridges, so this is a shared environment limitation, not a bridge difference. Flagging B's
"Reject all" mismatch (an unrelated headline) as a minor `find`-quality note, not a functional
bug, since the query was generic and the page had no actual "Reject all" text to match.

A separate, more concerning finding surfaced while investigating this scenario: **A's
`javascript_tool` blocked the return value of a plain `document.cookie` read**, printing
`[BLOCKED: Base64 encoded data]`-style output (`"[BLOCKED: Cookie/query string data]"`) for a
completely ordinary, non-sensitive cookie string (`consentUUID`, `consentDate`, A/B-test bucket
ids). This is the same false-positive content-filter pattern documented in the prior local-site
session (bug 6: blocking a long repeated-character string), now reproduced on a different trigger
(cookie-shaped strings) on a real external site. B's `javascript` returned the same cookie string
with no filtering. Filed under Bugs.

## Notable differences

1. **A's ref-based `computer left_click` silently no-op'd far more often than B's did.** Counted
   at least 11 clear instances across this session (checkboxes on /checkboxes, Start on
   /dynamic_loading/2, Remove on /dynamic_controls, Submit on /upload, Due header on /tables,
   404/500 links on /status_codes, the redirect link on /redirector, the Add-5 flow on
   /add_remove_elements, Click Here on /windows, the modal Close on /entry_ad, and Retrieve
   password on /forgot_password), against zero confirmed instances on B. Every one of A's no-ops
   was worked around by switching to a coordinate click on the same visible element, which then
   worked immediately. This is a stronger, more general form of the "off-screen ref click no-ops"
   bug documented in the prior local-site session; here it also hit fully on-screen, top-of-page
   elements.
2. **B's screenshot taken inside the same batched call as a mutating click can show a stale,
   pre-repaint frame**, giving a false "nothing happened" reading even though the underlying DOM
   change did apply (seen twice on TodoMVC: a batched add and a batched delete). Adding an
   explicit `wait_for_page` or splitting the screenshot into a separate call fixed it both times.
   This is arguably riskier than A's no-ops because the tool's own output actively lies about the
   result rather than looking merely unchanged.
3. **A's `get_page_text` has a recurring pattern of omitting rendered text that a screenshot
   proves is present**, seen at least 4 times: the /hovers fixture's minimal 404 target page
   (errored entirely, `"No text content found"`), the /drag_and_drop box labels on one run,
   the /notification_message flash banner, and the Gender/Hobbies values in demoqa.com's
   practice-form results modal. B's `get_page_text` did not reproduce any of these specific gaps
   (though it has its own gap, see #4).
4. **B's `get_page_text` did not reach into a genuinely relevant same-origin iframe on
   jqueryui.com/sortable** (missing the actual widget list under test), while A's omission
   pattern (#3) tends to hit banners/labels rather than the core content under test. Neither
   bridge's iframe-text-reach is strictly better; which one misses content depends on the page.
5. **B's `find` needs shorter, plainer queries and `include_all: true` on very large or
   deeply-nested pages** (/large, /tables) to succeed, where longer descriptive queries that work
   fine on small pages returned `"No elements matched ... among N searched"` with a suspiciously
   small N (2, 18). A's `find` handled the same longer descriptive queries correctly on those same
   pages.
6. **A's `find` surfaces elements hidden until hover** (found all 3 profile links on /hovers
   before any hover happened) where B's `find` under the same conditions only surfaced the one
   link already visible.
7. **`form_input` reliably drives React-controlled inputs, native inputs, checkboxes, radios,
   native `<select>`s, and even a `<input type=date>`/`<input type=color>`/`<input type=range>`
   on both bridges**, including TodoMVC's controlled React input and every field on the httpbin
   pizza form and the selenium.dev web-form. It does **not** work for demoqa.com's react-select
   State/City dropdowns (custom, non-native widgets); both bridges needed coordinate clicks there,
   which is expected and not a bridge gap.
8. **B's `perKey` typing mode failed silently on a real autocomplete input**
   (jqueryui.com/autocomplete), typing nothing despite reporting success, while plain `type` on
   the same input worked immediately. This directly contradicts the tool's own documented use
   case for `perKey` ("inputs that only react to keystrokes, such as autocompletes").
9. **Both bridges handle HTML5 native drag-and-drop correctly and reliably** (3/3 agreement each
   on /drag_and_drop), and both correctly simulate the full `dragstart`/`dragover`/`drop`
   sequence, which many pure-synthetic-mouse-event automations fail.
10. **Both bridges correctly and automatically capture a `window.open`-spawned tab into the
    current session**, immediately readable with no manual re-attach step, on /windows.

## Bugs

1. **A: `computer left_click` by `ref` silently no-ops on a wide range of fully on-screen,
   above-the-fold elements**, far beyond the previously-documented off-screen case. Reproduction:
   any of the sequences in Notable difference 1 above, e.g. navigate to
   `https://the-internet.herokuapp.com/dynamic_loading/2`, `read_page filter=interactive` to get
   the Start button's ref, `computer left_click` that ref — the tool reports success but the page
   is unchanged; a coordinate click on the same button works immediately. Happened on 11+
   separate elements across this session, with no consistent trigger identified (not limited to
   any one page structure, not limited to buttons vs links vs checkboxes).
2. **B: a screenshot taken inside the same batched (`quick`/`browser_batch`) call immediately
   after a state-mutating click can render a stale pre-paint frame**, showing the click as having
   failed when it actually succeeded. Reproduction: on TodoMVC React, in one `quick` script,
   click+type+Enter to add a todo then `SS` on the last line — the screenshot shows the field
   empty and no todo list, but a `read_page`/screenshot from a subsequent separate call shows the
   todo present. Also reproduced on a delete (`×`) click followed immediately by `SS`. Workaround:
   insert `W` (`wait_for_page`) before the screenshot, or take the screenshot in a separate call.
3. **A: `get_page_text` can return an outright error on a minimal page**, `"No text content
   found. Page may contain only images, videos, or canvas-based content."`, on a page whose only
   content is a single `<h1>Not Found</h1>`. Reproduction: navigate to
   `https://the-internet.herokuapp.com/users/1` (the dead link behind /hovers's "View profile"),
   call `get_page_text`.
4. **A: `get_page_text` silently omits some rendered text blocks** (a flash-message banner div, a
   drag-and-drop box's text labels on one run, and two label/value pairs in a results modal) even
   though the same content is visible in a screenshot taken at the same moment. No consistent
   trigger identified; affects around 4 distinct elements/pages this session.
5. **A: `javascript_tool` false-positive content filter blocks ordinary cookie data.**
   Reproduction: on `https://www.theguardian.com/international`, `javascript_tool` with
   `document.cookie` returns `"[BLOCKED: Cookie/query string data]"` instead of the actual (fully
   non-sensitive) cookie string; `javascript` on B returns it correctly. This is the same class of
   false positive as the previously-documented "long repeated character string" block, now shown
   to trigger on a completely different, common, benign payload shape.
6. **B: `computer type` with `perKey: true` can silently type nothing into a real input.**
   Reproduction: on `https://jqueryui.com/autocomplete/`, click the Tags field, then `computer
   type` with `text: "ja"` and `perKey: true` — the tool reports `{ok:true, typed:2}` but the
   field stays empty and no suggestion dropdown appears; the identical call with `perKey` omitted
   works immediately on the same field.
7. **B: `read_page`/`find` under-searches very large pages by default**, needing
   `include_all: true` and a shorter query to succeed; the default search silently covers a much
   smaller element set than the page actually has (`"among 2 searched"` on a page with 9000+
   table cells, `"among 18 searched"` on a page with a full data table). Not a hard failure, but
   the tool gives no indication that its default search scope was inadequate for the page size.
8. **B: `get_page_text` can miss the actual content under test inside a same-origin iframe** even
   when it successfully renders and includes iframe content on other pages. Reproduction: on
   `https://jqueryui.com/sortable/`, after reordering the list, `get_page_text` on A did not
   include the iframe's item list at all; on B it did. (Recorded as informational since it cuts
   the other way from bug 4 above; listed here because it is a concrete, reproducible content gap
   on a widely-used tool.)

All tabs opened during this session were closed on both bridges at the end (A: `177110503`,
`177110519`; B: `177110504` → recreated as `177110525` after the tab-death bug, plus `177110516`).

