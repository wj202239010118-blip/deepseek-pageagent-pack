#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const rootDir = dirname(fileURLToPath(import.meta.url))
const serverEntry = join(rootDir, 'index.js')

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
			return await request('tools/call', { name, arguments: args ?? {} })
		},
		async init() {
			await request('initialize', {
				protocolVersion: '2025-03-26',
				capabilities: { tools: {}, resources: {}, prompts: {} },
				clientInfo: { name: 'page-agent-figma-boundary-sequence', version: '0.1.0' },
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

function parseArgs(argv) {
	const args = argv.slice(2)
	const out = {
		port: '38401',
		timeoutMs: 180_000,
		figmaUrl: '',
		geminiUrl: 'https://gemini.google.com/',
		geminiPrompt:
			'请给出在 Figma 里创建一个“操作边界”的最稳做法：用 Frame 还是 Rectangle？如何命名为 “AI boundary”，以及如何锁定避免误移动？请按步骤列出。',
	}

	for (let i = 0; i < args.length; i++) {
		const a = args[i]
		if (a === '--port') out.port = args[++i] ?? out.port
		else if (a === '--timeoutMs') out.timeoutMs = Number(args[++i] ?? out.timeoutMs)
		else if (a === '--figmaUrl') out.figmaUrl = args[++i] ?? out.figmaUrl
		else if (a === '--geminiUrl') out.geminiUrl = args[++i] ?? out.geminiUrl
		else if (a === '--geminiPrompt') out.geminiPrompt = args[++i] ?? out.geminiPrompt
	}
	return out
}

function getToolText(res) {
	return res?.content?.find((c) => c?.type === 'text')?.text ?? ''
}

function getToolImageBase64(res) {
	const img = res?.content?.find((c) => c?.type === 'image')
	if (!img?.data || typeof img.data !== 'string') return null
	return img.data
}

function findIndexByLabel(mapText, pattern) {
	const lines = mapText.split('\n')
	for (const line of lines) {
		const m = line.match(/^\s*\[(\d+)\]/)
		if (!m) continue
		if (pattern.test(line)) return Number(m[1])
	}
	return null
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
		await delay(1000)
	}
	throw new Error('Timeout waiting for hub connection (connected:true)')
}

async function getMapText(session) {
	const res = await session.callTool('browser_get_map', {})
	return { res, text: getToolText(res) }
}

function logMapBrief(title, mapText) {
	const lines = mapText.split('\n').slice(0, 12)
	process.stdout.write(`\n--- ${title} ---\n${lines.join('\n')}\n`)
}

function ensureArtifactsDir() {
	const dir = join(rootDir, '..', '.artifacts')
	mkdirSync(dir, { recursive: true })
	return dir
}

async function screenshotToFile(session, fileBase) {
	const res = await session.callTool('browser_screenshot', { maxWidth: 1400, quality: 45 })
	const base64 = getToolImageBase64(res)
	const text = getToolText(res)
	const dir = ensureArtifactsDir()
	const filePath = join(dir, `${fileBase}.jpg`)
	if (base64) {
		writeFileSync(filePath, Buffer.from(base64, 'base64'))
		process.stdout.write(`${text}\nSaved: ${filePath}\n`)
	} else {
		process.stdout.write(`${text}\nNo image payload; nothing saved.\n`)
	}
	return { filePath, text }
}

async function clickFirst(session, mapText, pattern, label) {
	const idx = findIndexByLabel(mapText, pattern)
	if (idx == null) throw new Error(`Could not find element for: ${label}`)
	await session.callTool('browser_click', { index: idx })
	return idx
}

async function openGeminiAndAsk(session, { url, prompt, timeoutMs }) {
	await session.callTool('browser_open_tab', { url, timeout: 20000 })
	const { text: mapText } = await getMapText(session)
	logMapBrief('Gemini map (initial)', mapText)
	const inputIndex =
		findIndexByLabel(mapText, /role=textbox/i) ??
		findIndexByLabel(mapText, /Enter a prompt/i) ??
		findIndexByLabel(mapText, /为 Gemini 输入提示/i)
	if (inputIndex == null) {
		throw new Error('Could not find Gemini prompt input (textbox).')
	}
	await session.callTool('browser_click', { index: inputIndex })
	await session.callTool('browser_type', { index: inputIndex, text: prompt })
	const { text: afterType } = await getMapText(session)
	logMapBrief('Gemini map (after type)', afterType)
	const sendIndex =
		findIndexByLabel(afterType, /Send message/i) ??
		findIndexByLabel(afterType, /aria-label=.*Send/i) ??
		findIndexByLabel(afterType, /发送消息/i)
	if (sendIndex == null) throw new Error('Could not find Gemini Send button.')
	await session.callTool('browser_click', { index: sendIndex })

	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		const { text } = await getMapText(session)
		if (!/Stop response/i.test(text) && /(Copy|复制|Regenerate|重新生成|Gemini 说|Gemini says)/i.test(text)) break
		await delay(1500)
	}
	await screenshotToFile(session, `gemini-${Date.now()}`)
}

async function openFigmaAndTryBoundary(session, { url }) {
	await session.callTool('browser_open_tab', { url, timeout: 30000 })

	const { text: mapText0 } = await getMapText(session)
	logMapBrief('Figma map (initial)', mapText0)
	if (/Sign up to edit|登录以编辑|注册以编辑/i.test(mapText0)) {
		await screenshotToFile(session, `figma-view-only-${Date.now()}`)
		throw new Error('Figma is in view-only mode (Sign up to edit). Please log in / request edit access.')
	}

	let mapText = mapText0
	try {
		const idx = await clickFirst(session, mapText, /(aria-label=.*Frame\b|>Frame\s*\/?>)/i, 'Figma Frame tool')
		process.stdout.write(`Clicked Frame tool: [${idx}]\n`)
		mapText = (await getMapText(session)).text
		logMapBrief('Figma map (after Frame click)', mapText)
	} catch {}

	try {
		const preset =
			findIndexByLabel(mapText, />Desktop\s*\/?>/i) ??
			findIndexByLabel(mapText, />MacBook\s*\/?>/i) ??
			findIndexByLabel(mapText, />iPhone\s*\/?>/i)
		if (preset != null) {
			await session.callTool('browser_click', { index: preset })
			process.stdout.write(`Clicked frame preset: [${preset}]\n`)
			mapText = (await getMapText(session)).text
			logMapBrief('Figma map (after preset click)', mapText)
		}
	} catch {}

	try {
		const nameField =
			findIndexByLabel(mapText, /Name.*role=textbox/i) ??
			findIndexByLabel(mapText, /layer name/i) ??
			findIndexByLabel(mapText, /AI boundary/i)
		if (nameField != null) {
			await session.callTool('browser_click', { index: nameField })
			await session.callTool('browser_type', { index: nameField, text: 'AI boundary' })
			process.stdout.write(`Typed name into: [${nameField}]\n`)
		}
	} catch {}

	mapText = (await getMapText(session)).text
	logMapBrief('Figma map (before lock attempt)', mapText)
	try {
		const lockBtn =
			findIndexByLabel(mapText, /Lock/i) ??
			findIndexByLabel(mapText, /锁定/i) ??
			findIndexByLabel(mapText, /aria-label=.*Lock/i)
		if (lockBtn != null) await session.callTool('browser_click', { index: lockBtn })
	} catch {}

	await screenshotToFile(session, `figma-${Date.now()}`)
}

async function main() {
	const args = parseArgs(process.argv)
	if (!args.figmaUrl) {
		process.stderr.write('Missing --figmaUrl\n')
		process.exit(2)
	}

	const env = { ...process.env, PORT: args.port }
	const session = createMcpSession({ env })
	try {
		await session.init()
		process.stdout.write(
			[
				`MCP server started on http://localhost:${args.port}`,
				'Waiting for hub tab to connect. If prompted in Chrome, click “Allow this session?”.',
				'',
			].join('\n')
		)
		await waitForHubConnected(session, args.timeoutMs)

		process.stdout.write('Open Gemini and ask for boundary steps...\n')
		await openGeminiAndAsk(session, { url: args.geminiUrl, prompt: args.geminiPrompt, timeoutMs: args.timeoutMs })

		process.stdout.write('Open Figma and try creating a boundary frame...\n')
		await openFigmaAndTryBoundary(session, { url: args.figmaUrl })

		process.stdout.write('Done.\n')
	} finally {
		await session.close()
	}
}

main().catch((e) => {
	process.stderr.write(String(e?.stack || e) + '\n')
	process.exit(1)
})
