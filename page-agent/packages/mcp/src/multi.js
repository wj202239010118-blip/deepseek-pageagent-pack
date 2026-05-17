#!/usr/bin/env node

/**
 * pageagent-multi — 多实例管理器
 *
 * 用法:
 *   node src/multi.js list                         列出所有运行中的实例
 *   node src/multi.js start  [--port N] [--name X] 启动新实例
 *   node src/multi.js stop   <port>                 停止指定端口的实例
 *   node src/multi.js help                          显示帮助
 */

import { request } from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { platform } from 'node:os'

const MCP_INDEX = fileURLToPath(new URL('./index.js', import.meta.url))
const SCAN_RANGE = { start: 38401, end: 38420 }
const HEALTH_TIMEOUT = 3000

// ── helpers ──────────────────────────────────────────────────────────────────

/** HTTP GET {host}:{port}/health, return parsed JSON or null on failure. */
function checkHealth(port, host = 'localhost') {
	return new Promise((resolve) => {
		const req = request(
			{ hostname: host, port, path: '/health', method: 'GET', timeout: HEALTH_TIMEOUT },
			(res) => {
				let body = ''
				res.on('data', (chunk) => (body += chunk))
				res.on('end', () => {
					try {
						resolve(JSON.parse(body))
					} catch {
						resolve(null)
					}
				})
			}
		)
		req.on('error', () => resolve(null))
		req.on('timeout', () => {
			req.destroy()
			resolve(null)
		})
		req.end()
	})
}

/** Find the PID listening on `port` (Windows-only). */
function findPidByPort(port) {
	return new Promise((resolve) => {
		if (platform() !== 'win32') {
			resolve(null)
			return
		}
		const child = spawn('netstat', ['-ano'], { stdio: ['ignore', 'pipe', 'pipe'] })
		let output = ''
		child.stdout.on('data', (d) => (output += d))
		child.on('close', () => {
			const regex = new RegExp(`:${port}\\s+.*?\\s+LISTENING\\s+(\\d+)`)
			for (const line of output.split('\n')) {
				const m = line.match(regex)
				if (m) {
					resolve(parseInt(m[1], 10))
					return
				}
			}
			resolve(null)
		})
		child.on('error', () => resolve(null))
	})
}

// ── commands ─────────────────────────────────────────────────────────────────

async function cmdList() {
	const instances = []
	for (let port = SCAN_RANGE.start; port <= SCAN_RANGE.end; port++) {
		const health = await checkHealth(port)
		if (health && health.ok) {
			const pid = await findPidByPort(port)
			instances.push({ port, pid })
		}
	}

	if (instances.length === 0) {
		console.log('No running pageagent instances found.')
		return
	}

	console.log(`Found ${instances.length} pageagent instance(s):\n`)
	for (const inst of instances) {
		const pidInfo = inst.pid ? `  PID: ${inst.pid}` : ''
		console.log(`  Port ${inst.port}  ${pidInfo}`)
	}
}

async function cmdStart(args) {
	let port = null
	let name = 'default'
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--port' || args[i] === '-p') port = parseInt(args[++i], 10)
		else if (args[i] === '--name' || args[i] === '-n') name = args[++i]
	}

	const spawnArgs = []
	if (port) spawnArgs.push('--port', String(port))
	spawnArgs.push('--name', name)

	console.error(`[pageagent-multi] Starting instance "${name}"…`)

	const child = spawn(process.execPath, [MCP_INDEX, ...spawnArgs], {
		stdio: ['ignore', 'inherit', 'inherit'],
		detached: false,
	})

	child.on('error', (err) => {
		console.error(`[pageagent-multi] Failed to start: ${err.message}`)
		process.exit(1)
	})

	// Keep running — the child inherits stdio so its logs show here.
	// If the child exits, we exit with the same code.
	child.on('exit', (code) => {
		process.exit(code ?? 0)
	})
}

async function cmdStop(portStr) {
	const port = parseInt(portStr, 10)
	if (isNaN(port)) {
		console.error(`Usage: pageagent-multi stop <port>`)
		process.exit(1)
	}

	const health = await checkHealth(port)
	if (!health) {
		console.log(`No pageagent instance found on port ${port}.`)
		return
	}

	if (platform() === 'win32') {
		const pid = await findPidByPort(port)
		if (!pid) {
			console.log(`Could not determine PID for port ${port}.`)
			return
		}
		console.log(`Stopping pageagent on port ${port} (PID ${pid})…`)
		spawn('taskkill', ['/PID', String(pid), '/F'], {
			stdio: 'inherit',
		})
	} else {
		const pid = await findPidByPort(port)
		if (pid) {
			console.log(`Stopping pageagent on port ${port} (PID ${pid})…`)
			spawn('kill', ['-9', String(pid)], { stdio: 'inherit' })
		} else {
			console.log(`Could not determine PID for port ${port}.`)
		}
	}
}

// ── main ─────────────────────────────────────────────────────────────────────

const command = process.argv[2]
const rest = process.argv.slice(3)

switch (command) {
	case 'list':
		await cmdList()
		break
	case 'start':
		await cmdStart(rest)
		break
	case 'stop':
		await cmdStop(rest[0])
		break
	case 'help':
	case '--help':
	case '-h':
	case undefined:
		console.log(`pageagent-multi — 多实例管理器

用法:
  pageagent-multi list                         列出运行中的实例
  pageagent-multi start  [--port N] [--name X] 启动新实例
  pageagent-multi stop   <port>                 停止指定端口的实例
  pageagent-multi help                          显示此帮助

示例:
  pageagent-multi list
  pageagent-multi start --port 38402 --name "terminal-2"
  pageagent-multi stop 38402
`)
		break
	default:
		console.error(`Unknown command: "${command}". Use "help" for usage.`)
		process.exit(1)
}
