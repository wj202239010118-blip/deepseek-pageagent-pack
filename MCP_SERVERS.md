# MCP Servers — Extended Capabilities for DeepSeek TUI

本目录包含 DeepSeek TUI 的 MCP Server 扩展，填补 AI 能力空缺。

## 已集成的 MCP Servers

### 👁️ Vision MCP Server (`mcp-servers/vision-mcp-server/`)

**能力：图像理解、OCR 文字识别、图像对比、视频分析**

| 工具 | 用途 |
|------|------|
| `analyze_image` | 用自然语言分析图像内容 |
| `ocr_image` | 从图像中提取文字（支持中英文） |
| `compare_images` | 对比 2-4 张图像的差异 |
| `analyze_video` | 分析视频内容（需 Qwen3-VL 等模型） |

**安装：** 已内置在仓库中，`npm install && npm run build` 完成。

**配置：** 需要 OpenAI 兼容的 Vision 模型。推荐：
- **Qwen3-VL** (自部署/API，支持图像+视频)
- **GPT-4o** (OpenAI，仅图像)
- **InternVL** (开源，多语言 OCR 强)

### 📄 PDF MCP Server

**能力：PDF 读取、搜索、OCR、表格提取**

| 工具 | 用途 |
|------|------|
| `pdf_info` | 获取文档信息（页数、元数据、token 估算） |
| `pdf_read_pages` | 按页读取（含表格、图片提取） |
| `pdf_search` | 混合搜索（BM25 + 语义搜索） |

**安装：** `pip install pdf-mcp`（已完成）

**特性：**
- 分页读取，不会撑爆上下文窗口
- SQLite 缓存，重启不丢失
- OCR 支持扫描件
- 表格自动提取为结构化数据

### 📁 Filesystem MCP Server

**能力：安全文件系统操作**

| 工具 | 用途 |
|------|------|
| `read_file` | 读取文件 |
| `write_file` | 写入文件 |
| `create_directory` | 创建目录 |
| `list_directory` | 列出目录 |
| `move_file` | 移动文件 |
| `search_files` | 搜索文件 |
| `get_file_info` | 获取文件元数据 |

**安装：** `npm install -g @modelcontextprotocol/server-filesystem`

**安全：** 通过 `args` 参数限制可访问目录，防止越权操作。

---

## 配置方法

编辑 `~/.deepseek/config.toml`，在末尾添加：

```toml
# ─── Vision MCP Server ───
[mcp_servers.vision]
command = "node"
args    = ["path/to/mcp-servers/vision-mcp-server/dist/index.js"]
env     = { VISION_BASE_URL = "https://api.openai.com/v1", VISION_MODEL = "gpt-4o", VISION_API_KEY = "YOUR_OPENAI_KEY" }

# ─── PDF MCP Server ───
[mcp_servers.pdf]
command = "pdf-mcp"

# ─── Filesystem MCP Server ───
[mcp_servers.filesystem]
command = "npx"
args    = ["-y", "@modelcontextprotocol/server-filesystem", "C:\\Users\\YOURNAME\\Desktop"]
```

> 将 `YOUR_OPENAI_KEY` 和 `YOURNAME` 替换为实际值。

---

## 使用示例

在 DeepSeek TUI 中：

```
> 分析这张截图里的报错信息
> OCR 这张图片，提取所有文字，输出 Markdown 格式
> 读取这个 PDF 的第 3-5 页，提取表格数据
> 在 PDF 中搜索所有提到 "API key" 的页面
> 对比这两张 UI 设计图，找出差异
```

---

## 能力矩阵

| 能力 | 之前 | 现在 |
|------|:----:|:----:|
| 读代码 | ✅ | ✅ |
| 搜索代码库 | ✅ | ✅ |
| Git 操作 | ✅ | ✅ |
| 浏览器操控 | ✅ (Page Agent) | ✅ |
| **看图/截图** | ❌ | ✅ (Vision) |
| **OCR 文字识别** | ❌ | ✅ (Vision) |
| **读取 PDF** | 基础文本 | ✅ (PDF MCP) |
| **PDF 搜索** | ❌ | ✅ (PDF MCP) |
| **PDF 表格提取** | ❌ | ✅ (PDF MCP) |
| **视频分析** | ❌ | ✅ (Vision) |
| **图像对比** | ❌ | ✅ (Vision) |

---

## 维护

更新 MCP servers：

```bash
# Vision
cd mcp-servers/vision-mcp-server && git pull && npm install && npm run build

# PDF
pip install --upgrade pdf-mcp

# Filesystem
npm update -g @modelcontextprotocol/server-filesystem
```
