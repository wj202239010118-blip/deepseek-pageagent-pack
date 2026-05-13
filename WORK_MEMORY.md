# 工作记忆 / Work Memory

## 已固化的工作流程

### 1. Page Agent MCP — 浏览器操控
- **启动**: `node C:\Users\Mozat\Desktop\page-agent\scripts\deepseek-bridge.js` (background)
- **API**: `POST http://127.0.0.1:38406/execute` → `{"tool":"...", "args":{...}}`
- **Pattern**: `write_file` → temp JSON → `curl --data-binary @file`
- **GitHub**: 已登录 wj202239010118-blip，直接操作无需 token

### 2. MCP Server 集成
- Vision MCP: `mcp-servers/vision-mcp-server/dist/index.js`
- PDF MCP: `pdf-mcp` (pip)
- Filesystem MCP: `npx @modelcontextprotocol/server-filesystem`

### 3. 项目发布流程
- 目标仓库: `github.com/wj202239010118-blip/deepseek-pageagent-pack`
- 本地路径: `C:\Users\Mozat\Desktop\deepseek-pageagent-pack`
- 提交流程: git add → commit → push origin main
- 发布前检查: 无 API key 泄露

### 4. DeepSeek TUI 能力边界
- ✅ 文件读写、代码生成、Git、Shell、搜索
- ✅ 浏览器操控 (via Page Agent MCP)
- ✅ 图像分析/OCR (via Vision MCP)
- ✅ PDF 处理 (via PDF MCP)
- ❌ 音视频处理（有限）
- ❌ 数据库直连（需额外 MCP）
