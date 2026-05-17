import { handlePageControlMessage } from '@/agent/RemotePageController.background'
import { handleTabControlMessage, setupTabEventsPort } from '@/agent/TabsController.background'

function isInjectableUrl(url: string | undefined): boolean {
	if (!url) return false
	return url.startsWith('http://') || url.startsWith('https://')
}

export default defineBackground(() => {
	console.log('[Background] Service Worker started')

	// After extension reload: reopen Hub tab and re-inject content scripts.
	// Chrome closes all extension pages and does NOT re-inject content scripts automatically.
	chrome.runtime.onInstalled.addListener(async () => {
		// 1. Reopen Hub tabs for all previously active ports (fallback to default 38401)
		const { hubWsPorts } = await chrome.storage.local.get('hubWsPorts')
		const ports: number[] = Array.isArray(hubWsPorts) && hubWsPorts.length > 0
			? hubWsPorts
			: [38401]
		for (const port of ports) {
			await openOrFocusHubTab(port).catch(() => {})
		}

		// 2. Re-inject content script only into tabs in the currently focused window.
		//    Injecting ALL windows causes stale instance accumulation and error floods.
		const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
		const windowId = activeTab?.windowId
		if (!windowId) return

		const tabs = await chrome.tabs.query({ windowId })
		for (const tab of tabs) {
			if (!tab.id || !isInjectableUrl(tab.url)) continue
			// First try calling main() if content IIFE already ran (avoids full re-injection).
			chrome.scripting.executeScript({
				target: { tabId: tab.id },
				func: () => { if (typeof (globalThis as any).content?.main === 'function') { (globalThis as any).content.main(); return true } return false },
			}).then((results) => {
				if (results?.[0]?.result === false) {
					// content IIFE hasn't run — do full file injection then call main()
					return chrome.scripting.executeScript({ target: { tabId: tab.id! }, files: ['content-scripts/content.js'] })
						.then(() => chrome.scripting.executeScript({
							target: { tabId: tab.id! },
							func: () => { if (typeof (globalThis as any).content?.main === 'function') (globalThis as any).content.main() },
						}))
				}
			}).catch(() => {})
		}
	})

	// tab change events

	setupTabEventsPort()

	chrome.commands.onCommand.addListener(async (command) => {
		if (command === 'page-agent-toggle-origin-allow') {
			const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
			const url = tab?.url ?? ''
			if (!url) return
			let origin: string
			try { origin = new URL(url).origin } catch { return }
			const { hubAllowedOrigins } = await chrome.storage.local.get('hubAllowedOrigins')
			const list = Array.isArray(hubAllowedOrigins) ? (hubAllowedOrigins as string[]) : []
			const next = list.includes(origin) ? list.filter((o) => o !== origin) : [...list, origin]
			await chrome.storage.local.set({ hubAllowedOrigins: next })
		} else if (command === 'page-agent-panic-stop') {
			await chrome.storage.local.set({ hubDenyUntil: Date.now() + 60_000 })
		}
	})

	// generate user auth token

	chrome.storage.local.get('PageAgentExtUserAuthToken').then((result) => {
		if (result.PageAgentExtUserAuthToken) return

		const userAuthToken = crypto.randomUUID()
		chrome.storage.local.set({ PageAgentExtUserAuthToken: userAuthToken })
	})

	// message proxy

	chrome.runtime.onMessage.addListener((message, sender, sendResponse): true | undefined => {
		if (message.type === 'TAB_CONTROL') {
			return handleTabControlMessage(message, sender, sendResponse)
		} else if (message.type === 'PAGE_CONTROL') {
			return handlePageControlMessage(message, sender, sendResponse)
		} else {
			sendResponse({ error: 'Unknown message type' })
			return
		}
	})

	// external messages (from localhost launcher page via externally_connectable)

	chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
		if (message.type === 'OPEN_HUB') {
			openOrFocusHubTab(message.wsPort).then(() => {
				if (sender.tab?.id) chrome.tabs.remove(sender.tab.id)
				sendResponse({ ok: true })
			})
			return true
		}
	})

	// setup

	chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})
})

async function openOrFocusHubTab(wsPort: number) {
	// Persist all active ports so onInstalled can reopen them after extension reload
	const { hubWsPorts } = await chrome.storage.local.get('hubWsPorts')
	const ports: number[] = Array.isArray(hubWsPorts) ? hubWsPorts : []
	if (!ports.includes(wsPort)) {
		ports.push(wsPort)
		await chrome.storage.local.set({ hubWsPorts: ports })
	}

	const hubUrl = chrome.runtime.getURL('hub.html')
	const targetUrl = `${hubUrl}?ws=${wsPort}`

	// Look for an existing hub tab for this specific port
	const existing = await chrome.tabs.query({ url: targetUrl })

	if (existing.length > 0 && existing[0].id) {
		// Already open — just focus it
		await chrome.tabs.update(existing[0].id, { active: true })
		return
	}

	// Create a new hub tab for this port
	await chrome.tabs.create({ url: targetUrl, pinned: true })
}
