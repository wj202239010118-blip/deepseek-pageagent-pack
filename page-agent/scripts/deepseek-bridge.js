#!/usr/bin/env node
/**
 * deepseek-bridge.js — Persistent MCP bridge daemon for DeepSeek TUI
 *
 * Spawns the Page Agent MCP server as a child process, manages handshake,
 * and exposes a minimal HTTP API so DeepSeek TUI can invoke browser tools
 * via simple curl calls.
 *
 * HTTP API (localhost:38406):
 *   GET  /health          → {"ok":true,"connected":bool,"busy":bool}
 *   POST /execute         → body: {"tool":"browser_open_tab","args":{"url":"..."}}
 *   POST /stop            → stop current task
 *
 * Start:
 *   node scripts/deepseek-bridge.js
 *
 * Env vars:
 *   BRIDGE_PORT    — HTTP listen port (default 38406)
 *   MCP_PORT       — MCP server internal port (default 38405)
 *   LLM_BASE_URL, LLM_API_KEY, LLM_MODEL_NAME (optional, for execute_task)
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MCP_SERVER = resolve(__dirname, '..', 'packages', 'mcp', 'src', 'index.js')
const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT || '38406')
const MCP_PORT = process.env.MCP_PORT || '38405'
const MCP_START_TIMEOUT = 60_000
const TOOL_TIMEOUT = 120_000

// ---- MCP child process management ----

let child = null
let rl = null
let initialized = false
let requestId = 0
let pending = null // { resolve, reject, timer }

function startMcp() {
	return new Promise((resolve, reject) => {
		const env = {
			...process.env,
			PORT: MCP_PORT,
		}

		child = spawn('node', [MCP_SERVER], {
			env,
			stdio: ['pipe', 'pipe', 'pipe'],
			cwd: resolve(__dirname, '..'),
		})

		child.stderr.on('data', (d) => process.stderr.write(`[mcp] ${d}`))

		const startTimer = setTimeout(() => {
			reject(new Error('MCP server start timed out'))
		}, MCP_START_TIMEOUT)

		rl = createInterface({ input: child.stdout })

		let initDone = false

		rl.on('line', (line) => {
			let msg
			try {
				msg = JSON.parse(line)
			} catch {
				return
			}

			if (!initDone) {
				// Complete MCP handshake
				if (msg.id === 0 && msg.result) {
					initDone = true
					clearTimeout(startTimer)
					initialized = true

					// Send initialized notification
					sendMcp({ jsonrpc: '2.0', method: 'notifications/initialized' })

					// Wait for hub to connect by polling get_status
					pollHubConnection().then(resolve).catch(reject)
					return
				}
			}

			// Handle tool call responses
			if (msg.id === requestId && pending) {
				const p = pending
				pending = null
				clearTimeout(p.timer)

				if (msg.error) {
					p.reject(new Error(msg.error.message || 'Unknown MCP error'))
				} else {
					const content = msg.result?.content
					if (content && Array.isArray(content)) {
						const texts = content
							.filter((c) => c.type === 'text')
							.map((c) => c.text)
							.join('\n')
						p.resolve(texts)
					} else {
						p.resolve(JSON.stringify(msg.result))
					}
				}
			}
		})

		child.on('error', (err) => {
			clearTimeout(startTimer)
			initialized = false
			reject(err)
		})

		child.on('exit', (code) => {
			initialized = false
			if (rl) rl.close()
		})

		// Send initialize
		sendMcp({
			jsonrpc: '2.0',
			id: 0,
			method: 'initialize',
			params: {
				protocolVersion: '2024-11-05',
				capabilities: {},
				clientInfo: { name: 'deepseek-tui', version: '1.0' },
			},
		})
	})
}

function sendMcp(msg) {
	if (!child || child.killed) return
	const line = JSON.stringify(msg) + '\n'
	child.stdin.write(line)
}

async function pollHubConnection() {
	for (let i = 0; i < 30; i++) {
		try {
			const result = await callMcpTool('get_status', {})
			const status = JSON.parse(result)
			if (status.connected) {
				console.error('[bridge] Hub connected')
				return
			}
		} catch {
			// Still waiting
		}
		await sleep(2000)
	}
	throw new Error('Hub did not connect within 60s. Is the extension loaded in Chrome?')
}

function callMcpTool(name, args = {}) {
	return new Promise((resolve, reject) => {
		if (!initialized) {
			reject(new Error('MCP server not initialized'))
			return
		}
		if (pending) {
			reject(new Error('Another tool call is in progress'))
			return
		}

		requestId++
		const id = requestId
		const timer = setTimeout(() => {
			pending = null
			reject(new Error(`Tool '${name}' timed out after ${TOOL_TIMEOUT / 1000}s`))
		}, TOOL_TIMEOUT)

		pending = { resolve, reject, timer }

		sendMcp({
			jsonrpc: '2.0',
			id,
			method: 'tools/call',
			params: { name, arguments: args },
		})
	})
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms))
}

// ---- HTTP server ----

function jsonResponse(res, status, data) {
	res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
	res.end(JSON.stringify(data))
}

async function readBody(req) {
	const chunks = []
	for await (const chunk of req) chunks.push(chunk)
	return Buffer.concat(chunks).toString('utf-8')
}

const httpServer = createServer(async (req, res) => {
	const url = new URL(req.url ?? '/', `http://localhost:${BRIDGE_PORT}`)
	const path = url.pathname

	try {
		if (path === '/health') {
			jsonResponse(res, 200, {
				ok: true,
				initialized,
				port: BRIDGE_PORT,
				mcpPort: MCP_PORT,
			})
			return
		}

		if (path === '/execute' && req.method === 'POST') {
			const body = await readBody(req)
			let params
			try {
				params = JSON.parse(body)
			} catch {
				jsonResponse(res, 400, { error: 'Invalid JSON body' })
				return
			}

			const { tool, args } = params
			if (!tool) {
				jsonResponse(res, 400, { error: 'Missing "tool" field' })
				return
			}

			console.error(`[bridge] Executing: ${tool}`)
			const result = await callMcpTool(tool, args || {})
			console.error(`[bridge] Done: ${tool}`)
			jsonResponse(res, 200, { success: true, data: result })
			return
		}

		if (path === '/stop' && req.method === 'POST') {
			try {
				await callMcpTool('stop_task', {})
			} catch {
				// stop_task may fail if nothing is running; ignore
			}
			jsonResponse(res, 200, { success: true })
			return
		}

		jsonResponse(res, 404, { error: 'Not found' })
	} catch (err) {
		console.error(`[bridge] Error: ${err.message}`)
		jsonResponse(res, 500, { error: err.message })
	}
})

// ---- Main ----

console.error(`[bridge] Starting MCP server on port ${MCP_PORT}...`)
startMcp()
	.then(() => {
		console.error('[bridge] MCP server ready, hub connected.')
		httpServer.listen(BRIDGE_PORT, '127.0.0.1', () => {
			console.error(`[bridge] HTTP API listening on http://127.0.0.1:${BRIDGE_PORT}`)
		})
	})
	.catch((err) => {
		console.error(`[bridge] Failed to start: ${err.message}`)
		process.exit(1)
	})

// Graceful shutdown
process.on('SIGINT', () => {
	console.error('[bridge] Shutting down...')
	if (rl) rl.close()
	if (child && !child.killed) child.kill()
	httpServer.close()
	process.exit(0)
})
