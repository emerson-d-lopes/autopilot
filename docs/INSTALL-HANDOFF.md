Install and connect the Autopilot MCP server on this machine. Autopilot drives the user's own Chrome through an unpacked Manifest V3 extension and the Chrome DevTools Protocol, in the background, so the user's existing logins are usable and nothing ever brings a tab or window forward. Repository: https://github.com/emerson-d-lopes/autopilot (branch `main`, extension 0.2.0, npm package `autopilot-chrome`, MCP server name `autopilot`, native messaging host `com.autopilot.host`).

Do these steps in order and stop at the first failure, quoting the output.

1. Clone or update the repository to `C:\Users\<user>\workspace\autopilot` (any path works, but every later step uses the path you chose). Run `npm install` there. Node 22 or newer is required, and on this machine Node is managed by fnm, so run the commands from a shell where `node --version` answers.

2. Register the native messaging host: `npm run install-host`. It writes `host\com.autopilot.host.json`, rewrites `host\native-host.bat` with the real path to the node binary, registers the host with Chrome and Edge (and Brave and Vivaldi when installed), and removes any old `com.chromemcp.host` registration from an earlier name of this project. Read its output. Do not run `npm run keygen`: the extension key is committed and pins the id `giagijohigincdlpkfolgcljkhmjdiaa`, which the host registration expects.

3. Load the extension. Chrome 137 and later ignore `--load-extension`, so this is a manual step for the user: open `chrome://extensions`, turn on Developer mode, click Load unpacked, choose `<repo>\extension`. It must appear as "Autopilot" with version 0.2.0. If an older entry pointing at a `chrome-mcp` path exists, remove it first. Then fully restart Chrome so it reads the host registration.

4. Add the server to Claude Code at user scope: `claude mcp add -s user autopilot -- node "<repo>\host\mcp-server.js"`. For another MCP client, the equivalent stdio entry is `{"command": "node", "args": ["<repo>/host/mcp-server.js"]}`. Tools then appear as `mcp__autopilot__<tool>`.

5. Verify with `npm run doctor`. Every line must read `ok`, including "a browser is connected" and "Chrome extension is attached" with `extension v0.2.0`, and the profile line must show the Chrome profile name, the signed-in account and the sites with a session. If doctor says no browser is connected, Chrome was not restarted after step 2 or the extension is not loaded. If it says the extension is attached but names an older version, the reload did not take.

6. Make one real call without a chat session, through the bundled client: `node tools\mcp-client.js list_connected_browsers '{}'`. It must print the browser, profile, account and sessions. Then in Claude Code run `/mcp`, connect `autopilot`, and call `mcp__autopilot__tabs_context` with `createIfEmpty: true`, which opens an unselected tab in the user's current window.

Facts the user will want stated back:

- Background mode is a design rule. Tabs open unselected, nothing is activated or focused. Hidden tabs are woken through CDP and captured through a screencast frame.
- With several Chrome profiles open, each connects as its own browser. `select_browser` takes `browserId`, `label`, `profile`, `account` or `site` (for example `{"site": "linkedin.com"}` picks the profile signed in there), and every page tool accepts an optional `browser` argument for one call. `AUTOPILOT_BROWSER` in the server environment sets the session default.
- Permission modes live on the extension's options page: allow (default, with a financial-site blocklist), ask per origin, confirm (an irreversible click such as Send, Post, Delete or Pay returns a token and a screenshot of what is about to be submitted, and only the tokened retry performs it), and plan (`declare_plan` once per session). The optional in-browser Allow/Deny toast is off by default.
- Every result carries `ok`, `effects` (none, applied, unknown), `evidence` and `warnings`, and every error carries a code from `host/errors.js`, a cause, a hint and whether it is retryable. An action journal is written under `%LOCALAPPDATA%\Autopilot\logs` (`~/Library/Application Support/Autopilot/logs` on macOS, `~/.local/state/autopilot/logs` elsewhere) and read with `npm run log`. Set `AUTOPILOT_JOURNAL_REDACT=1` to keep typed values out of it.
- A site probing for CDP automation can detect the session. The debugger banner is visible on driven tabs.

Documentation in the repository: README.md (usage and tools), CONTRIBUTING.md (working rules, scripts, the live suite), docs/STATUS.md (parity, bugs, known limits), docs/claude-in-chrome-comparison/RESULT.md (the measured comparison against Claude in Chrome and the scorecard).
