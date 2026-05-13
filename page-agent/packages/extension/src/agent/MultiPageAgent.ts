import { type AgentConfig, PageAgentCore } from '@page-agent/core'
import * as z from 'zod/v4'

import { RemotePageController } from './RemotePageController'
import { TabsController } from './TabsController'
import SYSTEM_PROMPT from './system_prompt.md?raw'
import { createTabTools } from './tabTools'

/** Detect user language from browser settings */
function detectLanguage(): 'en-US' | 'zh-CN' {
	const lang = navigator.language || navigator.languages?.[0] || 'en-US'
	return lang.startsWith('zh') ? 'zh-CN' : 'en-US'
}

interface MultiPageAgentConfig extends AgentConfig {
	includeInitialTab?: boolean
	experimentalIncludeAllTabs?: boolean
}

/**
 * MultiPageAgent
 * - use with extension
 * - can be used from a side panel or a content script
 */
export class MultiPageAgent extends PageAgentCore {
	constructor(config: MultiPageAgentConfig) {
		// multi page controller
		const tabsController = new TabsController()
		const pageController = new RemotePageController(tabsController)
		const tabTools = createTabTools(tabsController)

		// Visual grounding tools: use Claude Vision + screenshot when DOM-based access fails.
		// Trigger conditions: Canvas/iframe/Shadow DOM elements not reachable via browser_get_map.
		const visualTools = {
			visual_click: {
				description:
					'Click a UI element identified by natural language description using AI vision. ' +
					'Use as FALLBACK when browser_click fails due to Canvas, iframe, or Shadow DOM. ' +
					'Example: visual_click("the red Buy button"), visual_click("close icon in the top-right")',
				inputSchema: z.object({
					description: z.string().describe('Natural language description of what to click'),
				}),
				execute: async (input: unknown) => {
					const { description } = input as { description: string }
					// 1. Capture current viewport screenshot
					const dataUrl = await pageController.captureScreenshot()
					if (!dataUrl) return '❌ Screenshot capture failed'

					// 2. Ask Claude Vision to locate the element (percentage coordinates)
					const llmConfig = (config as any).llmConfig as { baseURL?: string; apiKey?: string; model?: string } | undefined
					const baseURL = llmConfig?.baseURL ?? 'https://api.anthropic.com'
					const model = llmConfig?.model ?? 'claude-sonnet-4-6'
					const apiKey = llmConfig?.apiKey ?? ''

					const prompt = `You are a UI element locator. Given the screenshot, find "${description}".
Return ONLY valid JSON: {"xPct": <0-100>, "yPct": <0-100>}
xPct and yPct are the element center as percentage of viewport width/height (0=left/top, 100=right/bottom).
If not visible: {"xPct": -1, "yPct": -1}.`

					let coords = { xPct: -1, yPct: -1 }
					try {
						const resp = await fetch(`${baseURL}/v1/messages`, {
							method: 'POST',
							headers: {
								'Content-Type': 'application/json',
								'x-api-key': apiKey,
								'anthropic-version': '2023-06-01',
							},
							body: JSON.stringify({
								model,
								max_tokens: 64,
								messages: [{
									role: 'user',
									content: [
										{ type: 'image', source: { type: 'url', url: dataUrl } },
										{ type: 'text', text: prompt },
									],
								}],
							}),
						})
						const data = await resp.json() as { content?: { text?: string }[] }
						const text = data.content?.[0]?.text ?? ''
						const m = /\{[^}]+\}/.exec(text)
						if (m) coords = JSON.parse(m[0])
					} catch (e) {
						return `❌ Visual grounding failed: ${e instanceof Error ? e.message : String(e)}`
					}

					if (coords.xPct < 0) return `❌ Element not found in viewport: "${description}"`

					// 3. Click at the identified coordinates
					const result = await pageController.clickAtPoint(coords.xPct, coords.yPct)
					return result.success
						? `✅ Visual clicked "${description}" at (${coords.xPct.toFixed(1)}%, ${coords.yPct.toFixed(1)}%)`
						: `❌ Click failed: ${result.message}`
				},
			},
		}

		const customTools = { ...tabTools, ...visualTools }

		// system prompt - auto-detect language if not specified
		const language = config.language ?? detectLanguage()
		const targetLanguage = language === 'zh-CN' ? '中文' : 'English'
		const systemPrompt = SYSTEM_PROMPT.replace(
			/Default working language: \*\*.*?\*\*/,
			`Default working language: **${targetLanguage}**`
		)

		const includeInitialTab = config.includeInitialTab ?? true
		const experimentalIncludeAllTabs = config.experimentalIncludeAllTabs ?? false

		/**
		 * When the agent is in side-panel and user closed the side-panel.
		 * There is no chance for isAgentRunning to be set false.
		 * (unload event doesn't work well in side panel.)
		 * (I'm trying not to use long-lived connection because the lifecycle of a sw is hard to predict.)
		 * This heartbeat mechanism acts as a backup.
		 */
		let heartBeatInterval: null | number = null

		super({
			...config,
			pageController: pageController as any,
			customTools: customTools,
			customSystemPrompt: systemPrompt,

			onBeforeTask: async (agent) => {
				await tabsController.init(agent.task, { includeInitialTab, experimentalIncludeAllTabs })

				heartBeatInterval = window.setInterval(() => {
					// Self-destruct if extension context is gone (e.g. after reload)
					if (!chrome.runtime?.id) {
						if (heartBeatInterval) {
							window.clearInterval(heartBeatInterval)
							heartBeatInterval = null
						}
						return
					}
					try {
						chrome.storage.local.set({ agentHeartbeat: Date.now() })
					} catch {
						if (heartBeatInterval) {
							window.clearInterval(heartBeatInterval)
							heartBeatInterval = null
						}
					}
				}, 1_000)

				try {
					await chrome.storage.local.set({ isAgentRunning: true })
				} catch { /* context may be gone */ }
			},

			onAfterTask: async () => {
				if (heartBeatInterval) {
					window.clearInterval(heartBeatInterval)
					heartBeatInterval = null
				}

				try {
					await chrome.storage.local.set({ isAgentRunning: false })
				} catch { /* context may be gone */ }
			},

			onBeforeStep: async (agent) => {
				if (!tabsController.currentTabId) return
				// make sure the current tab is loaded before the step starts
				await tabsController.waitUntilTabLoaded(tabsController.currentTabId!)
			},

			onDispose: () => {
				if (heartBeatInterval) {
					window.clearInterval(heartBeatInterval)
					heartBeatInterval = null
				}

				try {
					chrome.storage.local.set({ isAgentRunning: false })
				} catch { /* context may be gone */ }

				tabsController.dispose()
			},
		})
	}
}
