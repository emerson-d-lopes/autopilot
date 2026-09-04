# interferer

A second unpacked extension for the development browser. It mounts a 1 px iframe whose src is its own `chrome-extension://` URL into every page, which reproduces `Cannot access a chrome-extension:// URL of different extension` on `chrome.debugger.attach` without needing x.com or a password manager.

Load it next to the Autopilot extension with `--load-extension=<autopilot>,<this folder>` (see `tools/browser.js`), or through chrome://extensions with Developer mode on. Never load it in a real profile.
