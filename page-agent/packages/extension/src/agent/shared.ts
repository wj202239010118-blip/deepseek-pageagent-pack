/**
 * SSOT: All cross-module utilities for the extension agent must be defined here.
 * Importing from this file ensures AI-assisted edits remain consistent across controllers.
 *
 * @module shared
 */

// ─── URL filtering ────────────────────────────────────────────────────────────

const RESTRICTED_PATTERNS = [
	/^chrome:\/\//,
	/^chrome-extension:\/\//,
	/^about:/,
	/^edge:\/\//,
	/^brave:\/\//,
	/^opera:\/\//,
	/^vivaldi:\/\//,
	/^file:\/\//,
	/^view-source:/,
	/^devtools:\/\//,
]

/**
 * Returns true if the URL can host a content script.
 * Covers all restricted browser-internal schemes.
 */
export function isContentScriptAllowed(url: string | undefined): boolean {
	if (!url) return false
	return !RESTRICTED_PATTERNS.some((pattern) => pattern.test(url))
}

// ─── Error formatting ─────────────────────────────────────────────────────────

/** Safely extract a human-readable string from any thrown value. */
export function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

// ─── Debug logger factory ─────────────────────────────────────────────────────

/**
 * Creates a prefixed debug logger bound to console.debug.
 * Centralised here so production log suppression can be toggled in one place.
 */
export function createLogger(prefix: string): (...args: unknown[]) => void {
	return console.debug.bind(console, `\x1b[90m[${prefix}]\x1b[0m`)
}

// ─── Chrome message helpers ───────────────────────────────────────────────────

/**
 * Send a chrome runtime message, guarding against both synchronous throws
 * (Extension context invalidated) and async rejections.
 *
 * @param message  The message object to send.
 * @param prefix   Module name used in error logs (e.g. 'TabsController').
 */
export function safeSendMessage<T>(message: T, prefix: string): Promise<unknown> {
	try {
		return (chrome.runtime.sendMessage(message) as Promise<unknown>).catch((error) => {
			console.error(`[${prefix}]`, (message as any).action ?? message, error)
			return null
		})
	} catch (error) {
		console.error(`[${prefix}]`, (message as any).action ?? message, error)
		return Promise.resolve(null)
	}
}
