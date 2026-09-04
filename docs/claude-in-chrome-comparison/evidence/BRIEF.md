# Briefing for bridge comparison agents

You are comparing two Chrome automation MCP bridges that are both connected in this session:

- **A: Claude in Chrome** (official Anthropic extension). Tools are named `mcp__claude-in-chrome__*`.
- **B: chrome-mcp** (the user's own project at `C:\Users\edfl\workspace\chrome-mcp`, README.md and STATUS.md there describe it). Tools are named `mcp__chrome-mcp__*`.

Both drive the same physical Chrome (the user's signed-in profile). A opens its own window. B opens tabs in the user's current window and activates them before input.

## Loading tools

All browser tools are deferred. Load everything you need in ONE ToolSearch call, e.g.
`select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__tabs_close_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__find,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__form_input,mcp__claude-in-chrome__javascript_tool,mcp__claude-in-chrome__get_page_text,mcp__claude-in-chrome__read_console_messages,mcp__claude-in-chrome__read_network_requests,mcp__claude-in-chrome__browser_batch,mcp__claude-in-chrome__file_upload,mcp__claude-in-chrome__gif_creator,mcp__claude-in-chrome__resize_window,mcp__claude-in-chrome__upload_image,mcp__claude-in-chrome__select_browser`
and the same list for `mcp__chrome-mcp__` (names there: `tabs_context`, `tabs_create`, `tabs_close`, `navigate`, `read_page`, `find`, `computer`, `form_input`, `javascript`, `get_page_text`, `read_console_messages`, `read_network_requests`, `browser_batch`, `quick`, `page_state`, `wait_for_page`, `file_upload`, `gif_creator`, `resize_window`, `upload_image`, `select_browser`).

## Browser selection (do this first, once)

- A: call `mcp__claude-in-chrome__select_browser` with deviceId `3573f868-d855-43cc-9350-000c625d6156`. Do NOT ask the user which browser; there is only one and this is pre-authorized. Then `tabs_context_mcp` with createIfEmpty true, then work in tabs you create.
- B: call `mcp__chrome-mcp__select_browser` with browserId `bz04vrv3f`. Then `tabs_context` with createIfEmpty true.

If a tool says the tab is gone, call the context tool again to get fresh ids.

## Ground rules

- No credentials anywhere, no sign-in, no CAPTCHA solving, no purchases, nothing that changes the user's real accounts (no stars, follows, comments, posts, issues, gists, edits on GitHub or anywhere signed in). Reading signed-in pages is fine.
- Never trigger `alert`, `confirm`, or `prompt`. A modal freezes the extension.
- Data modification tests use only throwaway sites (the local test site, TodoMVC, the-internet.herokuapp.com, demoqa.com, httpbin.org) where nothing persists to a real account.
- Do not run in parallel with another browser agent. You have the browser to yourself.
- Prefer `browser_batch` (both bridges) and `quick` (B only) to save turns. But ALSO test the single-call tools, since the comparison is about the tools.
- Close the tabs you created when done, on both bridges.
- Time things: run `date +%s%3N` in Bash before and after a sequence when you report a duration. B's navigate returns `durationMs` itself. Report the tool-reported figure and your wall-clock figure separately and say which is which.
- Report token cost where relevant: the character length of read_page output, the screenshot dimensions and the token estimate B prints under its screenshots.

## Local test site

Served at `http://127.0.0.1:8765/`. Pages:
- `/index.html`: the main fixture. Sections: Probe (shows navigator.webdriver, whether a console getter trap fired, and a live log of every click/keydown/input/pointerdown/drop event with its isTrusted flag), Form (text, email, select, checkbox, radios, textarea, disabled input, readonly input, a keydown-only counter input `#kd`, a controlled input `#ctl` that shows the input event's inputType, submit that prints FormData as JSON into `#out`), Shadow DOM (open and closed shadow roots each with a button, result in `#shadow-out`), Iframes (a same-origin srcdoc iframe with a button, and a cross-origin iframe of example.com), Contenteditable `#ce`, Hover menu (link only visible on hover, result in `#hoverout`), Drag and drop (HTML5 drag A onto B, result in `#dndout`, and a range slider `#slider` with value in `#sliderval`), Upload (file input `#file`, result in `#fileout`; a drop zone `#drop`, result in `#dropout`), Dynamic (button `#load` adds 5 list items after 1.5s; `#newtab` opens example.com with window.open; `#blanklink` is a target=_blank link; ctrl+k sets `#short`), Network (`#fetchok` GETs /api/ok, `#fetch404` GETs a 404, `#post` POSTs JSON to /api/echo, result in `#netout`), a pseudo dialog button, and `#farbtn` 2500px down the page.
- The page logs at load: `console.log('page loaded')`, a warning, an error, and throws an uncaught error 300ms later. It also console.logs an object whose `id` getter marks `#cdp` as YES if a debugger serialized it.
- `/slow` takes 4 seconds to respond. `/big` is a 3000-row table with a button and link per row (9000 interactive elements). `/redirect` 302s to index. `/spa` shows "loading" then after 2s renders a `#go` button, which when clicked renders `<p id=done>`. `/dialog` has an alert button (DO NOT click it) and an ok button.
- Upload fixtures: `C:\Users\edfl\AppData\Local\Temp\claude\C--Users-edfl-workspace\cea2edf7-d4ed-4c25-8d92-c6558ce2b6b8\scratchpad\site\upload1.txt` (13 bytes) and `upload2.txt` (5000 bytes).

## Repeat everything three times

The user wants reliable numbers. Run every scenario THREE times on each bridge, not once. Alternate the order (A then B, then B then A, then A then B) so warm-up and caching do not favour one side. For timings report all three values and the median. For behaviour (works / fails) report whether all three runs agreed, and if they did not, describe each run. A result that only happened once is flaky and must be labelled as such. Do not skip the repeats to save time. Time is not a constraint here.

## How to report

Write your findings to the results file named in your task, as Markdown. For every scenario give one row per bridge: what you called, what happened, verbatim error text if any, timing, and a verdict (works / partial / fails / not supported). Be concrete: quote the tool output that proves the claim. When something is untested say so and why. Do not pad. Plain descriptive headings. No em dashes, no semicolons. Also give a final section "Notable differences" with the 5 to 10 findings that matter most, and "Bugs" listing anything that looks like a defect in either bridge, with reproduction steps.
