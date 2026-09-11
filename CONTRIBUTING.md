# Contributing

Autopilot is an MCP server that drives Chrome through a Manifest V3 extension. Three parts live in this repository and they are tested differently, so this page starts with the map.

| Path | Runs where | Tested by |
|------|-----------|-----------|
| `extension/src/` | Inside Chrome as the service worker, content scripts, popup and options page | `test/*.test.js` through `test/chrome-stub.js` (a fake `chrome.*`) and `test/page-harness.js` (jsdom pages), plus the live suite |
| `host/` | Node. `native-host.js` is spawned by Chrome, `mcp-server.js` is spawned by the MCP client | Unit tests per module, `test/e2e.test.js` across real processes without a browser |
| `tools/` | Node, from the command line | `test/check-versions.test.js`, `test/probe-detect.test.js`. Launchers and installers are exercised by the live workflow |

## Setup

```
npm install
npm run check
```

`npm run check` is what CI runs on every pull request: ESLint, Prettier in check mode, the version sync check, the errors copy check, and the unit suite with coverage thresholds. It takes about a minute and needs no browser.

Node 20 or newer. The pinned development version is in `.node-version`.

## Scripts

| Script | What it does |
|--------|--------------|
| `npm test` | Every test file. Suites that need a browser skip themselves when none is connected. |
| `npm run test:unit` | The same files with browser discovery disabled, so the live suites always skip. This is the CI command. |
| `npm run test:coverage` | `test:unit` with V8 coverage, thresholds, `coverage/lcov.info` and `coverage/summary.txt`. |
| `npm run test:live` | The live suite against a connected browser. Start one with `npm run browser` first. |
| `npm run lint`, `npm run lint:fix` | ESLint over the whole repository. |
| `npm run format`, `npm run format:check` | Prettier. Markdown and generated files are ignored through `.prettierignore`. |
| `npm run check:versions` | `extension/manifest.json` and `package.json` carry the same version. With `--base <ref>` it also requires a bump when anything under `extension/` changed. |
| `npm run check:errors-copy` | `extension/src/lib/errors.js` is still a byte-for-byte copy of `host/errors.js` outside comments. |
| `npm run doctor` | Checks the local install: native host registration, extension id, pipe, journal. |

## The live suite

`test/live.test.js`, `test/edge.test.js`, `test/campaign.test.js`, `test/resilience.test.js` and `test/shortcuts.test.js` drive a real Chrome with the extension loaded. They need Chrome for Testing, because stock Chrome 137 and later ignores `--load-extension`:

```
npx @puppeteer/browsers install chrome@stable --path .browsers
npm run install-host
npm run browser
npm run test:live
```

On Linux, Chrome reads native messaging manifests from `<user-data-dir>/NativeMessagingHosts`, so copy `host/com.autopilot.host.json` into `.browsers/profile/NativeMessagingHosts/` after `npm run install-host`. `.github/workflows/live.yml` does exactly this on the runner.

The live workflow is not a required check. It runs nightly, on demand, and on pull requests that touch `extension/` or `host/`. A red live run on a pull request is worth reading before merging, because the unit suite cannot see Chrome's own behaviour.

## Rules that CI enforces

- **Bump the extension version on every change under `extension/`.** Chrome caches the compiled service worker module graph per version, so a change that ships without a bump can run stale code on a machine that already had the previous version loaded. The `version-bump` job fails the pull request otherwise. Keep `package.json` at the same version.
- **`host/errors.js` is the canonical error table.** The extension cannot import from `host/`, so `extension/src/lib/errors.js` is a copy. Edit the host file, copy it over, keep the header comment.
- **Coverage does not go down.** Thresholds live in `tools/run-tests.js`. Raise them when coverage grows. A pull request that needs them lowered needs a reason in the description.
- **Formatting is Prettier's.** `npm run format` before committing, or let the editor do it through `.editorconfig` and `.prettierrc`.

## Writing a test

- Unit tests import the module under test directly. For extension modules, call `installChromeStub()` from `test/chrome-stub.js` first and `resetStorage()` between cases that touch `chrome.storage`.
- For anything that reads a page, load an HTML fixture from `test/fixtures/` through `test/page-harness.js` rather than building DOM by hand.
- Tests that write files use `mkdtempSync` under `os.tmpdir()` and remove it in `test.after`.
- A test that needs a browser goes in one of the live files and follows their skip pattern: resolve `anyBridge()` at module load and pass `{ skip }` to the top-level test when it is null.
- Name tests by the behaviour, in the words a user of the tool would use. `closing the last tab of a session keeps the window and the browser` is the house style.

## Pull requests

- One change per pull request. A refactor and a behaviour change are two pull requests.
- Fill in the template. The "how it was verified" section is read, so say which suites ran.
- Commit messages are one plain sentence in the imperative, no prefix tags. `Report a click that opened a modal as applied` is the house style.
- Review comes from the maintainer through CODEOWNERS. When the repository has a `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` secret, Claude posts a first-pass review as well. Treat it as a reviewer whose comments can be wrong, and reply to what it gets wrong.

## Prose in comments and docs

Comments explain why, in full sentences, and they are the main place the design is recorded. Keep to these rules when writing them:

- No em dashes and no semicolons. Use periods, commas, colons or parentheses.
- No "not X but Y" constructions.
- No filler connectives ("moreover", "additionally", "simply", "finally").
- No marketing words ("robust", "seamless", "leverage"). Use the plain word.
- A claim of importance sits next to the fact that proves it, or it goes.
- When a comment cites a measurement, say where it was measured.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
