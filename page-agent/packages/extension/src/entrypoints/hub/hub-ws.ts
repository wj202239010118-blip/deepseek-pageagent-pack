/**
 * Hub WebSocket Protocol
 *
 * Hub connects as WS client to `ws://localhost:{port}`.
 * All messages are JSON. One task at a time.
 *
 * Inbound (Caller → Hub):
 *   { type: "execute", task: string, config?: object }
 *   { type: "stop" }
 *
 * Outbound (Hub → Caller):
 *   { type: "ready" }
 *   { type: "result", success: boolean, data: string }
 *   { type: "error", message: string }
 */
import type { ExecutionResult } from '@page-agent/core'
import { useEffect, useRef, useState } from 'react'

import type { ExtConfig } from '@/agent/useAgent'

// --- Protocol types ---

interface ExecuteMessage {
	type: 'execute'
	task: string
	config?: Record<string, unknown>
}

interface StopMessage {
	type: 'stop'
}

interface BrowserOpMessage {
	type: 'browser_op'
	id: string
	operation: string
	params: Record<string, unknown>
}

type InboundMessage = ExecuteMessage | StopMessage | BrowserOpMessage

interface ReadyMessage {
	type: 'ready'
}

interface ResultMessage {
	type: 'result'
	success: boolean
	data: string
}

interface ErrorMessage {
	type: 'error'
	message: string
}

interface BrowserOpResultMessage {
	type: 'browser_op_result'
	id: string
	success: boolean
	data?: string
	error?: string
}

type OutboundMessage = ReadyMessage | ResultMessage | ErrorMessage | BrowserOpResultMessage

export type HubWsState = 'connecting' | 'connected' | 'disconnected'

// --- HubWs class ---

export interface HubWsHandlers {
	onExecute: (
		task: string,
		config?: Record<string, unknown>
	) => Promise<{ success: boolean; data: string }>
	onStop: () => void
	onBrowserOp: (operation: string, params: Record<string, unknown>) => Promise<string>
}

/**
 * Framework-agnostic WebSocket client for Hub.
 * Connects to an external WS server, receives tasks, dispatches to handlers,
 * and sends results back. No React, no DOM.
 */
export class HubWs {
	#ws: WebSocket | null = null
	#state: HubWsState = 'disconnected'
	#busy = false
	#approved = false
	#handlers: HubWsHandlers
	#port: number
	#onStateChange: (state: HubWsState) => void
	#reconnectTimer: ReturnType<typeof setTimeout> | null = null
	#destroyed = false

	constructor(port: number, handlers: HubWsHandlers, onStateChange: (state: HubWsState) => void) {
		this.#port = port
		this.#handlers = handlers
		this.#onStateChange = onStateChange
	}

	get state() {
		return this.#state
	}

	get busy() {
		return this.#busy
	}

	connect() {
		if (this.#ws) return
		this.#setState('connecting')

		const ws = new WebSocket(`ws://localhost:${this.#port}`)
		this.#ws = ws

		ws.addEventListener('open', () => {
			this.#setState('connected')
			this.#send({ type: 'ready' })
		})

		ws.addEventListener('close', () => {
			this.#ws = null
			this.#busy = false
			this.#approved = false
			this.#setState('disconnected')
			// Auto-reconnect after 3 seconds unless explicitly disconnected
			if (!this.#destroyed) {
				this.#reconnectTimer = setTimeout(() => {
					if (!this.#destroyed) this.connect()
				}, 3000)
			}
		})

		ws.addEventListener('error', () => {
			// close event will fire after error, which handles reconnect
		})

		ws.addEventListener('message', (event) => {
			this.#handleMessage(event.data as string)
		})
	}

	disconnect() {
		this.#destroyed = true
		if (this.#reconnectTimer) {
			clearTimeout(this.#reconnectTimer)
			this.#reconnectTimer = null
		}
		this.#ws?.close()
		this.#ws = null
		this.#busy = false
		this.#approved = false
		this.#setState('disconnected')
	}

	#setState(state: HubWsState) {
		if (this.#state === state) return
		this.#state = state
		this.#onStateChange(state)
	}

	#send(msg: OutboundMessage) {
		if (this.#ws?.readyState === WebSocket.OPEN) {
			this.#ws.send(JSON.stringify(msg))
		}
	}

	async #handleMessage(raw: string) {
		let msg: InboundMessage
		try {
			msg = JSON.parse(raw)
		} catch {
			return
		}

		if (!(await this.#checkApproval())) {
			this.#send({ type: 'error', message: 'User denied the connection request.' })
			return
		}

		switch (msg.type) {
			case 'execute':
				this.#handleExecute(msg)
				break
			case 'stop':
				this.#handlers.onStop()
				break
			case 'browser_op':
				this.#handleBrowserOp(msg)
				break
		}
	}

	async #checkApproval(): Promise<boolean> {
		if (this.#approved) return true

		const { allowAllHubConnection } = await chrome.storage.local.get('allowAllHubConnection')
		if (allowAllHubConnection === true) {
			this.#approved = true
			return true
		}

		const ok = window.confirm(
			'An external application is requesting to control your browser via Page Agent Ext.\nAllow this session?'
		)
		if (ok) this.#approved = true
		return ok
	}

	async #handleBrowserOp(msg: BrowserOpMessage) {
		try {
			const data = await this.#handlers.onBrowserOp(msg.operation, msg.params)
			this.#send({ type: 'browser_op_result', id: msg.id, success: true, data })
		} catch (err) {
			const raw = err instanceof Error ? (err.message || String(err)) : String(err)
			const errorText = raw.trim() ? raw : 'browser_op failed (no error message)'
			this.#send({
				type: 'browser_op_result',
				id: msg.id,
				success: false,
				error: errorText,
			})
		}
	}

	async #handleExecute(msg: ExecuteMessage) {
		if (this.#busy) {
			this.#send({ type: 'error', message: 'Hub is busy with another task' })
			return
		}

		this.#busy = true
		try {
			const result = await this.#handlers.onExecute(msg.task, msg.config)
			this.#send({ type: 'result', success: result.success, data: result.data })
		} catch (err) {
			this.#send({ type: 'error', message: err instanceof Error ? err.message : String(err) })
		} finally {
			this.#busy = false
		}
	}
}

// --- React hook ---

/**
 * React hook that bridges HubWs to the agent's execute/stop/configure.
 * Handles the config-before-execute dance internally.
 */
export function useHubWs(
	execute: (task: string) => Promise<ExecutionResult>,
	stop: () => void,
	configure: (config: ExtConfig) => Promise<void>,
	config: ExtConfig | null,
	executeBrowserOp: (operation: string, params: Record<string, unknown>) => Promise<string>
): { wsState: HubWsState } {
	const wsPort = new URLSearchParams(location.search).get('ws')
	const [wsState, setWsState] = useState<HubWsState>(() => (wsPort ? 'connecting' : 'disconnected'))
	const hubWsRef = useRef<HubWs | null>(null)

	const latestRef = useRef({ execute, stop, configure, config, executeBrowserOp })
	useEffect(() => {
		latestRef.current = { execute, stop, configure, config, executeBrowserOp }
	})

	useEffect(() => {
		if (!wsPort) return

		const hubWs = new HubWs(
			Number(wsPort),
			{
				onExecute: async (task, incomingConfig) => {
					const { execute, configure, config } = latestRef.current
					if (incomingConfig) {
						await configure({ ...config, ...incomingConfig } as ExtConfig)
					}
					const result = await execute(task)
					return { success: result.success, data: result.data }
				},
				onStop: () => latestRef.current.stop(),
				onBrowserOp: (operation, params) => latestRef.current.executeBrowserOp(operation, params),
			},
			setWsState
		)

		hubWs.connect()
		hubWsRef.current = hubWs

		return () => {
			hubWs.disconnect()
			hubWsRef.current = null
		}
	}, [wsPort])

	return { wsState }
}
