## What changed

<!-- One paragraph. What a reader of `git log` needs to know. -->

## Why

<!-- The problem or the motivation. Link the issue if there is one. -->

## How it was verified

- [ ] `npm run check` passes locally (lint, format, version sync, unit tests with coverage)
- [ ] Live suite run against the development browser (`npm run browser`, then `npm run test:live`) if the change touches `extension/` or the tool contract
- [ ] `extension/manifest.json` and `package.json` versions bumped if anything under `extension/` changed

## Notes for the reviewer

<!-- Risky spots, follow-ups, anything deliberately left out. -->
