# Security Audit: browser_press_key / browser_drag

## Threat model summary
- Keyboard and drag primitives can trigger irreversible UI actions (submit, delete, navigation, closing tabs).
- Attack surface is gated by hub session approval plus a strict origin allowlist for sensitive operations.

## Controls implemented
- Origin allowlist gate (default deny):
  - Extension refuses `press_key` / `drag` / `drag_element` unless the active tab origin is in `hubAllowedOrigins`.
- Deny window:
  - `hubDenyUntil` blocks sensitive ops during a panic period.
- Dangerous key combos blocked:
  - At minimum: Ctrl+L/Ctrl+W/Ctrl+T/Ctrl+N/Ctrl+R/Ctrl+Shift+R/Ctrl+Shift+I/Ctrl+Shift+J/Ctrl+Shift+C/F12/Alt+F4.
- Password protection:
  - Page-controller blocks typing and key presses on password inputs.

## Remaining risks (explicit)
- Synthetic keyboard events are not fully equivalent to real user input; some sites may ignore them or behave inconsistently.
- If a user allowlists a high-risk origin, the agent can still cause damage within that origin's UI. This is by design.

## Audit checklist
- [x] Sensitive ops denied by default when allowlist is empty.
- [x] Sensitive ops denied when origin is not allowlisted.
- [x] Password input interactions blocked.
- [x] Disallowed key combos blocked.
- [x] No new usage of innerHTML/eval added for user-provided strings.
- [x] Error messages avoid leaking typed text/secrets.

