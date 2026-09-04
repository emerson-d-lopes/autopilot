# How chrome-mcp compares

Written 2026-09-03. Compares this project (the Lantern extension plus the `chrome-mcp` server) with the browser tools an agent can pick from today. Facts about the other projects come from their published docs and from search summaries of them, cited at the end. Facts about this project come from running it. Where a number is measured, the section says how.

## The field

| Project | Browser it drives | Transport | Page model | Status |
|---|---|---|---|---|
| Claude in Chrome (Anthropic) | The user's own Chrome, Edge, Brave, Arc, Vivaldi, Opera, through a Web Store extension | Native messaging to Claude Code, remote sessions through a bridge host | Accessibility tree with `ref_N` handles, screenshots, `find` through a nested model call | Shipped, 9 million installs by June 2026 |
| chrome-mcp (this project) | The user's own Chromium browser through an unpacked extension | Native messaging host, named pipe, MCP over stdio | Same tree and refs, local `find`, `quick` script protocol | Working, unreleased |
| Playwright MCP (Microsoft) | A browser it launches itself, or the user's Chrome through an optional extension mode | MCP, in-process Playwright | Accessibility snapshot with refs, over 20 core tools and over 70 with every category enabled | Shipped, maintained by the Playwright team |
| Chrome DevTools MCP (Google) | A Chrome it launches, or a running one over a DevTools URL | MCP, Puppeteer over CDP | Snapshot with `uid` handles, plus performance traces, network, console, memory, Lighthouse: 26 tools | Shipped, official Chrome DevTools project |
| Browser MCP | The user's own Chrome through an extension | Extension to a local server over a WebSocket | Adapted from Playwright MCP: navigation, clicks, keys, waits, snapshots | Shipped |
| browser-use | A browser it launches, Python | Library, not MCP first | Vision plus DOM analysis, an agent loop of its own | Shipped |
| Stagehand, Browserbase MCP | A hosted browser | MCP to a cloud runtime | `act`, `extract`, `observe` over natural language | Shipped, paid runtime |

Two families. One launches a fresh browser, which is repeatable and has no logins (Playwright, DevTools MCP, browser-use, Browserbase). The other drives the browser the user is already signed into (Claude in Chrome, Browser MCP, this project). The second family is what makes Gmail, Notion, an internal dashboard or a localhost app with a session cookie reachable without credentials, and it is where this project sits.

## Feature by feature

| Capability | Claude in Chrome | chrome-mcp | Playwright MCP | Chrome DevTools MCP | Browser MCP |
|---|---|---|---|---|---|
| Uses the user's logged-in profile | Yes | Yes | Only in extension mode | Only when connecting to a running Chrome started with a debugging port | Yes |
| Element handles from a tree | `ref_N` | `ref_N` | refs from `browser_snapshot` | `uid` from `take_snapshot` | refs |
| Natural-language `find` | Nested model call, costs a second inference | Local lexical ranking, under 1ms, no tokens, weaker on meaning | No | No | No |
| Screenshots sized for tokens | Yes, 1568px cap | Yes, area-bounded to about 1600 tokens, coordinates mapped back | Full-size | Full-size | Full-size |
| Batch of calls in one turn | `browser_batch` | `browser_batch`, plus `quick` one-line-per-action scripts and `$last` for a tab created in the batch | No batch tool | No batch tool | No |
| Console and network capture | Yes | Yes, from the moment the tab joined the session | Console and network tools | Console, network, plus request bodies | Console |
| Performance traces, Lighthouse, heap snapshots | No | No | No | Yes | No |
| File upload | Yes, 10 MB, shared files only | Yes, inputs and drop zones, 25 MB | Yes | Yes | No |
| GIF recording | Yes, with overlays | Yes, no overlays | Video and trace recording | No | No |
| Runs in the background | Tabs are visible; the docs say actions run in a visible window | Yes: tabs open unselected, nothing is raised, hidden tabs are woken through CDP | Launched browser can be headless | Launched browser can be headless | Visible |
| Where the agent's tabs live | A tab group in a new window | A tab group in the user's current window, marked ⏳ ✅ ❌ | Its own browser | Its own browser | The current tab |
| Permission model | Per-site prompts, blocked categories, high-risk action confirmation, classifiers | Origin blocklist, three modes, per-action origin re-check inside the extension | Client-side only | Client-side only | Client-side only |
| Several browsers connected | Pick from a list or pair from the extension | Registry and `select_browser` | One browser per server | One browser per server | One |
| What the user sees while it works | Side panel with progress, tab group | Toolbar popup with state, sessions and last calls, group marks | Nothing in the user's browser | Nothing in the user's browser | Nothing |
| Action journal on disk | No | Yes, JSONL and Markdown per browser per day | Traces on request | No | No |
| Site-specific skills, scheduling, workflow recording | Yes | No | No | No | No |
| Cross-origin iframes | Not documented | Reported as leaves, with a note when one covers the viewport | Playwright reaches into frames | Puppeteer reaches into frames | No |

## Speed

Numbers for this project are medians from the action journal of the runs on 2026-09-03 against the development browser (Chrome for Testing 152, Windows 11), with the session tab hidden behind another tab. The other projects publish no comparable per-call figures, so their column is what their architecture implies.

| Call | chrome-mcp, measured | What it involves | Others |
|---|---|---|---|
| `read_page` (accessibility tree, 13 nodes) | 6ms | Content script walks the DOM | Playwright and DevTools MCP build the snapshot from the browser's accessibility tree over CDP, typically tens of ms |
| `form_input` | 4ms | Content script sets the value and fires events | Comparable |
| `get_page_text` | 4ms, 17ms on a Wikipedia article | Content script | Comparable |
| `computer` click by ref | 203ms on a radio, 610ms on a submit that navigates | 100ms move-to-press gap, hit test, pointer drawing, mouse events over CDP | Playwright waits for actionability checks, often 50 to 300ms; Claude in Chrome uses the same 100ms gap |
| `computer` screenshot, hidden tab | 58ms | One screencast frame, downscaled | A surface capture of a hidden tab took 3 to 4 seconds and sometimes timed out in the same browser, which is why the screencast path exists |
| `navigate` | 396ms median, 819ms p90 | Load event on httpbin and Wikipedia | Network-bound for everyone |
| `wait_for_page` after a submit | 830ms | Waits for the navigation to begin, the load event, in-flight requests to drain, and the DOM to go quiet | Playwright's auto-waiting is per action rather than a separate call |
| `find` | under 1ms of ranking | Local scoring | Claude in Chrome spends a model call, hundreds of ms and tokens |

Where this project is faster: `find` (no inference), hidden-tab screenshots (screencast frame instead of a surface capture), and anything read through the content script rather than over CDP. Where it is slower: a click carries a deliberate 100ms hover gap before the press, the same as Claude in Chrome, so menus and tooltips that open on hover are there when the press lands.

Round trips matter more than per-call latency for an agent, because every call is a model turn. `browser_batch` and `quick` collapse a ten-step flow into one turn; Playwright MCP and DevTools MCP have no batch tool, so the same flow costs ten turns.

## Where this project is behind

- `find` resolves by wording first. A query like "most viewed article link", whose words share nothing with the link names, now escalates to a model call through MCP sampling, which only works on a client that offers the sampling capability.
- No site-specific skills, scheduling, workflow recording, or a chat surface of its own. Those are product features of Claude in Chrome rather than automation features.
- No performance traces, Lighthouse or heap analysis. Chrome DevTools MCP owns that ground.
- Cross-origin iframes are leaves. Playwright and Puppeteer address frames directly.
- Loading the extension is a manual click-through, since Chrome 137 and later ignore `--load-extension`. Claude in Chrome and Browser MCP install from the Web Store.

## Where this project is ahead

- Background operation with the user's own profile: nothing is brought to the front, and hidden tabs stay responsive through focus emulation and an active lifecycle state, measured at 1ms input acknowledgement and 58ms screenshots. Claude in Chrome's docs describe actions running in a visible window.
- `quick` mode: one line per action, parsed up front so a typo cannot leave a flow half done, with tab commands.
- An action journal that says what happened, per browser, per day, readable without tooling.
- Diagnostics that name the cause: a refused debugger attach lists the tab's frames and targets, a covering cross-origin frame is announced in the tree, a batch reports the step it stopped at.
- Claude in Chrome's own tool names and argument spellings are accepted, so a batch written for that extension runs unchanged.

## Sources

- Playwright MCP: [playwright.dev/mcp](https://playwright.dev/mcp/introduction), [github.com/microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp)
- Chrome DevTools MCP: [github.com/ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp), [tool list](https://mcpfind.org/blog/chrome-devtools-mcp-server-guide)
- Browser MCP: [browsermcp.io](https://browsermcp.io/), [docs.browsermcp.io](https://docs.browsermcp.io/), [github.com/BrowserMCP/mcp](https://github.com/browsermcp/mcp)
- Claude in Chrome: [Claude Code docs, Use Claude Code with Chrome](https://code.claude.com/docs/en/chrome), [Anthropic help center](https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome), [SPEC.md](SPEC.md) in this repository
- Field comparisons: [webfuse.com](https://www.webfuse.com/blog/the-top-5-best-mcp-servers-for-ai-agent-browser-automation), [fp8.co](https://fp8.co/articles/Browser-Use-vs-Stagehand-vs-Playwright-MCP-AI-Agent-Browser-Automation), [top-mcps.com](https://top-mcps.com/guides/playwright-vs-browserbase-mcp)
