# Upgrade Guide: browser_press_key / browser_drag

## What changed
- New MCP tools:
  - `browser_press_key`
  - `browser_drag`
- New extension-side primitive operations:
  - `press_key`, `drag`, `drag_element`
- New strict security gate:
  - Sensitive ops are denied unless the active tab origin is in `hubAllowedOrigins`.

## Why this exists
- Some web apps require keyboard events (e.g. Enter/Escape) and pointer drag sequences to complete tasks reliably.
- These capabilities increase the blast radius of automation, so they ship behind an explicit allowlist.

## Required actions after upgrading
- Open the hub tab and configure the allowlist:
  - Add the origins you intend to automate (one per line).
  - Keep the list minimal.

## Local development / tests
- The hub tab supports seeding a localhost allowlist entry via query parameter:
  - `chrome-extension://akldabonmimlicnjlflnapfeklbfemhj/hub.html?ws=PORT&allowOrigin=http://localhost:PORT`
- This is intended for repo-local fixtures and automated tests only.

## Notes
- Password inputs are blocked for typing and key presses.
- Dangerous key combos are blocked (e.g. Ctrl+L, Ctrl+W, Ctrl+T, F12).

