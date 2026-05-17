import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'

const EXT_ID = 'akldabonmimlicnjlflnapfeklbfemhj'
const STORE_URL = `https://chromewebstore.google.com/detail/page-agent-ext/${EXT_ID}`
const LOOPBACK_HOST = 'localhost'

const launcherTemplate = readFileSync(
	fileURLToPath(new URL('./launcher.html', import.meta.url)),
	'utf-8'
)

// ── Port resolution ──────────────────────────────────────────────────────────

/**
 * Probe a port by briefly binding a TCP server.
 * Returns the resolved port (may differ from `preferred` if it was taken).
 *
 * Strategy:
 *   1. Try `preferred`
 *   2. If busy, try `preferred + 1 … preferred + maxTries`
 *   3. If all taken, let the OS pick any free port
 */
export async function findFreePort(preferred, maxTries = 20) {
	return new Promise((resolve, reject) => {
		const attempt = (port) => {
			const srv = createServer()
			const cleanup = () => {
				srv.removeAllListeners()
				srv.close()
			}
			srv.on('error', (err) => {
				cleanup()
				if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
					const next = port + 1
					if (next < preferred + maxTries) {
						attempt(next)
					} else {
						// Last resort — OS-assigned
						const fallback = createServer()
						fallback.on('error', reject)
						fallback.listen(0, LOOPBACK_HOST, () => {
							const p = fallback.address().port
							fallback.close(() => resolve(p))
						})
					}
				} else {
					reject(err)
				}
			})
			srv.on('listening', () => {
				const p = srv.address().port
				cleanup()
				resolve(p)
			})
			srv.listen(port, LOOPBACK_HOST)
		}
		attempt(preferred)
	})
}

// ── HubBridge ────────────────────────────────────────────────────────────────

/**
 * HTTP + WebSocket bridge to the hub.html extension tab.
 * - HTTP serves the launcher page (triggers extension to open hub)
 * - WS carries execute/stop commands and result/error responses
 */
export class HubBridge {
	/** @type {number} */
	port

	/** @type {http.Server} */
	#httpServer

	/** @type {WebSocketServer} */
	#wss

	/** @type {import('ws').WebSocket | null} */
	#hub = null

	/** @type {{ resolve: (r: {success: boolean, data: string}) => void, reject: (e: Error) => void } | null} */
	#pendingTask = null

	/** @type {Map<string, { resolve: (data: string) => void, reject: (e: Error) => void }>} */
	#pendingOps = new Map()

	/** @param {number} port */
	constructor(port) {
		this.port = port
		this.#httpServer = http.createServer((req, res) => {
			this.#handleHttp(req, res).catch((err) => {
				res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
				res.end(`Internal error: ${err instanceof Error ? err.message : String(err)}`)
			})
		})
		this.#wss = new WebSocketServer({ server: this.#httpServer })
		this.#wss.on('connection', (ws) => this.#onConnection(ws))
	}

	async #handleHttp(req, res) {
		const url = new URL(req.url ?? '/', `http://${LOOPBACK_HOST}:${this.port}`)
		const path = url.pathname

		if (path === '/' || path === '/index.html') {
			const html = launcherTemplate
				.replaceAll('__EXT_ID__', EXT_ID)
				.replaceAll('__STORE_URL__', STORE_URL)
				.replaceAll('__WS_PORT__', String(this.port))
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
			res.end(html)
			return
		}

		if (path === '/fixtures/frame-boundary' || path === '/fixtures/frame-boundary.html') {
			const filePath = fileURLToPath(new URL('../fixtures/frame-boundary.html', import.meta.url))
			const buf = await readFile(filePath)
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
			res.end(buf)
			return
		}

		if (path === '/health') {
			res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
			res.end(JSON.stringify({ ok: true, port: this.port }))
			return
		}

		res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
		res.end('Not found')
	}

	/** @returns {Promise<void>} */
	async start() {
		// Ask the port-finder to pick a free port if `this.port` is busy
		const resolved = await findFreePort(this.port)
		this.port = resolved

		return new Promise((resolve, reject) => {
			this.#httpServer.on('error', (/** @type {NodeJS.ErrnoException} */ err) => {
				reject(err)
			})
			this.#httpServer.listen(this.port, LOOPBACK_HOST, () => {
				console.error(`[page-agent-mcp] HTTP + WS on http://${LOOPBACK_HOST}:${this.port}`)
				resolve()
			})
		})
	}

	get connected() {
		return this.#hub?.readyState === 1
	}

	get busy() {
		return this.#pendingTask !== null
	}

	/**
	 * @param {string} task
	 * @param {Record<string, unknown>} [config]
	 * @returns {Promise<{success: boolean, data: string}>}
	 */
	async executeTask(task, config) {
		if (!this.connected) throw new Error('Hub is not connected. Is the extension running?')
		if (this.#pendingTask) throw new Error('Agent is already running a task.')

		return new Promise((resolve, reject) => {
			this.#pendingTask = { resolve, reject }
			this.#hub.send(JSON.stringify({ type: 'execute', task, config }))
		})
	}

	stopTask() {
		if (this.connected) {
			this.#hub.send(JSON.stringify({ type: 'stop' }))
		}
	}

	/**
	 * Execute a low-level browser primitive operation (no LLM involved).
	 * @param {string} operation - e.g. 'get_map', 'click', 'type', 'navigate', 'scroll', 'inspect_element', 'get_user_input'
	 * @param {Record<string, unknown>} [params]
	 * @param {number} [timeout=30000]
	 * @returns {Promise<string>}
	 */
	executePrimitiveOp(operation, params = {}, timeout = 30000) {
		if (!this.connected) throw new Error('Hub is not connected. Is the extension running?')

		const id = Math.random().toString(36).slice(2)
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pendingOps.delete(id)
				reject(new Error(`browser_op '${operation}' timed out after ${timeout}ms`))
			}, timeout)

			this.#pendingOps.set(id, {
				operation,
				resolve: (data) => { clearTimeout(timer); resolve(data) },
				reject: (err) => { clearTimeout(timer); reject(err) },
			})

			this.#hub.send(JSON.stringify({ type: 'browser_op', id, operation, params }))
		})
	}

	// TODO: Add version checking

	/** @param {import('ws').WebSocket} ws */
	#onConnection(ws) {
		if (this.#hub && this.#hub.readyState === 1) {
			ws.close(4000, 'Another hub is already connected')
			return
		}

		this.#hub = ws
		console.error(`[page-agent-mcp] Hub connected (port ${this.port})`)

		ws.on('message', (/** @type {Buffer} */ rawData) => {
			/** @type {{ type: string, success?: boolean, data?: string, message?: string }} */
			let msg
			try {
				msg = JSON.parse(rawData.toString('utf-8'))
			} catch {
				return
			}

			if (msg.type === 'result') {
				this.#pendingTask?.resolve({ success: msg.success ?? false, data: msg.data ?? '' })
				this.#pendingTask = null
			} else if (msg.type === 'error') {
				this.#pendingTask?.reject(new Error(msg.message ?? 'Unknown error from hub'))
				this.#pendingTask = null
			} else if (msg.type === 'browser_op_result') {
				const pending = this.#pendingOps.get(msg.id)
				if (pending) {
					this.#pendingOps.delete(msg.id)
					if (msg.success) {
						pending.resolve(msg.data ?? '')
					} else {
						const raw = typeof msg.error === 'string' ? msg.error : ''
						const errorText = raw.trim() ? raw : 'browser_op failed (no error message)'
						pending.reject(new Error(`[${pending.operation}] ${errorText}`))
					}
				}
			}
		})

		ws.on('close', () => {
			console.error(`[page-agent-mcp] Hub disconnected (port ${this.port})`)
			if (this.#hub === ws) this.#hub = null
			if (this.#pendingTask) {
				this.#pendingTask.reject(new Error('Hub disconnected while task was running'))
				this.#pendingTask = null
			}
		})
	}
}
