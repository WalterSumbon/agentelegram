# Agentelegram — Milestones & Progress Tracker

> 每个 milestone 完成后做一轮端到端测试（Playwright），通过了才进下一阶段。

---

## M0：项目脚手架 ✅
- [x] Monorepo 搭建（server / web / shared）
- [x] PostgreSQL 连接 + schema 初始化
- [x] 开发工具链（TypeScript、Vite、dev script）
- **验收**：`npm run dev` 前后端都能跑起来，DB 表已建好 ✅

## M1：核心聊天 MVP ✅
- [x] WebSocket 连接 + JWT 认证
- [x] 人类注册/登录
- [x] 1:1 会话：创建、发消息、收消息
- [x] 消息持久化（append-only）
- [x] 基础前端：登录页、会话列表、聊天界面
- [x] 实时消息推送（WebSocket fan-out，跨用户即时可见）
- **验收**：一个人类用户能登录、创建会话、发消息并在页面上看到 ✅

## M2：Agent 接入 ✅
- [x] Agent 注册 REST API（API key 认证）
- [x] Agent 用同一套 WebSocket 协议连接
- [x] 流式支持：send_message_delta + send_message_done
- [x] Server 端内容累积 + 持久化
- [x] Agent typing/thinking 状态展示
- [x] 前端流式消息渲染（光标动画）+ agent 头像标识
- [x] E2E 测试脚本（mock-agent echo bot）
- **验收**：mock-agent 通过 API key 连入，人类发消息后 agent 流式 echo 回复，前端实时渲染 ✅

### M2 Code Review 发现的问题及修复（commit `526f041`）

**问题 1：API key 通过 URL query string 传递**
- 现象：agent 连 WebSocket 时 API key 放在 `ws://host/ws?apikey=xxx`，凭据会泄漏到服务器日志、反向代理日志、浏览器历史记录
- 根因：浏览器原生 WebSocket API 不支持自定义 Header，最初选了最简单的 query string 方案
- 修复：改为连接后首条消息认证。客户端发 `{ type: "auth", token/apiKey }`，服务端验证后回复 `auth_ok`，10 秒超时未认证自动断开。凭据走 WebSocket 数据帧，不出现在 URL 中

**问题 2：register-agent 端点无鉴权**
- 现象：`POST /api/auth/register-agent` 无需任何认证，任何人可以批量注册 agent 拿到 API key
- 风险：未授权 agent 注入、数据库 DoS、恶意 agent 参与对话
- 修复：加 `requireAuth` 中间件，需要 `Authorization: Bearer <jwt>`。只有登录的人类用户才能注册 agent

**问题 3：verifyApiKey O(N) bcrypt 全表扫描**
- 现象：每次 agent 认证需要 `SELECT * FROM participants WHERE type='agent'` 捞出所有 agent，逐个做 bcrypt.compare（每次 ~100ms）
- 风险：N 个 agent = 最坏 N×100ms 认证延迟，容易被利用做 DoS
- 根因：bcrypt 加盐哈希无法直接 WHERE 查找
- 修复：participants 表新增 `key_prefix` 列（API key 前 8 字符）+ partial index，查询先按 prefix 定位（通常 1 条），再做 1 次 bcrypt。O(N) → 实质 O(1)

## M3：群聊 ✅
- [x] Group conversation 支持
- [x] 多参与者消息 fan-out（人+agent、agent+agent 任意组合）
- [x] 前端群聊 UI（多选参与者 chip、群标题、成员标签、👥 图标 + 成员数 badge）
- [x] E2E 测试脚本（19 assertions，覆盖注册、认证、群创建、消息 fan-out、并发 streaming、历史验证）
- [x] Playwright 前端验证（登录、创建群聊、消息收发、agent 回复渲染）
- **验收**：创建一个群聊加入 2 个 agent，发消息后两个 agent 都能收到并分别回复 ✅

### M3 Code Review 发现的问题及修复

**Critical 修复：**

1. **REST 端点无鉴权（C1）**
   - 现象：`GET /api/participants` 和 `GET /api/conversations/:id/members` 无需认证，任何人可枚举所有参与者和对话成员
   - 修复：两个端点均加 `requireAuth` JWT 中间件。members 端点额外校验请求者是对话成员
   - 前端 API 调用同步增加 `Authorization: Bearer` header

2. **create_conversation 无事务（C2）**
   - 现象：创建对话（INSERT conversation + N 条 INSERT participant）未包在事务内，中途失败会造成数据不一致
   - 修复：改用 `pool.connect()` + `BEGIN/COMMIT/ROLLBACK` 事务，participant 改为批量 INSERT

3. **前端类型安全（W2/W3）**
   - 现象：`User.type` 和 `ConversationInfo.type` 定义为 `string`，失去编译期类型检查
   - 修复：改为 `'human' | 'agent'` 和 `'direct' | 'group'` 联合类型，`api.ts` 同步修正

**Warning 修复：**

- **W1**：silent `.catch(() => {})` 改为 `.catch((err) => console.error(...))`，不再静默吞错误
- **W8**：`.new-chat-form` 加 `overflow-y: auto` 防止内容溢出被裁剪

**已知待改进项（非阻塞）：**
- 重复 direct 对话未去重（W7）
- 参与者列表固定展示 10 条上限（W4）
- 创建群聊后 fire-and-forget 无确认（W5）
- CSS 硬编码 accent 色值（N1）
- participant-option 缺少键盘可访问性（N4）

## M4：Agent 管理面板
- [ ] REST API：agent 状态查询/管理（server 转发到 agent）
- [ ] 前端管理 UI：skills、MCP、memory、cron
- [ ] Agent 工作状态实时展示
- **验收**：在前端能查看 agent 的 skill 列表、memory 内容、cron 任务，并能操作修改

## M5：高级特性
- [ ] 用户模拟（agent 扮演 user，完全托管）
- [ ] Agent 实例生命周期：clone / merge / split
- [ ] 前端花活：技能树可视化等
- **验收**：能创建一个 agent 模拟用户行为；能 clone 一个 agent 实例
