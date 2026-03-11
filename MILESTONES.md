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

## M2：Agent 接入
- [ ] Agent 用同一套 WebSocket 协议连接（API key 认证）
- [ ] 流式支持：send_message_delta + send_message_done
- [ ] Server 端内容累积 + 持久化
- [ ] Agent typing/thinking 状态展示
- **验收**：Better-Claw 作为 agent 连入，人类发消息后 agent 能流式回复，前端实时渲染

## M3：群聊
- [ ] Group conversation 支持
- [ ] 多参与者消息 fan-out（人+agent、agent+agent 任意组合）
- [ ] 前端群聊 UI
- **验收**：创建一个群聊加入 2 个 agent，发消息后两个 agent 都能收到并分别回复

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
