import type { LLMConfig } from '@page-agent/llms'

export const CLAUDE_BASE_URL = 'http://localhost:3773/v1'
export const CLAUDE_MODEL = 'claude-sonnet-4-6'

// No API key needed — the local proxy (claude-proxy.js) handles authentication
export const DEMO_CONFIG: LLMConfig = {
	baseURL: CLAUDE_BASE_URL,
	model: CLAUDE_MODEL,
	disableNamedToolChoice: true,
}

// Keep legacy names for backward compat with ConfigPanel imports
export const DEMO_BASE_URL = CLAUDE_BASE_URL
export const DEMO_MODEL = CLAUDE_MODEL

/** Endpoints that should be auto-migrated to the local proxy */
export const LEGACY_TESTING_ENDPOINTS = [
	'https://hwcxiuzfylggtcktqgij.supabase.co/functions/v1/llm-testing-proxy',
	'https://page-ag-testing-ohftxirgbn.cn-shanghai.fcapp.run',
	'https://page-ag-testing-ohftxirzbn.cn-shanghai.fcapp.run',
	// Direct Anthropic API — blocked by org CORS policy, must use local proxy
	'https://api.anthropic.com/v1',
	'https://api.anthropic.com',
]

export function isTestingEndpoint(url: string): boolean {
	const normalized = url.replace(/\/+$/, '')
	return LEGACY_TESTING_ENDPOINTS.some((ep) => normalized === ep)
}

export function migrateLegacyEndpoint(config: LLMConfig): LLMConfig {
	const normalized = config.baseURL.replace(/\/+$/, '')
	if (LEGACY_TESTING_ENDPOINTS.some((ep) => normalized === ep)) {
		return { ...DEMO_CONFIG }
	}
	return config
}
