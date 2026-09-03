# Handoff prompt

Copy everything below the line into a fresh agent session.

---

You are picking up `C:\Users\edfl\workspace\chrome-mcp`, an MCP server that drives a real Chrome through a Manifest V3 extension and the Chrome DevTools Protocol. It was built to match Claude Code's own browser integration, Claude in Chrome. Read `README.md`, `STATUS.md`, `SPEC.md` and `COMPARISON.md` first. `STATUS.md` has the tool-by-tool parity table, the test coverage map, the bugs found and fixed, what was verified on the user's own Chrome on 2026-09-03, and the browser behaviours that shape the implementation.

25 tools, 16 test files. Everything is staged in git, nothing is committed. Do not commit or push without being asked.

## The goal the user set

Copy everything Claude in Chrome does, including its behaviour, look for gaps, fix them, and implement what is missing. The real Claude in Chrome tool schemas are the reference: load them in a session with `ToolSearch` (`select:mcp__claude-in-chrome__*`) and compare against `host/schemas.js`. That comparison was done once and the gaps it found are closed (see `STATUS.md`, "Feature parity"). Things still open from that comparison:

- The gif overlay options Claude in Chrome draws (click circles, action labels, progress bar, watermark) are accepted and ignored.
- `list_connected_browsers` there reports OS platform and whether the browser is on this machine. Here it reports id, name and version.
- `switch_browser` there broadcasts a pairing prompt to every connected extension and waits for a click. Here it is the same as `select_browser`.
- `read_page` there says it returns non-visible elements by default. Here invisible elements are dropped except for the styled-radio case.

## State of the one open bug

On the user's Chrome every CDP command used to fail with `Cannot access a chrome-extension:// URL of different extension`. The exact httpbin flow from the previous handoff now passes on the user's Chrome (fills, three CDP clicks, submit, echo checked). The refusal turned out to be a property of one tab, which had been driven by the extension build loaded before a reload, and it survived navigations in that tab. Fresh tabs from every creation path work. What Chrome objects to is not established. The attach and command failure paths now append the tab's frame list and debugger targets to the error message, so the next occurrence names it.

Experiment attempted once and inconclusive, because the session's tab group was gone after the reload (see `STATUS.md`). To retry: with a session tab open, reload the extension at `chrome://extensions`, confirm with `tabs_context` that the tab is still listed, then attach to it. If it is refused, the reload is the trigger and the fix is to drop and recreate session tabs when the service worker starts.

## Audit state

A hand-driven audit on real sites (Wikipedia, GitHub, the-internet.herokuapp.com, Hacker News, the Guardian, a video site built on custom elements, a blog) found ten problems, all fixed and listed in `STATUS.md` under "Bugs found and fixed", and verified on the development browser. Sites not yet audited: anything behind a login, a checkout flow, Google Docs style contenteditable editors, infinite scroll feeds, and pages with JavaScript dialogs.

## Branding and pages

The extension is named Lantern (the package and the MCP server stay `chrome-mcp`). Icon: `extension/src/ui/icon.svg`, rendered by `npm run icons` with the development browser up. Pages: `src/popup` (state, sessions, recent calls, reveal a session, close empty tabs) and `src/options` (policy, hosts, shortcuts, grants). Styles come from the user's Ash Lumen design system, copied from `C:Usersedflworkspaceash-lumendist` into `extension/src/ui`, plus `lantern.css` for layout and the two animations (a breathing status dot while working, a short rise on list rows). Keep it minimal: no colour except the semantic tokens.

## Working rules the user set

- Test against reality. Every bug in `STATUS.md` was found by running something. When you claim something works, say what you ran. When something is untested, say so.
- Do not run the full suite as a gate during development. It takes about five minutes with a browser up and the user considers it a blocker. Run the file you are touching, and verify behaviour by driving a browser directly. `npm run test:fast` skips the recovery tests.
- **Bump `version` in `extension/manifest.json` with every change under `extension/`.** The user asked for this. `npm run doctor` prints the running version, so it is how a reload is proven. Current: 0.1.9.
- The user's Chrome runs whatever extension build was last reloaded there. After editing extension code, either ask the user to reload it at `chrome://extensions` (then confirm with `npm run doctor`, which prints the extension version) or verify in the development browser.
- The agent works in the background. Tabs open unselected in the user's current window, and nothing activates a tab or focuses a window, ever. Hidden tabs are woken through CDP (`cdp.wake`) and captured through a screencast frame (`captureHidden` in `cdp.js`). Both are deliberate differences from Claude in Chrome, at the user's request.
- The user's Chrome does not yet have the `wait_for_page` fix (it was made after the second reload). Ask for a reload before relying on click-then-wait-then-read batches there.

## Environment traps

- **The development browser window is easy to close by accident.** It opens on the user's desktop, and the user closed it six times in one session. When it disappears, relaunch it with `node tools/browser.js`. Chrome's log goes to `.browsers/chrome.log`.
- **Shell escaping eats backslashes.** Patching source through `node -e "..."` from the agent's shell stripped `\b` and `\S` from regexes twice this session, and the code still parsed. When a patch touches a regex, write the patch as a file first, or use the editor tool, and grep the result.
- **The stale-code cache on Chrome 152 is `Default/Extension Scripts`.** The launcher clears it now. `chrome.runtime.reload()` does not. If an edit seems to have no effect in the development browser, stop it and run `node tools/browser.js` again.
- Chrome caches the compiled module graph for an extension service worker across browser restarts, a pending `setTimeout` does not keep an MV3 worker alive, `Input.dispatchMouseEvent` blocks five seconds on a throttled renderer, a fully covered window drops input, and the browser-driven test files share one bridge. All in `STATUS.md`.

## Commands

```bash
npm run doctor            # every link in the chain, prints the extension version
npm run log -- --tail 30  # the action journal: what each browser was asked to do, with outcomes
node tools/browser.js     # development browser, foreground, keep the terminal open
npm test                  # everything, about five minutes with a browser up
npm run test:fast         # skips the recovery tests
node --test test/cdp.test.js test/aliases.test.js   # the files touched most recently
```
