# DeepSeek TUI + Page Agent — AI 开发工具箱

<p align="center">
  <b>🧠 DeepSeek TUI 是你的 AI 编程大脑 | 🖐️ Page Agent 是你的浏览器之手</b>
</p>

---

## 这是什么？

一套开箱即用的 AI 开发环境，包含两个核心组件：

### 🤖 DeepSeek TUI — 终端 AI 编程助手

对标 Claude Code 的命令行 AI Agent。它在你的终端里运行，能：

- 📖 阅读和理解整个代码库
- 🔍 多路并行搜索（子 Agent 并发探索）
- ✏️ 自动编写和修改代码
- 🧪 运行测试、检查类型、格式化代码
- 🔀 操作 Git（查看 diff、创建 commit）
- 🧩 通过 MCP 协议接入外部工具（如 Page Agent）

### 🖥️ Page Agent — 浏览器操控 Agent

阿里巴巴开源的网页 AI 操控库。让 AI 能：

- 🖱️ 点击按钮、填写表单、滚动页面
- 🧭 跨标签页导航
- 📊 提取和分析网页内容
- 🔌 通过 Chrome 扩展 + MCP Server 被 DeepSeek TUI 调用

**两者结合：在 DeepSeek TUI 里说"帮我在浏览器里完成 X"，它自动操控浏览器执行。**

---

## 📦 仓库结构

```
deepseek-pageagent-pack/
├── README.md                    # ← 你在这里
├── setup.bat                    # Windows 一键安装脚本
├── .gitignore
├── deepseek-tui/
│   ├── config.toml              # DeepSeek TUI 配置模板（填入你的 API key）
│   ├── INSTALL.md               # 安装与配置指南
│   └── AGENTS.md                # 推荐 Agent 指令（可选）
└── page-agent/                  # Page Agent 源码（阿里巴巴 MIT 开源）
    ├── packages/
    │   ├── page-agent/          # 主入口
    │   ├── core/                # 核心 Agent 逻辑
    │   ├── llms/                # LLM 客户端
    │   ├── page-controller/     # DOM 操作引擎
    │   ├── extension/           # Chrome 扩展 (WXT + React)
    │   ├── mcp/                 # MCP Server
    │   ├── ui/                  # UI 面板
    │   └── website/             # 文档站点
    └── ...
```

---

## 🚀 快速开始

### 前提条件

- **Node.js** ≥ 22.13 或 ≥ 24
- **Chrome** 浏览器（Page Agent 扩展需要）
- **DeepSeek API Key**（在 [platform.deepseek.com](https://platform.deepseek.com) 获取）

### 1. 安装 DeepSeek TUI

```bash
# Windows
winget install deepseek-tui

# macOS
brew install deepseek-tui

# Linux
curl -fsSL https://dl.deepseek.com/tui/install.sh | bash
```

### 2. 配置 DeepSeek TUI

```bash
# 复制配置模板
cp deepseek-tui/config.toml ~/.deepseek/config.toml
```

编辑 `~/.deepseek/config.toml`，填入你的 API Key：

```toml
api_key = "sk-your-deepseek-api-key"
```

### 3. 安装 Page Agent

```bash
cd page-agent
npm install
npm run build:libs
```

### 4. 加载 Chrome 扩展

1. 打开 Chrome，进入 `chrome://extensions/`
2. 开启"开发者模式"
3. 点击"加载已解压的扩展程序"
4. 选择 `page-agent/packages/extension/dist` 目录

### 5. 启动 MCP Server（让 DeepSeek 能操控浏览器）

```bash
cd page-agent
npx -y @page-agent/mcp
```

### 6. 在 DeepSeek TUI 中配置 MCP

编辑 `~/.deepseek/config.toml`，添加：

```toml
[mcp_servers.page-agent]
command = "npx"
args    = ["-y", "@page-agent/mcp"]
```

### 7. 开始使用

```bash
deepseek
```

在 TUI 中输入：

```
> 打开 GitHub，看看 alibaba/page-agent 有没有新的 issue
```

DeepSeek TUI 会自动通过 Page Agent 操控你的浏览器。

---

## ⚙️ MCP 配置参考

DeepSeek TUI 通过 MCP 协议调用 Page Agent。完整流程：

```
DeepSeek TUI (终端) 
    ↓ MCP 协议
Page Agent MCP Server (npx @page-agent/mcp)
    ↓ WebSocket
Page Agent Chrome Extension (浏览器)
    ↓ DOM 操作
网页
```

---

## 🔑 API Key 说明

**本仓库不包含任何 API Key。** 你需要自行获取：

| 服务 | 获取地址 | 配置位置 |
|------|----------|----------|
| DeepSeek API | [platform.deepseek.com](https://platform.deepseek.com) | `~/.deepseek/config.toml` |
| OpenRouter (备用) | [openrouter.ai/keys](https://openrouter.ai/keys) | `~/.deepseek/config.toml` → `[providers.openrouter]` |
| Page Agent LLM | 任一 OpenAI 兼容 API | Page Agent 初始化时传入 |

---

## 🧩 Page Agent 独立使用

如果你只想用 Page Agent（不用 DeepSeek TUI），在网页中引入即可：

```html
<script src="https://cdn.jsdelivr.net/npm/page-agent@1.8.0/dist/iife/page-agent.demo.js" 
        crossorigin="true"></script>
```

```javascript
import { PageAgent } from 'page-agent'

const agent = new PageAgent({
    model: 'qwen3.5-plus',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: 'YOUR_API_KEY',
    language: 'zh-CN',
})

await agent.execute('点击登录按钮')
```

详细文档见 [Page Agent 官方文档](https://alibaba.github.io/page-agent/)。

---

## 🛠️ 可选：全局 Agent 指令

本项目附带了一套优化的 Agent 指令（`deepseek-tui/AGENTS.md`），让 DeepSeek TUI 更激进地自主工作：

```bash
cp deepseek-tui/AGENTS.md ~/.deepseek/AGENTS.md
```

特点：
- 先行动再汇报（减少不必要的确认）
- 并行子 Agent 探索（多文件同时分析）
- 自动格式化 / 自动测试 / 自动检查

---

## 📋 许可证

- **DeepSeek TUI**: DeepSeek License
- **Page Agent**: [MIT License](https://github.com/alibaba/page-agent/blob/main/LICENSE)
- **本仓库配置/文档**: MIT License

---

## 🤝 贡献

欢迎提 Issue 和 PR。本项目仅供内部团队使用，旨在降低 AI 开发工具的配置门槛。

---

**⭐ 如果这个工具包对你有用，请 Star！**
