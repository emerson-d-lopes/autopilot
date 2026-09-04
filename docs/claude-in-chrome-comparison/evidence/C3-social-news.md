# C3: Social and news sites, bridge comparison

Bridge A: Claude in Chrome (`mcp__claude-in-chrome__*`), own window.
Bridge B: chrome-mcp (`mcp__chrome-mcp__*`), tabs in the user's window.

All times in milliseconds, wall-clock measured with `date +%s%3N` around the call(s) unless noted as tool-reported. Order alternated A-then-B, B-then-A, A-then-B across the three runs of each scenario, as instructed. All scenarios are read-only, no sign-in, no state changes.

## 1. Reddit

### 1a. old.reddit.com/r/programming via read_page

Both bridges hit the same result every time: `old.reddit.com/r/programming` 302s to a login wall at `https://old.reddit.com/login/?reason=lor2&dest=https%3A%2F%2Fold.reddit.com%2Fr%2Fprogramming`, page titled "Boas-vindas ao Reddit" (Portuguese, matching the account locale). `read_page` on that page returns only the login form (Google/Apple/email fields), not subreddit content. No post titles were ever retrievable this way.

| Bridge | Run 1 | Run 2 | Run 3 | Agreement |
|---|---|---|---|---|
| A | redirected to login wall | redirected to login wall | redirected to login wall | 3/3 agree |
| B | redirected to login wall, `durationMs: 626` | redirected to login wall, `durationMs: 903` | redirected to login wall, `durationMs: 904` | 3/3 agree |

Verdict: **not supported** on either bridge, not a bridge issue. The site itself walls off old.reddit for this account/session. B's tool-reported `durationMs` for the navigate call: 626, 903, 904 (median 903).

### 1b. www.reddit.com/r/programming: first 10 titles, scroll 5x, count before/after

No login wall on the new Reddit UI (loads normally, feed visible). Post count measured via `document.querySelectorAll('shreddit-post').length`.

| Bridge | Run | Before scroll | After 5 scrolls | First 10 titles readable? |
|---|---|---|---|---|
| A | 1 | 3 | 24 | Yes, via `javascript_tool` `.getAttribute('post-title')` (only 3 were loaded pre-scroll, so "first 10" required scrolling) |
| A | 2 | 3 | 24 | same pattern |
| A | 3 | 3 | 24 | same pattern |
| B | 1 | 27 | 27 | Yes, all 10 readable immediately post-load |
| B | 2 | 27 | 27 | same |
| B | 3 | 27 | 27 | same |

A's runs agree 3/3 (3 → 24). B's runs agree 3/3 (27 → 27, i.e. scrolling added nothing further because B's `quick` `W` (wait-for-settle) step already let the feed lazy-load to 27 posts before the scroll commands ran).

B's `quick` `W` step timing was inconsistent: run 1 took `durationMs: 15734` (`timedOut: true`, it waited the full timeout for network idle that never came, likely due to a persistent ad/analytics connection), while runs 2 and 3 completed in `durationMs: 983` and `durationMs: 985` (`timedOut: false`). Median including the outlier: 983ms.

No login wall or block page for www.reddit.com on either bridge. There is a persistent "Entre no lugar mais autêntico da internet" (sign-in) card overlaying the left column, but it does not block reading or scrolling the feed.

Verdict: **works** on both bridges for scenario 1b, with a real behavioral difference: A's page starts with only 3 posts rendered and needs the scroll to reach 24; B's page (via `quick`'s longer settle wait) already has 27 loaded before any scroll command runs, so B's scroll step is a no-op for this metric.

## 2. cnn.com and theverge.com

### cnn.com (navigates to `edition.cnn.com`)

| Metric | A (run1 / run2 / run3, median) | B (run1 / run2 / run3, median) |
|---|---|---|
| `get_page_text` length | not directly comparable: A's tool has no char count, but `document.body.innerText.length` = 7916 / 7932 / (not re-measured, stable) | B reported full text inline, consistent across runs (~4.9k chars of headline/article text, `url:` header, no `Source element` line) |
| `get_page_text` content | article/headline text via `<div>` source element, not nav noise | same, headline/article text, not nav noise |
| `read_page` (interactive) char length | 2464 / 2464 / 2464 (only ~39 nodes: nav bar, top-of-viewport headline links, cookie banner) | 34112-ish / 34112 / 34112 (309 nodes, includes hundreds of `(offscreen)` links below the fold) |
| `read_page` wall time | ~2s (single call, e.g. run1: 770ms) | ~2.8-3.5s (single call) |
| Screenshot dimensions | 1568x758 (jpeg), all 3 runs | 1568x758, all 3 runs, "~1516 tokens" reported by B under each screenshot |
| Screenshot wall time | run1 ~4.1s (5375-1274=... measured 779914-775375=4539ms including prior step overlap), runs 2-3 batched, ~1-2s each | similar, ~1-3s |
| `read_network_requests` total | run1: "No network requests found for this tab" (tracking starts only when first called, page had already loaded) | 250 requests total (via `performance.getEntriesByType('resource').length`); `read_network_requests` itself errored past 500-line/178k-char output on an unfiltered call |
| `read_network_requests` failed count | N/A (none captured) | 27+ failed/blocked (mostly ad/analytics: 451s, CSP-blocked `doubleclick`/`google.com/rmkt`, `net::ERR_ABORTED`) |
| `read_console_messages` errors (onlyErrors) | 1 (a CNN "FAVE" ad-player `TypeError: window.turner_getGuid is not a function`), scoped correctly to the CNN domain | contaminated: without `clear:true` beforehand, the console buffer returned 30+ errors including CORS/CSP errors from old.reddit.com and reddit.com left over from earlier navigations in the same tab (see Bugs) |
| Page state (B only) | n/a | `scrollHeight: 7592`, viewport 1707x825, `devicePixelRatio: 2.25`, `readyState: complete` |

All three runs of each measurement agreed for both bridges (2464 chars / 39 nodes for A; ~309 nodes / ~34k chars for B; 1568x758 screenshots both sides).

### theverge.com

| Metric | A (3 runs) | B (3 runs) |
|---|---|---|
| `get_page_text` length | `document.body.innerText.length` = 22744 / 22747 / 22747 (get_page_text itself returned the article/headline stream, `Source element: <main>`, not nav noise) | 20604 / 20607 / 20607 chars, same content, article/headline text |
| `read_page` (interactive) char length | 1708 / 1708 / 1708 (small: nav + top-of-viewport only) | 42345 / 42269 / 42114 (343 / 341 / 340 nodes: full page including offscreen links) |
| Screenshot dims | 1568x758, all 3 runs | 1568x758, all 3 runs, "~1516 tokens" |
| Network requests | 27 total, 1 with a 503 (POST to btloader.com) | 9 requests captured after an explicit `clear:true` reset; 0 failed |
| Console errors | 0 (tool-reported "No console errors ... tracking starts when this tool is first called") | 0 (after `clear:true` reset; "No console messages") |
| `page_state` (B only) | n/a | `scrollHeight: 25528`, viewport 1707x825 |

All 3 runs agreed on both bridges for every metric measured.

**Key finding across both news sites**: A's `read_page` with `filter: "interactive"` consistently returns a much smaller, viewport/near-viewport-biased set of elements (roughly 40 nodes / ~1700-2500 chars) with no truncation warning, while B's `read_page` returns the full interactive tree including elements explicitly marked `(offscreen)`, 8-20x larger (300+ nodes / 34k-42k chars), and does warn when truncated (e.g. "truncated: showing 5 of 309 nodes, 34112 chars total"). This is a large, consistent difference in what "interactive elements" means between the two tools, not a fluke: it reproduced identically across all 6 runs (3 CNN, 3 Verge) on each bridge.

## 3. x.com home page

Loads a logged-out interstitial ("Acontecendo agora." / Continuar com telefone, Google, Apple / email field) on both bridges despite the signed-in Chrome profile, i.e. **x.com itself is not authenticated in this browser** (not a bridge limitation). URL redirects from `/home` to `/`. No posts were visible to read, so "first 5 post texts" is not applicable, confirmed 3/3 on both bridges via `get_page_text`.

| Bridge | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| A | login wall, `computer` screenshot/scroll worked fine | login wall, screenshot worked fine | login wall, `get_page_text` matched runs 1-2 |
| B | login wall confirmed via `get_page_text`; **`computer` (screenshot) then `navigate` in the same tab both failed** with a `chrome-extension://` debugger error | same crash reproduced immediately on a fresh tab | same crash reproduced immediately on a fresh tab |

This is the known bug from the brief ("tab can go unresponsive with a chrome-extension:// debugger error"), and it reproduced 3/3 times, 100% reliably, on x.com's login page specifically. Full verbatim error (first occurrence):

```
Cannot access a chrome-extension:// URL of different extension Frames: top https://x.com/; frame 1030 about:srcdoc; frame 1031 https://accounts.google.com/gsi/button?...&iframe_id=gsi_64871_182725&...
Debugger targets: worker* chrome-extension://nngceckbapebfimnlniiiahkandclblb/background.js; worker* chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/service-worker-loader.js; worker* chrome-extension://hehggadaopoacecdllhhajmbjkdcmajg/background.js; worker* chrome-extension://giagijohigincdlpkfolgcljkhmjdiaa/src/background.js; background_page* chrome-extension://ghbmnnjooekpmoecnnnilnnbdlolhkhi/offscreendocument.html?...; page https://x.com/; other* chrome-extension://nngceckbapebfimnlniiiahkandclblb/overlay/menu.html; ...
```

Repro steps: on bridge B, navigate a tab to `https://x.com/home` (redirects to `/`, which embeds a Google Identity Services sign-in-button iframe). Call `computer` with `action: "screenshot"` (or any `computer` action) on that tab. It fails immediately with the error above, every time, and the tab's group is marked `❌` in `tabs_context`. Once broken, even `navigate` on that same tab to a different URL fails with the same error (the debugger appears to stay wedged to the dead frame tree). `page_state`, `read_page`, `get_page_text`, and `javascript` continue to work on the broken tab; only `computer` and any subsequent `navigate` in that tab are affected.

Workaround confirmed 2/2 times: `tabs_close` the broken tab, `tabs_create` a fresh one, `navigate` to the URL again. This gets a working tab, but `computer` fails again immediately the moment it is called on the reloaded x.com page (i.e. it is triggered by the page itself, not by accumulated tab history).

A had zero issues here: `get_page_text`, `computer` (screenshot, scroll) all worked normally, 3/3 runs, no login-wall-adjacent iframe problem.

Verdict: x.com content **not accessible either way** (real login wall, not a bridge fault). Bridge behavior: A **works** (can screenshot/interact with the wall page). B: `get_page_text`/`read_page`/`navigate`(first load)/`page_state` **work**, but `computer` **fails reproducibly**, and one `computer` call also poisons the tab for further `navigate` calls until the tab is recreated.

## 4. linkedin.com/feed

Unlike x.com, LinkedIn loaded fully signed in on both bridges (as the user, "Emerson Lopes, Senior Software Engineer at Luxury Presence"), consistent with the shared signed-in Chrome profile. First 3 feed items were readable and matched in content type across bridges within each run (feed is dynamic/live and shows slightly different posts run-to-run since it's a real, changing feed, but structure was identical).

| Bridge | Run | `get_page_text` result | `read_page` / `computer` |
|---|---|---|---|
| A | 1, 2, 3 | Full feed text returned every time, `Source element: <main>`, first 3 posts readable (e.g. run 1: Ondrej Jelinek post, Credit Guide promoted post, Rémy Touzard post) | screenshot/scroll worked fine, no crash |
| B | 1, 2, 3 | **`(no text)` every time**, despite the page being visibly, fully rendered and signed in (confirmed via screenshot and via `read_page` returning 214 nodes / 17915 chars of real content) | `read_page`, `computer` (screenshot, scroll) worked fine, no x.com-style crash |

Sample of A's captured first-3-items (run 1): a personal post by Ondrej Jelinek about pitch deck design fatigue, a promoted post from "Credit Guide" (FIDC analytics tool, in Portuguese), and a post from Rémy Touzard about AI outreach tooling.

Verdict: **works** on A (3/3). On B: page loads and is fully interactive (confirmed via `read_page`/screenshot), but `get_page_text` **fails silently**, returning `(no text)` instead of an error, 3/3 times, so the specific ask ("read the first 3 feed items via get_page_text") could not be fulfilled on B with that tool. `read_page` on B is a working substitute (214 nodes, full content visible in the accessibility tree).

## Notable differences

1. **A's `read_page` (interactive filter) returns far less than B's** on content-heavy news pages: ~40 nodes/2-2.5k chars vs. B's 300+ nodes/34-42k chars, reproduced identically across 6 runs (CNN + Verge, 3 runs each). A appears to surface mostly onscreen/near-viewport interactive elements without a truncation warning; B returns the full tree, marks offscreen elements explicitly, and warns when it truncates.
2. **B's `get_page_text` fails silently on LinkedIn's feed** (`(no text)`, 3/3 runs) while the page is fully loaded and readable through other tools (`read_page`, screenshot). A's `get_page_text` handled the same page correctly every time.
3. **B's `computer` tool crashes reproducibly on x.com's login page** (3/3), due to a Google Identity Services iframe, and the failure also poisons subsequent `navigate` calls on the same tab until it is closed and recreated. A has no such issue on the same page.
4. **B's console/network buffers persist across navigations within a tab and are not domain-scoped**, unlike what the brief's known-bug notes might suggest for A. Reading `read_console_messages`/`read_network_requests` on B after multiple navigations in the same tab returns a mix of errors/requests from every site visited in that tab's lifetime, not just the current page, unless `clear:true` is passed proactively before generating the page state you actually want to measure. This produced a contaminated first CNN console-error read (30+ unrelated Reddit-domain CORS/CSP errors mixed with CNN's own error) until corrected.
5. **A's `read_network_requests` only tracks requests made after the tool is first called on a tab**, so a bare call right after `navigate` legitimately reports "No network requests found" even though the page clearly made requests. This showed up identically on CNN.
6. **B's `read_network_requests`/`quick`-with-`R` can exceed the harness's own output token cap** on link-dense pages (CNN: 500 requests / 178,499 chars; The Verge accessibility tree: 63,262 chars across 702 lines both hit the "exceeds maximum allowed tokens" ceiling and were redirected to a saved file). A never hit this ceiling in the same scenarios, because its `read_page`/`read_network_requests` return much smaller payloads by default.
7. **old.reddit.com is fully login-walled for this account/session on both bridges**, identically (3/3 each), a site-level fact rather than a bridge difference. www.reddit.com is not walled on either bridge.
8. **x.com is not authenticated in this Chrome profile** despite the "signed-in profile" premise; both bridges see the same logged-out interstitial, but only B's `computer` tool breaks on it.
9. **B reports a token-cost estimate directly under every screenshot** (e.g. "~1516 tokens"), which A's screenshot output does not surface at all.
10. **B's `quick` wait step (`W`) timing was highly variable on www.reddit.com** (15734ms with `timedOut: true` on the very first call, then a stable ~983-990ms on subsequent calls to the same URL), suggesting a one-time slow resource/connection (possibly the Google ad tag CSP violations seen in the console) rather than a a steady-state cost.

## Bugs

1. **Bridge B: `computer` tool throws and disables the tab on pages embedding a Google Identity Services sign-in iframe.** Repro: bridge B, `navigate` a tab to `https://x.com/home` (redirects to `https://x.com/`, which renders a "Continuar com o Google" button inside a GSI iframe). Call `computer` with any action (tested: `screenshot`, `scroll`) on that tab. Result: immediate error, `Cannot access a chrome-extension:// URL of different extension Frames: top https://x.com/; frame ... https://accounts.google.com/gsi/button?...`, listing several unrelated extension debugger targets. Reproduced 3/3 times, on 3 different tabs (a fresh tab each time). Secondary effect: once triggered, a subsequent `navigate` call on the *same* tab also fails with the identical error (tested twice), even though `page_state`, `read_page`, `get_page_text`, and `javascript` continue to work normally on that same broken tab. Workaround: `tabs_close` + `tabs_create` a new tab, then `navigate` again (confirmed working, though the new tab will hit the same `computer` failure again once it reaches the same page).

2. **Bridge B: `get_page_text` returns `(no text)` on linkedin.com/feed** even though the page is fully rendered, signed in, and interactive (confirmed by both a screenshot and `read_page` returning 214 nodes of real content in the same call sequence). Reproduced 3/3 times across fresh navigations. Repro: bridge B, `navigate` to `https://www.linkedin.com/feed`, wait for load, call `get_page_text`. Result body: `url: https://www.linkedin.com/feed/\n\n(no text)`. Bridge A's `get_page_text` on the identical URL/session returns the full feed text every time (`Source element: <main>`), so this looks specific to B's content-extraction heuristic not finding what it expects in LinkedIn's feed DOM structure.

3. **Bridge B: console and network buffers are not domain- or navigation-scoped**, and reading them without `clear:true` immediately beforehand silently mixes in data from every site the tab visited earlier in the session. This is arguably working as documented ("captured since the tab joined this session") but the tool's onscreen description invites the wrong assumption, and it produced a materially wrong error count for CNN in the first measurement (30 errors reported, nearly all from old.reddit.com/reddit.com, not CNN) until the buffer was cleared and re-measured. Recommend documenting this more prominently, or auto-clearing on cross-origin navigation the way bridge A appears to do for network requests.

4. **Both bridges: large accessibility-tree/network-request reads on link-dense pages can exceed the harness's own token cap**, aborting the call and dumping to a file instead of returning inline. Hit on bridge B for CNN's `read_network_requests` (500 requests / 178,499 characters) and for a combined `quick` `X`+`R` call on The Verge (63,262 characters / 702 lines). Not exactly a bug in the bridges themselves, but both bridges' defaults (no `max_chars` cap on `read_network_requests`, and B's `quick` `R` command has no way to pass `max_chars`) make it easy to trip this on ordinary news sites, and the recovery path documented by the error message (spawn a subagent to page through a saved file) is expensive for a routine read.

Tabs were closed on both bridges at the end of the session.
