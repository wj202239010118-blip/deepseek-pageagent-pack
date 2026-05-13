/**
 * content script for RemotePageController
 *
 * Lifecycle management strategy (per Gemini / Chrome extension best practices):
 * - Use chrome.runtime.connect() port to detect extension reload.
 * - When the extension reloads, the port disconnects automatically.
 * - Clean up everything in port.onDisconnect — this is the only reliable signal.
 * - Use document.documentElement.dataset to prevent duplicate injection across
 *   reloads (DOM persists across extension Isolated World recreations).
 */
import { PageController } from '@page-agent/page-controller'

const INJECTED_FLAG = 'pageAgentInjected'

export function initPageController() {
	// Use a DOM-level flag (not window) because DOM persists across extension reloads
	// while window (Isolated World) is recreated each time.
	if (document.documentElement.dataset[INJECTED_FLAG]) {
		// Already injected in this page lifetime — skip duplicate setup
		return
	}
	document.documentElement.dataset[INJECTED_FLAG] = 'true'

	let pageController: PageController | null = null

	function getPC(): PageController {
		if (!pageController) {
			pageController = new PageController({
				enableMask: false,
				viewportExpansion: 400,
			})
		}
		return pageController
	}

	function cleanup() {
		// Remove DOM flag so next injection after reload can reinitialize
		delete document.documentElement.dataset[INJECTED_FLAG]
		if (pageController) {
			try { pageController.dispose() } catch { /* ignore */ }
			pageController = null
		}
	}

	// Connect a port to the background. When the extension reloads, this port
	// disconnects automatically — the most reliable cleanup signal available.
	try {
		const port = chrome.runtime.connect({ name: 'content-script-lifecycle' })
		port.onDisconnect.addListener(() => {
			cleanup()
		})
	} catch {
		// If connect fails the context is already gone — nothing to do
		return
	}

	chrome.runtime.onMessage.addListener((message, sender, sendResponse): true | undefined => {
		// Quick liveness check — if context is gone, clean up and bail
		if (!chrome.runtime?.id) {
			cleanup()
			return
		}

		if (message.type !== 'PAGE_CONTROL') return

		const { action, payload } = message
		const methodName = getMethodName(action)
		const pc = getPC() as any

		switch (action) {
			case 'get_last_update_time':
			case 'get_browser_state':
			case 'update_tree':
			case 'clean_up_highlights':
			case 'click_element':
			case 'input_text':
			case 'press_key':
			case 'drag':
			case 'drag_element':
			case 'select_option':
			case 'scroll':
			case 'scroll_horizontally':
			case 'execute_javascript':
				pc[methodName](...(payload || []))
					.then((result: any) => { try { sendResponse(result) } catch { void 0 } })
					.catch((error: any) => {
						try {
							sendResponse({
								success: false,
								message: error instanceof Error ? error.message : String(error),
							})
						} catch { void 0 }
					})
				break

			case 'wait_for_selector': {
				// MutationObserver-based wait — Playwright-style actionability check
				// (inspired by playwright-mcp and CAMEL AI browser toolkit research)
				const { selector, timeout = 15000, visible = true } = (payload?.[0] ?? {}) as {
					selector: string
					timeout?: number
					visible?: boolean
				}
				waitForSelector(selector, timeout, visible)
					.then((found) => { try { sendResponse({ success: true, found }) } catch { void 0 } })
					.catch((err) => { try { sendResponse({ success: false, error: String(err) }) } catch { void 0 } })
				break
			}

			case 'get_current_url':
				try { sendResponse({ success: true, url: window.location.href, title: document.title }) } catch { void 0 }
				break

			case 'click_at_point': {
				// Visual grounding fallback: click at viewport-relative coordinates (0-100 percentage)
				const { xPct, yPct } = (payload?.[0] ?? {}) as { xPct: number; yPct: number }
				const x = (xPct / 100) * window.innerWidth
				const y = (yPct / 100) * window.innerHeight
				try {
					const el = document.elementFromPoint(x, y) as HTMLElement | null
					const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }
					const target = el ?? document.body
					target.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerType: 'mouse' }))
					target.dispatchEvent(new MouseEvent('mousedown', opts))
					target.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerType: 'mouse' }))
					target.dispatchEvent(new MouseEvent('mouseup', opts))
					target.dispatchEvent(new MouseEvent('click', opts))
					sendResponse({ success: true, message: `Clicked at (${x.toFixed(0)}, ${y.toFixed(0)}) — element: ${el?.tagName ?? 'none'}` })
				} catch (err) {
					sendResponse({ success: false, error: String(err) })
				}
				break
			}

			default:
				sendResponse({ success: false, error: `Unknown PAGE_CONTROL action: ${action}` })
		}

		return true
	})
}

/**
 * Wait for a CSS selector to appear in the DOM using MutationObserver.
 * Falls back to polling if MutationObserver fires for unrelated mutations.
 * Returns the element's text content when found.
 */
function waitForSelector(selector: string, timeout: number, visible: boolean): Promise<string> {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + timeout

		function check(): HTMLElement | null {
			try {
				const el = document.querySelector<HTMLElement>(selector)
				if (!el) return null
				if (visible) {
					const rect = el.getBoundingClientRect()
					if (rect.width === 0 && rect.height === 0) return null
				}
				return el
			} catch {
				return null
			}
		}

		// Immediate check
		const found = check()
		if (found) {
			resolve(found.textContent?.trim() ?? '')
			return
		}

		let observer: MutationObserver | null = null
		let timer: ReturnType<typeof setTimeout> | null = null

		const cleanup = () => {
			observer?.disconnect()
			if (timer) clearTimeout(timer)
		}

		observer = new MutationObserver(() => {
			const el = check()
			if (el) {
				cleanup()
				resolve(el.textContent?.trim() ?? '')
			} else if (Date.now() >= deadline) {
				cleanup()
				reject(new Error(`Selector "${selector}" not found within ${timeout}ms`))
			}
		})

		observer.observe(document.documentElement, { childList: true, subtree: true })

		// Hard deadline
		timer = setTimeout(() => {
			cleanup()
			const el = check()
			if (el) resolve(el.textContent?.trim() ?? '')
			else reject(new Error(`Selector "${selector}" not found within ${timeout}ms`))
		}, timeout)
	})
}

function getMethodName(action: string): string {
	switch (action) {
		case 'get_last_update_time': return 'getLastUpdateTime'
		case 'get_browser_state': return 'getBrowserState'
		case 'update_tree': return 'updateTree'
		case 'clean_up_highlights': return 'cleanUpHighlights'
		case 'click_element': return 'clickElement'
		case 'input_text': return 'inputText'
		case 'press_key': return 'pressKey'
		case 'drag': return 'drag'
		case 'drag_element': return 'dragElement'
		case 'select_option': return 'selectOption'
		case 'scroll': return 'scroll'
		case 'scroll_horizontally': return 'scrollHorizontally'
		case 'execute_javascript': return 'executeJavascript'
		default: return action
	}
}
