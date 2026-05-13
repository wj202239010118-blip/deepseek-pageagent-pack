/**
 * sync-credentials.js
 * 从 Claude Code 本地凭据同步 OAuth token 到 .env，然后重建扩展。
 * 用法：node sync-credentials.js
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CREDENTIALS_PATH = join(homedir(), '.claude', '.credentials.json')
const ENV_PATH = new URL('.env', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')

// Read Claude Code credentials
let credentials
try {
	credentials = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf-8'))
} catch {
	console.error(`❌  Cannot read ${CREDENTIALS_PATH}`)
	console.error('    Make sure Claude Code is installed and you have logged in.')
	process.exit(1)
}

const oauth = credentials?.claudeAiOauth
if (!oauth?.accessToken) {
	console.error('❌  No OAuth token found in credentials file.')
	process.exit(1)
}

// Check expiry
const expiresAt = oauth.expiresAt
const now = Date.now()
const daysLeft = Math.floor((expiresAt - now) / (1000 * 60 * 60 * 24))

if (expiresAt < now) {
	console.warn('⚠️  Token is expired. Re-run `claude` in terminal to refresh credentials, then run this script again.')
	process.exit(1)
}

console.log(`✅  Token valid for ~${daysLeft} more days`)

// Write .env
const envContent = `# 从 Claude Code 本地凭据自动同步（${new Date().toISOString()}）
# 如需更新，运行: node sync-credentials.js
VITE_CLAUDE_API_KEY=${oauth.accessToken}
`
writeFileSync(ENV_PATH, envContent, 'utf-8')
console.log('✅  .env updated')

// Rebuild extension
console.log('🔨  Building extension...')
execSync('npm run build:ext', { stdio: 'inherit' })
console.log('🎉  Done! Reload the extension in chrome://extensions')
