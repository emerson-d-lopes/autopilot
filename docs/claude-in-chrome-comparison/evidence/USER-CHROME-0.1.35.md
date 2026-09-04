# Checks on the user's Chrome, extension 0.1.35, 2026-09-04

Driven through `tools/mcp-client.js --browser bz04vrv3f` (the new host code), profile `Profile 3 "Emerson Lopes"`.

| Check | Result |
|---|---|
| `list_connected_browsers` | One row: profile directory, display name, account email, `sessions: linkedin.com, github.com, google.com`. Pass |
| `select_browser({site: "linkedin.com"})` | Picked Profile 3. Pass |
| `select_browser({account: "emerson.fr.lopes@gmail.com"})` | Picked Profile 3. Pass |
| Two browsers connected, no selector | `profile_ambiguous` listing both, with the hint. Pass |
| `get_page_text` on linkedin.com/feed | Returns text (750 chars) with `container: body, textNodes: 28, rejectedHidden: 383, fallback: true`. A `javascript` read of `document.querySelector('main').innerText.length` on the same tab gave 8989 and `document.visibilityState` was `visible`. Partial: the fallback works, the hidden-node filter still rejects visible content |
| `get_page_text` on notion.so | Redirected to notion.com/pt marketing page. The profile holds no Notion session cookie now (`sessions` lists none), so the Notion check cannot run in this profile. Deferred |
| Origin transition warning | Present on the first call after switching from linkedin.com to notion.com and back. Pass |
