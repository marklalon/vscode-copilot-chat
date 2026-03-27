# Mem0 集成研究：消息发送与上下文注入架构分析

> 本文档记录了 vscode-copilot-chat 工程中与消息处理、上下文注入相关的核心架构，
> 为后续集成 mem0 实现主动 memory recall 和上下文自动注入提供参考。

---

## 1. 消息处理总流程

```
User Message (VS Code Chat Panel)
    │
    ▼
ChatParticipant Handler (chatParticipants.ts)
    │  vscode.chat.createChatParticipant() → getChatParticipantHandler()
    ▼
ChatParticipantRequestHandler.getResult()
    │  sanitize variables → selectIntent()
    ▼
IIntent.invoke() → IIntentInvocation (含 buildPrompt 方法)
    │
    ▼
ToolCallingLoop.run() → _runLoop() → runOne()
    │  buildPrompt() → fetch() → 解析响应 → 执行工具 → 循环
    ▼
ChatResult 返回给 VS Code
```

### 关键文件

| 文件 | 职责 |
|------|------|
| `src/extension/conversation/vscode-node/chatParticipants.ts` | 注册所有 chat participants（default/editing/terminal 等） |
| `src/extension/conversation/vscode-node/conversationFeature.ts` | 会话系统激活入口 |
| `src/extension/prompt/node/chatParticipantRequestHandler.ts` | 请求路由，将用户消息分发到具体 intent |
| `src/extension/prompt/node/intents.ts` | `IIntent` 接口定义（invoke / handleRequest / getAvailableTools） |
| `src/extension/intents/node/intentService.ts` | Intent 注册表与选择逻辑 |
| `src/extension/intents/node/toolCallingLoop.ts` | **核心：工具调用循环与 LM 调用**，`fetch()` 发送请求 |
| `src/extension/intents/node/agentIntent.ts` | Agent intent，负责 buildPrompt + PromptRenderer |

---

## 2. Prompt 构建与上下文注入（prompt-tsx 系统）

### 2.1 AgentPrompt 组件树

主文件：`src/extension/prompts/node/agent/agentPrompt.tsx`

```
AgentPrompt.render()
├── <SystemMessage priority=1000>
│   ├── Base Agent Instructions (身份 + 安全规则)
│   ├── <MemoryInstructionsPrompt/>           ← 三层 memory 使用指南
│   └── <CustomInstructions/> (可选放在 System 或 User)
│
├── Autopilot Guidance (priority=80, 仅 autopilot 模式)
│
├── <UserMessage> — GlobalAgentContext
│   ├── <Tag name='environment_info'><UserOSPrompt/></Tag>
│   ├── <Tag name='workspace_info'> (TokenLimit max=2000)
│   │   ├── <AgentTasksInstructions/>
│   │   ├── <WorkspaceFoldersHint/>
│   │   └── <AgentMultirootWorkspaceStructure/>
│   ├── <UserPreferences/> (priority=800, flexGrow=7)
│   ├── <MemoryContextPrompt/> (★ 仅第一轮对话)    ← 现有 memory 注入点
│   ├── <TodoListContextPrompt/>
│   └── cacheBreakpoint (if cache enabled)
│
├── <AgentConversationHistory/> (priority=700, flexGrow=1)
│   │  或 <SummarizedConversationHistory/>
│   └── 每个 Turn:
│       ├── <UserMessage> (附件 + 编辑事件 + 用户请求)
│       ├── <ChatToolCalls/> (工具调用 + 结果)
│       └── <AssistantMessage/> (模型回复)
│
├── <AgentUserMessage/> (priority=900, flexGrow=2) — 当前用户消息
└── <ChatToolCalls/> (priority=899, flexGrow=2) — 当前工具调用
```

### 2.2 Priority/Budget 机制

prompt-tsx 使用优先级队列 + flexGrow 来分配 token 预算：

| 优先级范围 | 用途 |
|-----------|------|
| 1000 | System messages |
| 900 | 当前用户消息 |
| 700-800 | 会话历史、用户偏好 |
| 600-700 | 上下文附件 |
| 0-500 | 背景信息 |

- `flexGrow={N}` — token 超额分配倍率
- `TokenLimit max={N}` — 硬上限
- `passPriority` — 容器不影响子元素优先级

### 2.3 PromptElement 基类模式

```typescript
class MyPrompt extends PromptElement<MyProps> {
    constructor(
        props: MyProps,
        @IMyService private myService: IMyService  // DI 注入
    ) { super(props); }

    async render(state: void, sizing: PromptSizing) {
        const data = await this.myService.getData();
        return <UserMessage priority={650}>
            <Tag name='my_context'>{data}</Tag>
        </UserMessage>;
    }
}
```

- 支持 async render
- JSX 工厂：`vscpp`（不是 React）
- 换行用 `<br />`，JSX 中的 `\n` 不会保留

---

## 3. 现有 Memory 系统

主文件：`src/extension/tools/node/memoryContextPrompt.tsx`

### 三层 Memory 架构

| 层级 | 作用域 | 存储位置 | Feature Flag |
|------|--------|---------|-------------|
| User Memory | 跨工作区持久化 | `globalStorageUri/memory-tool/memories/` | `ConfigKey.MemoryToolEnabled` |
| Session Memory | 当前会话 | `storageUri/memory-tool/memories/{sessionId}/` | `ConfigKey.MemoryToolEnabled` |
| Repo Memory | 仓库级 | Copilot Memory Service (CAPI) 或本地文件 | `ConfigKey.CopilotMemoryEnabled` |

### MemoryContextPrompt 渲染逻辑

```typescript
// 仅在第一轮对话注入
async render() {
    const userMemory = enableMemoryTool ? await this.getUserMemoryContent() : undefined;
    const sessionMemory = enableMemoryTool ? await this.getSessionMemoryFiles(...) : undefined;
    const repoMemories = enableCopilotMemory ? await this.agentMemoryService.getRepoMemories() : undefined;

    return <>
        <Tag name='userMemory'>{userMemoryContent}</Tag>
        <Tag name='sessionMemory'>{sessionMemoryFiles}</Tag>
        <Tag name='repoMemory'>{repoMemoryContent}</Tag>
    </>;
}
```

### 相关服务

- `IAgentMemoryService` — repo memory 的获取（含 CAPI 调用）
- `IFileSystemService` — 本地文件读写
- Memory Tool（`ToolName.Memory`）— 供 agent 运行时读写 memory 文件

---

## 4. 依赖注入（DI）系统

### Service 定义与注册

```typescript
// 1. 创建 service identifier
export const IMyService = createServiceIdentifier<IMyService>('MyService');

// 2. 定义接口
export interface IMyService {
    readonly _serviceBrand: undefined;
    getData(): Promise<string>;
}

// 3. 实现
export class MyServiceImpl implements IMyService {
    readonly _serviceBrand: undefined;
    constructor(
        @ILogService private readonly log: ILogService,
        @IConfigurationService private readonly config: IConfigurationService
    ) {}
    async getData() { ... }
}

// 4. 注册（在 services.ts 中）
builder.define(IMyService, new SyncDescriptor(MyServiceImpl));
```

### 注册位置

| 文件 | 作用 |
|------|------|
| `src/extension/extension/vscode/services.ts` | 通用服务注册（150+ 服务） |
| `src/extension/extension/vscode-node/services.ts` | Node.js 环境专用服务 |
| `src/extension/extension/vscode-worker/services.ts` | Web Worker 专用服务 |

---

## 5. Custom Instructions 系统

主文件：`src/platform/customInstructions/common/customInstructionsService.ts`

### 指令来源

1. **工作区文件** — `.github/copilot-instructions.md`
2. **用户主目录** — `~/copilot-instructions.md`
3. **配置项** — 用户 settings 中指定的文件/glob
4. **扩展贡献** — VS Code 扩展的 `contributes.chatInstructions`
5. **Skill 文件夹** — `.instructions.md` 文件

### ICustomInstructionsService 接口

```typescript
interface ICustomInstructionsService {
    fetchInstructionsFromSetting(configKey): Promise<ICustomInstructions[]>;
    fetchInstructionsFromFile(fileUri): Promise<ICustomInstructions | undefined>;
    getAgentInstructions(): Promise<URI[]>;
    parseInstructionIndexFile(text): IInstructionIndexFile;
    // ...
}
```

---

## 6. 工具系统

### IToolsService 核心接口

文件：`src/extension/tools/common/toolsService.ts`

```typescript
interface IToolsService {
    tools: ReadonlyArray<LanguageModelToolInformation>;
    copilotTools: ReadonlyMap<ToolName, ICopilotTool<unknown>>;
    getCopilotTool(name: string): ICopilotTool<unknown> | undefined;
    invokeTool(name, options, token): Thenable<LanguageModelToolResult2>;
    getEnabledTools(request, endpoint, filter?): LanguageModelToolInformation[];
    onWillInvokeTool: Event<IOnWillInvokeToolEvent>;
}
```

### 工具注册

- **ToolName enum** — 内部工具名（`src/extension/tools/common/toolNames.ts`）
- **ContributedToolName enum** — 公开名称（带 `copilot_` 前缀）
- **onWillInvokeTool** — 工具执行前事件，可用于拦截/增强

---

## 7. Mem0 集成方案分析

### 7.1 推荐方案：新建 PromptElement 组件 + Service

这是最符合现有架构的方式，类似 `MemoryContextPrompt` 的模式：

```
新增文件:
├── src/extension/mem0/common/mem0Service.ts        — IMem0Service 接口 + 类型
├── src/extension/mem0/node/mem0ServiceImpl.ts       — 实现（HTTP 调用 mem0 API）
├── src/extension/mem0/node/mem0ContextPrompt.tsx    — Prompt 组件
└── 修改:
    ├── src/extension/prompts/node/agent/agentPrompt.tsx  — 插入 <Mem0ContextPrompt/>
    └── src/extension/extension/vscode/services.ts        — 注册 IMem0Service
```

**注入位置**：在 `AgentPrompt` 的 GlobalAgentContext `<UserMessage>` 中，
紧邻 `<MemoryContextPrompt/>` 之后，priority 约 600-700。

### 7.2 核心能力设计

| 能力 | 实现方式 |
|------|---------|
| **主动 Recall** | Mem0ContextPrompt.render() 中根据当前 query + 上下文调用 mem0 search API |
| **自动注入** | 作为 PromptElement 自动随每次请求渲染（或仅第一轮，取决于策略） |
| **Memory 存储** | 新增 mem0 Tool 或复用 onWillInvokeTool 事件，在对话结束时存储关键信息 |
| **Session 关联** | 通过 conversation sessionId 关联 mem0 的 session 概念 |

### 7.3 关键集成点

1. **上下文获取时机** — `PromptElement.render()` 是 async 的，可在渲染时调用 mem0 API
2. **Query 获取** — 通过 `props.promptContext.query` 拿到当前用户消息，用于 mem0 检索
3. **Token 预算** — 使用 `TokenLimit` 或 priority 控制注入的 memory 不超过预算
4. **Feature Flag** — 参考 `ConfigKey.MemoryToolEnabled` 模式新增配置开关
5. **Telemetry** — 参考 `memoryContextRead` 事件模式添加遥测

### 7.4 备选方案

| 方案 | 优点 | 缺点 |
|------|------|------|
| **Hook 拦截** | 无需改动 prompt 模板 | 仅 Claude SDK agent 支持，通用性差 |
| **Custom Instructions 扩展** | 复用现有管线 | 静态内容，不支持动态检索 |
| **Tool 方式** | agent 自主决定何时 recall | 不保证每次都调用，延迟高 |
| **PromptElement 组件**（推荐） | 原生集成，自动触发，token 可控 | 需要改动 agentPrompt.tsx |

---

## 8. 相关配置项参考

| ConfigKey | 用途 |
|-----------|------|
| `ConfigKey.MemoryToolEnabled` | 是否启用 memory tool |
| `ConfigKey.CopilotMemoryEnabled` | 是否启用 Copilot Memory（CAPI） |
| `ConfigKey.SummarizeAgentConversationHistory` | 是否启用历史摘要 |
| `ConfigKey.CustomInstructionsInSystemMessage` | 自定义指令放 system 还是 user message |
