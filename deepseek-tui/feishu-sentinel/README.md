# 飞书截图哨兵 v2.0 — Feishu Screenshot Sentinel

> 解决飞书截图在 AI 编程工具（Claude Code / Cursor / Windsurf 等）中无法直接粘贴的痛点。

## 🎯 功能

| 快捷键 | 效果 |
|--------|------|
| `Ctrl+Shift+A` | 飞书原生截图，剪贴板 = **图片**（发微信 / Gemini 照常使用） |
| `Ctrl+Shift+X` | **AI 截图**：自动唤起飞书截图 → 框选区域 → 剪贴板变成 **文件路径** |
| `Esc` | 取消等待 / 重置按键状态 |

### 工作流程

```
按下 Ctrl+Shift+X
     │
     ▼
脚本模拟 Ctrl+Shift+A → 飞书截图工具弹出
     │
     ▼
你框选截图区域（和平时一样）
     │
     ▼
脚本检测到剪贴板中有新图片
     │
     ▼
保存到 feishu_uploads/ 文件夹
     │
     ▼
剪贴板替换为文件路径（如 D:\...\feishu_uploads\cap_20250101_120000.png）
     │
     ▼
在 Claude Code 中 Ctrl+V → 直接粘贴路径，AI 可以读取文件！
```

## 🚀 快速开始

### 1. 安装 Python

- Python 3.9+：[下载地址](https://python.org/downloads/)
- 安装时勾选 ✅ **Add Python to PATH**

### 2. 双击启动

```
双击 开始监控.bat
```

首次运行会自动安装依赖，之后直接启动。

### 3. 使用

- 在飞书/企业微信中按 `Ctrl+Shift+X` → 框选区域
- 截图自动保存到 `feishu_uploads/` 文件夹
- 剪贴板自动变成文件路径
- 在 AI 工具中 `Ctrl+V` 粘贴即可

## ⚙️ 配置

编辑 `config.json` 自定义行为：

```json
{
    "save_dir": "feishu_uploads",
    "file_prefix": "cap",
    "max_files": 20,
    "timeout_seconds": 20.0,
    "image_format": "PNG",
    "image_quality": 85,
    "notification": true,
    "log_level": "INFO",
    "tray_icon": true,
    "simulate_delay": 0.35,
    "hotkeys": {
        "ai_screenshot": ["ctrl", "shift", "x"]
    }
}
```

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `save_dir` | 截图保存目录 | `feishu_uploads` |
| `file_prefix` | 文件名前缀 | `cap` |
| `max_files` | 最多保留文件数 | `20` |
| `timeout_seconds` | 截图等待超时 | `20` |
| `image_format` | 图片格式（PNG/JPEG） | `PNG` |
| `image_quality` | JPEG 质量 (1-100) | `85` |
| `notification` | Windows 通知 | `true` |
| `tray_icon` | 系统托盘图标 | `true` |
| `simulate_delay` | 模拟热键延迟 | `0.35` |

## 📁 文件结构

```
claude-feishu_send_picture/
├── feishu_screenshot_guard.py   # 核心脚本
├── config.json                  # 用户配置
├── requirements.txt             # Python 依赖
├── 开始监控.bat                  # Windows 启动入口
├── feishu_uploads/              # 截图自动保存目录
├── AI                           # 快捷键说明
└── Feishu                       # 快捷键说明
```

## 🔧 依赖

```
pynput>=1.7.6    # 全局热键监听 & 模拟按键
Pillow>=10.0.0   # 图片处理
pyperclip>=1.8.2 # 剪贴板读写
pystray>=0.19.0  # 系统托盘（可选）
```

## ❓ 常见问题

**Q: 按 Ctrl+Shift+X 没反应？**
- 确认已以管理员身份运行
- 检查是否有其他程序占用该快捷键
- 查看 `sentinel.log` 日志文件

**Q: 截图后剪贴板还是图片不是路径？**
- 飞书截图工具的"自动复制到剪贴板"功能必须开启
- 确保截图区域有效（非全黑/全白）

**Q: 如何自定义快捷键？**
- 编辑 `config.json` 中的 `hotkeys.ai_screenshot` 数组
- 支持: ctrl, shift, alt + 字母键

**Q: 如何停止？**
- 关闭黑色窗口，或按 `Ctrl+C`
- 系统托盘右键 → 退出

## 📜 License

MIT
