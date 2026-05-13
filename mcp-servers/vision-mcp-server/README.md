<div align="center">

# 👁️ Vision MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-Compatible-green.svg)](https://modelcontextprotocol.io/)

**Give your AI agent eyes.** An MCP server providing multimodal vision capabilities — image analysis, OCR, image comparison, and video analysis — powered by any OpenAI-compatible vision model.

**让你的 AI 代理拥有视觉能力。** 通过任何 OpenAI 兼容的视觉模型，提供图像分析、OCR 文字识别、图像对比和视频分析。

[Features](#-features) · [Quick Start](#-quick-start) · [Tools](#️-tools-reference) · [Models](#-supported-models) · [中文说明](#-中文说明)

</div>

---

## ✨ Features

| Tool | Description |
|------|-------------|
| 🔍 `analyze_image` | Analyze images with natural language prompts |
| 📝 `ocr_image` | Extract text from images (plain text / Markdown / JSON) |
| 🔀 `compare_images` | Compare 2–4 images side by side |
| 🎬 `analyze_video` | Analyze video content (requires video-capable model) |

**Plus:**
- 🌐 **OpenAI-compatible** — Works with any vision model via standard API
- 📁 **Local files & URLs** — Auto-converts local files to base64
- ⚙️ **Configurable** — Environment variables, config files, or both

## 🚀 Quick Start

### 1. Install

```bash
git clone https://github.com/Loveacup/vision-mcp-server.git
cd vision-mcp-server
npm install && npm run build
```

### 2. Configure

Create a `.env` file in the project root:

```bash
VISION_BASE_URL=http://your-server:port/v1/chat/completions
VISION_MODEL=Qwen3-VL-32B
VISION_API_KEY=your-api-key    # optional for local models
```

<details>
<summary>📄 Or use <code>config.json</code></summary>

```json
{
  "baseUrl": "http://your-server:port/v1/chat/completions",
  "model": "Qwen3-VL-32B",
  "apiKey": "your-api-key",
  "maxTokens": 4096,
  "temperature": 0.7
}
```

</details>

### 3. Run

```bash
npm start
```

The server communicates over stdio, designed to be launched by an MCP client such as Claude Code.

## 🔌 Claude Code Integration

Add to your `~/.mcp.json`:

```json
{
  "mcpServers": {
    "vision": {
      "command": "node",
      "args": ["/path/to/vision-mcp-server/dist/index.js"],
      "env": {
        "VISION_BASE_URL": "http://your-server:port/v1/chat/completions",
        "VISION_MODEL": "Qwen3-VL-32B",
        "VISION_API_KEY": "your-api-key"
      }
    }
  }
}
```

> Replace `/path/to/vision-mcp-server` with the actual install path.

## ⚙️ Configuration Reference

Configuration priority: **environment variables > config file > defaults**

| Variable | Config Key | Default | Description |
|---|---|---|---|
| `VISION_BASE_URL` | `baseUrl` | *(required)* | OpenAI-compatible chat completions endpoint |
| `VISION_MODEL` | `model` | `Qwen3-VL-32B` | Model name |
| `VISION_API_KEY` | `apiKey` | *(empty)* | API key (optional for local models) |
| `VISION_MAX_TOKENS` | `maxTokens` | `4096` | Max response tokens |
| `VISION_TEMPERATURE` | `temperature` | `0.7` | Sampling temperature |

## 🛠️ Tools Reference

### `analyze_image`

Analyze an image with a vision language model.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `image` | string | ✅ | — | Local file path or URL |
| `prompt` | string | | `"Describe this image in detail."` | Analysis prompt |
| `detail` | `"low"` \| `"high"` \| `"auto"` | | `"auto"` | Detail level |

### `ocr_image`

Extract text from an image using OCR.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `image` | string | ✅ | — | Local file path or URL |
| `languages` | string | | `""` | Language hint, e.g. `"zh,en"` |
| `format` | `"plain"` \| `"markdown"` \| `"json"` | | `"plain"` | Output format |

### `compare_images`

Compare 2–4 images and describe differences/similarities.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `images` | string[] | ✅ | — | 2–4 image sources |
| `prompt` | string | | `"Compare these images..."` | Comparison prompt |

### `analyze_video`

Analyze video content. Requires a model with video support (e.g., Qwen3-VL).

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `video` | string | ✅ | — | Local file path or URL |
| `prompt` | string | | `"Describe what happens in this video."` | Analysis prompt |

## 🤖 Supported Models

| Model | Provider | Image | Video | Notes |
|---|---|:---:|:---:|---|
| **Qwen3-VL** | Self-hosted / API | ✅ | ✅ | Recommended. Full multimodal support |
| **GPT-4o** | OpenAI | ✅ | ❌ | Strong image analysis |
| **LLaVA** | Self-hosted | ✅ | ❌ | Open-source alternative |
| **InternVL** | Self-hosted | ✅ | ⚠️ | Strong multilingual OCR |

Any model served via vLLM, Ollama, LMDeploy, or other OpenAI-compatible servers should work.

**Supported formats:** JPEG, PNG, GIF, WebP, BMP, SVG | MP4, AVI, MOV, MKV, WebM

## 📁 Project Structure

```
vision-mcp-server/
├── src/
│   ├── index.ts              # MCP server entry point
│   ├── config.ts             # Configuration loader
│   ├── types.ts              # TypeScript type definitions
│   ├── tools/
│   │   ├── analyze-image.ts
│   │   ├── ocr-image.ts
│   │   ├── compare-images.ts
│   │   └── analyze-video.ts
│   └── utils/
│       ├── api-client.ts     # OpenAI-compatible API client
│       └── file-handler.ts   # Local file → base64
├── package.json
├── tsconfig.json
├── .env.example
└── LICENSE
```

## 📄 License

[MIT](LICENSE)

---

## 🇨🇳 中文说明

### 功能

- **`analyze_image`** — 使用视觉语言模型分析图像，支持自然语言提问
- **`ocr_image`** — OCR 文字识别，支持纯文本、Markdown、JSON 输出
- **`compare_images`** — 对比 2–4 张图像，识别差异和相似之处
- **`analyze_video`** — 分析视频内容（需要 Qwen3-VL 等支持视频的模型）

### 快速开始

```bash
git clone https://github.com/Loveacup/vision-mcp-server.git
cd vision-mcp-server
npm install && npm run build
```

配置 `.env`：

```bash
VISION_BASE_URL=http://your-server:port/v1/chat/completions
VISION_MODEL=Qwen3-VL-32B
VISION_API_KEY=your-api-key
```

在 Claude Code 的 `~/.mcp.json` 中添加：

```json
{
  "mcpServers": {
    "vision": {
      "command": "node",
      "args": ["/path/to/vision-mcp-server/dist/index.js"],
      "env": {
        "VISION_BASE_URL": "http://your-server:port/v1/chat/completions",
        "VISION_MODEL": "Qwen3-VL-32B",
        "VISION_API_KEY": "your-api-key"
      }
    }
  }
}
```

将 `/path/to/vision-mcp-server` 替换为实际安装路径。
