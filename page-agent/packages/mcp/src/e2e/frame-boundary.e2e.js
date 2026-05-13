#!/usr/bin/env node
import { spawn } from 'node:child_process'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'

const rootDir = dirname(fileURLToPath(import.meta.url))
const serverEntry = join(rootDir, '..', 'index.js')
const extId = 'akldabonmimlicnjlflnapfeklbfemhj'

function parseJsonLine(line) {
	try {
		return JSON.parse(line)
	} catch {
		return null
	}
}

function createMcpSession({ env }) {
	const child = spawn(process.execPath, [serverEntry], {
		stdio: ['pipe', 'pipe', 'inherit'],
		env,
	})

	let buffer = ''
	let nextId = 1
	const pending = new Map()

	function write(obj) {
		child.stdin.write(JSON.stringify(obj) + '\n')
	}

	function request(method, params) {
		const id = nextId++
		const msg = { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject })
			write(msg)
		})
	}

	function notify(method, params) {
		const msg = { jsonrpc: '2.0', method, ...(params ? { params } : {}) }
		write(msg)
	}

	child.stdout.setEncoding('utf8')
	child.stdout.on('data', (chunk) => {
		buffer += chunk
		while (true) {
			const idx = buffer.indexOf('\n')
			if (idx === -1) break
			const line = buffer.slice(0, idx).trim()
			buffer = buffer.slice(idx + 1)
			if (!line) continue
			const msg = parseJsonLine(line)
			if (!msg || typeof msg !== 'object') continue
			if (msg.id == null) continue
			const p = pending.get(msg.id)
			if (!p) continue
			pending.delete(msg.id)
			if (msg.error) p.reject(new Error(msg.error.message || 'MCP error'))
			else p.resolve(msg.result)
		}
	})

	child.on('exit', (code) => {
		for (const { reject } of pending.values()) {
			reject(new Error(`MCP server exited with code ${code ?? 'unknown'}`))
		}
		pending.clear()
	})

	return {
		child,
		request,
		notify,
		async callTool(name, args) {
			const res = await request('tools/call', { name, arguments: args ?? {} })
			if (res?.isError) {
				throw new Error(getToolText(res) || `Tool error: ${name}`)
			}
			return res
		},
		async init() {
			await request('initialize', {
				protocolVersion: '2025-03-26',
				capabilities: { tools: {}, resources: {}, prompts: {} },
				clientInfo: { name: 'page-agent-e2e-frame-boundary', version: '0.1.0' },
			})
			notify('notifications/initialized', {})
		},
		async close() {
			try {
				child.stdin.end()
			} catch {}
			try {
				child.kill()
			} catch {}
			await delay(20)
		},
	}
}

function getToolText(res) {
	return res?.content?.find((c) => c?.type === 'text')?.text ?? ''
}

function ensureArtifactsDir() {
	const dir = join(rootDir, '..', '..', '.artifacts')
	mkdirSync(dir, { recursive: true })
	return dir
}

async function waitForHubConnected(session, timeoutMs) {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		const statusRes = await session.callTool('get_status', {})
		const text = getToolText(statusRes)
		let parsed
		try {
			parsed = JSON.parse(text)
		} catch {
			parsed = null
		}
		if (parsed?.connected === true) return parsed
		await delay(500)
	}
	throw new Error('Timeout waiting for hub connection (connected:true)')
}

async function getMapText(session) {
	const res = await session.callTool('browser_get_map', {})
	return getToolText(res)
}

function findIndexByLabel(mapText, pattern) {
	const lines = mapText.split('\n')
	for (const line of lines) {
		const m = line.match(/^\s*\*?\[(\d+)\]/)
		if (!m) continue
		if (pattern.test(line)) return Number(m[1])
	}
	return null
}

async function getStatusJson(session) {
	const res = await session.callTool('browser_wait_for_selector', { selector: '#status', timeout: 15000, visible: true })
	const text = getToolText(res)
	return JSON.parse(text)
}

async function waitForStatus(session, predicate, timeoutMs) {
	const start = Date.now()
	let last = null
	while (Date.now() - start < timeoutMs) {
		try {
			const status = await getStatusJson(session)
			last = status
			if (predicate(status)) return status
		} catch {}
		await delay(30)
	}
	throw new Error(`Timeout waiting for status predicate. last=${JSON.stringify(last)}`)
}

function getFrameCenter(status) {
	const x =
		typeof status?.frameX === 'number' && typeof status?.frameWidth === 'number'
			? status.frameX + status.frameWidth / 2
			: typeof status?.frameLeft === 'number'
				? status.frameLeft + 210
				: 0
	const y =
		typeof status?.frameY === 'number' && typeof status?.frameHeight === 'number'
			? status.frameY + status.frameHeight / 2
			: typeof status?.frameTop === 'number'
				? status.frameTop + 130
				: 0
	return { x: Math.round(x), y: Math.round(y) }
}

function quantile(sorted, q) {
	if (sorted.length === 0) return 0
	const pos = (sorted.length - 1) * q
	const base = Math.floor(pos)
	const rest = pos - base
	if (sorted[base + 1] == null) return sorted[base]
	return sorted[base] + rest * (sorted[base + 1] - sorted[base])
}

async function main() {
	const port = Number(process.env.PORT || '38401')
	const timeoutMs = Number(process.env.TIMEOUT_MS || '180000')
	const iterations = Number(process.env.ITERATIONS || '200')

	const env = { ...process.env, PORT: String(port) }
	const session = createMcpSession({ env })
	const artifactsDir = ensureArtifactsDir()
	const startedAt = Date.now()

	const perf = {
		port,
		startedAt,
		iterations,
		dragMs: [],
		renameMs: [],
		lockMs: [],
		unlockMs: [],
		lockDragNoMoveMs: [],
	}

	try {
		await session.init()
		await waitForHubConnected(session, timeoutMs)

		const allowOriginUrl = encodeURIComponent(`http://localhost:${port}`)
		const hubUrl = `chrome-extension://${extId}/hub.html?ws=${port}&allowOrigin=${allowOriginUrl}`
		await session.callTool('browser_open_tab', { url: hubUrl, timeout: 15000 })

		const fixtureUrl = `http://localhost:${port}/fixtures/frame-boundary`
		await session.callTool('browser_open_tab', { url: fixtureUrl, timeout: 15000 })
		await session.callTool('browser_wait_for_selector', { selector: '#frame', timeout: 15000, visible: true })

		const mapText = await getMapText(session)
		const nameInputIndex =
			findIndexByLabel(mapText, /nameinput/i) ??
			findIndexByLabel(mapText, /id=nameInput/i) ??
			findIndexByLabel(mapText, /type=text/i)
		const lockToggleIndex =
			findIndexByLabel(mapText, /locktoggle/i) ??
			findIndexByLabel(mapText, /type=checkbox/i)

		if (nameInputIndex == null || lockToggleIndex == null) {
			const debugPath = join(artifactsDir, `get-map-${Date.now()}.txt`)
			writeFileSync(debugPath, mapText)
			throw new Error('Could not find fixture interactive element indices (name input / lock toggle)')
		}

		const initial = await getStatusJson(session)
		const initialPos = { left: initial.frameLeft, top: initial.frameTop }

		for (let i = 0; i < iterations; i++) {
			const beforeDrag = await getStatusJson(session)
			const dragStart = getFrameCenter(beforeDrag)
			const dragEnd = { x: dragStart.x + 140, y: dragStart.y + 90 }
			const t0 = Date.now()
			await session.callTool('browser_drag', {
				start: dragStart,
				end: dragEnd,
				steps: 14,
			})
			const afterDrag = await waitForStatus(
				session,
				(s) => s.event === 'dragEnd' && (s.frameLeft !== beforeDrag.frameLeft || s.frameTop !== beforeDrag.frameTop),
				5000
			)
			perf.dragMs.push(Date.now() - t0)

			const t1 = Date.now()
			await session.callTool('browser_click', { index: nameInputIndex })
			await session.callTool('browser_type', { index: nameInputIndex, text: `AI boundary ${i}` })
			await session.callTool('browser_press_key', { key: 'Enter', index: nameInputIndex })
			await waitForStatus(session, (s) => s.event === 'rename' && s.name === `AI boundary ${i}`, 5000)
			perf.renameMs.push(Date.now() - t1)

			const t2 = Date.now()
			await session.callTool('browser_click', { index: lockToggleIndex })
			await waitForStatus(session, (s) => s.event === 'lock' && s.locked === true, 5000)
			perf.lockMs.push(Date.now() - t2)

			const lockedBefore = await getStatusJson(session)
			const lockedDragStart = getFrameCenter(lockedBefore)
			const lockedDragEnd = { x: lockedDragStart.x + 160, y: lockedDragStart.y + 110 }
			const t3 = Date.now()
			await session.callTool('browser_drag', {
				start: lockedDragStart,
				end: lockedDragEnd,
				steps: 10,
			})
			await delay(50)
			const lockedAfter = await getStatusJson(session)
			if (lockedAfter.frameLeft !== lockedBefore.frameLeft || lockedAfter.frameTop !== lockedBefore.frameTop) {
				throw new Error('Locked drag moved the frame (should not move)')
			}
			perf.lockDragNoMoveMs.push(Date.now() - t3)

			const t4 = Date.now()
			await session.callTool('browser_click', { index: lockToggleIndex })
			await waitForStatus(session, (s) => s.event === 'lock' && s.locked === false, 5000)
			perf.unlockMs.push(Date.now() - t4)
		}

		const final = await getStatusJson(session)
		if (final.frameLeft === initialPos.left && final.frameTop === initialPos.top) {
			throw new Error('Frame position did not change across test runs (drag ineffective)')
		}

		const report = (name, arr) => {
			const sorted = [...arr].sort((a, b) => a - b)
			return {
				name,
				count: sorted.length,
				p50: Math.round(quantile(sorted, 0.5)),
				p95: Math.round(quantile(sorted, 0.95)),
				p99: Math.round(quantile(sorted, 0.99)),
				max: Math.max(...sorted),
			}
		}

		const results = {
			drag: report('drag', perf.dragMs),
			rename: report('rename', perf.renameMs),
			lock: report('lock', perf.lockMs),
			unlock: report('unlock', perf.unlockMs),
			lockDragNoMove: report('lockDragNoMove', perf.lockDragNoMoveMs),
		}

		const p99Max = Math.max(
			results.drag.p99,
			results.rename.p99,
			results.lock.p99,
			results.unlock.p99,
			results.lockDragNoMove.p99
		)
		if (p99Max >= 200) {
			throw new Error(`Performance regression: p99=${p99Max}ms (target < 200ms)`)
		}

		const jsonPath = join(artifactsDir, `perf-report-${Date.now()}.json`)
		writeFileSync(jsonPath, JSON.stringify({ perf, results }, null, 2))

		const mdPath = join(artifactsDir, `perf-report-${Date.now()}.md`)
		writeFileSync(
			mdPath,
			[
				`# Perf Report (Frame Boundary Fixture)`,
				``,
				`- PORT: ${port}`,
				`- Iterations: ${iterations}`,
				`- p99 target: < 200ms (includes visible state update)`,
				``,
				`## Results`,
				`- drag: p50=${results.drag.p50}ms p95=${results.drag.p95}ms p99=${results.drag.p99}ms max=${results.drag.max}ms`,
				`- rename: p50=${results.rename.p50}ms p95=${results.rename.p95}ms p99=${results.rename.p99}ms max=${results.rename.max}ms`,
				`- lock: p50=${results.lock.p50}ms p95=${results.lock.p95}ms p99=${results.lock.p99}ms max=${results.lock.max}ms`,
				`- unlock: p50=${results.unlock.p50}ms p95=${results.unlock.p95}ms p99=${results.unlock.p99}ms max=${results.unlock.max}ms`,
				`- lockDragNoMove: p50=${results.lockDragNoMove.p50}ms p95=${results.lockDragNoMove.p95}ms p99=${results.lockDragNoMove.p99}ms max=${results.lockDragNoMove.max}ms`,
				``,
				`Artifacts:`,
				`- ${jsonPath}`,
				`- ${mdPath}`,
				``,
			].join('\n')
		)

		process.stdout.write(`E2E OK. Perf p99 max = ${p99Max}ms\nJSON: ${jsonPath}\nMD: ${mdPath}\n`)
	} finally {
		await session.close()
	}
}

main().catch((e) => {
	process.stderr.write(String(e?.stack || e) + '\n')
	process.exit(1)
})
