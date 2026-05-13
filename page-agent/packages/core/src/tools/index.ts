/**
 * Internal tools for PageAgent.
 * @note Adapted from browser-use
 */
import * as z from 'zod/v4'

import type { PageAgentCore } from '../PageAgentCore'
import { waitFor } from '../utils'

/**
 * Internal tool definition that has access to PageAgent `this` context
 */
export interface PageAgentTool<TParams = any> {
	// name: string
	description: string
	inputSchema: z.ZodType<TParams>
	execute: (this: PageAgentCore, args: TParams) => Promise<string>
}

export function tool<TParams>(options: PageAgentTool<TParams>): PageAgentTool<TParams> {
	return options
}

/**
 * Internal tools for PageAgent.
 * Note: Using any to allow different parameter types for each tool
 */
export const tools = new Map<string, PageAgentTool>()

tools.set(
	'done',
	tool({
		description:
			'Complete task. Text is your final response to the user — keep it concise unless the user explicitly asks for detail.',
		inputSchema: z.object({
			text: z.string(),
			success: z.boolean().default(true),
		}),
		execute: async function (this: PageAgentCore, input) {
			// @note main loop will handle this one
			return Promise.resolve('Task completed')
		},
	})
)

tools.set(
	'wait',
	tool({
		description: 'Wait for x seconds. Can be used to wait until the page or data is fully loaded.',
		inputSchema: z.object({
			seconds: z.number().min(1).max(10).default(1),
		}),
		execute: async function (this: PageAgentCore, input) {
			// try to subtract LLM calling time from the actual wait time
			const lastTimeUpdate = await this.pageController.getLastUpdateTime()
			const actualWaitTime = Math.max(0, input.seconds - (Date.now() - lastTimeUpdate) / 1000)
			console.log(`actualWaitTime: ${actualWaitTime} seconds`)
			await waitFor(actualWaitTime)

			return `✅ Waited for ${input.seconds} seconds.`
		},
	})
)

tools.set(
	'ask_user',
	tool({
		description:
			'Ask the user a question and wait for their answer. Use this if you need more information or clarification.',
		inputSchema: z.object({
			question: z.string(),
		}),
		execute: async function (this: PageAgentCore, input) {
			if (!this.onAskUser) {
				throw new Error('ask_user tool requires onAskUser callback to be set')
			}
			const answer = await this.onAskUser(input.question)
			return `User answered: ${answer}`
		},
	})
)

tools.set(
	'click_element_by_index',
	tool({
		description: 'Click element by index',
		inputSchema: z.object({
			index: z.int().min(0),
		}),
		execute: async function (this: PageAgentCore, input) {
			const result = await this.pageController.clickElement(input.index)
			return result.message
		},
	})
)

tools.set(
	'input_text',
	tool({
		description: 'Click and type text into an interactive input element',
		inputSchema: z.object({
			index: z.int().min(0),
			text: z.string(),
		}),
		execute: async function (this: PageAgentCore, input) {
			const result = await this.pageController.inputText(input.index, input.text)
			return result.message
		},
	})
)

tools.set(
	'select_dropdown_option',
	tool({
		description:
			'Select dropdown option for interactive element index by the text of the option you want to select',
		inputSchema: z.object({
			index: z.int().min(0),
			text: z.string(),
		}),
		execute: async function (this: PageAgentCore, input) {
			const result = await this.pageController.selectOption(input.index, input.text)
			return result.message
		},
	})
)

/**
 * @note Reference from browser-use
 */
tools.set(
	'scroll',
	tool({
		description:
			'Scroll vertically. Without index: scrolls the document. With index: scrolls the container at that index (or its nearest scrollable ancestor). Use index of a data-scrollable element to scroll a specific area.',
		inputSchema: z.object({
			down: z.boolean().default(true),
			num_pages: z.number().min(0).max(10).optional().default(0.1),
			pixels: z.number().int().min(0).optional(),
			index: z.number().int().min(0).optional(),
		}),
		execute: async function (this: PageAgentCore, input) {
			const result = await this.pageController.scroll({
				...input,
				numPages: input.num_pages,
			})
			return result.message
		},
	})
)

/**
 * @todo Tables need a dedicated parser to extract structured data. This tool is useless.
 */
tools.set(
	'scroll_horizontally',
	tool({
		description:
			'Scroll horizontally. Without index: scrolls the document. With index: scrolls the container at that index (or its nearest scrollable ancestor). Use index of a data-scrollable element to scroll a specific area.',
		inputSchema: z.object({
			right: z.boolean().default(true),
			pixels: z.number().int().min(0),
			index: z.number().int().min(0).optional(),
		}),
		execute: async function (this: PageAgentCore, input) {
			const result = await this.pageController.scrollHorizontally(input)
			return result.message
		},
	})
)

tools.set(
	'execute_javascript',
	tool({
		description:
			'Execute JavaScript code on the current page. Supports async/await syntax. Use with caution!',
		inputSchema: z.object({
			script: z.string(),
		}),
		execute: async function (this: PageAgentCore, input) {
			const result = await this.pageController.executeJavascript(input.script)
			return result.message
		},
	})
)

/**
 * Action Batching: execute multiple safe (non-navigation) actions without LLM re-evaluation.
 * Implements Stop & Re-sync on failure, static navigation_risk boundary.
 * Speed improvement: 300-500% for form-filling / sequential input tasks.
 */
tools.set(
	'execute_batch',
	tool({
		description:
			'Execute multiple SAFE actions sequentially without LLM re-evaluation between each step. ' +
			'Use for repeated input/scroll operations on the same page state. ' +
			'SAFE actions (no navigation risk): input_text, scroll, scroll_horizontally, select_dropdown_option. ' +
			'DO NOT include click_element_by_index — it may trigger navigation and must be a separate step. ' +
			'Stops immediately on first failure (Stop & Re-sync pattern) and returns status of each action.',
		inputSchema: z.object({
			actions: z
				.array(
					z.object({
						tool: z
							.enum(['input_text', 'scroll', 'scroll_horizontally', 'select_dropdown_option'])
							.describe('The tool to execute'),
						args: z.record(z.string(), z.unknown()).describe('Arguments for the tool'),
					})
				)
				.min(2)
				.max(10)
				.describe('List of 2-10 safe actions to execute in sequence'),
		}),
		execute: async function (this: PageAgentCore, input) {
			const results: string[] = []
			for (const { tool: toolName, args } of input.actions) {
				const toolDef = tools.get(toolName)
				if (!toolDef) {
					results.push(`❌ Unknown tool: ${toolName}. Batch stopped.`)
					break
				}
				try {
					const result = await toolDef.execute.call(this, args as any)
					results.push(`✅ ${toolName}: ${result}`)
				} catch (err) {
					// Stop & Re-sync: abandon remaining actions, let LLM re-decide
					results.push(`❌ ${toolName} failed: ${err instanceof Error ? err.message : String(err)}. Batch stopped — awaiting re-sync.`)
					break
				}
			}
			return results.join('\n')
		},
	})
)

/**
 * Visual grounding fallback: click an element by natural language description.
 * Uses execute_javascript internally so it works in any agent context.
 * For full VLM-powered grounding, use MultiPageAgent which adds the screenshot step.
 */
tools.set(
	'visual_click',
	tool({
		description:
			'Click a UI element described in natural language using visual positioning. ' +
			'Use as FALLBACK when click_element_by_index fails (Canvas, iframe, Shadow DOM, game UI). ' +
			'Describe what you see, e.g. "red Buy button", "close icon top-right", "submit button".',
		inputSchema: z.object({
			description: z.string().describe('Natural language description of the element to click'),
			x_pct: z.number().min(0).max(100).optional().describe('Approximate X position as % of viewport (0=left, 100=right)'),
			y_pct: z.number().min(0).max(100).optional().describe('Approximate Y position as % of viewport (0=top, 100=bottom)'),
		}),
		execute: async function (this: PageAgentCore, input) {
			// If coordinates are provided, click directly at that position
			if (input.x_pct !== undefined && input.y_pct !== undefined) {
				const script = `
					const x = ${input.x_pct} / 100 * window.innerWidth;
					const y = ${input.y_pct} / 100 * window.innerHeight;
					const el = document.elementFromPoint(x, y);
					const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };
					const target = el || document.body;
					target.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerType: 'mouse' }));
					target.dispatchEvent(new MouseEvent('mousedown', opts));
					target.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerType: 'mouse' }));
					target.dispatchEvent(new MouseEvent('mouseup', opts));
					target.dispatchEvent(new MouseEvent('click', opts));
					return 'Clicked at (' + x.toFixed(0) + ', ' + y.toFixed(0) + ') → ' + (el ? el.tagName : 'body');
				`
				const result = await this.pageController.executeJavascript(script)
				return `✅ visual_click "${input.description}": ${result.message}`
			}
			// No coordinates: instruct the agent to provide them after inspecting the screenshot
			return `⚠️ visual_click needs x_pct and y_pct coordinates. ` +
				`Take a screenshot, identify "${input.description}" position, then call visual_click again with coordinates.`
		},
	})
)

// @todo send_keys
// @todo upload_file
// @todo go_back
// @todo extract_structured_data
