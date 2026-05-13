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

function createStdioClient({ env }) {
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
		async close() {
			try {
				child.stdin.end()
			} catch {}
			try {
				child.kill()
			} catch {}
			await delay(10)
		},
	}
}

function parseArgs(argv) {
	const args = argv.slice(2)
	const out = { tool: null, json: null, env: {} }
	for (let i = 0; i < args.length; i++) {
		const a = args[i]
		if (a === '--tool') out.tool = args[++i] ?? null
		else if (a === '--args') out.json = args[++i] ?? null
		else if (a === '--llmBaseURL') out.env.LLM_BASE_URL = args[++i] ?? ''
		else if (a === '--llmModel') out.env.LLM_MODEL_NAME = args[++i] ?? ''
		else if (a === '--llmApiKey') out.env.LLM_API_KEY = args[++i] ?? ''
		else if (a === '--port') out.env.PORT = args[++i] ?? ''
	}
	return out
}

async function main() {
	const { tool, json, env } = parseArgs(process.argv)
	if (!tool) {
		process.stdout.write(
			[
				'Usage:',
				'  node src/stdio-client.js --tool get_status',
				'  node src/stdio-client.js --tool browser_get_map',
				'  node src/stdio-client.js --tool browser_open_tab --args \'{"url":"https://example.com"}\'',
				'  node src/stdio-client.js --tool execute_task --args \'{"task":"Open example.com and click ..."}\' --llmBaseURL ... --llmModel ... --llmApiKey ...',
				'',
			].join('\n')
		)
		process.exit(2)
	}

	const client = createStdioClient({ env: { ...process.env, ...env } })
	try {
		await client.request('initialize', {
			protocolVersion: '2025-03-26',
			capabilities: { tools: {}, resources: {}, prompts: {} },
			clientInfo: { name: 'page-agent-stdio-client', version: '0.1.0' },
		})
		client.notify('notifications/initialized', {})

		const toolArgs = json ? JSON.parse(json) : {}
		const res = await client.request('tools/call', { name: tool, arguments: toolArgs })
		process.stdout.write(JSON.stringify(res, null, 2) + '\n')
	} finally {
		await client.close()
	}
}

main().catch((e) => {
	process.stderr.write(String(e?.stack || e) + '\n')
	process.exit(1)
})
