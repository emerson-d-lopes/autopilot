# Security

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/emerson-d-lopes/autopilot/security/advisories/new). Do not open a public issue. A report gets a first reply within seven days.

Include the tool call or the page that triggers the problem, the extension version from `chrome://extensions`, and what an attacker gains.

## What is in scope

Autopilot gives a local MCP client the ability to drive the user's own browser. The boundaries that matter:

- **The native messaging host only answers the extension id baked into `extension/manifest.json`.** The `allowed_origins` entry written by `npm run install-host` is derived from the committed public key. A report that another origin can reach the host is in scope.
- **The pipe between the MCP server and the native host is local and per user.** Anything that lets another local user or another process on the machine issue tool calls through it is in scope.
- **Per-origin permissions.** Tools that act on a page go through `extension/src/lib/permissions.js`. A way to act on an origin the user has not allowed, or to keep acting after the origin changed under a tab, is in scope.
- **Redaction.** The action journal and the `read_console_messages` and `read_network_requests` outputs pass through `host/redact.js`. A secret that survives redaction in a shape the tests in `test/redact.test.js` and `test/sensitive.test.js` claim to cover is in scope.
- **`javascript`, `quick` and `browser_batch` run what the MCP client sends.** That is the product. A report that a client can run JavaScript on an allowed origin is not a vulnerability.

## What is not in scope

- Anything that requires a malicious MCP client. The client is trusted by design, the same way a terminal trusts the shell.
- Bot detection on third-party sites. The comparison notes under `docs/` record what is and is not detectable, and none of it is a security boundary.

## Supported versions

Only the latest release on `main` receives fixes.
