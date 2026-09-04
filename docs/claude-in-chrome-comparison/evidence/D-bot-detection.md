# Group D: Bot and automation detection

Bridges: A = Claude in Chrome (`mcp__claude-in-chrome__*`), B = chrome-mcp (`mcp__chrome-mcp__*`). Both drove the same physical Chrome 152 profile, same GPU (RTX 5080), same screen (1707x960 viewport reported by the OS). No baseline-with-no-bridge run was possible: both bridges attach to the one real signed-in Chrome window, there is no way to load a page in that Chrome instance without going through one of the two MCP tools, so the "baseline" data point does not exist for this browser. This is noted rather than fabricated.

Repeats: most probes were run 3 times per bridge, alternating order, as instructed. Two external sites failed to load at all (arh.antoinevastel.com, 502 from its own server) and are marked untested rather than repeated. For the deviceandbrowserinfo.com and reCAPTCHA v3 probes, bridge A's result took variable extra time or once failed outright to populate, which is itself reported as data, not smoothed over.

## 1. bot.sannysoft.com

| Check | A (Claude in Chrome) | B (chrome-mcp) |
|---|---|---|
| WebDriver (New) | missing (passed), all 3 runs | missing (passed), all 3 runs |
| Chrome (New) | present (passed) | present (passed) |
| Permissions (New) | denied | denied |
| Plugins length | 5, PluginArray, passed | 5, PluginArray, passed |
| WebGL Vendor/Renderer | Google Inc. (NVIDIA) / ANGLE ... RTX 5080 ... D3D11 | identical string |
| SELENIUM_DRIVER / HEADCHR_* / PHANTOM_* | all "ok", all false | all "ok", all false |
| `wOuterHeight`/`wOuterWidth` in the page's own load-time JSON dump (PHANTOM_WINDOW_HEIGHT) | **0 / 0**, all 3 runs (initial load and a reload) | **912 / 1707** (correct), all 3 runs |

Every scored test on the page's own table passes identically on both bridges (this page does not score the outerWidth/outerHeight fields, it just prints them raw). The raw JSON field is where the two diverge: on A, `window.outerWidth` and `window.outerHeight` read as `0` in a script running at page load, every time, across a fresh navigate and a reload. A direct `javascript_tool` eval a few seconds later on the same tab reports the correct `1707`/`912`. On B the same load-time script reports the correct values immediately. This is a reproducible signature that a fingerprinter reading `outerWidth`/`outerHeight` early (many headless detectors do exactly this) would catch on A and not on B. See "outerWidth/outerHeight" note under step 6 for the matching finding on the local site.

Screenshots taken for both, then a JS eval + reload cycle was run (as asked): no visible change to the table, verdicts identical before and after.

## 2. CreepJS (abrahamjuliot.github.io/creepjs)

One full run per bridge (10s wait, `get_page_text` plus screenshot; the site takes ~3 minutes to reach a stable page and its "Trust Score" badge renders as a canvas image at a location the text extractor does not capture, so no numeric trust score could be read from either bridge in the observation window used here — this is a real limitation of this run, not a difference between bridges).

| Signal | A | B |
|---|---|---|
| Headless section | `chromium: true`, `25% like headless`, `0% headless`, `0% stealth` | identical: `chromium: true`, `25% like headless`, `0% headless`, `0% stealth` |
| Resistance (privacy/security/mode/extension) | all "unknown" | all "unknown" |
| WebRTC local IP / host candidate | same public IP (189.49.70.160), different random ICE ufrag per run (expected, not a signal) | same |
| Any mention of "devtools", "debugger", "CDP", "Runtime.enable" | none found in extracted text | none found |
| FP ID / Fuzzy hash | same FP ID both bridges: `f68cab865d26a8c8b9a3306b7f170fac76a1abeea64a2e30a024db3bc8e844b7` | same |

CreepJS did not distinguish the two bridges in this run and did not flag either as headless/stealth/bot. Trust score: untested (rendering location, not a bridge difference).

## 3. browserleaks.com

| Check | A | B |
|---|---|---|
| `/javascript`: navigator.webdriver | `false` | `false` |
| `/javascript`: plugins.length | 5 | 5 |
| `/javascript`: window.chrome present | true | true |
| `/javascript`: userAgent / languages | identical strings | identical strings |
| `/canvas`: Canvas Fingerprint signature | `867a67b06afca98b3db126e27a9c4d7f` | `867a67b06afca98b3db126e27a9c4d7f` |

Canvas signature is byte-identical between bridges, as expected (same Chrome, same GPU, same renderer). No automation-specific rows are exposed on `/javascript` beyond plain `navigator.webdriver`, which both report as `false`.

## 4. Other headless/bot verdict pages

**arh.antoinevastel.com/bots/areyouheadless**: untested. The site itself returned `502 Bad Gateway (nginx/1.18.0 (Ubuntu))` for both bridges on the one attempt made. Not a bridge difference, the origin server is down.

**deviceandbrowserinfo.com/are_you_a_bot** — the single most decisive probe in this whole exercise. 3 runs each, alternating order:

| Run | A verdict | A `isAutomatedWithCDP` | B verdict | B `isAutomatedWithCDP` |
|---|---|---|---|---|
| 1 | `isBot: false` — "You are human!" (after ~6s; page/screenshot briefly showed an empty result box before this, see Bugs) | `false` | `isBot: true` — "You are a bot!" | `true` |
| 2 | never populated a verdict at all after 13+ seconds of waiting, reload, and repeated JS reads — a Rollbar-logged JS error fired during page load in this run | n/a (no result) | `isBot: true` | `true` |
| 3 | never populated a verdict after 13+ seconds of waiting across two navigations | n/a (no result) | `isBot: true` | `true` |

Full raw JSON for B (identical shape all 3 runs, only the CDP flag matters — every other flag was `false`):
```
{ "isBot": true, "details": { ... "isAutomatedWithCDP": true, ... rest all false } }
```
Full raw JSON for A run 1 (the one run that completed):
```
{ "isBot": false, "details": { ... "isAutomatedWithCDP": false, ... rest all false } }
```
B is flagged as a bot on every single run, specifically and only via `isAutomatedWithCDP: true` — every other signal (webdriver, Selenium markers, Playwright markers, headless Chrome markers, WebGL/client-hint inconsistency, etc.) is `false`. This means chrome-mcp's automation is detectable through the Chrome DevTools Protocol itself (the mechanism it uses to drive the browser), not through any spoofable JS property. A is not flagged as a bot on its one completed run, and its `isAutomatedWithCDP` reads `false` — consistent with it not going through raw CDP the way chrome-mcp does (or going through it in a way this detector's heuristic does not catch). A's own reliability on this page is the separate, real problem documented under Bugs below.

**fingerprint.com/products/bot-detection**: untested. This URL is a marketing/product page, not an interactive demo; it does not render a live per-visitor bot verdict, so there was nothing bridge-specific to record. Not run further given no verdict exists to compare.

## 5. browserscan.net/bot-detection

One run per bridge (5s wait, page state was stable):

| Section | A | B |
|---|---|---|
| Overall Test Result | Normal | Normal |
| WebDriver / WebDriver Advance / Selenium / NightmareJS / PhantomJS / Awesomium / Cef / CefSharp / Coaches / FMiner / Born / Phantomas / Rhino / Webdriverio / Headless Chrome | all "Normal" | all "Normal" |
| CDP / Dev Tool (Chrome DevTools Protocol Detection section) | Normal | **Normal** (this detector did NOT catch B's CDP usage, unlike deviceandbrowserinfo.com above) |
| Native Navigator dump | webdriver: false, hardwareConcurrency: 8, deviceMemory: 32, userAgentData brands: Chromium/152, Not?A_Brand/24, Google Chrome/152, mobile: false, platform: Windows | identical values |

Notable: BrowserScan's "CDP Detection" section, despite being explicitly named for this purpose, reported "Normal" for B even though B was simultaneously flagged as CDP-automated by deviceandbrowserinfo.com. Different vendors' CDP-detection heuristics disagree.

## 6. Local test site probes (127.0.0.1:8765/index.html)

All read via direct JS eval (`javascript_tool` on A, `javascript` on B) unless noted. One clean run reported below; the window-size and focus/visibility numbers were cross-checked twice more (see step 1 and step 7) and were consistent both times they were re-measured.

| Probe | A | B |
|---|---|---|
| `navigator.webdriver` | `false` | `false` |
| `!!window.chrome && !!window.chrome.runtime` | `false` | `false` |
| `new Error().stack` | normal V8 stack (`Error \| at <anonymous>:1:109 \| at <anonymous>:1:173`) | normal V8 stack, same shape |
| Fresh CDP getter trap (`Object.defineProperty` getter, `console.log`, wait 200ms) | getter did **not** fire (`hit: false`) | getter did **not** fire (`hit: false`) |
| Page's own load-time `#cdp` getter trap | `no` | `no` |
| `console.debug` timing loop (50x, 1000-elem array) | 5.4 ms | 5.6 ms |
| `document.hasFocus()` at page load | **false** | **true** |
| `document.visibilityState` at page load, and still after a real click | **`hidden`, both before and after clicking** | `visible` |
| `navigator.userActivation.isActive` / `.hasBeenActive` at load | `false` / `false` | `true` / `true` (already true before this script ran — B's own prior batched actions had produced a user gesture) |
| `window.outerWidth - innerWidth`, `outerHeight - innerHeight` at page load | **`-1707`, `-825`** (outerWidth/outerHeight both read as `0` at load) | `0`, `87` (normal: 0 horizontal chrome, 87px for title/tab/toolbar) |
| Same outer/inner diff, read again later in the same tab via direct JS eval (not at load) | `0`, `87` — now correct | unchanged |
| Click via **element ref** (`find` → `computer left_click ref_17` on `#name`, then type, then click `#submit` ref) | **No-op**: `document.activeElement` stayed `BODY`, `#name` value stayed empty, `#log` recorded **zero** events at all, not even the submit click | worked correctly first try: full trusted event sequence logged |
| Click via **coordinates** (screenshot, then `left_click [148,319]`, type, `left_click [457,379]`) | worked: `#name` value = "the quick brown fox", all events `trusted=true`, `pointerType=mouse` | (not needed, ref worked) |
| Typed key-down intervals (`the quick brown fox`, 19 keydowns) | via coordinates: **0 to 1.2 ms**, mostly 0.2-0.5 ms between keys — far faster than any human, effectively simultaneous | via `perKey:true`: ramps 23 → 33 → 52 ms then settles to a **very regular ~62-64 ms** per key |
| Click trust (`isTrusted`, `pointerType`) | `trusted=true`, `ptr=mouse` (once coordinates were used) | `trusted=true`, `ptr=mouse` |
| Mouse path (mousemove listener, from field click to submit click) | 2-4 samples total: a straight jump from the last recorded point to the click point, no interpolated path | 2 samples: same, a straight jump, no path |

Two things worth separating out from that table:
- **The outerWidth/outerHeight = 0 anomaly on A is load-time only.** It shows up identically here and on sannysoft (step 1), and it self-corrects a few seconds later when re-read via `javascript_tool`. Any detector reading `window.outerWidth`/`outerHeight` in an inline `<script>` near the top of the page (a very common headless check, since real desktop Chrome always has `outerHeight > innerHeight`) will see A come back with negative or zero deltas that read as headless, even though A is not headless and the value is correct moments later.
- **`document.hasFocus()`/`visibilityState` are persistently wrong on A.** Not just at load: after a real, successful, coordinate-driven, `isTrusted:true` click, `visibilityState` was still `hidden`. `hasFocus()` did flip to `true` after the click but `visibilityState` never did across the whole session. B reported `visible`/focused throughout. This is a strong, persistent tell: `document.visibilityState !== 'visible'` while events are actively firing is not a state a normal human-driven tab is ever in.
- **Typing cadence differs sharply in character, not just in bot-vs-human plausibility.** A's coordinate-driven type action delivers keys at sub-millisecond intervals (all-at-once, not simulated typing at all). B's `perKey:true` typing is much closer to human timing in magnitude (tens of ms) but is suspiciously uniform once it ramps up, which is itself a known bot tell (real human inter-key timing has much higher variance run to run). Neither is indistinguishable from a human typist to a keystroke-dynamics classifier.

## 7. DevTools banner and viewport shrink

Screenshots on both bridges are of the page viewport only (not the OS browser chrome), so neither bridge's screenshot tool can show the "\<extension\> is debugging this browser" infobar even if Chrome is displaying it — this is a tooling limitation, not evidence the banner is absent. Untested by design.

`window.innerHeight` measured directly by JS eval on the local test page: A = 825, B = 825 (both under the same 960px-tall screen with the same ~135px of OS/browser chrome removed). No before/after shrink was observed in either tab across the session, but note the sannysoft/local-site load-time capture showed A computing `innerHeight` normally (825) while simultaneously misreporting `outerHeight` as 0 — so the "banner shrinks the viewport" mechanism could not be isolated from the separate outerHeight anomaly above.

## 8. Cloudflare challenge pages

**nowsecure.nl** (3 runs each, alternating): all 6 runs (3 per bridge) passed automatically, landing on the "NOWSECURE / by nodriver" success text with no checkbox interaction required and no CAPTCHA shown to solve. The checkbox visible in the screenshot is decorative artwork baked into the page's 3D scene texture ("Confirme que é humano ... Somente para teste"), not a live Turnstile widget; the page's own text content confirmed the pass state before any screenshot was taken.

**scrapingcourse.com/cloudflare-challenge** (3 runs each, alternating): all 6 runs passed automatically, page text `"You bypassed the Cloudflare challenge! :D"` every time, both bridges, no checkbox shown.

Neither bridge triggered a visible Cloudflare interstitial checkbox or block on this pair of demo pages in 3 runs apiece. No CAPTCHA was clicked, per instructions.

## 9. Google reCAPTCHA v3 demo score

| Run | A score | A notes | B score | B notes |
|---|---|---|---|---|
| 1 | **no score obtained** | Console: `TypeError: grecaptcha.execute is not a function` at `recaptcha-v3-request-scores.php:41`; page stayed stuck at "grecaptcha.execute(...)" with no token ever requested, even after 8+ seconds | 0.9 | resolved essentially immediately |
| 2 | 0.9 | took roughly 10s longer than B to resolve on the same navigation | 0.9 | immediate |
| 3 | 0.9 | same slower resolution | 0.9 | immediate |

B scored the maximum 0.9 (most human-like) on all 3 runs, consistently and quickly. A scored 0.9 on the 2 runs that worked, but failed outright on run 1 with a genuine JS exception from Google's own reCAPTCHA loader, not a low score, a total failure to initialize. This is reported as a reliability/bug finding for A rather than a "worse bot score."

## What differs between the bridges

1. **CDP is directly detectable on B, not on A.** deviceandbrowserinfo.com's `isAutomatedWithCDP` flag was `true` on every one of B's 3 runs and `false` on A's one completed run. This is the clearest, most reproducible fingerprint distinguishing the two bridges of everything tested.
2. **`document.visibilityState` is stuck on `hidden` for A**, even mid-interaction after a real trusted click, while B reports `visible` throughout. `document.hasFocus()` also starts `false` on A (vs `true` on B) though it does flip true after a click.
3. **`window.outerWidth`/`outerHeight` read as `0` at page-load time on A**, self-correcting to the true values (1707/912) within a few seconds when re-read. B reports correct values immediately, every time. This makes A trip the classic "outerWidth <= innerWidth" headless heuristic if a site checks it early.
4. **Element-ref clicks silently no-op on A** (matches the known failure mode called out in the brief); coordinate clicks work. On B, ref clicks worked correctly first try in this scenario.
5. **Typed input timing is categorically different.** A's synthetic typing lands in well under a millisecond per key (effectively simultaneous keystrokes, nothing like human typing). B's `perKey` typing lands in a very regular ~62-64ms band, human-scale but suspiciously low-variance.
6. **Neither bridge produces a real mouse path.** Both only ever emit start/end mousemove samples with a straight jump between click targets, no intermediate motion, on every scenario tested.
7. **A is less reliable on scripts with async/network dependencies.** The deviceandbrowserinfo.com verdict box failed to populate at all on 2 of 3 runs (once after a genuine page-level JS error), and the reCAPTCHA v3 loader threw `grecaptcha.execute is not a function` on 1 of 3 runs. B never failed to produce a result on any of these pages across 3 runs each.
8. **Canvas fingerprint, WebGL vendor/renderer, plugin list, userAgent, and userAgentData are all byte-identical between bridges** on every site tested (sannysoft, browserleaks, browserscan, creepjs) — expected, since both drive the same physical Chrome install, and confirms neither bridge alters GPU/canvas rendering.
9. **BrowserScan's CDP-specific detector did not catch B**, while deviceandbrowserinfo.com's did. Vendors disagree on CDP detection even though both claim to test for it.
10. **Cloudflare's managed challenge and Google reCAPTCHA v3's score did not distinguish the bridges** in the runs performed: both passed Cloudflare 3/3 automatically, and both scored 0.9 on reCAPTCHA v3 whenever the script actually finished loading.

## What is visible to a site on both bridges

- `navigator.webdriver` is `false` on both, always.
- Canvas/WebGL/plugin/UA fingerprints are identical (same physical browser).
- Neither bridge produces a curved or stepped mouse-movement path; both jump straight to click targets.
- Neither bridge's CDP getter trap (a plain `Object.defineProperty` getter probed via `console.log`) fires, on the local test site's own load-time trap or the fresh one built for this test. Production-grade detectors (deviceandbrowserinfo.com) still catch B through a different, more robust CDP-detection method that this simple homemade probe does not replicate.
- Both bridges' clicks, once they land at all, produce `isTrusted: true`, correct `screenX`/`screenY`, and `pointerType: "mouse"`.

## Bugs

1. **Bridge A: element-ref clicks silently no-op on the local test site's `#name` field and its knock-on effects.** Repro: `find` "Name text input field" on `http://127.0.0.1:8765/index.html` returns a valid ref (e.g. `ref_17`); `computer left_click` with that ref, followed by `computer type`, reports success (`"Clicked on element ref_17"`, `"Typed \"the quick brown fox\""`) but `document.activeElement` remains `BODY`, `#name`'s value stays empty, and the page's own event log (`#log`) records **zero** entries, not even for the subsequent ref-click on `#submit`. Switching to coordinate-based clicks (`left_click [148,319]`) on the same elements works correctly and produces a full trusted event trail. This matches the known failure mode flagged in the brief.

2. **Bridge A: `get_page_text` and `screenshot` can return stale DOM content that a same-moment `javascript_tool` eval shows has already updated.** Repro: on `deviceandbrowserinfo.com/are_you_a_bot`, after the detection script had already written `"You are human!"` and a populated `isBot: false` JSON block into `<main>` (confirmed by an immediate `javascript_tool` read of `document.querySelector('main').innerText`), a `screenshot` taken moments earlier showed the "Raw detection details" box completely empty, and a `get_page_text` call before that also returned the pre-population page. The underlying page content was correct; the bridge's own read tools were returning older state.

3. **Bridge A: `window.outerWidth`/`window.outerHeight` are `0` in scripts that run at page load, correcting to true values only when re-read seconds later.** Repro: on both `https://bot.sannysoft.com` and `http://127.0.0.1:8765/index.html`, a load-time inline script computing `window.outerWidth`/`outerHeight` (sannysoft's `PHANTOM_WINDOW_HEIGHT` test, and the local probe's own load-time capture) recorded `0`/`0` on every one of 3 sannysoft runs and the local-site run. A `javascript_tool` eval on the same tab moments later reports the correct `1707`/`912`. Bridge B never exhibited this on any run.

4. **Bridge A: `deviceandbrowserinfo.com/are_you_a_bot`'s detection script failed to complete at all on 2 of 3 runs**, leaving the "Raw detection details" box permanently empty even after 13+ seconds of waiting, a full page reload, and repeated reads; a Rollbar-captured JS error was logged at the time of the stall in one of those runs. This is a distinct failure mode from the stale-read bug above (bug 2): here the underlying page state genuinely never populated, confirmed by repeated `javascript_tool` reads over many seconds, not just a stale read.

5. **Bridge A: Google's reCAPTCHA v3 loader threw `TypeError: grecaptcha.execute is not a function`** on 1 of 3 runs of `https://recaptcha-demo.appspot.com/recaptcha-v3-request-scores.php`, leaving the page stuck at "grecaptcha.execute(...)" indefinitely with no token ever requested and no score ever produced. The other 2 runs on A succeeded (with a score of 0.9, matching B) but took visibly longer to resolve than the same page on B. B never failed this test and was consistently near-instant.

All 5 bugs are on bridge A (Claude in Chrome) and are all about reliability/consistency of page-state reads and interactions, not about being more detectable as a bot, bridge A's failures generally leave a page in a state that reveals nothing to a detector rather than a state that flags it as automated. Bridge B's one clear detectability finding (bug-adjacent, not a defect) is the `isAutomatedWithCDP: true` flag from deviceandbrowserinfo.com, which is a true positive about how chrome-mcp drives the browser, not a malfunction.
