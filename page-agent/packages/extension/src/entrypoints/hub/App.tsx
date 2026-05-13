import { FoldVertical, Globe, Plug, PlugZap, Square, UnfoldVertical, Unplug } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useAgent } from '@/agent/useAgent'
import { ActivityCard, EventCard } from '@/components/cards'
import { Logo, MotionOverlay, StatusDot } from '@/components/misc'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'

import { useHubWs } from './hub-ws'

// Labels for primitive browser operations
const PRIM_OP_LABELS: Record<string, string> = {
	get_map: '📋 读取页面元素',
	navigate: '🌐 导航到页面',
	click: '🖱️ 点击元素',
	type: '⌨️ 输入文字',
	scroll: '📜 滚动页面',
	inspect_element: '🔍 检查元素',
	get_user_input: '💬 读取用户输入',
	upload_file: '📎 上传文件',
}

interface PrimOpLog {
	id: number
	op: string
	params: Record<string, unknown>
	result?: string
	error?: string
	ts: number
}

let primOpCounter = 0

export default function App() {
	const {
		status,
		history,
		activity,
		currentTask,
		config,
		execute,
		stop,
		configure,
		executeBrowserOp,
	} = useAgent()
	const [primOp, setPrimOp] = useState<string | null>(null)
	const [primOpLogs, setPrimOpLogs] = useState<PrimOpLog[]>([])
	const [currentUrl, setCurrentUrl] = useState<string | null>(null)

	// Wrap executeBrowserOp to track primitive op progress in the Hub UI
	const trackedExecuteBrowserOp = useCallback(
		async (op: string, params: Record<string, unknown>): Promise<string> => {
			const id = ++primOpCounter
			const log: PrimOpLog = { id, op, params, ts: Date.now() }
			setPrimOp(op)
			setPrimOpLogs((prev) => [...prev.slice(-19), log])
			try {
				const result = await executeBrowserOp(op, params)
				// Extract current URL from get_map result
				if (op === 'get_map' && result) {
					const m = /^URL: (.+)$/m.exec(result)
					if (m?.[1] && m[1] !== 'undefined') setCurrentUrl(m[1])
				}
				if (op === 'navigate') {
					const url = (params as { url?: string }).url
					if (url) setCurrentUrl(url)
				}
				setPrimOpLogs((prev) =>
					prev.map((l) => (l.id === id ? { ...l, result: result.slice(0, 120) } : l))
				)
				return result
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err)
				setPrimOpLogs((prev) => prev.map((l) => (l.id === id ? { ...l, error: msg } : l)))
				throw err
			} finally {
				setPrimOp(null)
			}
		},
		[executeBrowserOp]
	)

	const { wsState } = useHubWs(execute, stop, configure, config, trackedExecuteBrowserOp)

	const historyRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		if (historyRef.current) {
			historyRef.current.scrollTop = historyRef.current.scrollHeight
		}
	}, [history, activity, primOpLogs])

	const isRunning = status === 'running'
	const WsIcon = wsState === 'connected' ? PlugZap : wsState === 'connecting' ? Plug : Unplug
	const wsLabel = {
		connected: 'Connected',
		connecting: 'Connecting…',
		disconnected: new URLSearchParams(location.search).get('ws') ? 'Disconnected' : 'No connection',
	}[wsState]

	// Show prim op logs when no task is running (direct MCP primitive op mode)
	const showPrimLogs = primOpLogs.length > 0 && !currentTask

	return (
		<div className="flex h-screen bg-background">
			{/* Left — Protocol docs */}
			<aside className="w-80 shrink-0 border-r flex flex-col bg-muted/20">
				<a
					href="https://alibaba.github.io/page-agent/"
					target="_blank"
					rel="noopener noreferrer"
					className="flex items-center gap-2 px-5 h-12 border-b hover:bg-muted/30 transition-colors"
				>
					<Logo className="size-5" />
					<span className="text-sm font-semibold tracking-tight">Page Agent Hub</span>
					<span className="text-[9px] font-medium uppercase tracking-wider text-amber-600 bg-amber-500/10 border border-amber-500/30 rounded px-1.5 py-0.5">
						Beta
					</span>
				</a>

				<div className="flex-1 overflow-y-auto px-5 py-4 space-y-6">
					<div className="text-xs text-muted-foreground leading-relaxed space-y-2">
						<p>
							Page Agent Hub lets local apps (e.g. MCP servers) control the Page Agent extension via
							WebSocket.
						</p>
						<p>
							Check out the official{' '}
							<a
								href="https://github.com/alibaba/page-agent/tree/main/packages/mcp"
								target="_blank"
								rel="noopener noreferrer"
								className="underline hover:text-foreground"
							>
								MCP server package
							</a>
							.
						</p>
					</div>

					<HubConfig />

					<ProtocolDocsCollapsible />
				</div>

				<div className="border-t px-5 py-3 text-[10px] text-muted-foreground/60 flex items-center justify-between">
					<span className="font-mono">v{__VERSION__}</span>
					<span>
						Built with ♥️ by{' '}
						<a
							href="https://github.com/gaomeng1900"
							target="_blank"
							rel="noopener noreferrer"
							className="underline hover:text-foreground"
						>
							@Simon
						</a>
					</span>
				</div>
			</aside>

			{/* Right — Live session */}
			<main className="flex-1 flex flex-col min-w-0 relative">
				<MotionOverlay active={isRunning} />

				<header className="flex items-center justify-between border-b px-5 h-12 gap-3">
					<div className="flex items-center gap-2 text-xs text-muted-foreground shrink-0">
						<WsIcon className="size-3.5" />
						<span>{wsLabel}</span>
					</div>
					{/* Current page URL indicator */}
					{currentUrl && (
						<div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/70 min-w-0 flex-1">
							<Globe className="size-3 shrink-0" />
							<span className="truncate font-mono" title={currentUrl}>
								{currentUrl}
							</span>
						</div>
					)}
					<div className="flex items-center gap-3 shrink-0">
						<StatusDot status={status} />
						{isRunning && (
							<Button variant="destructive" size="sm" onClick={stop} className="h-7 text-xs">
								<Square className="size-3 mr-1" />
								Stop
							</Button>
						)}
					</div>
				</header>

				{/* Task banner */}
				{currentTask && (
					<div className="border-b px-5 py-2 bg-muted/30">
						<div className="text-[10px] text-muted-foreground uppercase tracking-wide">
							Current Task
						</div>
						<div className="text-sm font-medium truncate" title={currentTask}>
							{currentTask}
						</div>
					</div>
				)}

				{/* Primitive op live indicator */}
				{primOp && (
					<div className="border-b px-5 py-1.5 bg-blue-500/5 flex items-center gap-2">
						<span className="size-1.5 rounded-full bg-blue-500 animate-ping inline-block" />
						<span className="text-xs text-blue-600 dark:text-blue-400">
							{PRIM_OP_LABELS[primOp] ?? primOp}
						</span>
					</div>
				)}

				{/* Event stream */}
				<div ref={historyRef} className="flex-1 overflow-y-auto p-5 space-y-2">
					{!currentTask && history.length === 0 && !isRunning && !showPrimLogs && (
						<div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3">
							<WsIcon className="size-10 opacity-30" />
							<p className="text-sm">
								{wsState === 'connected'
									? 'Waiting for task from external caller…'
									: 'No active session'}
							</p>
						</div>
					)}

					{/* Primitive op logs (shown when using direct MCP tools, not execute_task) */}
					{showPrimLogs && (
						<div className="space-y-1.5">
							<div className="text-[10px] text-muted-foreground uppercase tracking-wide px-0.5 mb-2">
								Browser Operations
							</div>
							{primOpLogs.map((log) => (
								<div
									key={log.id}
									className={`rounded-md border p-2 text-[11px] flex items-start gap-2 ${log.error ? 'border-destructive/30 bg-destructive/5' : log.result !== undefined ? 'border-green-500/20 bg-green-500/5' : 'border-blue-500/20 bg-blue-500/5 animate-pulse'}`}
								>
									<span className="shrink-0 mt-0.5">
										{log.error ? '❌' : log.result !== undefined ? '✅' : '⏳'}
									</span>
									<div className="min-w-0 flex-1">
										<div className="font-medium text-foreground/80">
											{PRIM_OP_LABELS[log.op] ?? log.op}
											{log.op === 'navigate' && Boolean(log.params.url) && (
												<span className="ml-1.5 font-mono font-normal text-muted-foreground">
													{String(log.params.url)}
												</span>
											)}
											{log.op === 'click' && log.params.index != null && (
												<span className="ml-1.5 text-muted-foreground">
													元素 [{formatParam(log.params.index)}]
												</span>
											)}
											{log.op === 'type' && Boolean(log.params.text) && (
												<span className="ml-1.5 text-muted-foreground">
													"{String(log.params.text)}"
												</span>
											)}
										</div>
										{log.error && (
											<div className="text-destructive mt-0.5 truncate">{log.error}</div>
										)}
										{log.result && log.op === 'get_map' && renderGetMapSummary(log.result)}
									</div>
								</div>
							))}
						</div>
					)}

					{history.map((event, index) => (
						<EventCard key={index} event={event} />
					))}

					{activity && <ActivityCard activity={activity} />}
				</div>
			</main>
		</div>
	)
}

function HubConfig() {
	const [allowAll, setAllowAll] = useState(false)
	const [allowedOriginsText, setAllowedOriginsText] = useState('')
	const [savingOrigins, setSavingOrigins] = useState(false)

	useEffect(() => {
		chrome.storage.local.get('allowAllHubConnection').then((r) => {
			setAllowAll(r.allowAllHubConnection === true)
		})
	}, [])

	useEffect(() => {
		chrome.storage.local.get('hubAllowedOrigins').then((r) => {
			const list = Array.isArray(r.hubAllowedOrigins) ? (r.hubAllowedOrigins as string[]) : []
			setAllowedOriginsText(list.join('\n'))
		})
	}, [])

	useEffect(() => {
		const allowOrigin = new URLSearchParams(location.search).get('allowOrigin')
		if (!allowOrigin) return
		let origin: string
		try {
			origin = new URL(allowOrigin).origin
		} catch {
			return
		}
		const isLocal =
			origin.startsWith('http://localhost') ||
			origin.startsWith('https://localhost') ||
			origin.startsWith('http://127.0.0.1') ||
			origin.startsWith('https://127.0.0.1')
		if (!isLocal) return
		chrome.storage.local.get('hubAllowedOrigins').then((r) => {
			const list = Array.isArray(r.hubAllowedOrigins) ? (r.hubAllowedOrigins as string[]) : []
			if (list.includes(origin)) return
			const next = [...list, origin]
			chrome.storage.local.set({ hubAllowedOrigins: next }).then(() => {
				setAllowedOriginsText(next.join('\n'))
			})
		})
	}, [])

	const toggle = (checked: boolean) => {
		setAllowAll(checked)
		chrome.storage.local.set({ allowAllHubConnection: checked })
	}

	const saveAllowedOrigins = async () => {
		setSavingOrigins(true)
		try {
			const list = allowedOriginsText
				.split(/[\n,]/g)
				.map((s) => s.trim())
				.filter(Boolean)
			const unique = Array.from(new Set(list))
			await chrome.storage.local.set({ hubAllowedOrigins: unique })
			setAllowedOriginsText(unique.join('\n'))
		} finally {
			setSavingOrigins(false)
		}
	}

	const addCurrentOrigin = async () => {
		const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
		const url = tab?.url ?? ''
		if (!url) return
		let origin: string
		try {
			origin = new URL(url).origin
		} catch {
			return
		}
		const list = allowedOriginsText
			.split(/[\n,]/g)
			.map((s) => s.trim())
			.filter(Boolean)
		if (list.includes(origin)) return
		const next = [...list, origin]
		setAllowedOriginsText(next.join('\n'))
		await chrome.storage.local.set({ hubAllowedOrigins: next })
	}

	return (
		<div>
			<h3 className="text-[11px] font-semibold text-foreground/80 uppercase tracking-wider mb-2">
				Config
			</h3>
			<div className="group/hub relative">
				<label
					className={`flex items-center justify-between p-3 rounded-md border cursor-pointer text-xs ${allowAll ? 'bg-amber-500/10 border-amber-500/30 text-amber-600' : 'bg-muted/50 text-muted-foreground'}`}
				>
					Auto-approve connections
					<Switch
						checked={allowAll}
						onCheckedChange={toggle}
						className={allowAll ? 'data-[state=checked]:bg-amber-500' : ''}
					/>
				</label>

				{/* hide with invisible absolute opacity-0*/}
				<div className="group-hover/hub:visible group-hover/hub:opacity-100 transition-opacity duration-150  left-0 right-0 top-full z-10 pt-2">
					<div className="relative p-2.5 rounded-md border border-border bg-background/60 backdrop-blur-md shadow-2xl text-muted-foreground text-xs leading-relaxed">
						<div className="absolute -top-1.5 left-5 size-3 rotate-45 rounded-[1px] border-l border-t border-border bg-background/60 backdrop-blur-md" />
						By default, each connection requires your approval before running tasks. <br />
						Enable this to skip per-session approval.
						<br />
						<span className="font-semibold">* Use with caution!</span>
					</div>
				</div>
			</div>

			<div className="mt-3">
				<label className="text-[11px] font-medium text-foreground/60 mb-1.5 block">
					Sensitive ops allowlist (origins)
				</label>
				<textarea
					value={allowedOriginsText}
					onChange={(e) => setAllowedOriginsText(e.target.value)}
					rows={4}
					placeholder={`https://example.com\nhttp://localhost:38401`}
					className="w-full text-[11px] rounded-md border border-border bg-muted/30 px-3 py-2 resize-y font-mono"
				/>
				<div className="flex gap-2 mt-2">
					<button
						type="button"
						onClick={addCurrentOrigin}
						className="h-8 px-3 rounded-md border border-border text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/40"
					>
						Add current origin
					</button>
					<button
						type="button"
						onClick={saveAllowedOrigins}
						disabled={savingOrigins}
						className="h-8 px-3 rounded-md bg-foreground text-background text-[11px] disabled:opacity-50"
					>
						{savingOrigins ? 'Saving…' : 'Save allowlist'}
					</button>
				</div>
				<p className="mt-2 text-[10px] text-muted-foreground leading-relaxed">
					press_key / drag / drag_element are denied unless the active tab origin is in this
					allowlist.
				</p>
			</div>
		</div>
	)
}

function formatParam(v: unknown) {
	if (typeof v === 'string') return v
	if (typeof v === 'number') return String(v)
	if (typeof v === 'boolean') return v ? 'true' : 'false'
	try {
		return JSON.stringify(v)
	} catch {
		return String(v)
	}
}

function renderGetMapSummary(result: string) {
	const lines = result.split('\n').filter(Boolean)
	const elemCount = lines.filter((l) => l.startsWith('[')).length
	const urlLine = lines.find((l) => l.startsWith('URL:'))
	return (
		<div className="text-muted-foreground mt-0.5">
			{urlLine && <span className="font-mono">{urlLine.replace('URL: ', '')}</span>}
			{elemCount > 0 && <span className="ml-2">· {elemCount} 个可交互元素</span>}
		</div>
	)
}

function ProtocolDocsCollapsible() {
	const [open, setOpen] = useState(false)

	return (
		<div>
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className="flex items-center gap-1 text-[11px] font-semibold text-foreground/80 uppercase tracking-wider cursor-pointer"
			>
				Docs
				{open ? <FoldVertical className="size-3" /> : <UnfoldVertical className="size-3" />}
			</button>

			{open && (
				<div className="mt-3 space-y-4 text-xs text-muted-foreground">
					<p className="text-[10px]">
						Connect via <code className="text-[10px]">hub.html?ws=PORT</code>
					</p>

					<section>
						<h4 className="text-[11px] font-medium text-foreground/60 mb-1.5">Flow</h4>
						<ol className="list-decimal list-inside space-y-1 text-[11px] leading-relaxed">
							<li>Hub opens WS to caller's server</li>
							<li>
								Sends <code className="text-[10px]">ready</code>
							</li>
							<li>
								Caller sends <code className="text-[10px]">execute</code> with task
							</li>
							<li>Hub runs agent, streams events</li>
							<li>
								Hub sends <code className="text-[10px]">result</code> or{' '}
								<code className="text-[10px]">error</code>
							</li>
						</ol>
					</section>

					<section>
						<h4 className="text-[11px] font-medium text-foreground/60 mb-1.5">Caller → Hub</h4>
						<pre className="bg-muted/50 rounded-md p-3 font-mono text-[10px] leading-relaxed whitespace-pre-wrap">
							{`{ type: "execute", task: string, config?: object }
{ type: "stop" }`}
						</pre>
					</section>

					<section>
						<h4 className="text-[11px] font-medium text-foreground/60 mb-1.5">Hub → Caller</h4>
						<pre className="bg-muted/50 rounded-md p-3 font-mono text-[10px] leading-relaxed whitespace-pre-wrap">
							{`{ type: "ready" }
{ type: "result", success: boolean, data: string }
{ type: "error", message: string }`}
						</pre>
					</section>
				</div>
			)}
		</div>
	)
}
