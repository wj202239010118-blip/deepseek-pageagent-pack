/**
 * background logics for TabsController
 */
import type { TabAction } from './TabsController'
import { createLogger, isContentScriptAllowed, toErrorMessage } from './shared'

const PREFIX = 'TabsController.background'

const debug = createLogger(PREFIX)

const LAST_USER_TAB_KEY = 'lastUserTabId'

/** Wraps a chrome API promise, forwarding the result or a formatted error to sendResponse. */
function handleChromeResult<T>(
	promise: Promise<T>,
	transform: (result: T) => object,
	sendResponse: (response: unknown) => void,
): void {
	promise
		.then((result) => sendResponse(transform(result)))
		.catch((error) => sendResponse({ error: toErrorMessage(error) }))
}

async function getLastUserTabId(): Promise<number | null> {
	const result = await chrome.storage.local.get(LAST_USER_TAB_KEY)
	return (result[LAST_USER_TAB_KEY] as number | undefined) ?? null
}

async function setLastUserTabId(tabId: number): Promise<void> {
	await chrome.storage.local.set({ [LAST_USER_TAB_KEY]: tabId })
}

export function handleTabControlMessage(
	message: { type: 'TAB_CONTROL'; action: TabAction; payload: any },
	sender: chrome.runtime.MessageSender,
	sendResponse: (response: unknown) => void
): true | undefined {
	const { action, payload } = message

	switch (action as TabAction) {
		case 'get_active_tab': {
			debug('get_active_tab')
			;(async () => {
				try {
					// Find the Hub tab's window so we can prefer tabs in the same window
					const hubUrl = chrome.runtime.getURL('hub.html')
					const hubTabs = await chrome.tabs.query({ url: `${hubUrl}*` })
					const hubWindowId = hubTabs[0]?.windowId ?? null

					// Helper: prefer tabs in Hub's window, then any user tab
					const pickBestTab = (tabs: chrome.tabs.Tab[]) => {
						const userTabs = tabs.filter((t) => isContentScriptAllowed(t.url))
						if (hubWindowId !== null) {
							const sameWindow = userTabs.find((t) => t.windowId === hubWindowId)
							if (sameWindow) return sameWindow
						}
						return userTabs[0] ?? null
					}

					// First: active tabs across windows
					const activeTabs = await chrome.tabs.query({ active: true })
					const activeUserTab = pickBestTab(activeTabs)
					if (activeUserTab) {
						debug('get_active_tab: found active user tab', activeUserTab.id)
						sendResponse({ success: true, tab: activeUserTab })
						return
					}

					// Second: last known user tab (persisted across SW restarts)
					const lastId = await getLastUserTabId()
					if (lastId !== null) {
						try {
							const tab = await chrome.tabs.get(lastId)
							if (isContentScriptAllowed(tab.url)) {
								debug('get_active_tab: using persisted lastUserTabId', lastId)
								sendResponse({ success: true, tab })
								return
							}
						} catch {
							await chrome.storage.local.remove(LAST_USER_TAB_KEY)
						}
					}

					// Last resort: any open user tab, prefer Hub's window
					const allTabs = await chrome.tabs.query({})
					const anyUserTab = pickBestTab(allTabs)
					debug('get_active_tab: last resort tab', anyUserTab?.id)
					sendResponse({ success: true, tab: anyUserTab ?? activeTabs[0] })
				} catch (error) {
					sendResponse({ error: toErrorMessage(error) })
				}
			})()
			return true // async response
		}

		case 'get_tab_info': {
			debug('get_tab_info', payload)
			handleChromeResult(
				chrome.tabs.get(payload.tabId).then((tab) => { debug('get_tab_info: success', tab); return tab }),
				(tab) => tab as object,
				sendResponse,
			)
			return true // async response
		}

		case 'open_new_tab': {
			debug('open_new_tab', payload)
			handleChromeResult(
				chrome.tabs.create({ url: payload.url, active: false }).then((t) => { debug('open_new_tab: success', t); return t }),
				(newTab) => ({ success: true, tabId: (newTab as chrome.tabs.Tab).id }),
				sendResponse,
			)
			return true // async response
		}

		case 'create_tab_group': {
			debug('create_tab_group', payload)
			handleChromeResult(
				chrome.tabs.group({ tabIds: payload.tabIds, createProperties: { windowId: payload.windowId } })
					.then((id) => { debug('create_tab_group: success', id); return id }),
				(groupId) => ({ success: true, groupId }),
				sendResponse,
			)
			return true // async response
		}

		case 'update_tab_group': {
			debug('update_tab_group', payload)
			handleChromeResult(
				chrome.tabGroups.update(payload.groupId, payload.properties),
				() => ({ success: true }),
				sendResponse,
			)
			return true // async response
		}

		case 'add_tab_to_group': {
			debug('add_tab_to_group', payload)
			handleChromeResult(
				chrome.tabs.group({ tabIds: payload.tabId, groupId: payload.groupId }),
				() => ({ success: true }),
				sendResponse,
			)
			return true // async response
		}

		case 'close_tab': {
			debug('close_tab', payload)
			handleChromeResult(
				chrome.tabs.remove(payload.tabId),
				() => ({ success: true }),
				sendResponse,
			)
			return true // async response
		}

		case 'get_window_tabs': {
			debug('get_window_tabs', payload)
			handleChromeResult(
				chrome.tabs.query({ windowId: payload.windowId }),
				(tabs) => ({ success: true, tabs }),
				sendResponse,
			)
			return true
		}

		case 'capture_screenshot': {
			debug('capture_screenshot', payload)
			handleChromeResult(
				chrome.tabs.captureVisibleTab(payload?.windowId ?? null, {
					format: 'jpeg',
					quality: 85,
				}),
				(dataUrl) => ({ success: true, dataUrl }),
				sendResponse,
			)
			return true
		}

		default:
			sendResponse({ error: `Unknown action: ${action}` })
			return
	}
}

const tabEventPorts = new Set<chrome.runtime.Port>()

function broadcastTabEvent(message: object) {
	for (const port of tabEventPorts) {
		port.postMessage(message)
	}
}

/**
 * Port-based tab events: agents connect via `chrome.runtime.connect({ name: 'tab-events' })`
 * and receive tab change events through the port. Works for both extension pages and content scripts.
 */
export function setupTabEventsPort() {
	// Track the last user-accessible tab so get_active_tab works even when Hub is focused.
	// Persisted to storage so it survives service worker restarts (MV3 limitation).
	chrome.tabs.onActivated.addListener(({ tabId }) => {
		chrome.tabs.get(tabId).then((tab) => {
			if (isContentScriptAllowed(tab.url)) {
				setLastUserTabId(tabId)
				debug('lastUserTabId persisted', tabId, tab.url)
			}
		}).catch(() => {})
	})

	chrome.runtime.onConnect.addListener((port) => {
		if (port.name !== 'tab-events') return

		debug('port connected', port.sender?.tab?.id ?? port.sender?.url)
		tabEventPorts.add(port)

		port.onDisconnect.addListener(() => {
			debug('port disconnected')
			tabEventPorts.delete(port)
		})
	})

	chrome.tabs.onCreated.addListener((tab) => {
		broadcastTabEvent({ action: 'created', payload: { tab } })
	})

	chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
		broadcastTabEvent({ action: 'removed', payload: { tabId, removeInfo } })
	})

	chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
		broadcastTabEvent({ action: 'updated', payload: { tabId, changeInfo, tab } })
	})
}
