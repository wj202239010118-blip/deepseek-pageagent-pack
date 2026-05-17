#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { exec } from 'node:child_process'
import { platform } from 'node:os'
import * as z from 'zod/v4'

import { HubBridge } from './hub-bridge.js'

// ── CLI argument parsing ─────────────────────────────────────────────────────

const args = process.argv.slice(2)
let requestedPort = null
let instanceName = 'default'

for (let i = 0; i < args.length; i++) {
	if (args[i] === '--port' || args[i] === '-p') {
		requestedPort = parseInt(args[++i], 10)
	} else if (args[i] === '--name' || args[i] === '-n') {
		instanceName = args[++i]
	} else if (args[i] === '--help' || args[i] === '-h') {
		console.error(`Usage: page-agent-mcp [options]

Options:
  --port, -p <number>   HTTP/WS port (default: env PORT or 38401)
  --name, -n <string>   Instance name for identification (default: "default")
  --help, -h            Show this help

Environment:
  PORT                  Fallback port when --port is not specified
  LLM_BASE_URL          Base URL for the LLM backend (execute_task only)
  LLM_MODEL_NAME        Model name (default: deepseek-v4-pro)
  LLM_API_KEY           API key for the LLM backend
`)
		process.exit(0)
	}
}

const env = process.env
const port = requestedPort || parseInt(env.PORT || '38401')

/** @type {Record<string, string>} */
const llmConfig = {}
if (env.LLM_BASE_URL) llmConfig.baseURL = env.LLM_BASE_URL
if (env.LLM_MODEL_NAME) llmConfig.model = env.LLM_MODEL_NAME
if (env.LLM_API_KEY) llmConfig.apiKey = env.LLM_API_KEY

// --- Hub bridge (HTTP + WebSocket) ---

const hub = new HubBridge(port)
await hub.start()

// Log the actual port after auto-resolution
console.error(`[page-agent-mcp] Instance "${instanceName}" ready on port ${hub.port}`)

// Open launcher in default browser
const url = `http://localhost:${hub.port}`
const cmd = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start ""' : 'xdg-open'
exec(`${cmd} "${url}"`, (err) => {
	if (err) console.error(`[page-agent-mcp] Could not open browser: ${err.message}`)
})

// --- MCP server (stdio) ---

const mcpServer = new McpServer({ name: `page-agent-${instanceName}`, version: '1.8.0' })

mcpServer.registerTool(
	'execute_task',
	{
		description: "Execute a task in user's browser.",
		inputSchema: {
			task: z
				.string()
				.describe(
					'Task description. Give specific instructions for the task. Steps preferable. And the information you want to get after the task is done.'
				),
		},
	},
	async ({ task }) => {
		try {
			const config = Object.keys(llmConfig).length > 0 ? llmConfig : undefined
			const result = await hub.executeTask(task, config)
			return {
				content: [
					{
						type: 'text',
						text: result.success
							? `Task completed.\n\n${result.data}`
							: `Task failed.\n\n${result.data}`,
					},
				],
			}
		} catch (err) {
			return {
				content: [{ type: 'text', text: `Error: ${err.message}` }],
				isError: true,
			}
		}
	}
)

mcpServer.registerTool(
	'get_status',
	{
		description: 'Check the current status of the Page Agent hub.',
	},
	async () => ({
		content: [
			{
				type: 'text',
				text: JSON.stringify(
					{
						connected: hub.connected,
						busy: hub.busy,
						port: hub.port,
						instance: instanceName,
					},
					null,
					2
				),
			},
		],
	})
)

mcpServer.registerTool(
	'stop_task',
	{
		description: 'Stop the currently running browser automation task.',
	},
	async () => {
		hub.stopTask()
		return { content: [{ type: 'text', text: 'Stop signal sent.' }] }
	}
)

// --- Browser primitive tools (no LLM needed in extension) ---

mcpServer.registerTool(
	'browser_get_map',
	{
		description:
			'Get a lightweight semantic map of the current browser page: URL, title, and a numbered list of all interactive elements (buttons, links, inputs). Use this as the default way to understand what is on a page. Returns ~100-200 tokens. Also reports if there is a pending user input from the extension sidebar.',
		inputSchema: {},
	},
	async () => {
		try {
			const data = await hub.executePrimitiveOp('get_map', {})
			return { content: [{ type: 'text', text: data }] }
		} catch (err) {
			return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
		}
	}
)

mcpServer.registerTool(
	'browser_inspect_element',
	{
		description:
			'Get detailed HTML and key CSS properties for a specific interactive element by its index (from browser_get_map). Returns outerHTML (trimmed), visually impactful styles (color, background, padding, borderRadius, fontSize, fontWeight, border, display), and parent container layout (display, flexDirection, gap, alignItems, justifyContent). Use this when you need to replicate a component or understand its visual structure.',
		inputSchema: {
			index: z.number().int().positive().describe('Element index as shown in browser_get_map'),
		},
	},
	async ({ index }) => {
		try {
			const data = await hub.executePrimitiveOp('inspect_element', { index })
			return { content: [{ type: 'text', text: data }] }
		} catch (err) {
			return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
		}
	}
)

mcpServer.registerTool(
	'browser_open_tab',
	{
		description:
			'Open a URL in a new browser tab and wait for it to load. Preferred over browser_navigate for sites like GitHub that block eval-based navigation.',
		inputSchema: {
			url: z.string().describe('Full URL to open in a new tab'),
			timeout: z.number().optional().describe('Load timeout ms (default 15000)'),
		},
	},
	async ({ url, timeout = 15000 }) => {
		try {
			const data = await hub.executePrimitiveOp('open_tab', { url, timeout })
			return { content: [{ type: 'text', text: data }] }
		} catch (err) {
			return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
		}
	}
)

mcpServer.registerTool(
	'browser_navigate',
	{
		description:
			'Navigate the current browser tab to a URL. Useful for opening local dev servers (e.g. localhost:3000) or any website.',
		inputSchema: {
			url: z.string().describe('Full URL to navigate to'),
			timeout: z.number().optional().describe('Load timeout ms (default 15000)'),
		},
	},
	async ({ url, timeout = 15000 }) => {
		try {
			const data = await hub.executePrimitiveOp('navigate', { url, timeout })
			return { content: [{ type: 'text', text: data }] }
		} catch (err) {
			return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
		}
	}
)

mcpServer.registerTool(
	'browser_click',
	{
		description: 'Click an interactive element by its index (from browser_get_map).',
		inputSchema: { index: z.number().int().positive().describe('Element index to click') },
	},
	async ({ index }) => {
		try {
			const data = await hub.executePrimitiveOp('click', { index })
			return { content: [{ type: 'text', text: data }] }
		} catch (err) {
			return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
		}
	}
)

mcpServer.registerTool(
	'browser_type',
	{
		description: 'Type text into an input element by its index (from browser_get_map).',
		inputSchema: {
			index: z.number().int().positive().describe('Element index to type into'),
			text: z.string().describe('Text to type'),
		},
	},
	async ({ index, text }) => {
		try {
			const data = await hub.executePrimitiveOp('type', { index, text })
			return { content: [{ type: 'text', text: data }] }
		} catch (err) {
			return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
		}
	}
)

mcpServer.registerTool(
	'browser_press_key',
	{
		description:
			'Press a keyboard key (keydown/keyup) on the active element, optionally focusing an element by its index first.',
		inputSchema: {
			key: z.string().min(1).describe('Keyboard key (e.g. "Enter", "Escape", "a")'),
			code: z.string().optional().describe('KeyboardEvent.code (optional)'),
			index: z
				.number()
				.int()
				.positive()
				.optional()
				.describe('Optional element index to focus before pressing'),
			modifiers: z
				.object({
					alt: z.boolean().optional(),
					ctrl: z.boolean().optional(),
					meta: z.boolean().optional(),
					shift: z.boolean().optional(),
				})
				.optional()
				.describe('Optional modifier keys'),
		},
	},
	async ({ key, code, index, modifiers }) => {
		try {
			const data = await hub.executePrimitiveOp('press_key', { key, code, index, modifiers })
			return { content: [{ type: 'text', text: data }] }
		} catch (err) {
			return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
		}
	}
)

mcpServer.registerTool(
	'browser_drag',
	{
		description:
			'Drag the mouse pointer from a start point to an end point. Coordinates can be absolute pixels {x,y} or viewport percentages {xPct,yPct}.',
		inputSchema: {
			start: z
				.union([
					z.object({ x: z.number(), y: z.number() }),
					z.object({ xPct: z.number(), yPct: z.number() }),
				])
				.describe('Drag start point'),
			end: z
				.union([
					z.object({ x: z.number(), y: z.number() }),
					z.object({ xPct: z.number(), yPct: z.number() }),
				])
				.describe('Drag end point'),
			steps: z
				.number()
				.int()
				.min(1)
				.max(100)
				.optional()
				.describe('Number of move steps (default 12)'),
		},
	},
	async ({ start, end, steps }) => {
		try {
			const data = await hub.executePrimitiveOp('drag', { start, end, steps })
			return { content: [{ type: 'text', text: data }] }
		} catch (err) {
			return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
		}
	}
)

mcpServer.registerTool(
	'browser_scroll',
	{
		description: 'Scroll the current page up or down.',
		inputSchema: {
			down: z.boolean().describe('true to scroll down, false to scroll up'),
			pages: z.number().optional().describe('Number of page heights to scroll (default 1)'),
		},
	},
	async ({ down, pages = 1 }) => {
		try {
			const data = await hub.executePrimitiveOp('scroll', { down, pages })
			return { content: [{ type: 'text', text: data }] }
		} catch (err) {
			return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
		}
	}
)

mcpServer.registerTool(
	'browser_get_user_input',
	{
		description:
			'Read a pending message that the user typed in the extension sidebar\'s "发送给 Claude" input box. Returns the message and any selected element. Returns null message if no input is pending. Call this when browser_get_map shows a PENDING USER INPUT notice, or proactively to check for user instructions.',
		inputSchema: {},
	},
	async () => {
		try {
			const data = await hub.executePrimitiveOp('get_user_input', {})
			return { content: [{ type: 'text', text: data }] }
		} catch (err) {
			return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
		}
	}
)

mcpServer.registerTool(
	'browser_reload_extension',
	{
		description:
			'Reload the Chrome extension itself. Use this after building new extension code to apply changes without manual chrome://extensions refresh. Hub will auto-reconnect in ~3 seconds after reload.',
		inputSchema: {},
	},
	async () => {
		try {
			const data = await hub.executePrimitiveOp('reload_extension', {})
			return { content: [{ type: 'text', text: data }] }
		} catch (err) {
			return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
		}
	}
)

mcpServer.registerTool(
	'browser_screenshot',
	{
		description:
			'Capture a screenshot of the current browser tab as a compressed JPEG image. Returns base64-encoded image data. Use this to visually verify page state, debug layout issues, or understand what is actually rendered on screen.',
		inputSchema: {
			quality: z
				.number()
				.optional()
				.describe('JPEG quality 1-100 (default 50). Lower = smaller file.'),
			maxWidth: z
				.number()
				.optional()
				.describe('Max image width in pixels (default 800). Image is downscaled proportionally.'),
		},
	},
	async ({ quality = 50, maxWidth = 800 }) => {
		try {
			const dataUrl = await hub.executePrimitiveOp('screenshot', { quality, maxWidth })
			// Return as image content so Claude can see it visually
			const base64 = dataUrl.replace(/^data:image\/jpeg;base64,/, '')
			return {
				content: [
					{ type: 'text', text: `Screenshot captured (${maxWidth}px wide, quality ${quality}%)` },
					{ type: 'image', data: base64, mimeType: 'image/jpeg' },
				],
			}
		} catch (err) {
			return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
		}
	}
)

mcpServer.registerTool(
	'browser_wait_for_selector',
	{
		description:
			'Wait for a CSS selector to appear and be visible in the page. Uses MutationObserver for efficiency — returns immediately when found, no unnecessary polling. Use after navigation or click when you know a specific element will appear.',
		inputSchema: {
			selector: z
				.string()
				.describe('CSS selector to wait for (e.g. "button.submit", "#result", "[data-loaded]")'),
			timeout: z.number().optional().describe('Max wait time in ms (default 15000)'),
			visible: z
				.boolean()
				.optional()
				.describe('Also check element is visible/has size (default true)'),
		},
	},
	async ({ selector, timeout = 15000, visible = true }) => {
		try {
			const data = await hub.executePrimitiveOp('wait_for_selector', { selector, timeout, visible })
			return { content: [{ type: 'text', text: data }] }
		} catch (err) {
			return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
		}
	}
)

mcpServer.registerTool(
	'browser_wait',
	{
		description:
			'Wait until a specific text string appears in the current page content. Useful after navigation or clicking to wait for the page to update before proceeding. Polls every second.',
		inputSchema: {
			text: z.string().describe('Text to wait for in the page (URL, title, or visible content)'),
			timeout: z.number().optional().describe('Maximum wait time in milliseconds (default 15000)'),
		},
	},
	async ({ text, timeout = 15000 }) => {
		try {
			const data = await hub.executePrimitiveOp('wait', { text, timeout })
			return { content: [{ type: 'text', text: data }] }
		} catch (err) {
			return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
		}
	}
)

// --- File upload tool ---

function getMimeType(filePath) {
	const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
	const map = {
		png: 'image/png',
		jpg: 'image/jpeg',
		jpeg: 'image/jpeg',
		gif: 'image/gif',
		webp: 'image/webp',
		svg: 'image/svg+xml',
		pdf: 'application/pdf',
		txt: 'text/plain',
		md: 'text/markdown',
		csv: 'text/csv',
		json: 'application/json',
		js: 'text/javascript',
		ts: 'text/typescript',
		html: 'text/html',
		css: 'text/css',
		zip: 'application/zip',
		doc: 'application/msword',
		docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	}
	return map[ext] ?? 'application/octet-stream'
}

mcpServer.registerTool(
	'browser_upload_file',
	{
		description:
			'Upload a local file to the current browser tab. Works with AI chat interfaces (ChatGPT, Gemini) and standard HTML file inputs. Tries three strategies in order: (1) CDP DOM.setFileInputFiles — most reliable, works on any hidden <input type="file">; (2) clipboard paste — for images on AI chat interfaces; (3) synthetic drop event — last resort. Provide index if you know which upload button/zone to target (from browser_get_map).',
		inputSchema: {
			filePath: z
				.string()
				.describe('Absolute local file path to upload (e.g. "C:\\\\Users\\\\me\\\\photo.png")'),
			index: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(
					'Optional element index from browser_get_map — the upload button or drop zone to target'
				),
		},
	},
	async ({ filePath, index }) => {
		try {
			const { readFileSync } = await import('node:fs')
			const { basename } = await import('node:path')
			const fileBuffer = readFileSync(filePath)
			const fileData = fileBuffer.toString('base64')
			const fileName = basename(filePath)
			const mimeType = getMimeType(filePath)

			const result = await hub.executePrimitiveOp(
				'upload_file',
				{ filePath, fileData, mimeType, fileName, index },
				60000
			)
			return { content: [{ type: 'text', text: result }] }
		} catch (err) {
			return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
		}
	}
)

const transport = new StdioServerTransport()
await mcpServer.connect(transport)
console.error(`[page-agent-mcp] MCP server ready (stdio) — instance "${instanceName}"`)
