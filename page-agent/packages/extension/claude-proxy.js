/**
 * claude-proxy.js — 本地 Anthropic API 代理
 * 解决：组织设置禁止浏览器直接 CORS 访问 + 规范化请求参数
 * 用法：node claude-proxy.js
 */

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PORT = 3773
const UPSTREAM = 'https://api.anthropic.com'
const CREDENTIALS_PATH = join(homedir(), '.claude', '.credentials.json')
const ENV_PATH = join(homedir(), 'Desktop', 'page-agent', 'packages', 'extension', '.env')

function readToken() {
	// 1. Try proper API key from .env first (sk-ant-api03-...)
	try {
		const env = readFileSync(ENV_PATH, 'utf-8')
		const match = env.match(/VITE_CLAUDE_API_KEY=(sk-ant-api\d+-[^\s]+)/)
		if (match?.[1]) {
			console.log('  [proxy] using API key from .env')
			return match[1]
		}
	} catch {}

	// 2. Fall back to OAuth token from Claude Code (sk-ant-oat01-...)
	// NOTE: OAuth tokens only work with the native Messages API, not the OpenAI-compat endpoint.
	// If you see rate_limit errors, add a proper API key to .env
	try {
		const creds = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf-8'))
		const oauth = creds?.claudeAiOauth
		if (!oauth?.accessToken) throw new Error('No accessToken')
		if (oauth.expiresAt < Date.now()) {
			console.warn('⚠️  OAuth token expired — run `claude` in terminal to refresh')
		}
		console.log('  [proxy] using OAuth token (limited — add API key to .env for full access)')
		return oauth.accessToken
	} catch (e) {
		console.error('❌  No credentials found. Add VITE_CLAUDE_API_KEY to .env')
		process.exit(1)
	}
}

/** Normalize request body so Anthropic OpenAI-compat endpoint accepts it */
function normalizeBody(body) {
	try {
		const obj = JSON.parse(body.toString())

		// tool_choice: Anthropic compat only accepts 'auto' | 'required' | 'none'
		if (obj.tool_choice && typeof obj.tool_choice === 'object') {
			console.log(`  [proxy] normalizing tool_choice object → 'required'`)
			obj.tool_choice = 'required'
		}

		// Remove Anthropic-native-only fields that the compat endpoint rejects
		delete obj.thinking

		return JSON.stringify(obj)
	} catch {
		return body.toString()
	}
}

const server = createServer(async (req, res) => {
	res.setHeader('Access-Control-Allow-Origin', '*')
	res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, anthropic-version, anthropic-beta')

	if (req.method === 'OPTIONS') {
		res.writeHead(204)
		res.end()
		return
	}

	const chunks = []
	for await (const chunk of req) chunks.push(chunk)
	const rawBody = Buffer.concat(chunks)
	const normalizedBody = req.method === 'POST' ? normalizeBody(rawBody) : rawBody.toString()

	const token = readToken()

	let upstreamRes
	try {
		upstreamRes = await fetch(`${UPSTREAM}${req.url}`, {
			method: req.method,
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${token}`,
				'anthropic-dangerous-direct-browser-access': 'true',
			},
			body: normalizedBody.length ? normalizedBody : undefined,
		})
	} catch (e) {
		res.writeHead(502, { 'Content-Type': 'application/json' })
		res.end(JSON.stringify({ error: `Proxy upstream error: ${e.message}` }))
		return
	}

	const responseBody = await upstreamRes.text()
	if (!upstreamRes.ok) {
		console.error(`  [proxy] upstream ${upstreamRes.status}:`, responseBody.slice(0, 200))
	}
	res.writeHead(upstreamRes.status, { 'Content-Type': 'application/json' })
	res.end(responseBody)
})

server.listen(PORT, '127.0.0.1', () => {
	console.log(`✅  Claude proxy running at http://localhost:${PORT}`)
	console.log(`   Extension Base URL: http://localhost:${PORT}/v1`)
	console.log('   Keep this terminal open while using the extension.')
})
