# Roadmap

What is planned for the code base itself, as opposed to the tool set. Each item is sized for one pull request. Items are removed when they land, and the order is by value over risk.

## Refactors

The three largest modules grew by accretion during the build. Each already has section headers marking its seams, so the splits below move existing sections into files without changing behaviour. Every split runs the live suite before and after, and a split that needs a test assertion changed is a behaviour change and goes back to the drawing board.

1. **Extract result formatting from `host/mcp-server.js`.** The "Result formatting" section (about 500 lines) is pure functions from a tool result to MCP content blocks. It becomes `host/format.js` with unit tests of its own, which the e2e suite cannot give it today because it only sees the formatted output.
2. **Split `extension/src/lib/tools.js` along its headers.** Input verification, write actions, rich editors, and window size each become a module. `tools.js` keeps the handler table and the shared `gate` and `pageCall` helpers.
3. **Split `extension/src/lib/cdp.js` into input, capture, and attach.** Keyboard and pointer dispatch, the screencast and screenshot path, and the attach and recovery ladder are three concerns with different failure modes. The attach ladder carries the most state and moves last.
4. **Give `extension/src/content/agent.js` top-level functions.** It is one message handler of 2400 lines with no exported functions, which is why coverage of it is reported through `page-harness.js` only. The first step is naming the handlers so the next step can be planned.
5. **Inject the module-level state in `tabs.js` and `sessions.js`.** Session groups and per-tab state live in module maps, so tests reset them through the chrome stub. A factory that takes storage would let each test own its state.

## Tests

- **Raise the coverage floor as it grows.** Thresholds in `tools/run-tests.js` are 75/75/70. `tools.js` is at 58% lines and `background.js` at 50% because their branches need a browser. Each refactor above brings some of that under unit tests.
- **Cover `tools/cdp.js` and `tools/probe-detect.js`.** They are at 25% and 43% lines. A fake DevTools websocket is a small fixture.
- **Run the live suite on Windows in CI.** The Linux runner proves Chrome for Testing under Xvfb. The `resize_window` case showed the page's viewport lagging the window on Windows, which only a Windows runner catches. `windows-latest` has no display server problem, so the cost is the Chrome download.

## Release

- **Decide whether `autopilot-chrome` goes to npm.** `package.json` carries `files`, `bin`, `repository` and `license`, and is still `private: true`. Publishing needs a release workflow that tags, builds nothing, and runs `npm publish --provenance`, plus a decision on whether the extension is shipped in the package or loaded from the clone.
- **Chrome Web Store listing.** Loading the extension is manual on Chrome 137 and later. A store listing removes that step for people who do not clone the repository, at the cost of a review cycle per version.

## Review

- **Turn on the Claude review workflow.** `.github/workflows/claude-review.yml` skips itself until the repository has a `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` secret. `claude /install-github-app` sets it up.
- **Rewrite `docs/claude-in-chrome-comparison/REPORT.md` against the current build.** It measured extension 0.1.7 and names the project by its old name throughout. The scorecard in `RESULT.md` is current as of 0.2.0.
