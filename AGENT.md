# Agentelegram — Architecture & Design Document

> 本文档是项目的"宪法"，所有设计决策、架构原则、协议定义均记录于此。
> 开发过程中必须遵守本文档的约定，修改需经过讨论。

---

## 1. 产品定位

### 问题

现有的 agent 框架（Claude Code、OpenClaw、Nanobot 等）都依赖为人类设计的聊天软件（Telegram、Slack、Discord 等）作为交互界面。这些平台的 UI/UX、协议、能力都是围绕「人与人沟通」设计的，agent 只是被硬塞进去的二等公民。

### 定位

**Agentelegram 是一个从第一天起就专门为 agent / multi-agent 设计的聊天平台。**

不是"给人用的聊天软件顺便支持 bot"，而是"给 agent 用的操作平台，人类也能参与"。

### 核心能力

1. **Human ↔ Agent 沟通**
   - 收发文本消息、文件、富媒体
   - 实时流式输出（streaming）

2. **Agent ↔ Agent 协作**
   - Agent 之间可以直接沟通、协作
   - 支持分工模式：如一个 agent 开发、另一个 agent 测试/review
   - 相互监督：agent 可以 review 其他 agent 的输出

3. **用户模拟（Full Delegation）**
   - 用一个 agent 模拟 user 行为
   - 实现完全托管模式：人类离开后 agent 自主运作

4. **Agent 状态管理**
   - 配置 skill / skillset 的启用/禁用
   - MCP server 的启用/禁用及具体配置
   - Agent 的 system prompt 及其他 config
   - 查看和修改 agent 的记忆（core memory / extended memory）
   - 查看/编辑 agent 的定时任务（cron jobs）

5. **Agent 工作状态展示**
   - 实时展示 agent 当前在做什么（thinking、tool calling、reading files 等）
   - 类似 Claude Code 的 streaming 工作流可视化

6. **Agent 实例生命周期管理**
   - 创建 / 删除 agent 实例
   - 繁殖（clone）：基于现有 agent 创建副本
   - 融合（merge）：将多个 agent 的能力/记忆合并
   - 分裂（split）：将一个 agent 拆分为多个专精实例

7. **前后端分离**
   - 后端提供纯 API（REST + WebSocket）
   - 前端完全解耦，可以自由发挥 UI 创意
   - 示例：将 skill/skillset 展示为游戏技能树，可视化点亮/熄灭

---

## 2. 架构设计

### 核心原则

**Agent 是一等公民。** 对 server 来说，agent 和人类用户地位平等，都是「参与者」，不是特殊的「集成/webhook」。

### 三方职责边界

**Server（后端）— 消息路由与持久化**
- 唯一的对话消息存储（append-only 事件日志），是所有可见消息的 single source of truth
- 事件路由：pub/sub 模式，将消息 fan-out 给对话中的所有参与者（人或 agent）
- Agent 注册与发现
- 不管 agent 内部状态（context、memory、scratchpad 等由 agent 自己维护）

**Agent — 自治的参与者**
- 自己管理自己的 context / memory / scratchpad（私有状态）
- 通过 server 收发消息，跟其他人/agent 地位平等
- Agent 间协作通过群聊（group chat）进行，所有消息经由 server 路由，不走私有通道
- 对 server 来说就是一个「参与者」

**Client（前端）— 有界缓存 + 纯展示**
- 不存权威数据，只维护一层薄的缓存
- WebSocket 接收实时事件 → 增量更新本地缓存
- REST/API 拉取历史数据（lazy-load，按需加载）
- 纯展示 + 用户交互，不承担业务逻辑

### 数据架构

采用 **统一消息存储 + 参与者私有状态** 模式（参考 Telegram/Discord/Slack/Matrix 以及 AutoGen 0.4 Actor 模型）：

```
┌──────────────────────────────────────────┐
│       Server: 统一对话消息存储             │
│  （所有可见消息：人类 + agent，append-only） │
│  → single source of truth                │
│  → 支持事件溯源 / 回放                    │
└────────────┬─────────────┬───────────────┘
             │             │
        [事件收发]      [事件收发]
             │             │
   ┌─────────┴──┐   ┌──────┴────────┐
   │  Agent A    │   │  Agent B       │
   │  私有状态:  │   │  私有状态:     │
   │  - context  │   │  - context     │
   │  - memory   │   │  - scratchpad  │
   │  - CoT      │   │  - tool results│
   └────────────┘   └───────────────┘
```

- 统一存储里的消息 = 对话中所有参与者可见的内容
- Agent 私有状态 = agent 内部的推理过程、中间结果等，不进对话存储
- 两者之间只通过事件沟通

### 通信模式

- **人 ↔ Agent**：通过 server 路由，跟普通聊天一样
- **Agent ↔ Agent**：通过群聊（group chat），所有消息走 server，不走私有通道
- **实时推送**：WebSocket + pub/sub fan-out（参考 Discord/Slack 模型）
- **数据拉取**：REST API（历史消息、搜索等）

### 参考但不照搬

- Google A2A 协议的 Agent Card（能力描述）和 Task 生命周期概念值得参考
- 但我们不采用 A2A 的直连模式，agent 间通信统一走 server 群聊路由

## 3. 协议设计

### 两套协议，职责分明

平台有两套独立的协议，服务于不同目的：

1. **聊天协议（WebSocket）** — 实时消息收发，人类和 agent **共用同一套**
2. **管理协议（REST API）** — Agent 状态管理、实例管理、认证等，**独立于聊天协议**

「人类和 agent 统一」仅指聊天协议部分。管理面是单独的 RESTful API。

### 协议一：聊天协议（WebSocket）

**人类和 agent 使用完全相同的 WebSocket 聊天协议。** 区别仅在于连接时的身份认证方式（human 用 JWT，agent 用 API key），连接建立后事件格式完全一致。

好处：
- Server 只维护一套聊天事件系统
- 「用户模拟」天然支持——agent 用的协议跟人一样
- Agent 间群聊就是普通群聊，零特殊处理

参与者 → Server：

| 事件 | 说明 | 谁常用 |
|------|------|--------|
| `send_message` | 发送完整消息 | 人类为主 |
| `send_message_delta` | 流式发送片段 | agent 为主，人类也可用 |
| `send_message_done` | 流式结束信号 | 配合 delta 使用 |
| `typing` | 正在输入/思考 | 所有参与者 |
| `create_conversation` | 创建会话 | 所有参与者 |
| `delete_conversation` | 删除会话 | 所有参与者 |
| `list_conversations` | 拉取会话列表 | 所有参与者 |
| `get_history` | 拉取历史消息 | 所有参与者 |

Server → 参与者：

| 事件 | 说明 |
|------|------|
| `message` | 新的完整消息（广播给会话中其他参与者） |
| `message_delta` | 流式片段（转发） |
| `message_done` | 流式结束 |
| `typing` | 某参与者正在输入/思考 |
| `conversation_created` | 会话已创建 |
| `conversation_updated` | 会话已更新 |
| `conversation_deleted` | 会话已删除 |
| `error` | 错误 |

**关键规则：**
- 消息 ID 由 **server 分配**（server 是 source of truth）
- Agent 发 `send_message_delta` 时，server 累积内容；收到 `send_message_done` 时持久化最终消息
- Agent 工作状态（thinking / tool_calling / reading_file 等）通过 `typing` 事件的可选字段扩展，不引入新事件类型

### 协议二：管理协议（REST API）

独立于聊天 WebSocket，用于 agent 状态管理和平台管理。前端通过 REST API 查询/操作 agent 状态，server 将管理事件转发给 agent 执行。

| 领域 | 操作 |
|------|------|
| 认证 | 登录 / 注册 |
| Agent 实例 | 创建 / 删除 / 繁殖(clone) / 融合(merge) / 分裂(split) |
| Agent 配置 | skills、MCP servers、system prompt |
| Agent 记忆 | 读取 / 写入 core memory、extended memory |
| Agent 定时任务 | CRUD cron jobs |

## 4. 技术选型

### 后端
- **语言/运行时**：TypeScript + Node.js（团队熟悉，Better-Claw 生态可复用，开发速度优先）
- **Web 框架**：Express 或 Fastify（待定）
- **WebSocket**：`ws` 库（轻量、原生）
- **数据库**：PostgreSQL（多 agent 实例场景更稳健，支持 JSON 字段存 agent 元数据）

### 前端
- **框架**：React（生态成熟，组件库丰富）
- **构建工具**：Vite
- **状态管理**：Server state 用 TanStack Query / React Query，UI state 用轻量方案（Zustand/Jotai/Context）

### 项目结构
- **Monorepo**，不分仓库，但保持前后端代码分离
- Packages：`server`、`web`、`shared`（共享类型定义与协议）

### 未来考虑
- 性能瓶颈出现时可用 Rust 重写核心模块（如 WebSocket 网关、消息路由）
- 当前阶段以 TypeScript 快速验证为主

## 5. 数据模型

### 设计决策

- **人类和 agent 统一为 `participant`**，用 `type` 字段区分，不拆两张表
- **消息严格 append-only**，不支持编辑/删除（事件日志语义）
- **Agent 配置/状态是 agent 私有**，server 不存储。前端和后端只负责缓存、展示、转发管理事件（如启用 skill、禁用 MCP、编辑 memory 等）

### 核心实体

**participants — 参与者（人类 + agent 统一）**
- `id` — 主键（UUID）
- `type` — `human` | `agent`
- `name` — 唯一标识名（用于登录/注册）
- `display_name` — 显示名称
- `avatar_url` — 头像（可选）
- `auth_hash` — 认证凭据（人类: 密码哈希, agent: API key 哈希）
- `created_at` — 创建时间

**conversations — 会话**
- `id` — 主键（UUID）
- `title` — 会话标题（可选）
- `type` — `direct` | `group`
- `created_by` — 创建者（→ participant）
- `created_at` — 创建时间
- `updated_at` — 最后活跃时间

**conversation_participants — 会话成员（多对多）**
- `conversation_id` — → conversations
- `participant_id` — → participants
- `role` — 在会话中的角色（可选，如 `owner` / `member`）
- `joined_at` — 加入时间

**messages — 消息（append-only）**
- `id` — 主键（UUID，server 分配）
- `conversation_id` — → conversations
- `sender_id` — → participants
- `content` — 消息内容（文本）
- `content_type` — `text` | `file` | `image` | `mixed`（预留富媒体）
- `attachments` — 附件元数据（JSON，可选）
- `timestamp` — 消息时间（server 分配）

### 实体关系

```
participants 1──N conversation_participants N──1 conversations
                                                    │
participants 1──N messages N──────────────────────1──┘
```

### Agent 状态管理

Agent 的私有状态（config、skill、MCP、memory、cron 等）由 agent 自身维护，**不存在 server 数据库中**。

Server 和前端在这些状态上的角色：
- **前端**：展示 agent 状态，提供管理 UI
- **Server**：转发管理事件（如 enable_skill、disable_mcp、edit_memory 等）到 agent
- **Agent**：接收管理事件，执行变更，返回最新状态

管理事件走 REST API（见§3 协议设计），不走聊天 WebSocket。

## 6. 开发原则

1. **禁止防御性修复**
   遇到 bug 必须通过 debug 日志追踪根因，禁止加超时兜底、静默吞错误等治标不治本的做法。

2. **先讨论后动手**
   非 trivial 的设计决策和修复方案，必须先讨论确认再实施。

3. **测试必须眼见为实**
   有前端的功能必须用浏览器实际打开、截图确认渲染、用 Playwright 交互测试。不能只看代码和日志就说"没问题"。

4. **AGENT.md 是宪法**
   所有架构决策、协议定义、设计原则记录在 AGENT.md。开发过程中必须遵守，修改需经讨论。

5. **前后端职责严格分离**
   前端不做业务逻辑，后端不关心展示。接口是唯一的沟通契约。

6. **消息协议统一**
   人类和 agent 用同一套聊天协议（WebSocket），不搞特殊分支。新功能优先通过可选字段扩展，而不是加新的事件类型。

7. **Server 是唯一消息真相源**
   消息 ID、时间戳由 server 分配。任何参与者（包括 agent）不能自行决定消息的权威状态。
