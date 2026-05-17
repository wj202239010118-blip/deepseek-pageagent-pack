# DeepSeek TUI — 持久化记忆
# 每次会话启动时自动加载，无需重复沟通

## 环境信息

- **操作系统**: Windows 10/11 x64
- **Python**: 3.11.9 (python)
- **Node.js**: v24.14.0 (node)
- **DeepSeek 版本**: 0.0.0-self（设备自用，脱离官方更新）
- **安装方式**: npm wrapper (全局)
- **二进制路径**: `%APPDATA%\npm\node_modules\deepseek-tui\bin\downloads\`

## 版本状态 (2026-05-16)
- **状态**: 已脱离官方更新机制，设备自用版本 `0.0.0-self`
- **二进制**: v0.8.38 已下载（`deepseek.exe.download` + `deepseek-tui.exe.download`）
- **替换脚本**: `replace_binaries.bat`（退出 TUI 后运行以完成替换）

## 资源迁移 (2026-05-16)
所有项目文件已从桌面迁移到 `.deepseek` 目录：

| 项目 | 旧位置 | 新位置 |
|------|--------|--------|
| 飞书截图哨兵 | `~/claude-feishu_send_picture/` | `~/.deepseek/feishu-sentinel/` |
| MarkItDown 源码 | 桌面 `markitdown-main/` | `~/.deepseek/markitdown/` |
| MarkItDown 包 | pip 已安装 | `markitdown[all]` |

## Skills 目录
- 路径: `C:\Users\86133\.claude\skills\`
- 已添加: `markitdown` — 文档转 Markdown

## Sidecar 组件（随 TUI 启动/关闭）
1. **Page Agent MCP Server** (port 38401) — 浏览器操控
   - 路径: `~/deepseek-pageagent-pack/page-agent/packages/mcp/src/index.js`
   - 验证: stderr 输出 `[page-agent-mcp] HTTP + WS on http://localhost:38401`
   - 端口检查: netstat :38401 LISTENING
2. **Session Manager（2026-05-17）** — 终端原生会话管理器 (Textual)
   - 路径: `~/.deepseek/session_manager.py`
   - 框架: Python Textual 8.2.6
   - 功能: 分栏显示会话列表 + 消息预览，恢复/删除/钉选/改备注
   - 替代: 旧 tkinter sidebar（已废弃）
   - 键盘: N新建 D删除 P置顶 Enter恢复 R刷新 Q退出
   - 集成: run.js 改为会话管理器循环 -> `deepseek resume <id>`
   - 通信: `~/.deepseek/.resume_target`（目标会话 ID）
   - 崩溃恢复: `~/.deepseek/.last_session`（持久化，永不删除，标记上次活跃会话）
   - 路径展示: 预览面板自动提取 turn_meta 中的 Active paths 并显示
3. **飞书截图哨兵** — `~/.deepseek/feishu-sentinel/feishu_screenshot_guard.py`
4. **WeChat ↔ TUI 桥接** — `~/.deepseek/wechat_bridge.py`
   - 双向转发：微信浮生 ⇄ DeepSeek TUI 输入/输出
   - 苏醒守护：微信发 "deepseek苏醒" → 自动拉起 TUI
   - 依赖: pynput, pyperclip（均已安装）
## 核心能力

### Pageagent MCP
- 可用工具: browser_open_tab, browser_get_map, browser_click, browser_type, browser_scroll, browser_inspect_element, browser_navigate
- 多 AI 站点: ~/.deepseek/pageagent-site-handlers.json (11个)
- GitHub 已登录: wj202239010118-blip
### Vision MCP Server — 深度求索看图（实验性）
- **路径**: `~/deepseek-pageagent-pack/mcp-servers/vision-mcp-server/`
- **后端**: DeepSeek V4 Pro API（零额外内存，API 侧处理）
- **工具**:
  - `analyze_image` — 分析图片内容（本地路径/URL 均可）
  - `ocr_image` — 提取图片文字（支持 plain/markdown/json 输出）
  - `compare_images` — 比较多张图片差异
  - `analyze_video` — 分析视频内容
- **配置**: `~/.deepseek/mcp.json` 中已启用 `vision` server
- **状态**: 重启 TUI 后工具自动注册可用

### Vision MCP Server — 深度求索看图（实验性）
- **路径**: `~/deepseek-pageagent-pack/mcp-servers/vision-mcp-server/`
- **后端**: DeepSeek V4 Pro API（零额外内存，API 侧处理）
- **状态**: MCP tools 未注册（需要 TUI 重启时自动连接）
- **替代方案**: Vision Relay（见 AGENTS.md）

### Vision Relay — 剪贴板 → Web AI → DeepSeek 看图回路
当 Vision MCP 不可用时，通过 Page Agent 操控 Web AI 实现看图：
1. 图片 → 剪贴板（`clipboard_image.py`）
2. Page Agent 打开 Gemini/ChatGPT
3. Windows GUI 自动化发 Ctrl+V（绕过浏览器 CSP）
4. 读取 AI 描述后返回
- 脚本: `~/.deepseek/clipboard_image.py`
- AI 站点: site-handlers.json (gemini/ChatGPT/DeepSeek Chat)
- 文档: AGENTS.md `## Vision Relay`

## 技能自感知系统 (2026-05-17)
- 索引文件: `~/.deepseek/skills-index.json` (57 个技能，18KB)
- 自动匹配: 任务启动时扫描触发词，按需加载 `on_demand` 技能
- 始终生效: karpathy-guidelines（全局行为准则）

## 命令
- `!chong` — 切换交互模式（TUI 拦截 `/` 命令，改用 `!` 前缀）
  - 检测到后，读取 `~/.deepseek/.mode` 当前值（normal/auto）
  - 提示用户选择模式：1-normal（需授权）/ 2-auto（自动运行）
  - 用 `write_file` 将新值写入 `.mode` 文件
  - 确认切换结果，下次启动 TUI 生效
- 自然语言直接触发：用户提到 "询问"/"不询问"/"授权"/"审批"/"模式"/"auto"/"normal" 等关键词涉及模式切换，直接执行，不需要用户记命令格式

## 自修复规则 (2026-05-17)
- MCP 故障: diagnose(port/process) → repair → retry → 3×fail → fallback
- Page Agent: port 38401, node index.js restart
- 回退链: browser → exec_shell/web_search（3 次失败后）

### Windows GUI 自动化
- 脚本: `~/.deepseek/windows-automation.py` (pywinauto UIA)
- 命令: list-apps, list-windows, get-ui-tree, click, type-text, press-keys, drag, screenshot

### 微信操控
- 发送: powershell -File ~/.deepseek/wechat-send.ps1 -Contact "xxx" -Message "xxx"
- 读取: powershell -File ~/.deepseek/wechat-read.ps1 -Count 5

## 关键路径
| 路径 | 说明 |
|------|------|
| `~/.deepseek/AGENTS.md` | 全局指令（自动加载） |
| `~/.deepseek/config.toml` | 主配置 |
| `~/.deepseek/memory.md` | 持久化记忆（本文件，自动加载） |
| `~/.deepseek/mcp.json` | MCP 服务器配置 |
| `~/deepseek-pageagent-pack/` | Page Agent monorepo |
| `%APPDATA%\npm\node_modules\deepseek-tui\scripts\run.js` | TUI 启动脚本（已修改：sidecar + 看门狗 + 禁用更新） |
| `%APPDATA%\npm\node_modules\deepseek-tui\scripts\install.js` | 安装脚本（已冻结，永不下载） |

## 用户偏好
- 语言：简体中文
- 风格：先做后说，不要过度解释
- GitHub 已登录 `wj202239010118-blip`
