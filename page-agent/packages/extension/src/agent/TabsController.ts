import { createLogger, isContentScriptAllowed, safeSendMessage } from './shared'

const PREFIX = 'TabsController'

const debug = createLogger(PREFIX)

function sendMessage(message: {
	type: 'TAB_CONTROL'
	action: TabAction
	payload?: any
}): Promise<any> {
	return safeSendMessage(message, PREFIX)
}

/**
 * Controller for managing browser tabs.
 * - live in the agent env (extension page or content script)
 * - no chrome apis. call sw for tab operations
 */
export class TabsController {
	currentTabId: number | null = null

	private disposed = false
	private port?: chrome.runtime.Port
	private portRetries = 0

	private windowId: number | null = null
	private tabs: TabMeta[] = []
	private initialTabId: number | null = null
	private tabGroupId: number | null = null
	private experimentalIncludeAllTabs = false
	private task: string = ''

	async init(task: string, options: TabsInitOptions = {}) {
		const { includeInitialTab = true, experimentalIncludeAllTabs = false } = options
		debug('init', task, options)

		if (this.disposed) {
			throw new Error('TabsController already disposed')
		}

		this.currentTabId = null
		this.disposed = false
		this.port = undefined
		this.portRetries = 0

		this.windowId = null
		this.tabs = []
		this.tabGroupId = null
		this.initialTabId = null
		this.experimentalIncludeAllTabs = experimentalIncludeAllTabs
		this.task = task

		const activeTabResult = await sendMessage({
			type: 'TAB_CONTROL',
			action: 'get_active_tab',
		})

		this.initialTabId = activeTabResult.tab?.id
		this.windowId = activeTabResult.tab?.windowId

		if (!this.initialTabId || !this.windowId) {
			if (activeTabResult.error) {
				throw new Error(activeTabResult.error)
			} else {
				throw new Error('Failed to get active tab')
			}
		}

		this.connectTabEvents()

		if (experimentalIncludeAllTabs) {
			const allTabs = await sendMessage({
				type: 'TAB_CONTROL',
				action: 'get_window_tabs',
				payload: { windowId: this.windowId },
			})
			for (const tab of allTabs.tabs as chrome.tabs.Tab[]) {
				if (tab.id && !tab.pinned && isContentScriptAllowed(tab.url)) {
					this.addTab({
						id: tab.id,
						isInitial: tab.id === this.initialTabId,
						url: tab.url,
						title: tab.title,
						status: tab.status,
					})
				}
			}
			if (this.tabs.find((t) => t.id === this.initialTabId)) {
				this.currentTabId = this.initialTabId
				await this.ensureTabGroup([this.initialTabId])
			}
		} else if (includeInitialTab) {
			const info = await sendMessage({
				type: 'TAB_CONTROL',
				action: 'get_tab_info',
				payload: { tabId: this.initialTabId },
			})

			if (isContentScriptAllowed(info.url) && !info.pinned) {
				this.currentTabId = this.initialTabId

				this.addTab({
					id: this.initialTabId,
					isInitial: true,
					url: info.url,
					title: info.title,
					status: info.status,
				})

				// Reuse existing tab group if the tab is already in one
				await this.ensureTabGroup([this.initialTabId], info.groupId)
			}
		}

		await this.updateCurrentTabId(this.currentTabId)
	}

	async openNewTab(url: string): Promise<string> {
		debug('openNewTab', url)

		const result = await sendMessage({
			type: 'TAB_CONTROL',
			action: 'open_new_tab',
			payload: { url },
		})

		if (!result.success) {
			throw new Error(`Failed to open new tab: ${result.error}`)
		}

		const tabId = result.tabId as number

		this.addTab({
			id: tabId,
			isInitial: false,
		})

		await this.switchToTab(tabId)

		if (!this.tabGroupId) {
			await this.createTabGroup([tabId])
		} else {
			await sendMessage({
				type: 'TAB_CONTROL',
				action: 'add_tab_to_group',
				payload: { tabId: result.tabId, groupId: this.tabGroupId },
			})
		}

		await this.waitUntilTabLoaded(tabId)

		return `✅ Opened new tab ID ${tabId} with URL ${url}`
	}

	async switchToTab(tabId: number): Promise<string> {
		debug('switchToTab', tabId)

		const targetTab = this.tabs.find((t) => t.id === tabId)
		if (!targetTab) {
			throw new Error(`Tab ID ${tabId} not found in tab list.`)
		}

		await this.updateCurrentTabId(tabId)

		return `✅ Switched to tab ID ${tabId}.`
	}

	async closeTab(tabId: number): Promise<string> {
		debug('closeTab', tabId)

		const targetTab = this.tabs.find((t) => t.id === tabId)
		if (!targetTab) {
			throw new Error(`Tab ID ${tabId} not found in tab list.`)
		}
		if (targetTab.isInitial) {
			throw new Error(`Cannot close the initial tab ID ${tabId}.`)
		}

		const result = await sendMessage({
			type: 'TAB_CONTROL',
			action: 'close_tab',
			payload: { tabId },
		})

		if (result.success) {
			await this._handleTabRemoval(tabId)
			return `✅ Closed tab ID ${tabId}.`
		} else {
			throw new Error(`Failed to close tab ID ${tabId}: ${result.error}`)
		}
	}

	/** Remove a tab from the managed list and switch away if it was the current tab. */
	private async _handleTabRemoval(tabId: number): Promise<void> {
		this.tabs = this.tabs.filter((t) => t.id !== tabId)
		if (this.currentTabId === tabId) {
			const fallback = this.tabs[this.tabs.length - 1] ?? null
			if (fallback) {
				await this.switchToTab(fallback.id)
			} else {
				await this.updateCurrentTabId(null)
			}
		}
	}

	/**
	 * Reuse an existing tab group if provided, otherwise create a new one.
	 * Prevents creating a new group on every task when the tab is already grouped.
	 */
	private async ensureTabGroup(tabIds: number[], existingGroupId?: number) {
		if (existingGroupId != null && existingGroupId >= 0) {
			// Tab is already in a group — reuse it and just update the title
			this.tabGroupId = existingGroupId
			await sendMessage({
				type: 'TAB_CONTROL',
				action: 'update_tab_group',
				payload: {
					groupId: this.tabGroupId,
					properties: {
						title: `PageAgent(${this.task})`,
						collapsed: false,
					},
				},
			}).catch(() => {}) // non-fatal if group update fails
		} else {
			await this.createTabGroup(tabIds)
		}
	}

	private async createTabGroup(tabIds: number[]) {
		const result = await sendMessage({
			type: 'TAB_CONTROL',
			action: 'create_tab_group',
			payload: { tabIds, windowId: this.windowId },
		})

		if (!result?.success) {
			throw new Error(`Failed to create tab group: ${result?.error}`)
		}

		this.tabGroupId = result.groupId as number

		await sendMessage({
			type: 'TAB_CONTROL',
			action: 'update_tab_group',
			payload: {
				groupId: this.tabGroupId,
				properties: {
					title: `PageAgent(${this.task})`,
					color: randomColor(),
					collapsed: false,
				},
			},
		})
	}

	private addTab(meta: TabMeta) {
		if (this.tabs.find((t) => t.id === meta.id)) return
		this.tabs.push(meta)
	}

	async updateCurrentTabId(tabId: number | null) {
		debug('updateCurrentTabId', tabId)

		this.currentTabId = tabId
		try {
			await chrome.storage.local.set({ currentTabId: tabId })
		} catch { /* context may be gone */ }
	}

	async getTabInfo(tabId: number): Promise<{ title: string; url: string }> {
		// use cached tab info if available
		const tabMeta = this.tabs.find((t) => t.id === tabId)
		if (tabMeta && tabMeta.url && tabMeta.title) {
			return { title: tabMeta.title, url: tabMeta.url }
		}

		// otherwise, pull the latest tab info from the background script
		debug('getTabInfo: pulling from background script', tabId)
		const result = await sendMessage({
			type: 'TAB_CONTROL',
			action: 'get_tab_info',
			payload: { tabId },
		})

		if (tabMeta) {
			tabMeta.url = result.url
			tabMeta.title = result.title
		}

		return result
	}

	async summarizeTabs(): Promise<string> {
		const summaries = [`| Tab ID | URL | Title | Current |`, `|-----|-----|-----|-----|`]
		for (const tab of this.tabs) {
			const { title, url } = await this.getTabInfo(tab.id)
			summaries.push(
				`| ${tab.id} | ${url} | ${title} | ${this.currentTabId === tab.id ? '✅' : ''} |`
			)
		}
		if (!this.tabs.length) {
			summaries.push('\nNo tabs available. Open a tab if needed.')
		}

		return summaries.join('\n')
	}

	async waitUntilTabLoaded(tabId: number): Promise<void> {
		const tab = this.tabs.find((t) => t.id === tabId)
		if (!tab) throw new Error(`Tab ID ${tabId} not found in tab list.`)

		if (tab.status === 'unloaded') throw new Error(`Tab ID ${tabId} is unloaded.`)
		if (tab.status === 'complete') return

		debug('waitUntilTabLoaded', tabId)
		await waitUntil(() => tab.status === 'complete', 4_000)
	}

	/**
	 * Connect to background SW via port to receive tab change events.
	 *
	 * @note Port is 1:1 (runtime.connect → background SW has no frames),
	 * so onDisconnect fires exactly once and we can safely reconnect.
	 * Reconnection may miss events during the gap.
	 * TODO: refresh this.tabs from background after reconnect to stay consistent.
	 */
	private connectTabEvents() {
		try {
			this.port = chrome.runtime.connect({ name: 'tab-events' })
		} catch {
			// Extension context invalidated — cannot reconnect
			return
		}

		this.port.onMessage.addListener((message: any) => {
			if (this.disposed) return
			this.portRetries = 0

			if (message.action === 'created') {
				const tab = message.payload.tab as chrome.tabs.Tab
				// Track new tabs only if they were opened from a tab this agent manages
				// (e.g. target="_blank" links). Using openerTabId avoids stealing tabs
				// from other concurrent PageAgent instances in the same window.
				const openerIsManaged =
					tab.openerTabId != null && this.tabs.some((t) => t.id === tab.openerTabId)
				const shouldTrack =
					this.experimentalIncludeAllTabs || tab.groupId === this.tabGroupId || openerIsManaged
				if (shouldTrack && tab.id != null) {
					this.addTab({ id: tab.id, isInitial: false })
					this.switchToTab(tab.id)
				}
			} else if (message.action === 'removed') {
				const { tabId } = message.payload as { tabId: number }
				const targetTab = this.tabs.find((t) => t.id === tabId)
				if (targetTab) {
					this._handleTabRemoval(tabId)
				}
			} else if (message.action === 'updated') {
				const { tabId, changeInfo, tab } = message.payload as {
					tabId: number
					changeInfo: { groupId?: number; status?: string; url?: string; title?: string }
					tab: chrome.tabs.Tab
				}
				const targetTab = this.tabs.find((t) => t.id === tabId)
				if (targetTab) {
					targetTab.url = tab.url
					targetTab.title = tab.title
					targetTab.status = tab.status
				} else if (
					// User manually dragged a tab into the working group — start tracking it
					changeInfo.groupId != null &&
					this.tabGroupId != null &&
					changeInfo.groupId === this.tabGroupId &&
					tab.id != null &&
					isContentScriptAllowed(tab.url)
				) {
					debug('user added tab to group, tracking', tabId)
					this.addTab({ id: tabId, isInitial: false, url: tab.url, title: tab.title, status: tab.status })
					this.switchToTab(tabId)
				}
			}
		})

		this.port.onDisconnect.addListener(() => {
			this.port = undefined
			if (this.disposed) return
			if (this.portRetries >= 7) {
				console.error(PREFIX, 'tab events port failed after 7 retries, giving up')
				return
			}
			debug('port disconnected, reconnecting...')
			this.portRetries++
			this.connectTabEvents()
		})
	}

	dispose() {
		debug('dispose')
		this.disposed = true
		this.port?.disconnect()
		this.port = undefined
	}
}

export interface TabsInitOptions {
	includeInitialTab?: boolean
	experimentalIncludeAllTabs?: boolean
}

export type TabAction =
	| 'get_active_tab'
	| 'get_tab_info'
	| 'open_new_tab'
	| 'create_tab_group'
	| 'update_tab_group'
	| 'add_tab_to_group'
	| 'close_tab'
	| 'get_tab_title'
	| 'get_window_tabs'
	| 'capture_screenshot'

interface TabMeta {
	id: number
	isInitial: boolean
	url?: string
	title?: string
	status?: 'loading' | 'unloaded' | 'complete'
}

const TAB_GROUP_COLORS = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan'] as const

type TabGroupColor = (typeof TAB_GROUP_COLORS)[number]

function randomColor(): TabGroupColor {
	return TAB_GROUP_COLORS[Math.floor(Math.random() * TAB_GROUP_COLORS.length)]
}

/**
 * Wait until condition becomes true
 * @returns Returns when condition becomes true, throws otherwise
 * @param timeoutMS Timeout in milliseconds, default 1 minutes, throws error on timeout
 * @param error Error object to reject on timeout. If not provided, will resolve with false
 */
export async function waitUntil(
	check: () => boolean | Promise<boolean>,
	timeoutMS = 60_000,
	error?: string
): Promise<boolean> {
	if (await check()) return true

	return new Promise((resolve, reject) => {
		const start = Date.now()
		const poll = async () => {
			if (await check()) return resolve(true)
			if (Date.now() - start > timeoutMS) {
				if (error) {
					return reject(new Error(error))
				} else {
					return resolve(false)
				}
			}
			setTimeout(poll, 100)
		}
		setTimeout(poll, 100)
	})
}
