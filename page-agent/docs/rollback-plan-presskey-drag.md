# Rollback Plan: browser_press_key / browser_drag

## Fast rollback (no rebuild)
- Remove all sensitive origins from `hubAllowedOrigins` in the hub tab UI.
- Trigger panic stop:
  - Run the extension command `page-agent-panic-stop` to set a temporary deny window.

## Code rollback
- MCP side:
  - Remove tool registrations for `browser_press_key` and `browser_drag` from `packages/mcp/src/index.js`.
- Extension side:
  - Remove `press_key` / `drag` / `drag_element` cases from `packages/extension/src/agent/useAgent.ts`.
  - Remove corresponding PAGE_CONTROL actions from `packages/extension/src/agent/RemotePageController.content.ts`.
- Page-controller side:
  - Remove `pressKey/drag/dragElement` public methods from `packages/page-controller/src/PageController.ts`.
  - Remove the event helpers from `packages/page-controller/src/utils/inputEvents.ts`.

## Operational rollback checklist
- Rebuild and redeploy extension package.
- Verify `browser_get_map` / `browser_click` / `browser_type` still work.
- Confirm sensitive ops return errors (or do not exist) after rollback.

