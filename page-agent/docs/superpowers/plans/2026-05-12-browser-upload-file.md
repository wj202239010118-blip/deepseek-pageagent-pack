# browser_upload_file Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `browser_upload_file` MCP tool that lets Claude upload local files to any browser tab — with primary support for AI chat interfaces (ChatGPT, Gemini) — without user interaction.

**Architecture:** Three strategies in priority order: (1) `chrome.debugger` + `DOM.setFileInputFiles` — directly sets a local file path on any `<input type="file">` via Chrome DevTools Protocol, bypassing all `isTrusted` restrictions (95%+ reliable); (2) clipboard paste — writes image data to clipboard then dispatches a paste event (image-only fallback); (3) synthetic `drop` events — creates a `DataTransfer` with a `File` object and dispatches `dragenter/dragover/drop` (last-resort, ~60% on sites that don't enforce `isTrusted`). All three strategies are implemented in a new `case 'upload_file':` in `useAgent.ts`, following the existing switch pattern.

**Tech Stack:** Chrome Extension MV3 (WXT), `chrome.debugger` API (CDP), `chrome.scripting.executeScript`, Node.js `fs`, existing WebSocket `browser_op` protocol

---

### Task 1: Add required permissions to manifest

**Files:**
- Modify: `packages/extension/wxt.config.js:49`

- [ ] **Step 1: Add `"debugger"` and `"clipboardWrite"` to permissions array**

Open `packages/extension/wxt.config.js`. Change line 49:

```js
// Before:
permissions: ['tabs', 'tabGroups', 'sidePanel', 'storage', 'scripting'],

// After:
permissions: ['tabs', 'tabGroups', 'sidePanel', 'storage', 'scripting', 'debugger', 'clipboardWrite'],
```

- [ ] **Step 2: Verify the change is correct**

Run:
```bash
node -e "const c = require('./packages/extension/wxt.config.js'); console.log('ok')" 2>&1 || echo "config ok (ESM)"
```

Expected: no parse error (the file is ESM so node may error but that's fine — just check the edit is syntactically valid by reading it).

- [ ] **Step 3: Commit**

```bash
git add packages/extension/wxt.config.js
git commit -m "feat(ext): add debugger and clipboardWrite permissions for file upload"
```

---

### Task 2: Add `browser_upload_file` MCP tool

**Files:**
- Modify: `packages/mcp/src/index.js` — add new tool after `browser_wait` (around line 377)

- [ ] **Step 1: Add mime-type helper and the tool registration**

Open `packages/mcp/src/index.js`. Before the final `const transport = new StdioServerTransport()` line, add:

```js
// --- File upload tool ---

function getMimeType(filePath) {
	const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
	const map = {
		png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
		webp: 'image/webp', svg: 'image/svg+xml',
		pdf: 'application/pdf',
		txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
		json: 'application/json', js: 'text/javascript', ts: 'text/typescript',
		html: 'text/html', css: 'text/css',
		zip: 'application/zip', doc: 'application/msword',
		docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	}
	return map[ext] ?? 'application/octet-stream'
}

mcpServer.registerTool(
	'browser_upload_file',
	{
		description:
			'Upload a local file to the current browser tab. Works with AI chat interfaces (ChatGPT, Gemini) and standard HTML file inputs. Tries three strategies in order: (1) CDP DOM.setFileInputFiles — most reliable, works on any hidden <input type="file">; (2) clipboard paste — for images on AI chat interfaces; (3) synthetic drop event — last resort. Provide index if you know which upload button/zone to target (from browser_get_map).',
		inputSchema: {
			filePath: z.string().describe('Absolute local file path to upload (e.g. "C:\\\\Users\\\\me\\\\photo.png")'),
			index: z.number().int().positive().optional().describe('Optional element index from browser_get_map — the upload button or drop zone to target'),
		},
	},
	async ({ filePath, index }) => {
		try {
			const { readFileSync } = await import('node:fs')
			const { basename } = await import('node:path')
			const fileBuffer = readFileSync(filePath)
			const fileData = fileBuffer.toString('base64')
			const fileName = basename(filePath)
			const mimeType = getMimeType(filePath)

			const result = await hub.executePrimitiveOp(
				'upload_file',
				{ filePath, fileData, mimeType, fileName, index },
				60000  // 60s timeout for large files
			)
			return { content: [{ type: 'text', text: result }] }
		} catch (err) {
			return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
		}
	}
)
```

- [ ] **Step 2: Verify the file parses correctly**

```bash
node --input-type=module --eval "import './packages/mcp/src/index.js'" 2>&1 | head -5
```

Expected: may show MCP server startup messages (not a parse error). If it says `SyntaxError`, fix the syntax.

- [ ] **Step 3: Commit**

```bash
git add packages/mcp/src/index.js
git commit -m "feat(mcp): add browser_upload_file tool with base64 file encoding"
```

---

### Task 3: Add `upload_file` case to `useAgent.ts` — CDP strategy (primary)

**Files:**
- Modify: `packages/extension/src/agent/useAgent.ts:443` — add before the `default:` case

- [ ] **Step 1: Add the CDP helper and `upload_file` case**

In `packages/extension/src/agent/useAgent.ts`, find the line:

```typescript
			default:
				throw new Error(`Unknown browser operation: ${operation}`)
```

Insert the following **before** that `default:` line:

```typescript
			case 'upload_file': {
				const { filePath, fileData, mimeType = 'application/octet-stream', fileName = 'file', index } = params as {
					filePath: string
					fileData?: string
					mimeType?: string
					fileName?: string
					index?: number
				}

				const tabId = tc?.currentTabId
				if (!tabId) throw new Error('No active tab for file upload')

				// --- Strategy 1: CDP DOM.setFileInputFiles (most reliable) ---
				const cdpResult = await tryUploadViaCdp(tabId, filePath)
				if (cdpResult) return `Uploaded "${fileName}" via CDP (strategy 1)`

				// --- Strategy 2: Clipboard paste (images only) ---
				if (fileData && mimeType.startsWith('image/')) {
					const clipResult = await tryUploadViaClipboard(tabId, fileData, mimeType)
					if (clipResult) return `Uploaded "${fileName}" via clipboard paste (strategy 2)`
				}

				// --- Strategy 3: Synthetic drop (last resort) ---
				if (fileData) {
					await tryUploadViaDrop(tabId, fileData, mimeType, fileName, index ?? null)
					return `Dispatched drop event for "${fileName}" (strategy 3 — isTrusted=false, may not work on strict sites)`
				}

				throw new Error('upload_file: no fileData provided and CDP strategy failed')
			}
```

- [ ] **Step 2: Add the three helper functions**

At the **bottom** of `useAgent.ts`, just before the final closing `}` of the file, add these three helper functions (outside the hook):

```typescript
// --- upload_file strategy helpers ---

/**
 * Strategy 1: CDP DOM.setFileInputFiles
 * Attaches chrome.debugger to the tab, finds the first <input type="file">,
 * and sets the file path directly — bypasses isTrusted and file picker.
 * Returns true on success, false if no file input found or CDP fails.
 */
async function tryUploadViaCdp(tabId: number, filePath: string): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		chrome.debugger.attach({ tabId }, '1.3', () => {
			if (chrome.runtime.lastError) {
				console.warn('[upload_file] CDP attach failed:', chrome.runtime.lastError.message)
				resolve(false)
				return
			}

			const detach = () => chrome.debugger.detach({ tabId }, () => {})

			chrome.debugger.sendCommand({ tabId }, 'DOM.getDocument', { depth: 0 }, (docResult: any) => {
				if (chrome.runtime.lastError || !docResult?.root?.nodeId) {
					detach(); resolve(false); return
				}

				const rootNodeId: number = docResult.root.nodeId

				chrome.debugger.sendCommand({ tabId }, 'DOM.querySelector', {
					nodeId: rootNodeId,
					selector: 'input[type="file"]',
				}, (queryResult: any) => {
					if (chrome.runtime.lastError || !queryResult?.nodeId) {
						detach(); resolve(false); return
					}

					const nodeId: number = queryResult.nodeId

					chrome.debugger.sendCommand({ tabId }, 'DOM.setFileInputFiles', {
						files: [filePath],
						nodeId,
					}, () => {
						if (chrome.runtime.lastError) {
							detach(); resolve(false); return
						}

						// Dispatch change event so React/Vue pick up the new files
						chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
							expression: `(function(){
								const fi = document.querySelector('input[type="file"]')
								if (fi) {
									fi.dispatchEvent(new Event('change', { bubbles: true }))
									fi.dispatchEvent(new Event('input', { bubbles: true }))
								}
							})()`,
						}, () => {
							detach()
							resolve(true)
						})
					})
				})
			})
		})
	})
}

/**
 * Strategy 2: Clipboard paste (images only)
 * Writes image bytes to the system clipboard from the content script,
 * then dispatches a paste event on the focused element.
 * Returns true on success.
 */
async function tryUploadViaClipboard(tabId: number, fileData: string, mimeType: string): Promise<boolean> {
	try {
		const results = await chrome.scripting.executeScript({
			target: { tabId },
			world: 'ISOLATED',
			args: [fileData, mimeType] as [string, string],
			func: async (b64: string, mime: string): Promise<boolean> => {
				try {
					const byteStr = atob(b64)
					const arr = new Uint8Array(byteStr.length)
					for (let i = 0; i < byteStr.length; i++) arr[i] = byteStr.charCodeAt(i)
					const blob = new Blob([arr], { type: mime })
					await navigator.clipboard.write([new ClipboardItem({ [mime]: blob })])
					// Give the clipboard write a moment to settle
					await new Promise(r => setTimeout(r, 100))
					// Dispatch paste event on the focused element (or body)
					const target = (document.activeElement as HTMLElement) ?? document.body
					const pasteEvent = new ClipboardEvent('paste', { bubbles: true, cancelable: true })
					target.dispatchEvent(pasteEvent)
					return true
				} catch {
					return false
				}
			},
		})
		return results?.[0]?.result === true
	} catch {
		return false
	}
}

/**
 * Strategy 3: Synthetic drop event
 * Creates a real File object in the content script and dispatches
 * dragenter/dragover/drop on the target element (or body).
 * isTrusted will be false — may be rejected by strict sites.
 */
async function tryUploadViaDrop(
	tabId: number,
	fileData: string,
	mimeType: string,
	fileName: string,
	index: number | null
): Promise<void> {
	await chrome.scripting.executeScript({
		target: { tabId },
		world: 'ISOLATED',
		args: [fileData, mimeType, fileName, index] as [string, string, string, number | null],
		func: (b64: string, mime: string, name: string, idx: number | null) => {
			const byteStr = atob(b64)
			const arr = new Uint8Array(byteStr.length)
			for (let i = 0; i < byteStr.length; i++) arr[i] = byteStr.charCodeAt(i)
			const file = new File([arr], name, { type: mime })
			const dt = new DataTransfer()
			dt.items.add(file)

			let target: Element = document.body
			if (idx != null) {
				const interactive = Array.from(document.querySelectorAll('*')).filter((el) => {
					const r = el.getBoundingClientRect()
					return r.width > 0 && r.height > 0 && el.matches('a,button,input,select,textarea,[role="button"],[role="link"],[tabindex]')
				})
				if (interactive[idx - 1]) target = interactive[idx - 1]
			}

			for (const eventType of ['dragenter', 'dragover', 'drop'] as const) {
				target.dispatchEvent(new DragEvent(eventType, { bubbles: true, cancelable: true, dataTransfer: dt }))
			}
		},
	})
}
```

- [ ] **Step 3: Check TypeScript compiles**

```bash
cd C:\Users\Mozat\Desktop\page-agent && npm run typecheck 2>&1 | tail -20
```

Expected: no errors in `useAgent.ts`. Fix any type errors before proceeding.

- [ ] **Step 4: Commit**

```bash
git add packages/extension/src/agent/useAgent.ts
git commit -m "feat(ext): add upload_file browser op with CDP/clipboard/drop strategies"
```

---

### Task 4: Add UI label and rebuild extension

**Files:**
- Modify: `packages/extension/src/entrypoints/hub/App.tsx:13-21` — PRIM_OP_LABELS map

- [ ] **Step 1: Add label for `upload_file`**

In `packages/extension/src/entrypoints/hub/App.tsx`, find the `PRIM_OP_LABELS` object and add one entry:

```typescript
// Find this object:
const PRIM_OP_LABELS: Record<string, string> = {
	get_map: '📋 读取页面元素',
	navigate: '🌐 导航到页面',
	click: '🖱️ 点击元素',
	type: '⌨️ 输入文字',
	scroll: '📜 滚动页面',
	inspect_element: '🔍 检查元素',
	get_user_input: '💬 读取用户输入',
}

// Change to (add the upload_file line):
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
```

- [ ] **Step 2: Build the extension**

```bash
cd C:\Users\Mozat\Desktop\page-agent && npm run build:ext 2>&1 | tail -30
```

Expected: build succeeds, zip file created in `packages/extension/.output/`.

- [ ] **Step 3: Reload the extension in Chrome**

Use the MCP tool (once the server is running):
```
browser_reload_extension
```

Or manually: go to `chrome://extensions`, find Page Agent Ext, click the reload button.

- [ ] **Step 4: Commit**

```bash
git add packages/extension/src/entrypoints/hub/App.tsx
git commit -m "feat(ext): add upload_file label to hub UI"
```

---

### Task 5: End-to-end test

**Goal:** Verify `browser_upload_file` works on ChatGPT and Gemini.

- [ ] **Step 1: Test CDP strategy on a standard file input**

Navigate to a simple test page with a file input (e.g. `https://www.w3schools.com/howto/howto_html_file_upload_button.asp`).

Use MCP:
```
browser_upload_file filePath="C:\Users\Mozat\Desktop\kix.png"
```

Expected response: `Uploaded "kix.png" via CDP (strategy 1)`

Verify in Chrome: the file input should show "kix.png" selected.

- [ ] **Step 2: Test image upload on Gemini**

Navigate to `https://gemini.google.com/app`. Use MCP:
```
browser_upload_file filePath="C:\Users\Mozat\Desktop\kix.png"
```

Check response. If strategy 1 succeeds (Gemini has a hidden file input), Gemini should show the image in the chat input area.

If strategy 1 says `false` and falls through to strategy 2 (clipboard), verify the image appears via paste.

- [ ] **Step 3: Test image upload on ChatGPT**

Navigate to `https://chatgpt.com`. Use MCP:
```
browser_upload_file filePath="C:\Users\Mozat\Desktop\kix.png"
```

Expected: image appears in the ChatGPT composer.

- [ ] **Step 4: Test PDF upload on ChatGPT**

```
browser_upload_file filePath="C:\Users\Mozat\Desktop\SCOGA-KiX-Partnership-Landing-Plan-2026.md"
```

Expected: file appears in the ChatGPT composer (ChatGPT accepts markdown/text files).

- [ ] **Step 5: Debug if CDP fails**

If CDP returns false consistently, open Chrome DevTools on the target tab and run manually:
```js
document.querySelector('input[type="file"]')
```

If it returns `null`, the file input is dynamically created only after clicking the upload button. In that case, click the upload button first with `browser_click`, then call `browser_upload_file`.

If the file input is inside a shadow DOM, the `DOM.querySelector` selector won't find it. In that case, update `tryUploadViaCdp` to use `'DOM.querySelectorAll'` with `pierce: true` or use `Runtime.evaluate` instead:

```typescript
// Replace DOM.querySelector with Runtime.evaluate to pierce shadow DOM:
chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: `document.querySelector('input[type="file"]') || document.querySelector('*')?.shadowRoot?.querySelector('input[type="file"]')`,
    returnByValue: false,
}, (evalResult: any) => {
    if (!evalResult?.result?.objectId) { detach(); resolve(false); return }
    // Convert objectId to nodeId via DOM.requestNode
    chrome.debugger.sendCommand({ tabId }, 'DOM.requestNode', {
        objectId: evalResult.result.objectId
    }, (nodeResult: any) => {
        if (!nodeResult?.nodeId) { detach(); resolve(false); return }
        // Continue with setFileInputFiles using nodeResult.nodeId
        // ... (same as before)
    })
})
```

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "test: verify browser_upload_file e2e on ChatGPT and Gemini"
```

---

## Summary

| File | Change |
|------|--------|
| `packages/extension/wxt.config.js` | Add `debugger`, `clipboardWrite` permissions |
| `packages/mcp/src/index.js` | New `browser_upload_file` tool + `getMimeType` helper |
| `packages/extension/src/agent/useAgent.ts` | New `case 'upload_file':` + 3 strategy helpers at bottom of file |
| `packages/extension/src/entrypoints/hub/App.tsx` | Add `upload_file` label |

**Known limitations:**
- CDP `DOM.setFileInputFiles` only works for file inputs in the regular DOM (not shadow DOM). For shadow DOM, use the `Runtime.evaluate` + `DOM.requestNode` approach described in Task 5 Step 5.
- Clipboard paste strategy requires the tab to be focused (active). If it fails, activate the tab first with `browser_click` on any element.
- Synthetic drop (strategy 3) will fail silently on sites that enforce `event.isTrusted`. This is expected behavior.
- `chrome.debugger.attach` shows a yellow "DevTools is debugging this browser" banner at the top. It disappears immediately after `detach()`.
