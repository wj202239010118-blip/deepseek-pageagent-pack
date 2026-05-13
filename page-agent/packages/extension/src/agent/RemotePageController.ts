import type { BrowserState } from '@page-agent/page-controller'

import type { TabsController } from './TabsController'
import { createLogger, isContentScriptAllowed, safeSendMessage } from './shared'

// Re-exported so existing imports from './RemotePageController' still resolve.
export { isContentScriptAllowed } from './shared'

const PREFIX = 'RemotePageController'

const debug = createLogger(PREFIX)

function sendMessage(message: {
	type: 'PAGE_CONTROL'
	action: string
	targetTabId: number
	payload?: any
}): Promise<any> {
	return safeSendMessage(message, PREFIX)
}

/**
 * Agent side page controller.
 * - live in the agent env (extension page or content script)
 * - communicates with remote PageController via sw
 */
export class RemotePageController {
	tabsController: TabsController

	constructor(tabsController: TabsController) {
		this.tabsController = tabsController
	}

	get currentTabId(): number | null {
		return this.tabsController.currentTabId
	}

	private async getCurrentUrl(): Promise<string> {
		if (!this.currentTabId) return ''
		const { url } = await this.tabsController.getTabInfo(this.currentTabId)
		return url || ''
	}

	private async getCurrentTitle(): Promise<string> {
		if (!this.currentTabId) return ''
		const { title } = await this.tabsController.getTabInfo(this.currentTabId)
		return title || ''
	}

	async getLastUpdateTime(): Promise<number> {
		if (!this.currentTabId) throw new Error('tabsController not initialized.')
		return sendMessage({
			type: 'PAGE_CONTROL',
			action: 'get_last_update_time',
			targetTabId: this.currentTabId,
		})
	}

	async getBrowserState(): Promise<BrowserState> {
		let browserState: BrowserState
		debug('getBrowserState', this.currentTabId)

		const currentUrl = await this.getCurrentUrl()
		const currentTitle = await this.getCurrentTitle()

		if (!this.currentTabId || !isContentScriptAllowed(currentUrl)) {
			browserState = {
				url: currentUrl,
				title: currentTitle,
				header: '',
				content: '(empty page. either current page is not readable or not loaded yet.)',
				footer: '',
			}
		} else {
			browserState = await sendMessage({
				type: 'PAGE_CONTROL',
				action: 'get_browser_state',
				targetTabId: this.currentTabId,
			})
		}

		const sum = await this.tabsController.summarizeTabs()
		browserState.header = sum + '\n\n' + (browserState.header || '')

		debug('getBrowserState: success', this.currentTabId, browserState)

		return browserState
	}

	async updateTree(): Promise<void> {
		if (!this.currentTabId || !isContentScriptAllowed(await this.getCurrentUrl())) {
			return
		}

		await sendMessage({
			type: 'PAGE_CONTROL',
			action: 'update_tree',
			targetTabId: this.currentTabId,
		})
	}

	async cleanUpHighlights(): Promise<void> {
		if (!this.currentTabId || !isContentScriptAllowed(await this.getCurrentUrl())) {
			return
		}

		await sendMessage({
			type: 'PAGE_CONTROL',
			action: 'clean_up_highlights',
			targetTabId: this.currentTabId,
		})
	}

	async clickElement(...args: any[]): Promise<DomActionReturn> {
		const res = await this.remoteCallDomAction('click_element', args)
		// Reduced from 1000ms: short pause lets navigation start without blocking the agent.
		// Navigation detection (via URL change) is handled by getBrowserState, not this wait.
		await new Promise((resolve) => setTimeout(resolve, 150))
		return res
	}

	async inputText(...args: any[]): Promise<DomActionReturn> {
		return this.remoteCallDomAction('input_text', args)
	}

	async pressKey(options: {
		key: string
		code?: string
		modifiers?: { alt?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean }
		index?: number
	}): Promise<DomActionReturn> {
		return this.remoteCallDomAction('press_key', [options])
	}

	async drag(options: {
		start: { x: number; y: number }
		end: { x: number; y: number }
		steps?: number
	}): Promise<DomActionReturn> {
		return this.remoteCallDomAction('drag', [options])
	}

	async dragElement(options: {
		fromIndex: number
		toIndex?: number
		delta?: { dx: number; dy: number }
		steps?: number
	}): Promise<DomActionReturn> {
		return this.remoteCallDomAction('drag_element', [options])
	}

	async selectOption(...args: any[]): Promise<DomActionReturn> {
		return this.remoteCallDomAction('select_option', args)
	}

	async scroll(...args: any[]): Promise<DomActionReturn> {
		return this.remoteCallDomAction('scroll', args)
	}

	async scrollHorizontally(...args: any[]): Promise<DomActionReturn> {
		return this.remoteCallDomAction('scroll_horizontally', args)
	}

	async executeJavascript(...args: any[]): Promise<DomActionReturn> {
		return this.remoteCallDomAction('execute_javascript', args)
	}

	/**
	 * Wait for a CSS selector using MutationObserver in the content script.
	 * Inspired by Playwright's auto-wait mechanism.
	 */
	async waitForSelector(selector: string, timeout = 15000, visible = true): Promise<string> {
		const result = await this.remoteCallDomAction('wait_for_selector', [{ selector, timeout, visible }])
		if (!result.success) throw new Error(result.message)
		return (result as any).found ?? ''
	}

	/**
	 * Get current URL and title directly from the content script (bypasses cache).
	 */
	async getLiveUrl(): Promise<{ url: string; title: string }> {
		if (!this.currentTabId) return { url: '', title: '' }
		const result = await sendMessage({
			type: 'PAGE_CONTROL',
			action: 'get_current_url',
			targetTabId: this.currentTabId,
		})
		return result ?? { url: '', title: '' }
	}

	/**
	 * Capture a JPEG screenshot of the current tab via the background service worker.
	 * Returns a base64-encoded data URL, or null on failure.
	 */
	async captureScreenshot(): Promise<string | null> {
		const result = await safeSendMessage(
			{ type: 'TAB_CONTROL', action: 'capture_screenshot', payload: {} },
			PREFIX,
		) as { success?: boolean; dataUrl?: string } | null
		return result?.dataUrl ?? null
	}

	/**
	 * Click at a viewport-relative position (0–100% of width/height).
	 * Used by visual grounding tools when DOM targeting is unavailable.
	 */
	async clickAtPoint(xPct: number, yPct: number): Promise<DomActionReturn> {
		return this.remoteCallDomAction('click_at_point', [{ xPct, yPct }])
	}

	/** @note Managed by content script via storage polling. */
	async showMask(): Promise<void> {}
	/** @note Managed by content script via storage polling. */
	async hideMask(): Promise<void> {}
	/** @note Managed by content script via storage polling. */
	dispose(): void {}

	private async remoteCallDomAction(action: string, payload: any[]): Promise<DomActionReturn> {
		if (!this.currentTabId) {
			return { success: false, message: 'RemotePageController not initialized.' }
		}

		if (!isContentScriptAllowed(await this.getCurrentUrl())) {
			return {
				success: false,
				message:
					'Operation not allowed on this page. Use open_new_tab to navigate to a web page first.',
			}
		}

		return sendMessage({
			type: 'PAGE_CONTROL',
			action: action,
			targetTabId: this.currentTabId!,
			payload,
		})
	}
}

interface DomActionReturn {
	success: boolean
	message: string
}

