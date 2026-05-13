/**
 * React hook for using AgentController
 */
import type {
	AgentActivity,
	AgentStatus,
	ExecutionResult,
	HistoricalEvent,
	SupportedLanguage,
} from '@page-agent/core'
import type { LLMConfig } from '@page-agent/llms'
import { useCallback, useEffect, useRef, useState } from 'react'

import { MultiPageAgent } from './MultiPageAgent'
import { CLAUDE_BASE_URL, DEMO_CONFIG, migrateLegacyEndpoint } from './constants'

// Bump this string whenever DEMO_CONFIG changes to force a storage reset
const CONFIG_VERSION = 'claude-proxy-v2'

/** Language preference: undefined means follow system */
export type LanguagePreference = SupportedLanguage | undefined

export interface AdvancedConfig {
	maxSteps?: number
	systemInstruction?: string
	experimentalLlmsTxt?: boolean
	experimentalIncludeAllTabs?: boolean
	disableNamedToolChoice?: boolean
}

export interface ExtConfig extends LLMConfig, AdvancedConfig {
	language?: LanguagePreference
}

export interface UseAgentResult {
	status: AgentStatus
	history: HistoricalEvent[]
	activity: AgentActivity | null
	currentTask: string
	config: ExtConfig | null
	execute: (task: string) => Promise<ExecutionResult>
	stop: () => void
	configure: (config: ExtConfig) => Promise<void>
	executeBrowserOp: (operation: string, params: Record<string, unknown>) => Promise<string>
}

export function useAgent(): UseAgentResult {
	const agentRef = useRef<MultiPageAgent | null>(null)
	const [status, setStatus] = useState<AgentStatus>('idle')
	const [history, setHistory] = useState<HistoricalEvent[]>([])
	const [activity, setActivity] = useState<AgentActivity | null>(null)
	const [currentTask, setCurrentTask] = useState('')
	const [config, setConfig] = useState<ExtConfig | null>(null)

	useEffect(() => {
		chrome.storage.local
			.get(['llmConfig', 'language', 'advancedConfig', 'configVersion'])
			.then((result) => {
				// Force reset when config version changes or when using direct Anthropic URL
				const versionMismatch = result.configVersion !== CONFIG_VERSION
				const isDirectAnthropic =
					typeof (result.llmConfig as any)?.baseURL === 'string' &&
					(result.llmConfig as any).baseURL.includes('anthropic.com')

				if (versionMismatch || isDirectAnthropic) {
					console.log(
						'[useAgent] Config version mismatch or direct Anthropic URL — resetting to defaults'
					)
					chrome.storage.local.set({
						llmConfig: DEMO_CONFIG,
						advancedConfig: { disableNamedToolChoice: true },
						configVersion: CONFIG_VERSION,
					})
					setConfig({ ...DEMO_CONFIG, disableNamedToolChoice: true })
					return
				}

				let llmConfig = (result.llmConfig as LLMConfig) ?? DEMO_CONFIG
				const language = (result.language as SupportedLanguage) || undefined
				const advancedConfig = (result.advancedConfig as AdvancedConfig) ?? {}

				// Auto-migrate legacy testing endpoints
				const migrated = migrateLegacyEndpoint(llmConfig)
				if (migrated !== llmConfig) {
					llmConfig = migrated
					chrome.storage.local.set({ llmConfig: migrated, configVersion: CONFIG_VERSION })
				} else if (!result.llmConfig) {
					chrome.storage.local.set({ llmConfig: DEMO_CONFIG, configVersion: CONFIG_VERSION })
				}

				// Always enforce disableNamedToolChoice for Claude proxy setup
				const finalAdvanced = { disableNamedToolChoice: true, ...advancedConfig }
				setConfig({ ...llmConfig, ...finalAdvanced, language })
			})
	}, [])

	useEffect(() => {
		if (!config) return

		const { systemInstruction, ...agentConfig } = config
		const agent = new MultiPageAgent({
			...agentConfig,
			instructions: systemInstruction ? { system: systemInstruction } : undefined,
		})
		agentRef.current = agent

		const handleStatusChange = (e: Event) => {
			const newStatus = agent.status as AgentStatus
			setStatus(newStatus)
			if (newStatus === 'idle' || newStatus === 'completed' || newStatus === 'error') {
				setActivity(null)
			}
		}

		const handleHistoryChange = (e: Event) => {
			setHistory([...agent.history])
		}

		const handleActivity = (e: Event) => {
			const newActivity = (e as CustomEvent).detail as AgentActivity
			setActivity(newActivity)
		}

		agent.addEventListener('statuschange', handleStatusChange)
		agent.addEventListener('historychange', handleHistoryChange)
		agent.addEventListener('activity', handleActivity)

		return () => {
			agent.removeEventListener('statuschange', handleStatusChange)
			agent.removeEventListener('historychange', handleHistoryChange)
			agent.removeEventListener('activity', handleActivity)
			agent.dispose()
		}
	}, [config])

	const execute = useCallback(async (task: string) => {
		const agent = agentRef.current
		console.log('🚀 [useAgent] start executing task:', task)
		if (!agent) throw new Error('Agent not initialized')

		setCurrentTask(task)
		setHistory([])
		return agent.execute(task)
	}, [])

	const stop = useCallback(() => {
		agentRef.current?.stop()
	}, [])

	const executeBrowserOp = useCallback(
		async (operation: string, params: Record<string, unknown>): Promise<string> => {
			const agent = agentRef.current
			if (!agent) throw new Error('Agent not initialized')
			const pc = (agent as any).pageController
			if (!pc) throw new Error('PageController not available')

			// Primitive ops bypass onBeforeTask, so tabsController may not be initialized yet.
			// Init it here if needed so currentTabId is resolved before any DOM operation.
			const tc = pc.tabsController
			if (tc && tc.currentTabId === null) {
				await tc.init('browser_op', { includeInitialTab: true })
			}

			const tabId = tc?.currentTabId ?? null
			const tabUrl = tabId ? ((await chrome.tabs.get(tabId).catch(() => null))?.url ?? '') : ''
			let tabOrigin = ''
			try {
				tabOrigin = tabUrl ? new URL(tabUrl).origin : ''
			} catch {
				tabOrigin = ''
			}

			const assertSensitiveAllowed = async () => {
				const { hubAllowedOrigins, hubDenyUntil } = await chrome.storage.local.get([
					'hubAllowedOrigins',
					'hubDenyUntil',
				])
				const allowed = Array.isArray(hubAllowedOrigins) ? (hubAllowedOrigins as string[]) : []
				const denyUntil = typeof hubDenyUntil === 'number' ? hubDenyUntil : 0
				if (Date.now() < denyUntil) throw new Error('DENIED_UNTIL')
				if (!tabOrigin) throw new Error('NO_ORIGIN')
				if (!allowed.includes(tabOrigin)) throw new Error(`NOT_ALLOWED_ORIGIN: ${tabOrigin}`)
			}

			const isDisallowedKeyCombo = (
				key: string,
				modifiers?: { alt?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean }
			) => {
				const parts: string[] = []
				if (modifiers?.ctrl) parts.push('Ctrl')
				if (modifiers?.meta) parts.push('Meta')
				if (modifiers?.alt) parts.push('Alt')
				if (modifiers?.shift) parts.push('Shift')
				parts.push(key)
				const combo = parts.join('+')
				const disallowed = new Set([
					'Ctrl+L',
					'Ctrl+W',
					'Ctrl+T',
					'Ctrl+N',
					'Ctrl+R',
					'Ctrl+Shift+R',
					'Ctrl+Shift+I',
					'Ctrl+Shift+J',
					'Ctrl+Shift+C',
					'F12',
					'Alt+F4',
				])
				return disallowed.has(combo)
			}

			switch (operation) {
				case 'get_map': {
					if (pc.updateTree) await pc.updateTree()
					const state = await pc.getBrowserState()
					const { pendingUserInput } = await chrome.storage.local.get('pendingUserInput')
					const notice = pendingUserInput
						? `\n⚠️  PENDING USER INPUT — call browser_get_user_input to read it\n`
						: ''
					return `URL: ${state.url}\nTitle: ${state.title}${notice}\n${state.content}`
				}

				case 'inspect_element': {
					const { index } = params as { index: number }
					if (pc.updateTree) await pc.updateTree()
					const result = await pc.executeJavascript(`
					(function(idx) {
						function isInteractive(el) {
							return el.matches('a,button,input,select,textarea,[role="button"],[role="link"],[tabindex]')
						}
						function isVisible(el) {
							const r = el.getBoundingClientRect()
							return r.width > 0 && r.height > 0
						}
						const all = Array.from(document.querySelectorAll('*'))
							.filter(el => isInteractive(el) && isVisible(el))
						const el = all[idx - 1]
						if (!el) return JSON.stringify({ error: 'Element ' + idx + ' not found' })
						const cs = getComputedStyle(el)
						const parent = el.parentElement
						const pcs = parent ? getComputedStyle(parent) : {}
						return JSON.stringify({
							outerHTML: el.outerHTML.slice(0, 1200),
							styles: {
								background: cs.background.slice(0,80),
								color: cs.color,
								borderRadius: cs.borderRadius,
								padding: cs.padding,
								fontSize: cs.fontSize,
								fontWeight: cs.fontWeight,
								border: cs.border,
								display: cs.display,
							},
							parentLayout: {
								display: pcs.display,
								flexDirection: pcs.flexDirection,
								gap: pcs.gap,
								alignItems: pcs.alignItems,
								justifyContent: pcs.justifyContent,
								tag: parent ? parent.tagName : null,
								class: parent ? parent.className.slice(0, 80) : null,
							}
						})
					})(${index})
				`)
					return typeof result === 'string' ? result : JSON.stringify(result)
				}

				case 'open_tab': {
					const { url, timeout = 15000 } = params as { url: string; timeout?: number }
					const newTab = await chrome.tabs.create({ url, active: true })
					const tabId = newTab.id!
					await waitForTabLoad(tabId, timeout)
					// Track the new tab in tabsController and clear stale cache
					const tc2 = pc.tabsController
					if (tc2) {
						tc2.currentTabId = tabId
						await chrome.storage.local.set({ currentTabId: tabId })
						clearTabInfoCache(tc2, tabId)
					}
					return `Opened new tab ${tabId} at ${url}`
				}

				case 'navigate': {
					const { url, timeout = 15000 } = params as { url: string; timeout?: number }
					const tabId = pc.tabsController?.currentTabId
					if (tabId) {
						await chrome.tabs.update(tabId, { url })
						await waitForTabLoad(tabId, timeout)
						// Clear stale tab info cache so next get_map reads fresh URL/title
						clearTabInfoCache(pc.tabsController, tabId)
					} else {
						await pc.executeJavascript(`window.location.href = ${JSON.stringify(url)}`)
					}
					return `Navigated to ${url}`
				}

				case 'wait': {
					// Wait until a text string appears in the page map (polls every 1s)
					const { text, timeout = 15000 } = params as { text: string; timeout?: number }
					const deadline = Date.now() + timeout
					while (Date.now() < deadline) {
						try {
							if (pc.updateTree) await pc.updateTree()
							const state = await pc.getBrowserState()
							const content = `${state.url} ${state.title} ${state.content}`
							if (content.includes(text)) return `Found: "${text}"`
						} catch {
							/* ignore mid-poll errors */
						}
						await new Promise((r) => setTimeout(r, 1000))
					}
					return `Timeout: "${text}" not found within ${timeout}ms`
				}

				case 'click': {
					const { index } = params as { index: number }
					const urlBefore = tc?.currentTabId
						? ((await chrome.tabs.get(tc.currentTabId).catch(() => null))?.url ?? '')
						: ''
					const result = await pc.clickElement(index)
					if (!result || result.success === false) {
						throw new Error(result?.message || 'CLICK_FAILED')
					}
					// If click triggered navigation, clear stale tab info cache
					if (tc?.currentTabId) {
						await new Promise((r) => setTimeout(r, 800))
						const urlAfter = (await chrome.tabs.get(tc.currentTabId).catch(() => null))?.url ?? ''
						if (urlAfter && urlAfter !== urlBefore) {
							clearTabInfoCache(tc, tc.currentTabId)
						}
					}
					return `Clicked element [${index}]`
				}

				case 'type': {
					const { index, text } = params as { index: number; text: string }
					const result = await pc.inputText(index, text)
					if (!result || result.success === false) {
						throw new Error(result?.message || 'TYPE_FAILED')
					}
					return `Typed into element [${index}]`
				}

				case 'press_key': {
					await assertSensitiveAllowed()
					const { key, code, modifiers, index } = params as {
						key: string
						code?: string
						modifiers?: { alt?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean }
						index?: number
					}
					if (!key) throw new Error('INVALID_PARAMS')
					if (isDisallowedKeyCombo(key, modifiers)) throw new Error('DISALLOWED_KEY_COMBO')
					const result = await pc.pressKey({ key, code, modifiers, index })
					if (!result || result.success === false)
						throw new Error(result?.message || 'PRESS_KEY_FAILED')
					return `Pressed key (${key})`
				}

				case 'drag': {
					await assertSensitiveAllowed()
					const { start, end, steps } = params as {
						start: { x: number; y: number } | { xPct: number; yPct: number }
						end: { x: number; y: number } | { xPct: number; yPct: number }
						steps?: number
					}
					const result = await pc.drag({ start, end, steps })
					if (!result || result.success === false) throw new Error(result?.message || 'DRAG_FAILED')
					return `Dragged pointer`
				}

				case 'drag_element': {
					await assertSensitiveAllowed()
					const { fromIndex, toIndex, delta, steps } = params as {
						fromIndex: number
						toIndex?: number
						delta?: { dx: number; dy: number }
						steps?: number
					}
					const result = await pc.dragElement({ fromIndex, toIndex, delta, steps })
					if (!result || result.success === false)
						throw new Error(result?.message || 'DRAG_ELEMENT_FAILED')
					return `Dragged element [${fromIndex}]`
				}

				case 'scroll': {
					const { down = true, pages = 1 } = params as { down?: boolean; pages?: number }
					await pc.scroll({ down, numPages: pages })
					return `Scrolled ${down ? 'down' : 'up'} ${pages} page(s)`
				}

				case 'wait_for_selector': {
					// Delegates to content script MutationObserver-based wait
					const {
						selector,
						timeout = 15000,
						visible = true,
					} = params as {
						selector: string
						timeout?: number
						visible?: boolean
					}
					const result = await (pc as any).waitForSelector(selector, timeout, visible)
					return typeof result === 'string' ? result : JSON.stringify(result)
				}

				case 'reload_extension': {
					// Reload the extension itself — eliminates manual chrome://extensions refresh step.
					// After this call, the Hub WebSocket will disconnect and auto-reconnect in ~3s.
					setTimeout(() => chrome.runtime.reload(), 500)
					return 'Extension reloading in 500ms. Hub will auto-reconnect.'
				}

				case 'screenshot': {
					// Capture visible tab as compressed JPEG.
					// IMPORTANT: captureVisibleTab captures the ACTIVE tab of the specified window.
					// We must first activate the target tab, then capture, then we're done.
					const { quality = 50, maxWidth = 800 } = params as { quality?: number; maxWidth?: number }
					const tabId = tc?.currentTabId
					if (!tabId) throw new Error('No active tab to screenshot')

					// Get the window of the target tab and make it active for capture
					const targetTab = await chrome.tabs.get(tabId)
					const windowId = targetTab.windowId
					// Activate target tab so captureVisibleTab gets the right content
					await chrome.tabs.update(tabId, { active: true })
					await new Promise((r) => setTimeout(r, 150)) // brief settle

					// Capture raw PNG from browser
					const dataUrl: string = await new Promise((resolve, reject) => {
						chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, (result) => {
							if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message))
							else resolve(result)
						})
					})

					// Resize + compress to JPEG via OffscreenCanvas (MV3 compatible)
					const img = await createImageBitmap(await (await fetch(dataUrl)).blob())
					const scale = Math.min(1, maxWidth / img.width)
					const w = Math.round(img.width * scale)
					const h = Math.round(img.height * scale)
					const canvas = new OffscreenCanvas(w, h)
					const ctx = canvas.getContext('2d')!
					ctx.drawImage(img, 0, 0, w, h)
					const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: quality / 100 })
					const compressed = await new Promise<string>((resolve) => {
						const reader = new FileReader()
						reader.onload = () => resolve(reader.result as string)
						reader.readAsDataURL(blob)
					})
					return compressed // data:image/jpeg;base64,...
				}

				case 'get_user_input': {
					const result = await chrome.storage.local.get([
						'pendingUserInput',
						'pendingSelectedElement',
					])
					await chrome.storage.local.remove(['pendingUserInput', 'pendingSelectedElement'])
					return JSON.stringify({
						message: result.pendingUserInput ?? null,
						selectedElement: result.pendingSelectedElement ?? null,
					})
				}

				case 'upload_file': {
					const {
						filePath,
						fileData,
						mimeType = 'application/octet-stream',
						fileName = 'file',
						index,
					} = params as {
						filePath: string
						fileData?: string
						mimeType?: string
						fileName?: string
						index?: number
					}

					const tabId = tc?.currentTabId
					if (!tabId) throw new Error('No active tab for file upload')

					if (!filePath) throw new Error('upload_file: filePath is required')
					// Strategy 1: CDP DOM.setFileInputFiles (most reliable)
					const cdpResult = await tryUploadViaCdp(tabId, filePath)
					if (cdpResult) return `Uploaded "${fileName}" via CDP (strategy 1)`

					// Strategy 2: Clipboard paste (images only)
					if (fileData && mimeType.startsWith('image/')) {
						const clipResult = await tryUploadViaClipboard(tabId, fileData, mimeType)
						if (clipResult) return `Uploaded "${fileName}" via clipboard paste (strategy 2)`
					}

					// Strategy 3: Synthetic drop (last resort)
					if (fileData) {
						await tryUploadViaDrop(tabId, fileData, mimeType, fileName, index ?? null)
						return `Dispatched drop event for "${fileName}" (strategy 3 — isTrusted=false, may not work on strict sites)`
					}

					throw new Error('upload_file: no fileData provided and CDP strategy failed')
				}

				default:
					throw new Error(`Unknown browser operation: ${operation}`)
			}
		},
		[]
	)

	const configure = useCallback(
		async ({
			language,
			maxSteps,
			systemInstruction,
			experimentalLlmsTxt,
			experimentalIncludeAllTabs,
			disableNamedToolChoice,
			...llmConfig
		}: ExtConfig) => {
			await chrome.storage.local.set({ llmConfig })
			if (language) {
				await chrome.storage.local.set({ language })
			} else {
				await chrome.storage.local.remove('language')
			}
			const advancedConfig: AdvancedConfig = {
				maxSteps,
				systemInstruction,
				experimentalLlmsTxt,
				experimentalIncludeAllTabs,
				disableNamedToolChoice,
			}
			await chrome.storage.local.set({ advancedConfig })
			setConfig({ ...llmConfig, ...advancedConfig, language })
		},
		[]
	)

	return {
		status,
		history,
		activity,
		currentTask,
		config,
		execute,
		stop,
		configure,
		executeBrowserOp,
	}
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Wait for a tab to finish loading (status === 'complete'). */
function waitForTabLoad(tabId: number, timeout: number): Promise<void> {
	return new Promise<void>((resolve) => {
		const listener = (updatedTabId: number, info: { status?: string }) => {
			if (updatedTabId === tabId && info.status === 'complete') {
				chrome.tabs.onUpdated.removeListener(listener)
				resolve()
			}
		}
		chrome.tabs.onUpdated.addListener(listener)
		setTimeout(() => {
			chrome.tabs.onUpdated.removeListener(listener)
			resolve()
		}, timeout)
	})
}

/** Clear a tab's cached URL/title so the next getTabInfo call fetches fresh data. */
function clearTabInfoCache(tc: any, tabId: number) {
	if (!tc) return
	const tabMeta = tc.tabs?.find((t: any) => t.id === tabId)
	if (tabMeta) {
		tabMeta.url = undefined
		tabMeta.title = undefined
	}
}

// --- upload_file strategy helpers ---

/**
 * Strategy 1: CDP DOM.setFileInputFiles
 * Directly sets a local file path on any <input type="file"> via Chrome DevTools Protocol.
 * Bypasses isTrusted restrictions. Returns true on success, false if no file input found.
 */
async function tryUploadViaCdp(tabId: number, filePath: string): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		chrome.debugger.attach({ tabId }, '1.3', () => {
			if (chrome.runtime.lastError) {
				console.warn('[upload_file] CDP attach failed:', chrome.runtime.lastError.message)
				resolve(false)
				return
			}

			const detach = () => chrome.debugger.detach({ tabId }, () => {})

			chrome.debugger.sendCommand({ tabId }, 'DOM.getDocument', { depth: 0 }, (docResult: any) => {
				if (chrome.runtime.lastError || !(docResult as any)?.root?.nodeId) {
					detach()
					resolve(false)
					return
				}

				const rootNodeId: number = (docResult as any).root.nodeId

				chrome.debugger.sendCommand(
					{ tabId },
					'DOM.querySelector',
					{
						nodeId: rootNodeId,
						selector: 'input[type="file"]',
					},
					(queryResult: any) => {
						if (chrome.runtime.lastError || !(queryResult as any)?.nodeId) {
							detach()
							resolve(false)
							return
						}

						const nodeId: number = (queryResult as any).nodeId

						chrome.debugger.sendCommand(
							{ tabId },
							'DOM.setFileInputFiles',
							{
								files: [filePath],
								nodeId,
							},
							() => {
								if (chrome.runtime.lastError) {
									detach()
									resolve(false)
									return
								}

								// Dispatch change + input events so React/Vue pick up the new files
								chrome.debugger.sendCommand(
									{ tabId },
									'Runtime.evaluate',
									{
										expression: `(function(){
								const fi = document.querySelector('input[type="file"]')
								if (fi) {
									fi.dispatchEvent(new Event('change', { bubbles: true }))
									fi.dispatchEvent(new Event('input', { bubbles: true }))
								}
							})()`,
									},
									() => {
										if (chrome.runtime.lastError) {
											console.warn(
												'[upload_file] Runtime.evaluate failed:',
												chrome.runtime.lastError.message
											)
										}
										detach()
										resolve(true)
									}
								)
							}
						)
					}
				)
			})
		})
	})
}

/**
 * Strategy 2: Clipboard paste (images only).
 * Writes image bytes to the system clipboard from the content script,
 * then dispatches a paste event on the focused element.
 */
async function tryUploadViaClipboard(
	tabId: number,
	fileData: string,
	mimeType: string
): Promise<boolean> {
	try {
		const results = await chrome.scripting.executeScript({
			target: { tabId },
			world: 'ISOLATED',
			args: [fileData, mimeType] as [string, string],
			func: async (b64: string, mime: string): Promise<boolean> => {
				try {
					const byteStr = atob(b64)
					const arr = new Uint8Array(byteStr.length)
					for (let i = 0; i < byteStr.length; i++) arr[i] = byteStr.charCodeAt(i)
					const blob = new Blob([arr], { type: mime })
					await navigator.clipboard.write([new ClipboardItem({ [mime]: blob })])
					await new Promise((r) => setTimeout(r, 100))
					const target = (document.activeElement as HTMLElement) ?? document.body
					target.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true }))
					return true
				} catch {
					return false
				}
			},
		})
		return results?.[0]?.result === true
	} catch {
		return false
	}
}

/**
 * Strategy 3: Synthetic drop event (last resort).
 * Creates a real File object in the content script and dispatches drag/drop events.
 * isTrusted=false — rejected by strict sites like ChatGPT/Gemini but works on simpler sites.
 */
async function tryUploadViaDrop(
	tabId: number,
	fileData: string,
	mimeType: string,
	fileName: string,
	index: number | null
): Promise<void> {
	await chrome.scripting.executeScript({
		target: { tabId },
		world: 'ISOLATED',
		args: [fileData, mimeType, fileName, index] as [string, string, string, number | null],
		func: (b64: string, mime: string, name: string, idx: number | null) => {
			const byteStr = atob(b64)
			const arr = new Uint8Array(byteStr.length)
			for (let i = 0; i < byteStr.length; i++) arr[i] = byteStr.charCodeAt(i)
			const file = new File([arr], name, { type: mime })
			const dt = new DataTransfer()
			dt.items.add(file)

			let target: Element = document.body
			if (idx != null) {
				const interactive = Array.from(document.querySelectorAll('*')).filter((el) => {
					const r = el.getBoundingClientRect()
					return (
						r.width > 0 &&
						r.height > 0 &&
						el.matches('a,button,input,select,textarea,[role="button"],[role="link"],[tabindex]')
					)
				})
				if (interactive[idx - 1]) target = interactive[idx - 1]
			}

			for (const eventType of ['dragenter', 'dragover', 'drop'] as const) {
				target.dispatchEvent(
					new DragEvent(eventType, { bubbles: true, cancelable: true, dataTransfer: dt })
				)
			}
		},
	})
}
