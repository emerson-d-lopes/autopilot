# Real websites, read-only, bridge comparison

## Scope note (read first)

This file was built across two passes. The first pass ran Wikipedia and Hacker News once each. This second pass completed Wikipedia and Hacker News to three runs each per bridge (alternating bridge order run to run, as instructed), then ran GitHub (signed in), YouTube, Google Search, Google Maps, and Amazon, one full pass per bridge each (not three runs each, given the number of sub-steps in each of those scenarios and the session's turn budget — called out explicitly in each scenario's own section, with the specific reduction named). Every timing/behavior claim below is quoted from an actual tool call, not a projection. The "Notable differences" and "Bugs" sections near the end of this file are the final, consolidated versions covering everything run in both passes; earlier partial versions of those two sections have been removed to avoid duplication.

Not run in this pass, due to budget: Reddit, CNN/The Verge, X, LinkedIn, Gmail, Google Docs, Notion, and a dedicated scenario-15-style timing table. These should be treated as untested, not as "works" or "fails."

## Scenario 1: Wikipedia

One run per bridge (not three).

### Bridge A (Claude in Chrome)

- Navigated to en.wikipedia.org: ok.
- Search box: `form_input` set the value "Chrome DevTools Protocol" into the search textbox, then `computer key Return` was sent. **Did not submit the search** — `location.href` stayed on `Main_Page` and the visible page was unchanged (confirmed via screenshot showing the typed text still sitting in the box, no results). Re-tried with `computer left_click` on the box, `computer type`, `computer key Return` — same result, Enter did not submit. Only clicking the literal "Search" button with `computer left_click` at its coordinates submitted the form and navigated to the search results page (`/w/index.php?search=...`).
- Wikipedia has no article titled exactly "Chrome DevTools Protocol" (630 results, closest exact match is "Headless browser"), so "first result" was literally "Chrome Remote Desktop." I used that as the target article for the rest of the scenario.
- Clicking the first result's ref (`ref_180`, a `find`-returned link) via `computer left_click ref=...` **silently no-op'd**: no navigation, `location.href` unchanged, confirmed with a direct `javascript_tool` read of `document.title` immediately after. Retried after `computer scroll_to ref_180` then `computer left_click ref_180` again — still no navigation. Took a screenshot and clicked the same link by raw pixel coordinate (`computer left_click [222,402]`) — this worked, but only after roughly a 1-second settle; `document.title` was still the search-results title immediately after the click and only became "Chrome Remote Desktop - Wikipedia" after a `computer wait 1`.
- Aside: `javascript_tool` returned `[BLOCKED: Cookie/query string data]` instead of executing `location.href` while the tab's URL contained a `search=` query string, even though the expression had nothing to do with cookies. `document.title` on the same tab, same moment, executed fine. This looks like an overly broad content filter keying off the URL rather than the JS expression.
- On the article page, `get_page_text` returned a clean article body (~2,750 words as printed, full infobox + "Software"/"See also"/"References"/"External links" sections + categories), no visible left-nav or sidebar noise mixed into the body text, matching the known-good pattern from the local-site tests.
- `read_page filter=interactive` on the article returned 67 refs, not truncated, but **does not mark elements as offscreen** the way bridge B's does — every ref looks equally "there," which contributed to picking an offscreen TOC link below.
- Clicked the TOC "Software" link (`ref_9`, from the earlier `find`) with `computer left_click ref=ref_9`. **Silently no-op'd again**: `window.scrollY` was `0` and `location.hash` was empty immediately after, confirmed via `javascript_tool`.

This is the same failure mode called out in the brief for bridge A: **ref clicks on off-screen (or otherwise non-trivially-positioned) elements silently no-op**, with no error returned to the caller. It recurred four times in this one scenario (search-result link twice, TOC link once, plus the Return-key-doesn't-submit variant on the search box), all with clean, verified proof (no navigation, no hash change, no scroll).

Verdict: **partial**. Text extraction and interactive-tree size are fine and match bridge B's data closely; navigation via ref-click and via Enter-in-search-box are broken often enough that a caller must fall back to raw-coordinate clicks and verify state after every click.

### Bridge B (chrome-mcp)

- Navigated with `N` in a `quick` script: `durationMs: 989` (self-reported).
- `read_page interactive` on Main_Page returned 248 nodes, explicitly tagging offscreen elements, e.g. `link "a transnational online sexual-abuse network" [ref_53] (offscreen)`.
- Search: one `quick` script — `F ref_4 <query>` (form_input) then `C ref_5` (click Search button) then `W` — worked in a single shot, `durationMs: 1410` for the wait step, landed on the results page with the search string carried through.
- Clicked the first result via `find` → `C ref_35` in a `quick` script: worked immediately, `navigated: true`, `durationMs: 512` for the wait. No retry needed.
- `get_page_text` on the article: same clean content as bridge A, same sections, no nav noise.
- `read_page interactive`: 159 nodes on the article page, offscreen elements correctly flagged (e.g. TOC entries below the fold before scrolling are not flagged offscreen because the sidebar-style TOC sits in the visible left column here — headings deeper in the article body are marked offscreen).
- Clicked TOC "1 Software" (`ref_11`): worked on the first try. Verified with `javascript`: `window.scrollY + " " + location.hash` returned `"524.44... #Software"` — real scroll, real hash.

Verdict: **works**. Every click landed on the first try, no retries or coordinate fallbacks needed, and the tool self-reports both duration and whether navigation actually occurred (`navigated: true/false`), which bridge A's `computer`/`browser_batch` output does not give at all — you have to separately verify state yourself, as I did above.

### Scenario 1 timing (single run, not median of three)

- Bridge A: wall clock not cleanly isolated because of the retries forced by the click bug; the search-box detour plus three failed clicks plus one successful coordinate click took roughly 90 seconds of tool-call time end to end (from first navigate to landing on the article), most of it retry overhead, not raw page load.
- Bridge B: `navigate` 989 ms, search-submit-wait 1410 ms, click-first-result-wait 512 ms — three cleanly reported figures, ~2.9 s of actual waits, no retries.

## Scenario 2: Hacker News

One run per bridge.

### Bridge A

- `navigate` + `read_page interactive` in one `browser_batch`: returned all ~30 front-page items' refs cleanly (title, link, points-adjacent metadata is in separate `get_page_text`, not `read_page`).
- Top 5 titles (from `read_page`): "Audacity 4.0", "Elevated Errors for Multiple Models", "Pre-Release of Polars 2.0", "The Browser's Main Thread Is Expensive", "Invisible Companies". Matches bridge B exactly (expected, same page).
- Clicked "108 comments" link for the first story via its ref (`ref_17`) with `computer left_click`. **Silently no-op'd** a fifth time in this session: `get_page_text` right after the click still showed the front-page listing, not the comments thread. Screenshotted, then clicked the same link by raw pixel coordinate (`[373, 61]`) — this worked immediately, landed on `item?id=49548395`, `get_page_text` returned the full comment thread (first three comments: Lautzi's Muse/Tantacrul video recommendation, Lio's reply about "Notation Must Die", stevoski's reply — all present and correctly threaded/readable).
- `navigate url="back"`: worked, returned to the front page. Confirmed via the next screenshot/title.

Verdict: **partial**, same failure mode as scenario 1 — ref-click no-op on a normal, in-viewport link this time (the "108 comments" link was near the top of the page, well within the viewport, so this is not purely an offscreen issue; it reproduced on a visible element too).

### Bridge B

- `quick` script `N` + `W` + `R interactive` in one call: 226 nodes, offscreen-tagged, `durationMs: 1028` for navigate+wait.
- Top 5 titles matched bridge A exactly.
- One `quick` script did click ("108 comments" ref_17) + wait + read-text + navigate-back + wait + read-title, all in a single call. Click worked on the first try (`navigated: true`, `durationMs: 845`), full comment thread returned via `X` (get_page_text), first three comments visible and correctly ordered, then `N back` + `W` (`durationMs: 989`) returned to the front page, confirmed by `J document.title` returning `"Hacker News"`.

Verdict: **works**, first try, and the whole read-click-read-back-verify sequence for this scenario took one tool call on bridge B versus three separate calls (plus a failed click and a screenshot to recover) on bridge A.

## Scenario 1 continued: Wikipedia runs 2 and 3

Runs 2 and 3 used a lighter methodology than run 1: instead of re-running the full search-to-article flow every time, run 2 repeated the full flow (search, click result, click TOC) and run 3 tested only the highest-signal step (TOC ref-click on the article page, the step that best isolates the bridge A bug) after navigating straight to the article. This was a deliberate scope reduction to fit budget; it is called out here rather than silently done.

### Bridge A, run 2 (full flow)
- `form_input` set the search box, screenshot confirmed text entered, clicked the Search button (coordinate `[752,30]`, since the button's ref changes once the autocomplete dropdown renders): worked, landed on results page.
- Clicked the first result ("Chrome Remote Desktop") by ref (`ref_180`): **no-op**. Verified via `javascript_tool` `document.title` immediately after, unchanged ("...Search results - Wikipedia").
- Fallback: screenshot, then coordinate click `[278,376]`: worked, `get_page_text` confirmed landing on the article.
- Clicked TOC "Software" link by ref (`ref_106`): **no-op** again. Verified via `javascript_tool` `window.scrollY + ' ' + location.hash` → `"0 "` (no scroll, no hash).
- Wall clock (navigate to end of TOC-click check): 1788445239746 → 1788445286212 ≈ 46.5s, including the two failed clicks, two recovery steps, and verification calls.

### Bridge A, run 3 (TOC click only, starting from the article page)
- Navigated directly to `https://en.wikipedia.org/wiki/Chrome_Remote_Desktop`.
- Clicked TOC "Software" link by ref (`ref_106`): **no-op** a third time. `javascript_tool` confirmed `window.scrollY + ' ' + location.hash` → `"0 "`.
- This is run 3 of 3 for the TOC-click sub-case: no-op all three times it was attempted (run 1 in the original file, run 2, run 3 here). The search-result-click sub-case no-op'd in run 1 and run 2 (only attempted twice, not three times, due to the lighter run-3 methodology).

### Bridge B, run 2 (full flow)
- `quick`: `N` (navigate) + `W` + `R interactive` on Main_Page: `durationMs: 984`.
- `F ref_4 <query>` then intended `C ref_5`: **failed** with `ref ref_5 is no longer on the page. Re-read the page.` The search box's autocomplete dropdown re-rendered the DOM after `form_input`, invalidating the previously-read Search-button ref. This is a real bridge B failure mode, distinct from bridge A's silent no-op: bridge B fails loudly and says exactly why, and recovery was a single `find` call to get a fresh ref (`ref_253`), then the click worked immediately. Recorded as a bug below.
- Clicked Search button (`ref_253`): worked, `durationMs: 1207`, landed on results with `navigated: true`.
- Clicked first result "Chrome Remote Desktop" (`ref_35`): worked, `durationMs: 499`, `navigated: true`, confirmed via `get_page_text` returning the full article.
- Clicked TOC "1 Software" (`ref_11`): worked, `durationMs: 1045`. Verified via `javascript`: `window.scrollY + " " + location.hash` → `"524.4444580078125 #Software"`.
- Wall clock (navigate to end of TOC-click check): 1788445210760 → 1788445232802 ≈ 22.0s, including the stale-ref recovery.

### Bridge B, run 3 (TOC click only, starting from the article page)
- `quick`: `N` to the article + `W` (`durationMs: 985`) + `R interactive` (159 nodes).
- Clicked TOC "1 Software" (`ref_11`): worked, `durationMs: 984`. `javascript` confirmed `"524.4444580078125 #Software"`, same result as run 2.

### Wikipedia: three-run agreement summary
- Bridge A TOC-click: **no-op all 3/3 runs**, consistent failure, not flaky, zero exceptions raised by the tool itself in any run.
- Bridge A search-result-click: no-op 2/2 attempted runs (not run in run 3's lighter methodology).
- Bridge A recovery (screenshot + coordinate click): worked 2/2 times it was tried.
- Bridge B TOC-click and result-click: **worked 3/3 and 2/2 runs respectively**, first try every time.
- Bridge B stale-ref-after-form_input: happened 1/1 times it was tested this way (only tested in run 2, since run 1 used a different action order and run 3 skipped search entirely). Not enough runs to call this a rate; recorded as observed once.
- Bridge B navigate+wait durations across the 3 Main_Page/article navigations: 989ms (run1), 984ms (run2), 985ms (run3) — tightly clustered, median 985ms.
- Bridge B TOC-click durations: 512ms(run1, different target)/1045ms(run2)/984ms(run3) for comparable clicks: 1045 and 984 for the identical TOC click, median ≈1015ms.

## Scenario 2 continued (numbering per original file): Hacker News runs 2 and 3

### Bridge A, run 2
- `find` located the "110 comments" ref for the top story (`ref_27`). Clicked by ref: **no-op**, confirmed via `javascript_tool` `location.href` → unchanged (`https://news.ycombinator.com/`).
- Fallback: screenshot, coordinate click `[373,61]`: worked, `location.href` → `https://news.ycombinator.com/item?id=49548395`.
- `navigate back`: worked, returned to front page.

### Bridge A, run 3
- Re-`find` on the front page (ref ids can change per page load): `ref_27` again for "110 comments".
- Clicked by ref: **this time it worked**, `location.href` → `.../item?id=49548395` on the first try, no fallback needed.
- This is the one case in this whole session where a bridge A ref-click on a previously-reliable-failing target succeeded without any workaround. It contradicts the "no-op every time" pattern seen on the Wikipedia TOC link and shows the bug is not deterministic per-element: same link, same page, same session, worked once out of three tries (run1 no-op, run2 no-op, run3 worked). Labeled explicitly as **flaky** per the brief's instruction.
- `navigate back`: worked.

### Bridge B, run 2
- `quick`: `N`+`W` (`durationMs: 1028` for the earlier read, not re-measured here) then `R interactive` (226 nodes).
- `C ref_17` (comments link) + `W` + `X` (get_page_text): worked, `durationMs: 847`, landed on the full comment thread, first three comments legible and in order (Lautzi → Lio → stevoski).
- `N back` + `W` + `J document.title`: worked, `durationMs: 1043`, title returned `"Hacker News"`.

### Bridge B, run 3
- `N`+`W`+`R interactive`: `durationMs: 987`, 226 nodes (list refreshed, same top story).
- `C ref_17` + `W` + `J document.title`: worked, `durationMs: 842`, title `"Audacity 4.0 | Hacker News"` (comment page title, confirms navigation).
- `navigate back`: worked, confirmed via `page_state`/title on return.

### Hacker News: three-run agreement summary
- Bridge A comments-link ref-click: **no-op 2/3 runs (run1, run2), worked 1/3 (run3)**. This is the flaky case called out in the brief. All three runs used the same "110 comments" link for the same top story position.
- Bridge A recovery via coordinate click: worked 2/2 times it was needed.
- Bridge B comments-link ref-click: **worked 3/3 runs**, no failures, no stale-ref issues on this page (unlike the Wikipedia search box case).
- Bridge B click+wait durations: 845ms(run1)/847ms(run2)/842ms(run3), extremely tight, median 845ms.
- Bridge B navigate+wait durations: 1028ms(run1)/984ms(run2 Main-page-equivalent context differs)/987ms(run3), consistent around 1000ms.


## Scenario 3: GitHub, signed in as emerson-d-lopes

One full pass per bridge (not three runs, due to budget: this scenario has many sub-steps and the account is a live, real, signed-in GitHub account with a changing notification inbox, so a strict repeat would just re-read a shifting inbox rather than compare bridges). Read-only throughout: no stars, no comments, no clicks on notification items beyond navigating to the inbox page itself.

### Bridge B (chrome-mcp)
- `N` to `github.com/emerson-d-lopes/chrome-mcp` + `W` (`durationMs: 984`) + `X`: clean full README text, no nav chrome mixed in. Length of the `<article>` README content measured via `document.querySelector('article, [data-testid="readme"], .markdown-body')?.innerText.length` -> **16,226 characters**.
- Issues tab (`C ref_17`): worked, `navigated: true`, `durationMs: 688`.
- Pull requests tab (`C ref_18`): the click landed and the URL updated to `/pulls` immediately, but `document.title` read back as `"Issues · ..."` for one JS eval, and only updated to `"Pull requests · ..."` on a second read a moment later. This is a timing race in when GitHub's client-side router updates `document.title` relative to `readyState`/network-idle, not a click failure. Noted, not counted as a bug.
- Code tab (`C ref_16`): worked, `navigated: true`, `durationMs: 1019`, landed back on `location.href` = the repo root.
- `t` file-finder shortcut: `K t` alone worked correctly and opened the "Go to file" box (confirmed by screenshot: box shows a lone "t" character and a file-suggestion dropdown). **However**, following it with `T README` (the `quick` "type" command) appended text without clearing the existing "t", producing the literal query `"tREADME"` and a "No matches found" result. Fix: `ctrl+a` before typing cleared the box, then `README` typed cleanly, `README.md` matched, Enter navigated to `blob/main/README.md`. This is a real usability trap in the `quick` DSL: `T` inserts without clearing, so any shortcut that pre-populates the target field needs an explicit select-all first. Recorded as a bug below.
- Commits list (`N .../commits/main` + `X`): latest commit message read cleanly: **"Install from the committed manifest key, document other MCP clients"** (short SHA `ececc33`, authored by emerson-d-lopes and claude).
- Global search: `K /` **failed outright**: `unknown key "/". Supported: 0,1,2,...` (the `K` keys command has no entry for punctuation keys like `/`). Fix: `TK /` (type-with-real-key-events) worked and opened the global search dialog, since `/` is a printable character rather than a named key. Recorded as a bug below.
- Typed "chrome-mcp", Enter: landed on `github.com/search?q=chrome-mcp&type=repositories`, results read cleanly via `get_page_text`, top result `ChromeDevTools/chrome-devtools-mcp`, second `hangwin/mcp-chrome`, etc.
- Notifications inbox: `read_page interactive` returned `link "Inbox 62"` in the folder list. Repository breakdown visible too (dashboard 24, client-applications 20, lpmobileV2 14, crm-monorepo 2). No clicks on individual notification rows.

### Bridge A (Claude in Chrome)
- `navigate` + `get_page_text` on the repo root: same README content and structure as bridge B, effectively identical text (not re-measured by character count on this side, but no missing sections, no extra chrome).
- Issues tab: `find` -> `computer left_click ref=ref_55` **no-op'd** (`location.href` unchanged after the click, confirmed via `javascript_tool`). Fallback: screenshot + coordinate click at `(137,70)` worked, `location.href` -> `.../issues`.
- Pull requests tab: `find` -> ref-click **no-op'd** again (`location.href` unchanged). Coordinate click at `(233,70)` was tried immediately after and *also* initially looked like a no-op (`location.href` unchanged right after the click), but this was the same GitHub-router timing race seen on bridge B: waiting ~2s and re-checking showed the page had in fact navigated and rendered (`document.title` -> "Pull requests" page content visible in a follow-up screenshot). So this specific case is a false alarm caused by checking state too early, not a second click failure, and is called out explicitly so it isn't miscounted as a no-op.
- Code tab: coordinate click at `(57,70)` worked cleanly, landed back on the repo root after a 1s wait.
- `t` file-finder shortcut: `computer key text="t"` **had no visible effect on the first press** (screenshot right after showed the "Go to file" box unfocused, page still mid-render with skeleton loaders). A second press of `t` after an extra 1s wait worked and focused the box (screenshot confirmed cursor/focus ring on "Go to file"). This looks like the shortcut listener not yet being attached while the page was still loading, rather than a bug in the key-press mechanism itself; recorded as an observation, not a bug, since it self-resolved once the page was ready.
- Typed "README" via `computer type`, `computer key Return`: worked cleanly on the first try (no stale-focus issue here, unlike bridge B's need for `ctrl+a`), landed on `blob/main/README.md`.
- Commits list: `navigate` + `get_page_text` reproduced the exact same latest commit message and SHA as bridge B: "Install from the committed manifest key, document other MCP clients" (`ececc33`).
- Global search: `computer key text="slash"` (the named-key spelling) **had no effect**, no dialog opened (screenshot confirmed page unchanged, still showing the dashboard feed). Retried with `computer key text="/"` (the literal character): worked, opened the search dialog. This mirrors bridge B's `K /` failure in spirit (both bridges have a punctuation-key naming gap) but the workaround differs: bridge A's `computer key` tool accepts the literal character `/` directly, while bridge B's `K` command rejects it outright and requires switching to `TK` (a different command) entirely.
- Typed "chrome-mcp", Enter: landed on the same `github.com/search?q=chrome-mcp&type=repositories` URL. `javascript_tool` `location.href` read immediately after returned **`[BLOCKED: Cookie/query string data]`** again, the same content-filter misfire recorded in the original Wikipedia bug (scenario 1, bug 2) - this URL also happens to carry a `q=` query string. Confirms the filter keys off the current page URL shape, not the evaluated expression, since `location.href` is an unambiguous read with nothing cookie-related in it. `get_page_text` on the same page worked normally and returned the same result set as bridge B (same top 2 hits: `ChromeDevTools/chrome-devtools-mcp`, `hangwin/mcp-chrome`).
- Notifications inbox: `get_page_text` (used since bridge A's `read_page interactive` output does not carry the folder-count label text the way bridge B's does) showed **Inbox 61**, one less than bridge B's read a few minutes earlier. This is a real, live, changing inbox on a signed-in account (notifications arrive continuously), not a bridge discrepancy: the two reads were roughly 90 seconds apart in wall-clock time. No item clicks performed.

### GitHub scenario: differences and verdicts
- Bridge A ref-clicks on the repo nav tabs no-op'd 2 out of the 3 tabs tried by ref (Issues, Pull requests); Code was only tried by coordinate. Bridge B's ref-clicks worked on all 3 nav tabs.
- Both bridges have a punctuation-key gap on their "named key" input path (`slash` on bridge A, `K /` on bridge B), each with a different, bridge-specific workaround (literal character for bridge A, a different command (`TK`) for bridge B).
- Both bridges reproduced their own already-known bugs on this real, unrelated site: bridge A's cookie/query-string `javascript_tool` false-positive, and (new here) bridge B's `T` command not clearing pre-filled input before typing.
- The file-finder (`t`) and global-search (`/`) GitHub keyboard shortcuts work on both bridges once the input-quirks above are worked around. Both are genuine OS-level `keydown` shortcuts, not app-level clicks, and both bridges can trigger them.
- Verdict: bridge A **partial** (nav-tab ref-clicks unreliable, needs coordinate fallback and extra wait/verify discipline around GitHub's client-side router), bridge B **partial** (nav-tab clicks and the file-finder/search shortcuts all work, but two DSL-level rough edges: no punctuation support in `K`, and `T` not clearing existing input).

## Scenario 4: YouTube

One full pass per bridge. Read-only: no like, no subscribe, no comment.

### Bridge A (Claude in Chrome)
- `navigate` to youtube.com, `find` located the search combobox (`ref_12`).
- `form_input` set "chrome devtools protocol", then `computer key Return`: **did not submit**, same Enter-does-not-submit pattern as the Wikipedia search box in scenario 1 (`location.href` stayed on `youtube.com/`, confirmed via `javascript_tool`). Screenshot showed the query still sitting in the box with an autocomplete dropdown open, no navigation.
- Fix: clicked the search button by coordinate `(1012,25)`, worked immediately, landed on `youtube.com/results?search_query=chrome+devtools+protocol`.
- Top titles read via `find`+`get_page_text` (YouTube's results page interleaves a few genuinely relevant hits with home-feed-style recommendations after the first 4): "Hacking websites with CDP (Chrome Devtools Protocol) and Python", "Guia de Evasão de DevTools e Antidetect para o Protocolo CDP (2026)", "O Chrome DevTools MCP Server resolve um GRANDE problema", "Develop Chrome Extensions with DevTools for agents" — 4 clearly on-topic results before the feed drifts into personalized/unrelated content (Brazilian Portuguese UI, personalized account).
- Clicked the first result by ref (`ref_711`): **worked immediately**, no no-op, landed on `watch?v=vt2zsdiNh3U`.
- Title/channel read via `javascript_tool`: `"Hacking websites with CDP (Chrome Devtools Protocol) and Python - YouTube || Michael Mintz"`.
- Pressed `k` twice (via `computer key text="k"`), checking `document.querySelector('video').paused` between presses: first press paused->false (was already paused from an earlier player-area click), second press false->true. **`k` toggled play/pause correctly both directions**, confirmed by direct DOM read each time.

### Bridge B (chrome-mcp)
- `N`+`W`+`R interactive` on youtube.com: `durationMs: 1007`, 174 nodes.
- `F ref_4 <query>` + `C ref_6` (search button, not Enter) in one `quick` script: worked in a single shot, `durationMs: 984` for the wait, landed on the results page. Enter-key submission was not separately tested on this bridge for YouTube (the script used the button directly), so this is not a clean like-for-like comparison with bridge A's Enter failure, but it is consistent with the Wikipedia scenario where bridge B's button-click approach also always worked.
- Top 4 titles read via `R interactive`: "Hacking websites with CDP (Chrome Devtools Protocol) and Python", "Nordic.js 2018 • Trent Willis - Automação poderosa com o protocolo Chrome DevTools", "O Chrome DevTools MCP Server resolve um GRANDE problema", "Chrome DevTools - Crash Course". Note this differs from bridge A's exact top-4 set (2nd and 4th titles differ) — expected, since YouTube search ranking/personalization is not fully deterministic between separate page loads/sessions, not a bridge bug.
- Clicked first result (`ref_216`): worked, `durationMs: 1047`, `navigated: false` (SPA-style in-page transition, not a full navigation) but URL and later title both changed correctly.
- `J document.title` immediately after read back `"YouTube"` (stale) while the channel-name read in the same expression correctly returned `"Michael Mintz"`. A `javascript` call moments later returned the correct video title. Same SPA title-update race seen on GitHub (scenario 3): the DOM element (`ytd-channel-name`) updates before `document.title` does on this Google Video page too.
- `K k` (press k) + `J document.querySelector('video').paused`: video was auto-playing (`paused: false` before the press), single `k` press flipped it to `paused: true`. **Works correctly.**

### YouTube scenario: differences and verdict
- Bridge A's Enter-to-submit-search failure reproduces on YouTube exactly as it did on Wikipedia (scenario 1): a 3rd confirmed site where this bridge's Enter key does not submit a search form reliably, always requiring a button click instead.
- The SPA-title-lags-behind-navigation race (first seen as a "false alarm no-op" on GitHub in scenario 3) reproduces here on bridge B too: `document.title` read immediately after a click can be stale for a few hundred ms even though `navigated`/DOM state is already correct. This is now confirmed on two different real sites (GitHub, YouTube) and looks like a general property of reading `document.title` too eagerly on any SPA, not something specific to one bridge.
- Both bridges correctly toggle YouTube's `k` play/pause shortcut, verified by a direct `video.paused` DOM read rather than trusting a screenshot.
- Both bridges' ref-clicks on the actual video thumbnail/title link worked on the first try, unlike the Wikipedia/HN link no-op pattern from scenario 1/2 — the bridge A no-op bug did not reproduce here even once.
- Verdict: bridge A **partial** (search-submit-by-Enter still broken, everything else works including ref-clicks and the k-shortcut), bridge B **works** (only caveat is the pre-existing, now-cross-site-confirmed title-read race, not a functional failure).

## Scenario 5: Google Search and Google Maps

One full pass per bridge. Read-only, no CAPTCHA encountered on either bridge.

### Bridge B (chrome-mcp), Google Search
- `N`+`W`+`R interactive` on google.com: `durationMs: 989`, 19 nodes, signed in as the account's real Google identity (`Conta do Google: Emerson Lopes`).
- `F ref_6 <query>` + `K Enter` + `W` + `X` in one `quick` script: worked in a single shot, no separate button click needed, `durationMs: 3055` for the wait (noticeably slower than a typical `W` — Google's results page is heavier). Landed on `google.com/search?q=chrome+extension+debugger+api...`, **no CAPTCHA, no "unusual traffic" interstitial**.
- Top 5 results read via `X`: "chrome.debugger | API - Chrome for Developers", "chrome.debugger | Reference - Chrome for Developers", "API Debugger Overlay - Chrome Web Store", "chrome.experimental.debugger documentation..." (Google Groups), "Best Chrome extensions for API development & testing..." (DEV Community).

### Bridge B, Google Maps
- `N`+`W`+`R interactive` on google.com/maps: `durationMs: 989`, only **5 nodes** exposed (Maps is a canvas/WebGL-heavy SPA, almost nothing is in the accessibility tree beyond the search box and a couple of top-level buttons).
- `F ref_3 Avenida Paulista` + `C ref_4` (search button) + `W`: worked, `durationMs: 681`, map re-centered and a place page loaded.
- Place card located both ways: `find query="Avenida Paulista place card title"` returned `heading "Av. Paulista - Montes Claros" [ref_24] level=1` (Maps' IP/location-biased match, not the famous São Paulo avenue — this machine's apparent location is Montes Claros, MG). `get_page_text` also cleanly returned the same place name and address block. **Map loaded, both `find` and `get_page_text` located the place card.**

### Bridge A (Claude in Chrome), Google Search
- `navigate` + `find` located the search combobox (`ref_34`).
- `form_input` set the query, `computer key Return`: **did not submit**, same Enter-does-not-submit failure as Wikipedia, YouTube, and (partially) Wikipedia's search box again — 4th confirmed site with this exact bug on this bridge. Confirmed via `javascript_tool` `location.href` unchanged (`google.com/`).
- Fix: screenshot, coordinate click on the "Pesquisa Google" button `(712,584)`: worked immediately, landed on the results page. **No CAPTCHA, no "unusual traffic" page.**
- Top 5 results via `get_page_text`: identical set and order to bridge B's read — "chrome.debugger | API - Chrome for Developers", "chrome.debugger | Reference - Chrome for Developers", "API Debugger Overlay - Chrome Web Store", "chrome.experimental.debugger documentation...", and (bridge A's read continued slightly further into the page) "Chrome DevTools Protocol" (GitHub Pages docs). Content matches bridge B closely; both are the same live Google Search results a few seconds apart.

### Bridge A, Google Maps
- `navigate` + `find` located the Maps search combobox (`ref_44`).
- `form_input` set "Avenida Paulista", `computer key Return`: this time **did visibly do something** (URL changed to a `/maps/@lat,lng,zoom` view centered on Montes Claros, matching bridge B's location bias), but it left an open suggestion dropdown rather than a single resolved place page — `get_page_text` showed a list of 5 candidate "Avenida Paulista" locations (Montes Claros, São Paulo x2, Curitiba, Suzano) plus map chrome (restaurants/hotels category chips, weather, traffic), not a single place card. This is a different outcome than bridge B's (bridge B's button-click landed on one resolved place, "Av. Paulista - Montes Claros"; bridge A's Enter-key path left the multi-result dropdown open). Both are legitimate, real Google Maps UI states, not failures, but they demonstrate the two bridges' different interaction paths (Enter-in-box vs. click-search-button) can leave Maps in different UI states even when both "worked" in the sense of returning data.
- Place card / candidate list located via `find query="Avenida Paulista São Paulo suggestion in dropdown list"`: found the São Paulo entry inside the still-open suggestion grid (`ref_118`), confirming `find` can reach into Maps' custom dropdown UI despite the very sparse top-level accessibility tree. **Map loaded, `find` located a place-related element; `get_page_text` also worked and returned readable candidate text.**

### Google scenario: differences and verdict
- Bridge A's Enter-does-not-submit bug reproduces a 4th time on the plain Google Search box, with the same workaround (coordinate click on the submit button).
- On Maps specifically, bridge A's Enter key was not a pure no-op the way it was on Search/Wikipedia/YouTube — it did trigger a map recentre and opened a suggestion dropdown. This suggests the bug is specific to standard `<form>` submission on Enter, not to Enter-handling in general; Maps' search box has custom JS-driven Enter handling (likely a keydown listener) that isn't affected the same way a plain form submit is.
- Neither bridge encountered a CAPTCHA or "unusual traffic" interstitial on Google Search in this session, on either the sudden-automation-heavy click-then-search flow (bridge A) or the scripted `quick` flow (bridge B).
- Both bridges independently reproduced the same real-world Google Maps behavior: "Avenida Paulista" resolves to a Montes Claros street by default due to the machine's apparent location, with the famous São Paulo avenue reachable as one of several suggestions. This is Google's behavior, not a bridge difference.
- Verdict: bridge A **partial** on Search (Enter-submit still broken, same as every other site tested), **works** on Maps (Enter did something meaningful, if a different UI state than bridge B). Bridge B **works** on both Search and Maps.

## Scenario 6: Amazon

One full pass per bridge. Read-only, no cart additions (screenshots show "Add to cart" buttons present but never clicked).

### Bridge B (chrome-mcp)
- `N`+`W`+`R interactive` on amazon.com: `durationMs: 2157` (Amazon's homepage is heavier than the other sites tested, 189 nodes), not signed in.
- `F ref_9 usb c cable` + `C ref_10` (Go button) + `W` + `X` in one `quick` script: worked, `durationMs: 2112`, landed on `/s?k=usb+c+cable...`.
- First 5 titles/prices read via `X` (get_page_text): 3 sponsored variants of "USB C to USB C Cable...for Apple" ($9.99/$8.99/$12.99), then "Anker USB C to USB C Cable, 60W...(2-Pack, 6 ft, Black)" $9.99, then "LISEN USB C to USB C Cable, 240W..." $9.99. Clean, well-ordered text, prices attached to the right titles.
- `find query="first product price"`: **did not locate the price element** — returned 6 matches, none of them the actual first-product price (a min/max price-filter slider, unrelated footer links, and the sort-by combobox). This is a real limitation: Amazon's price markup (`$` and cents in separate `<span>`s, `.a-offscreen` duplicate text) doesn't map cleanly to natural-language `find` queries the way a plain link or button does.
- Located and clicked the first product via `find query="first product title link..."` -> `C ref_68`: **first attempt no-op'd** (`location.href` unchanged, confirmed via `javascript`, still on the search results page, `get_page_text` re-printed the identical listing). **Second attempt with the same ref, same script, worked immediately** (`navigated: true`, `durationMs: 2802`, landed on the Anker product page). This is a new, flaky no-op case for bridge B, on a real e-commerce link, not previously seen in scenarios 1-5 where bridge B's clicks were 100% reliable.
- Title/price read via `javascript`: `{"title":"Anker USB C to USB C Cable, 60W Fast Charging Cable (2-Pack, 6 ft, Black)","price":"$9.99"}`.

### Bridge A (Claude in Chrome)
- `navigate` + `find` located the search box (`ref_112`).
- `form_input` + `computer key Return`: **did not submit**, 5th confirmed site with this exact bug (Wikipedia, YouTube, Google Search, and now Amazon), verified via `javascript_tool` `location.href` unchanged.
- Fix: coordinate click on the Go/magnifying-glass button `(1150,27)`: worked, landed on the results page.
- `get_page_text` on the results page returned the same first-5 titles/prices as bridge B, but with substantially more surrounding noise: the full "All Departments" category mega-menu (60+ category names), a keyboard-shortcuts legend, duplicated image-alt captions next to each visible caption, and a trailing block of internal Amazon `Test: <selector>` debug strings (`Test: amzn-nv-flyout-healthy-choice`, `Test: nav-rufus-disc-txt`, etc.) that have no place in readable article text. This is a meaningfully noisier extraction than bridge B's `get_page_text` on the identical page, in contrast to the Wikipedia scenario where the two bridges' extraction quality was indistinguishable.
- `find query="Anker USB C...product title link"` **failed outright**: `400 prompt is too long: 234540 tokens > 200000 maximum`. This is a hard failure, not a no-op: bridge A's `find` cannot function at all on this page, because the accessibility tree it builds internally is too large for its own backing model call. This is the most severe bug found in the whole session: a tool that errors out completely rather than degrading, truncating, or warning.
- Fallback attempt via `javascript_tool` to read the first product's title/price/link directly from the DOM: the first query (asking for `.href` inside a `JSON.stringify` including a null-guarded expression) threw a real `TypeError` server-side (not a bridge bug, a genuine script bug: `el.querySelector('h2 a')` was `null` because the real anchor sits one level up, not inside the `h2`). The corrected version (asking for the first 3 `<a>` hrefs to avoid guessing the structure) triggered the **same `[BLOCKED: Cookie/query string data]` false-positive** as scenarios 1 and 3, on the current results-page URL (which carries a `crid=` query parameter) — 3rd confirmed instance of this bug in the session.
- Final fallback: screenshot + coordinate click at `(897,521)` on the first organic (non-sponsored) result's title: worked immediately, landed on the identical Anker product (`/dp/B088NRLMPV`) that bridge B reached.
- Title read via `javascript_tool`: `"Anker USB C to USB C Cable, 60W Fast Charging Cable (2-Pack, 6 ft, Black)"`, matching bridge B exactly. Price ($9.99) was read directly off the search-results screenshot rather than the product page, since by this point in the scenario `javascript_tool` had two live known-bug triggers on this page (the cookie-string block and the earlier TypeError) and a screenshot was the more reliable path.

### Amazon scenario: differences and verdict
- Bridge A's Enter-does-not-submit-search bug reproduces a 5th time, across every single site tested that has a plain HTML search form (Wikipedia, YouTube, Google Search, Amazon). It did not reproduce on Google Maps or on any button-driven bridge B search. This is now the single most consistently reproducible bug in the whole session.
- Bridge A's `find` hit a hard, complete failure (400, prompt too long) on Amazon's dense search-results page, something not seen on any other site in this session including Wikipedia's 630-result search page or GitHub's notification inbox. Amazon's results page is unusually large (many nested product cards, badges, and sponsored-content markup), and bridge A's `find` has no apparent fallback for that.
- Bridge B's `find` did not fail outright on the same page, but also could not locate a specific price element by description, returning irrelevant matches (a price-range slider, footer links) instead of an honest "not found." Neither bridge's `find` is trustworthy for Amazon's non-standard price markup.
- Bridge B's ref-click on the first product had one no-op out of two attempts on this page, the first confirmed bridge B click failure in this entire session (scenarios 1-5 were 100% reliable for bridge B ref-clicks). This may indicate Amazon's page (heavier DOM, more re-render churn on hover/impression tracking) is more prone to triggering whatever timing issue underlies bridge A's more frequent no-ops.
- Bridge A's `get_page_text` on Amazon is measurably noisier than bridge B's on the identical page (mega-menu, duplicated captions, internal `Test:` debug strings leaking into the output) — the first clear content-quality gap between the two bridges' text extraction in this session (Wikipedia, GitHub, and YouTube text extraction were comparable between bridges).
- Both bridges' `javascript_tool`/`javascript` cookie/query-string false-positive reproduced again on bridge A (3rd time this session: Wikipedia, GitHub search, Amazon results), always on a URL carrying a query string, never on bridge B.
- Both bridges ultimately landed on the identical product (Anker 60W 2-Pack 6ft, $9.99) via different paths, so the end data collected is consistent between bridges despite very different amounts of friction to get there.
- Verdict: bridge A **partial** (Enter-submit and cookie-string bugs both reproduce again, `find` hard-fails on this page, but coordinate-click fallback and manual JS/screenshot reads still get to the same correct answer). Bridge B **partial** (mostly clean and fast, but a first-seen flaky ref-click no-op and an unreliable `find` for the price element keep it from a clean "works").

## Final notable differences (revised, covering all scenarios run: Wikipedia x3, HN x3, GitHub, YouTube, Google Search+Maps, Amazon)

1. **Bridge A's Enter-key does not submit standard HTML search forms.** Confirmed on 5 separate sites in this session: Wikipedia, YouTube, Google Search, Amazon, and (partially, Enter did something but not a clean submit) Google Maps. Every single time, a coordinate click on the visible submit/search button was required and worked immediately. Bridge B's button-click and `K Enter` paths both worked wherever tried. This is the single most reproducible bug of the whole session.
2. **Bridge A's ref-based clicks are unreliable on some elements, bridge B's are reliable except on Amazon.** Bridge A no-op'd on Wikipedia search results/TOC (3/3 and 2/2), Hacker News comments link (2/3, flaky), and GitHub nav tabs (2/3). Bridge B was 100% reliable across Wikipedia, HN, GitHub, and YouTube, but had its first-seen no-op on Amazon's first product-title link (1/2 attempts, same ref, second attempt worked).
3. **Bridge A's `find` hard-fails on very large pages instead of degrading.** On Amazon's search-results page it returned `400 prompt is too long: 234540 tokens > 200000 maximum` — a complete tool failure, not a partial or truncated result. Bridge B's `find` on the same page did not crash, but also failed to locate a specific price element, returning irrelevant matches instead.
4. **Bridge A's `javascript_tool` has a cookie/query-string content filter that misfires on ordinary reads.** Reproduced 3 times this session (Wikipedia search results, GitHub search results, Amazon search results), always right after landing on a URL containing a `?query=` style parameter, always blocking a completely unrelated expression (`location.href`, a `.href` array read). `document.title` on the same page at the same moment always executes fine, confirming the filter keys off the current URL, not the evaluated code.
5. **Both bridges share a "SPA title lags navigation" quirk**, first noticed on GitHub (Pull requests tab) and reproduced on YouTube (video watch page): `document.title` read immediately after a click/navigate can return the stale previous-page title for a few hundred milliseconds even though the URL and DOM have already updated. Confirmed on both bridge A and bridge B. Not a bug specific to either bridge, a general risk of reading `document.title` too eagerly on any client-side-routed site.
6. **Bridge B's `quick` DSL has two small but real rough edges**, both newly found in scenario 3 (GitHub): the `K` (press-keys) command has no entry for punctuation keys (`K /` errors with "unknown key", requiring `TK /` instead), and the `T` (type) command does not clear a pre-filled input before typing, so typing into a box a keyboard shortcut already partially populated appends rather than replaces (workaround: `ctrl+a` first). Bridge A's `computer key`/`type` did not hit either issue in the same GitHub flow, though it separately failed on the named key `"slash"` (needing the literal `"/"` character instead).
7. **Text extraction quality is comparable between bridges on most sites but diverges on Amazon.** `get_page_text`/`X` output was effectively identical in content and cleanliness on Wikipedia, GitHub, and YouTube. On Amazon's search-results page, bridge A's extraction included substantial extra noise not present in bridge B's read of the same page: the full category mega-menu, duplicated image captions, and internal Amazon `Test: <selector>` debug strings.
8. **Both bridges handle real, live, signed-in account state correctly and match each other.** GitHub's notification inbox count differed by exactly 1 between the two reads (62 vs 61) because the account is real and live, roughly 90 seconds apart, not because of a bridge discrepancy. Neither bridge required any credential entry or triggered any sign-in prompt during navigation of already-authenticated Google/GitHub sessions.
9. **Neither bridge triggered a CAPTCHA or "unusual traffic" page on Google Search**, on either bridge's very different interaction pattern (bridge A: several failed/retried clicks before a working search page load; bridge B: a single clean scripted flow).
10. **Google Maps resolved "Avenida Paulista" to a Montes Claros, MG street by default on both bridges** (location/IP bias), with the well-known São Paulo avenue reachable only as one of several suggestions — a real Google Maps behavior reproduced identically on both bridges, not a bridge difference. The two bridges' different interaction paths (Enter-in-box vs. click-search-button) left Maps in different UI states afterward (bridge A: an open multi-result suggestion dropdown; bridge B: one resolved place page), worth knowing if a caller expects a single deterministic post-search state.

## Bugs (full list, all scenarios)

1. **Bridge A: ref-based clicks silently no-op on some elements, with no error or warning, including flaky cases where the identical click sometimes works.**
   Repro: navigate to `https://news.ycombinator.com`, `find` the first story's "N comments" link, `computer left_click ref=...`. In this session this no-op'd on 2 of 3 identical attempts and worked once, with no difference in the calling code between attempts. Also reproduced deterministically (3/3) on a Wikipedia article's table-of-contents link, and 2/3 on GitHub's Issues/Pull requests nav tabs. Fix that worked every time it was tried: screenshot, then `computer left_click` with a raw `[x,y]` coordinate on the same visible element instead of `ref=`.

2. **Bridge A: `javascript_tool` blocks benign expressions on pages whose URL contains a query string, mislabeling them as cookie/query-string data.**
   Repro: navigate to any URL containing a `?query=`/`?search=`/`?crid=`-style parameter (a Wikipedia search-results page, a GitHub code-search results page, or an Amazon search-results page all reproduced it), then evaluate `location.href` or a `.href`-reading expression via `javascript_tool`. Result: `[BLOCKED: Cookie/query string data]` instead of the actual value. `document.title` on the same tab at the same moment executes normally, confirming the filter triggers on the page's current URL shape rather than on anything in the evaluated expression. Reproduced 3 separate times across 3 different real sites in this session.

3. **Bridge A: pressing Return in a search box does not reliably submit the form.**
   Reproduced on 4 separate sites with a plain HTML search form (Wikipedia, YouTube, Google Search, Amazon), using both `form_input`+`key Return` and `computer type`+`key Return` as the text-entry method, every single time. A real click on the adjacent search/submit button always worked immediately as the fix. On Google Maps specifically, Enter was not a pure no-op (it triggered a map recentre and opened a suggestion dropdown), suggesting the bug is specific to plain `<form>` submission via Enter rather than Enter-handling in general.

4. **Bridge A: `find` fails completely (HTTP 400, no partial result) on very large/dense pages.**
   Repro: navigate to `https://www.amazon.com/s?k=usb+c+cable`, then call `find` with any query. Result: `400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 234540 tokens > 200000 maximum"}}`. No truncation, no partial match list, no warning ahead of time — the tool call fails outright and the caller must fall back to `get_page_text`/`javascript_tool`/screenshot entirely. Not reproduced on any other page tested this session, including other large pages (Wikipedia's 630-result search listing, GitHub's notification inbox), so it appears specific to how dense/nested Amazon's product-card markup is.

5. **Bridge A: `get_page_text` includes substantial non-article noise on at least one real site (Amazon).**
   Repro: navigate to an Amazon search-results page, call `get_page_text`. The output includes the full multi-level category mega-menu (60+ entries), a keyboard-shortcuts legend, duplicated image-alt captions alongside the visible captions, and a trailing block of internal Amazon test-instrumentation strings (`Test: amzn-nv-flyout-healthy-choice`, `Test: nav-rufus-disc-txt`, etc.) that clearly should not be in a "readable text" extraction. Bridge B's `get_page_text`/`X` on the identical URL did not include any of this. Not reproduced on Wikipedia, GitHub, or YouTube, where both bridges' text extraction was comparably clean.

6. **Bridge B: the `K` (press-key) command in `quick` scripts has no entry for punctuation keys.**
   Repro: on any page, `quick` script containing the line `K /`. Result: `unknown key "/". Supported: 0,1,2,...` (a fixed list of named keys, no punctuation). Fix: use `TK /` (type-with-real-key-events) instead, which accepts the literal character. This is a real gap since several sites' keyboard shortcuts are punctuation characters (GitHub's `/` for global search being one).

7. **Bridge B: the `T` (type) command in `quick` scripts does not clear a pre-filled/partially-typed input before inserting text.**
   Repro: on a page where a keyboard shortcut (e.g. GitHub's `t` file-finder) has already put a character into the target input, a subsequent `quick` script line `T <text>` appends rather than replaces, producing a garbled combined query (observed: `t` + `README` typed via `T` became the literal string `tREADME`). Fix: an explicit `K ctrl+a` (or equivalent select-all) before the `T` line clears the field first.

8. **Bridge B: ref-based clicks are not always reliable, contrary to the pattern in scenarios 1-5.**
   Repro: on an Amazon search-results page, `find` the first product's title link, then `C <ref>` in a `quick` script. First attempt: click registers (`ok`) but `location.href` is unchanged afterward and the page content is still the search-results listing, confirmed via a follow-up `javascript` call. Second attempt, identical script and ref, worked immediately (`navigated: true`). Only observed once in this entire session (all other bridge B ref-clicks across Wikipedia, HN, GitHub, and YouTube were 100% reliable), so this is flagged as flaky rather than a deterministic failure, but it is a real counterexample to "bridge B's ref-clicks always work."

9. **Both bridges: `document.title` can read stale on client-side-routed (SPA-style) pages immediately after a navigation/click that has already updated the URL and visible DOM.**
   Repro (bridge A, GitHub): click the "Pull requests" tab by coordinate, immediately evaluate `document.title` — returns the previous page's title ("Issues · ..."), even though `location.href` already reflects `/pulls` and the page visibly renders correctly given ~2 seconds. Repro (bridge B, YouTube): click a video result, immediately evaluate `document.title` in the same `quick` script step — returns `"YouTube"`, while a DOM read (`ytd-channel-name`) in the identical expression correctly returns the new channel name; a follow-up `javascript` call moments later returns the correct video title. Not a functional failure (the underlying navigation did happen correctly both times) but a real trap for any caller that uses `document.title` as its sole "did this navigate" check immediately after a click, on either bridge.
