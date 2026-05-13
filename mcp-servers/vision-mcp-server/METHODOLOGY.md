# Vision MCP Server — 开发方法论

本文档面向 AI 编程助手和开发者，说明 Vision MCP Server 的设计思路、架构决策和扩展方式。

## 1. 设计目标

**核心问题**：Claude Code 等 AI 编程助手本身没有视觉能力，无法分析截图、读取图片中的文字、对比 UI 变更。

**解决方案**：通过 MCP（Model Context Protocol）协议，将视觉能力作为工具暴露给 AI agent，由外部 Vision LLM（如 Qwen3-VL、GPT-4o）提供实际的图像/视频理解。

**设计原则**：
- **模型无关**：不绑定任何特定视觉模型，通过 OpenAI 兼容 API 适配所有主流模型
- **零依赖推理**：服务器本身不运行模型，只做协议转换和文件处理
- **本地文件友好**：AI agent 操作的是本地文件系统，自动将本地文件转为 base64 data URI

## 2. 架构

```
┌─────────────┐    MCP/stdio    ┌──────────────────┐    HTTP/JSON    ┌─────────────┐
│  Claude Code │ ◄────────────► │ Vision MCP Server │ ─────────────► │  Vision LLM │
│  (MCP Client)│                │   (本项目)         │                │  (API 端点)  │
└─────────────┘                └──────────────────┘                └─────────────┘
                                       │
                                       ▼
                                ┌──────────────┐
                                │ 本地文件系统   │
                                │ (图片/视频)    │
                                └──────────────┘
```

### 分层设计

| 层 | 文件 | 职责 |
|---|---|---|
| **入口层** | `index.ts` | MCP server 初始化、工具注册、错误处理 |
| **工具层** | `tools/*.ts` | 每个工具一个文件，定义 Zod schema + 处理逻辑 |
| **客户端层** | `utils/api-client.ts` | OpenAI 兼容 API 的 HTTP 客户端 |
| **文件处理层** | `utils/file-handler.ts` | 本地文件 → base64 data URI 转换 |
| **配置层** | `config.ts` | 环境变量 + 配置文件的多源加载 |

### 关键决策

**为什么用 Zod schema？**
MCP SDK 的 `server.tool()` 方法直接接受 Zod schema 的 `.shape` 作为参数定义，同时 Zod 提供运行时类型验证。一个 schema 同时解决类型安全和参数校验。

**为什么不用 SDK 内置的文件处理？**
MCP 协议本身支持资源（Resource）概念，但工具调用的参数是纯 JSON。Vision API 需要 base64 或 URL 格式的图片输入，所以我们在服务器侧完成本地文件到 data URI 的转换，对 MCP client 透明。

**为什么用 `fetch` 而不是 OpenAI SDK？**
减少依赖。OpenAI 兼容 API 的 chat completions 端点格式简单且稳定，直接用 Node.js 内置的 `fetch` 即可，无需引入 `openai` 包。

## 3. 工具设计模式

每个工具遵循相同模式：

```typescript
// 1. Zod schema 定义参数
export const toolSchema = z.object({
  image: z.string().describe("..."),
  prompt: z.string().default("...").describe("..."),
});

// 2. 处理函数
export async function toolHandler(
  client: VisionApiClient,
  input: z.infer<typeof toolSchema>
): Promise<string> {
  // 解析文件 → 构造 messages → 调用 API → 返回文本
}
```

注册时统一包裹 try/catch：

```typescript
server.tool("tool_name", "description", schema.shape, async (input) => {
  try {
    const result = await toolHandler(client, input);
    return { content: [{ type: "text", text: result }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});
```

## 4. 文件处理策略

| 输入类型 | 处理方式 |
|---|---|
| `http://` / `https://` URL | 直接传递给 Vision API |
| 绝对路径 `/path/to/file` | 读取 → base64 → `data:mime;base64,...` |
| 相对路径 `./file` | resolve(cwd, path) → 同绝对路径 |

安全限制：
- 文件大小上限 100 MB
- 仅接受已知的图片/视频 MIME 类型
- 路径必须指向实际存在的文件

## 5. 配置优先级

```
环境变量 > config.json / vision-mcp.config.json > 默认值
```

这允许：
- 开发时用 `.env` 文件
- MCP 集成时用 `env` 字段直接传入
- 共享部署时用 `config.json`

## 6. 添加新工具

1. 在 `src/tools/` 下创建新文件（如 `describe-ui.ts`）
2. 定义 Zod schema 和处理函数
3. 在 `index.ts` 中 import 并调用 `server.tool()` 注册
4. `npm run build` 重新编译

## 7. 局限性

- **无流式输出**：MCP 工具返回完整文本，不支持流式（适合短回答，长视频分析可能较慢）
- **无本地模型**：服务器不内置推理能力，必须有外部 API 端点
- **视频支持有限**：大多数 Vision LLM 不支持视频输入，目前只有 Qwen3-VL 等少数模型支持
- **base64 开销**：大文件转 base64 会增加约 33% 的数据量和内存占用
