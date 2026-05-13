#!/usr/bin/env node
import { spawn } from 'node:child_process'
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
				clientInfo: { name: 'page-agent-mcp-sequence', version: '0.1.0' },
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
		port: '38402',
		llmBaseURL: process.env.LLM_BASE_URL ?? '',
		llmModel: process.env.LLM_MODEL_NAME ?? '',
		llmApiKey: process.env.LLM_API_KEY ?? '',
		geminiUrl: 'https://gemini.google.com/',
		timeoutMs: 90_000,
		message: 'I can control this browser via Page Agent MCP. Please reply with: ACK',
	}

	for (let i = 0; i < args.length; i++) {
		const a = args[i]
		if (a === '--port') out.port = args[++i] ?? out.port
		else if (a === '--llmBaseURL') out.llmBaseURL = args[++i] ?? out.llmBaseURL
		else if (a === '--llmModel') out.llmModel = args[++i] ?? out.llmModel
		else if (a === '--llmApiKey') out.llmApiKey = args[++i] ?? out.llmApiKey
		else if (a === '--geminiUrl') out.geminiUrl = args[++i] ?? out.geminiUrl
		else if (a === '--timeoutMs') out.timeoutMs = Number(args[++i] ?? out.timeoutMs)
		else if (a === '--message') out.message = args[++i] ?? out.message
	}
	return out
}

function getToolText(res) {
	return res?.content?.[0]?.text ?? ''
}

function findIndexByLabel(mapText, pattern) {
	const lines = mapText.split('\n')
	for (const line of lines) {
		const m = line.match(/^\s*\[(\d+)\].*$/)
		if (!m) continue
		if (pattern.test(line)) return Number(m[1])
	}
	return null
}

async function waitForMapText(session, { pattern, timeoutMs }) {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		const res = await session.callTool('browser_get_map', {})
		const text = getToolText(res)
		if (pattern.test(text)) return { res, text }
		await delay(2000)
	}
	return { res: null, text: '' }
}

async function waitForMapPredicate(session, { predicate, timeoutMs }) {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		const res = await session.callTool('browser_get_map', {})
		const text = getToolText(res)
		if (predicate(text)) return { res, text }
		await delay(2000)
	}
	return { res: null, text: '' }
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

async function main() {
	const args = parseArgs(process.argv)
	const env = {
		...process.env,
		PORT: args.port,
		...(args.llmBaseURL ? { LLM_BASE_URL: args.llmBaseURL } : null),
		...(args.llmModel ? { LLM_MODEL_NAME: args.llmModel } : null),
		...(args.llmApiKey ? { LLM_API_KEY: args.llmApiKey } : null),
	}

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

		const status = await waitForHubConnected(session, args.timeoutMs)
		process.stdout.write(`Hub connected: ${JSON.stringify(status)}\n\n`)

		process.stdout.write('Open example.com...\n')
		process.stdout.write(JSON.stringify(await session.callTool('browser_open_tab', { url: 'https://example.com' }), null, 2) + '\n\n')
		process.stdout.write('Get map...\n')
		process.stdout.write(JSON.stringify(await session.callTool('browser_get_map', {}), null, 2) + '\n\n')

		process.stdout.write(`Open Gemini: ${args.geminiUrl}\n`)
		process.stdout.write(JSON.stringify(await session.callTool('browser_open_tab', { url: args.geminiUrl }), null, 2) + '\n\n')
		process.stdout.write('Get Gemini map...\n')
		const geminiMapRes = await session.callTool('browser_get_map', {})
		process.stdout.write(JSON.stringify(geminiMapRes, null, 2) + '\n\n')

		const geminiMapText = getToolText(geminiMapRes)
		const inputIndex =
			findIndexByLabel(geminiMapText, /role=textbox/i) ??
			findIndexByLabel(geminiMapText, /Enter a prompt/i)

		if (inputIndex == null) {
			process.stdout.write('Could not find Gemini prompt input. You may need to log in manually, then rerun.\n')
			return
		}

		process.stdout.write(`Type into Gemini prompt input [${inputIndex}]...\n`)
		process.stdout.write(
			JSON.stringify(await session.callTool('browser_type', { index: inputIndex, text: args.message }), null, 2) +
				'\n\n'
		)

		process.stdout.write('Get Gemini map after typing...\n')
		const afterTypeRes = await session.callTool('browser_get_map', {})
		process.stdout.write(JSON.stringify(afterTypeRes, null, 2) + '\n\n')

		const afterTypeText = getToolText(afterTypeRes)
		const sendIndex =
			findIndexByLabel(afterTypeText, /Send/i) ??
			findIndexByLabel(afterTypeText, /aria-label=.*send/i)

		if (sendIndex == null) {
			process.stdout.write('Could not find Send button. Try clicking the prompt input and rerun.\n')
			return
		}

		process.stdout.write(`Click Send [${sendIndex}]...\n`)
		process.stdout.write(
			JSON.stringify(await session.callTool('browser_click', { index: sendIndex }), null, 2) + '\n\n'
		)

		process.stdout.write('Wait for Gemini response...\n')
		const { res: afterSendRes } = await waitForMapPredicate(session, {
			predicate: (text) => !/Stop response/i.test(text) && /(CHECKLIST:|RISKS:|Copy response|Regenerate)/i.test(text),
			timeoutMs: args.timeoutMs,
		})

		if (afterSendRes) {
			process.stdout.write('Get Gemini map after response...\n')
			process.stdout.write(JSON.stringify(afterSendRes, null, 2) + '\n\n')
		} else {
			process.stdout.write('Timed out waiting for response UI. Capturing screenshot anyway.\n\n')
		}

		const screenshotRes = await session.callTool('browser_screenshot', { maxWidth: 900, quality: 35 })
		const screenshotText = screenshotRes?.content?.[0]?.text ?? 'Screenshot captured'
		process.stdout.write(`${screenshotText}\n`)
	} finally {
		await session.close()
	}
}

main().catch((e) => {
	process.stderr.write(String(e?.stack || e) + '\n')
	process.exit(1)
})

