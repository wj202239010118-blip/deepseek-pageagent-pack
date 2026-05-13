import { History, MessageSquare, Send, Settings, Square } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { ConfigPanel } from '@/components/ConfigPanel'
import { HistoryDetail } from '@/components/HistoryDetail'
import { HistoryList } from '@/components/HistoryList'
import { ActivityCard, EventCard } from '@/components/cards'
import { EmptyState, Logo, MotionOverlay, StatusDot } from '@/components/misc'
import { Button } from '@/components/ui/button'
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupTextarea,
} from '@/components/ui/input-group'
import { saveSession } from '@/lib/db'

import { useAgent } from '../../agent/useAgent'

type View =
	| { name: 'chat' }
	| { name: 'config' }
	| { name: 'history' }
	| { name: 'history-detail'; sessionId: string }

export default function App() {
	const [view, setView] = useState<View>({ name: 'chat' })
	const [inputValue, setInputValue] = useState('')
	const [claudeInput, setClaudeInput] = useState('')
	const [claudeSent, setClaudeSent] = useState(false)
	const historyRef = useRef<HTMLDivElement>(null)
	const textareaRef = useRef<HTMLTextAreaElement>(null)

	const { status, history, activity, currentTask, config, execute, stop, configure } = useAgent()

	// Persist session when task finishes
	const prevStatusRef = useRef(status)
	useEffect(() => {
		const prev = prevStatusRef.current
		prevStatusRef.current = status

		if (
			prev === 'running' &&
			(status === 'completed' || status === 'error') &&
			history.length > 0 &&
			currentTask
		) {
			saveSession({ task: currentTask, history, status }).catch((err) =>
				console.error('[SidePanel] Failed to save session:', err)
			)
		}
	}, [status, history, currentTask])

	// Auto-scroll to bottom on new events
	useEffect(() => {
		if (historyRef.current) {
			historyRef.current.scrollTop = historyRef.current.scrollHeight
		}
	}, [history, activity])

	const runTask = useCallback(
		(task: string) => {
			const normalizedTask = task.trim()
			if (!normalizedTask || status === 'running') return

			setInputValue('')
			setView({ name: 'chat' })

			execute(normalizedTask).catch((error) => {
				console.error('[SidePanel] Failed to execute task:', error)
			})
		},
		[execute, status]
	)

	const handleSubmit = useCallback(
		(e?: React.SyntheticEvent) => {
			e?.preventDefault()
			runTask(inputValue)
		},
		[inputValue, runTask]
	)

	const handleSendToClaude = useCallback(async () => {
		const msg = claudeInput.trim()
		if (!msg) return
		await chrome.storage.local.set({ pendingUserInput: msg })
		setClaudeInput('')
		setClaudeSent(true)
		setTimeout(() => setClaudeSent(false), 2000)
	}, [claudeInput])

	const handleStop = useCallback(() => {
		console.log('[SidePanel] Stopping task...')
		stop()
	}, [stop])

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault()
			handleSubmit()
		}
	}

	// --- View routing ---

	if (view.name === 'config') {
		return (
			<ConfigPanel
				config={config}
				onSave={async (newConfig) => {
					await configure(newConfig)
					setView({ name: 'chat' })
				}}
				onClose={() => setView({ name: 'chat' })}
			/>
		)
	}

	if (view.name === 'history') {
		return (
			<HistoryList
				onSelect={(id) => setView({ name: 'history-detail', sessionId: id })}
				onBack={() => setView({ name: 'chat' })}
				onRerun={runTask}
			/>
		)
	}

	if (view.name === 'history-detail') {
		return (
			<HistoryDetail
				sessionId={view.sessionId}
				onBack={() => setView({ name: 'history' })}
				onRerun={runTask}
			/>
		)
	}

	// --- Chat view ---

	const isRunning = status === 'running'
	const showEmptyState = !currentTask && history.length === 0 && !isRunning

	return (
		<div className="relative flex flex-col h-screen bg-background">
			<MotionOverlay active={isRunning} />
			{/* Header */}
			<header className="flex items-center justify-between border-b px-3 py-2">
				<div className="flex items-center gap-2">
					<Logo className="size-5" />
					<span className="text-sm font-medium">Browser MCP</span>
				</div>
				<div className="flex items-center gap-1">
					<StatusDot status={status} />
					<Button
						variant="ghost"
						size="icon-sm"
						onClick={() => setView({ name: 'history' })}
						className="cursor-pointer"
						aria-label="History"
						title="History"
					>
						<History className="size-3.5" />
					</Button>
					<Button
						variant="ghost"
						size="icon-sm"
						onClick={() => setView({ name: 'config' })}
						className="cursor-pointer"
						aria-label="Settings"
						title="Settings"
					>
						<Settings className="size-3.5" />
					</Button>
				</div>
			</header>

			{/* Content */}
			<main className="flex-1 overflow-hidden flex flex-col">
				{/* Current task */}
				{currentTask && (
					<div className="border-b px-3 py-2 bg-muted/30">
						<div className="text-[10px] text-muted-foreground uppercase tracking-wide">Task</div>
						<div className="text-xs font-medium truncate" title={currentTask}>
							{currentTask}
						</div>
					</div>
				)}

				{/* History */}
				<div ref={historyRef} className="flex-1 overflow-y-auto p-3 space-y-2">
					{showEmptyState && (
						<div className="flex flex-col items-center justify-center h-full gap-3 text-center px-4">
							<Logo className="size-8 opacity-40" />
							<p className="text-xs text-muted-foreground leading-relaxed">
								通过 <strong>Claude Code 终端</strong> 对话，<br />
								Claude 会自动调用浏览器工具操作此页面。<br />
								<span className="text-[10px] opacity-70 mt-1 block">下方输入框可向 Claude 发送临时指令</span>
							</p>
						</div>
					)}

					{history.map((event, index) => (
						<EventCard key={index} event={event} />
					))}

					{/* Activity indicator at bottom */}
					{activity && <ActivityCard activity={activity} />}
				</div>
			</main>

			{/* Input */}
			<footer className="border-t p-3">

				{/* Send to Claude input */}
				<div className="mt-2 border rounded-md p-2 bg-muted/30">
					<div className="flex items-center gap-1 mb-1.5">
						<MessageSquare className="size-3 text-muted-foreground" />
						<span className="text-[10px] text-muted-foreground font-medium">发送给 Claude</span>
					</div>
					<div className="flex gap-1">
						<input
							type="text"
							placeholder="输入后 Claude 下次查询时会收到..."
							value={claudeInput}
							onChange={(e) => setClaudeInput(e.target.value)}
							onKeyDown={(e) => { if (e.key === 'Enter') handleSendToClaude() }}
							className="flex-1 text-[11px] h-7 px-2 rounded border border-input bg-background outline-none"
						/>
						<Button
							size="icon-sm"
							variant={claudeSent ? 'default' : 'outline'}
							onClick={handleSendToClaude}
							disabled={!claudeInput.trim()}
							className="size-7 shrink-0 cursor-pointer"
							title="发送给 Claude"
						>
							{claudeSent ? '✓' : <Send className="size-3" />}
						</Button>
					</div>
				</div>
			</footer>
		</div>
	)
}
