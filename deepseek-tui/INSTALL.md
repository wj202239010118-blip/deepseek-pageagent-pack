# DeepSeek TUI — 安装指南

## 简介

DeepSeek TUI 是一个终端里的 AI 编程助手，对标 Claude Code。它运行在命令行中，能读代码、搜索工程、执行测试、操作 Git，还能并行启动子 Agent 做多路探索。

它与 Page Agent 配合使用：**DeepSeek TUI 是大脑（指挥）**，**Page Agent 是手（操控浏览器网页）**。

---

## 安装

### Windows

```powershell
# 通过 winget 安装
winget install deepseek-tui

# 或下载安装包
# https://github.com/deepseek-ai/deepseek-tui/releases
```

### macOS

```bash
# Homebrew
brew install deepseek-tui

# 或下载安装包
# https://github.com/deepseek-ai/deepseek-tui/releases
```

### Linux

```bash
# 下载二进制
curl -fsSL https://dl.deepseek.com/tui/install.sh | bash

# 或手动下载
# https://github.com/deepseek-ai/deepseek-tui/releases
```

---

## 配置

### 1. 获取 API Key

在 [platform.deepseek.com](https://platform.deepseek.com) 注册并获取 API Key。

### 2. 创建配置文件

```bash
mkdir -p ~/.deepseek
```

将本仓库的 `deepseek-tui/config.toml` 复制到 `~/.deepseek/config.toml`：

```bash
cp deepseek-tui/config.toml ~/.deepseek/config.toml
```

### 3. 填入 API Key

编辑 `~/.deepseek/config.toml`，将 `YOUR_DEEPSEEK_API_KEY` 替换为你的真实 key：

```toml
api_key = "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

### 4. 验证

```bash
deepseek --version
deepseek          # 启动 TUI
```

---

## 接入 Page Agent (MCP)

Page Agent 提供 MCP Server，让 DeepSeek TUI 可以直接操控浏览器。

### 启动 MCP Server

```bash
cd page-agent
npm install
npx -y @page-agent/mcp
```

### 在 DeepSeek TUI 中配置 MCP

编辑 `~/.deepseek/config.toml`，添加：

```toml
[mcp_servers.page-agent]
command = "npx"
args    = ["-y", "@page-agent/mcp"]
```

---

## 快速开始

```bash
# 1. 启动 DeepSeek TUI
deepseek

# 2. 在 TUI 中输入任务
> 帮我打开 GitHub，搜索 page-agent 项目的最新 issue

# 3. DeepSeek 自动通过 Page Agent MCP 操作浏览器
```

---

## 常用命令

| 命令 | 说明 |
|------|------|
| `/help` | 查看帮助 |
| `/provider` | 切换模型提供商 |
| `/compact` | 压缩上下文 |
| `/cost` | 查看费用统计 |
| `Shift+Tab` | 切换推理深度 (high/max) |
| `Ctrl+R` | 重试当前请求 |

---

## 目录结构

```
~/.deepseek/
├── config.toml      # 主配置（API key、模型、审批策略）
├── memory.md        # 持久记忆（跨会话保留）
├── AGENTS.md        # 全局 Agent 指令（可选覆盖）
├── skills/          # 自定义技能
├── sessions/        # 会话记录
└── logs/            # 运行日志
```
