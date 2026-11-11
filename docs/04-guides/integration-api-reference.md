# 集成与 API 参考

> 平台对外集成面的 as-built 速查：认证、app-scoped REST、WebSocket 协议、管理/多租户/能力边界、widget 嵌入快速开始。
> widget 嵌入完整教程见 [Widget SDK 应用接入指南](./widget-sdk-app-integration-guide.md)；后台操作见 [Admin 控制台指南](./admin-console-guide.md)。

## 1. 总览

平台对外暴露三种集成形态，共享同一套认证主体：

| 形态 | 入口 | 认证 |
|---|---|---|
| 用户工作台（内置 SPA） | `/`（登录后） | 用户 JWT |
| App-scoped REST API | `/api/apps/:appId/*` | 用户 JWT **+** AppKey（双 principal） |
| 嵌入式 Widget | `/embed/apps/:appId/widget` | widgetToken（30m，绑定单 agent） |

**铁律：AppKey 永不替代用户认证。** REST 上 JWT 与 AppKey 同时必须；widgetToken 是给浏览器的第三种短期 token，AppKey 永不抵达浏览器。

## 2. 认证

### 2.1 登录与 JWT
- `POST /api/auth/login`，body `{ username, password }` → `200 { user, token, mustChangePassword }`
  - `user = { id, username, displayName, role, orgId }`，`token` 为 JWT；凭据错误 → `401 { error:"Invalid credentials" }`
- JWT payload：`{ userId, username, role, orgId }`
- 签名 secret：环境变量 `JWT_SECRET`（启动时 `assertJwtSecret()` 强校验，未设/弱值即 `[FATAL]` 拒绝启动，除非 `ALLOW_DEV_JWT_SECRET=1`）
- 过期：环境变量 `JWT_EXPIRES_IN`（代码回退 `"7d"`；`.env.example` 默认 `24h`）
- `GET /api/auth/me`（需 JWT）→ `{ userId, role }`
- `POST /api/auth/register` → `201` 返回 `UserInfo`（**不发 token**，注册后另行 login）

### 2.2 首次登录强制改密
- 种子 admin 建号时 `must_change_password = 1`。
- HTTP：`authMiddleware` 命中标记且路径不在白名单（仅 `/api/auth/me`、`/api/auth/change-password`）→ `403 { error:"Password change required", code:"MUST_CHANGE_PASSWORD" }`。
- WS：命中标记 → `ws.close(4003, "Password change required")`。
- 改密：`POST /api/auth/change-password`，body `{ oldPassword, newPassword }` → `{ ok:true }`。新密码策略：≥8 位、含字母+数字、不得与旧密码相同、不得为 `admin123`。

### 2.3 AppKey vs 用户 JWT（双 principal 边界）

|  | 用户 JWT | AppKey |
|---|---|---|
| 认证主体 | 用户（操作者） | 应用 |
| 携带信息 | `userId, role, orgId` | `appId, orgId`（无用户身份） |
| 传递方式 | `Authorization: Bearer <JWT>` | `X-App-Key: <AppKey>`（REST）/ `?appKey=`（WS） |
| 有效期 | `JWT_EXPIRES_IN`（默认 24h） | 长期（`status=active` 期间） |
| 生成 | login 签发 | admin 在 `POST /api/admin/applications/:id/key` 生成，格式 `sap_<48hex>`，明文仅返回一次（落库仅存 sha256 + 前 16 字符 prefix） |

app-scoped 调用上**两者同时必须**；且 URL `:appId` 必须 = AppKey 解析出的 appId，AppKey 的 org 必须 = JWT 的 org（Phase 7 跨租户护栏）。

### 2.4 widgetToken 流程（浏览器短期 token）
1. 应用后端（BFF，已持 JWT + AppKey）调 `POST /api/apps/:appId/widget-tokens`，body `{ agentId?, title?, pageSessionId?, origin? }` → `201 { token, expiresIn:1800, pageSessionId, agentId }`。
   - 传 `agentId` 必须已属该 user+app（否则 403）；不传则在该 app 下新建 agent。
2. BFF 把 `token` 下发给浏览器。
3. 浏览器加载 `GET /embed/apps/:appId/widget?widgetToken=<token>`（iframe），内部连接 `/api/apps/:appId/ws?widgetToken=<token>`。
- widgetToken payload `{ kind:"widget", appId, userId, role, agentId, pageSessionId, origin }`，secret 同 `JWT_SECRET`，过期 `WIDGET_TOKEN_EXPIRES_IN`（回退 `30m`）。
- **类型隔离**：用户 JWT 校验器对 `kind:"widget"` 直接拒绝 —— widget token 不能冒充 7 天用户凭证。
- **AppKey 永不抵达浏览器。**

## 3. App-scoped REST API

挂载在 `/api/apps/:appId`，全部经 `appAuthMiddleware`（JWT + AppKey 双 principal + org 对齐 + appId 一致）。

| 方法 | 路径 | 请求 | 成功响应 |
|---|---|---|---|
| GET | `/api/apps/:appId/agents` | — | `200 Agent[]` |
| POST | `/api/apps/:appId/agents` | `{ title? }` | `201 Agent` |
| GET | `/api/apps/:appId/agents/:agentId` | — | `200 Agent` / `404` |
| DELETE | `/api/apps/:appId/agents/:agentId` | — | `200 { success:true }` |
| GET | `/api/apps/:appId/agents/:agentId/messages` | — | `200 messages[]` |
| GET | `/api/apps/:appId/agents/:agentId/events` | `from, limit, raw` | `200 { events, nextFrom, hasMore }`（`limit` 默认 100、上限 500；`raw=true` 仅 admin） |
| POST | `/api/apps/:appId/widget-tokens` | `{ agentId?, title?, pageSessionId?, origin? }` | `201 { token, expiresIn:1800, pageSessionId, agentId }` |

示例（list agents）：
```bash
curl -H "Authorization: Bearer <JWT>" -H "X-App-Key: sap_<...>" \
  https://<host>/api/apps/<appId>/agents
```

## 4. WebSocket 协议

### 4.1 连接
- 用户工作台：`/ws?token=<JWT>`
- App-scoped：`/api/apps/:appId/ws?token=<JWT>&appKey=<AppKey>`
- Widget：`/api/apps/:appId/ws?widgetToken=<widgetJWT>`
- 连接成功即收 `{ type:"connected", message:"Connected to chat server" }`。
- 鉴权失败关闭码：`4001`（token 缺失/失效、appKey 缺失/错误、widgetToken 无效）；`4003`（必须改密、appId 不匹配）。

### 4.2 入站（client → server）
| `type` | 关键字段 | 说明 |
|---|---|---|
| `subscribe` | `chatId` | 订阅某 agent 消息流；服务端回 `history` |
| `chat` | `content, chatId, pageSessionId?, pageContext?` | 发送一条用户消息 |
| `approval_response` | `id, chatId, approved, message?, alwaysAllow?` | 审批工具调用 |
| `stop` | `chatId` | 中止当前轮 |
| `a2ui_submit` | `chatId, blockId, actionId, actionLabel?, values` | 提交内联交互卡片 |

### 4.3 出站事件（server → client）
| `type` | 触发 | 关键字段 |
|---|---|---|
| `connected` | 连接成功 | `message` |
| `history` | `subscribe` 之后 | `messages, chatId` |
| `user_message` | 用户消息回显 | `content, chatId` |
| `assistant_message` | 助手文本块（去重 + a2ui 切分后） | `content, chatId` |
| `a2ui_block` | 助手文本里的 `<a2ui-json>` 解析出的卡片 | `blockId, block, chatId` |
| `tool_use` | 助手请求工具调用 | `toolName, toolId, toolInput, chatId` |
| `tool_result` | 工具结果 | `toolId, output(≤5000), isError, chatId` |
| `approval_request` | 工具需审批（`APPROVAL_ENABLED=true`） | `id, toolName, toolInput, toolUseId, chatId` |
| `slash_commands` | SDK init / subscribe 缓存命中 | `commands, sdkInit?, chatId` |
| `system_notice` | `/compact` 后的 compact 边界 | `subtype:"compact", preTokens, trigger, chatId` |
| `command_result` | 斜杠命令输出 | `output(≤5000), isError, chatId` |
| `result` | 一轮完成 | `success, cost, duration, chatId` |
| `files_updated` | Docker 模式 `/workspace/output` 出现新文件 | `chatId` |
| `error` | 会话/发送错误 | `error, chatId?` |
| `stopped` | 停止 | `chatId` |

> 注：没有出站 `system` / `assistant` / `a2ui_submit` —— 助手文本走 `assistant_message`，卡片走 `a2ui_block`，`a2ui_submit` 是入站。

## 5. 管理 / 多租户 / 能力边界

### 5.1 三级角色
| 角色 | 能力 |
|---|---|
| `admin` | 跨 org 超级用户；全局路由（runtime/skills/mcp/install）+ 全部 admin 操作 |
| `org_admin` | 本 org 管理员；可进 `/api/admin` 做本 org 范围的 users/agents/profiles/applications 管理；**不能**改特权账号、不能授特权角色 |
| `user` | 普通用户；只能操作自己的会话/agent |

入口判定：`isPrivilegedReq` = admin + org_admin（进 `/api/admin` 的门槛）；`isAdminReq` = 仅 admin（全局安装/运行时路由）。

### 5.2 能力三层模型（资源池 → entitlement → 激活）
最终生效 = **资源池 ∩ entitlement ∩ agent 激活**。
- **资源池**（全局安装）：`data/skills.json` / `data/mcp.json` / `data/hook-plugins.json`
- **entitlement**（谁能用）：按 `org` / `user` scope 的 allow/deny
- **激活**（单个 agent 是否启用）：agent-capabilities

管理入口（Admin 控制台）：

| 页面 | 管什么 |
|---|---|
| Plugin (`/admin/plugins`) | 导入/卸载 skill、hook-plugin（写资源池） |
| Skill (`/admin/skills`) | 启用/禁用 skill（全局开关） |
| MCP (`/admin/mcp`) | MCP server 注册（`data/mcp.json`） |
| 能力资源 (`/admin/capabilities`) | 编辑 entitlement（org/user allow/deny） |
| Agents (`/admin/agents`) | 单 agent 能力激活 |

给某 org 开放某能力：能力资源页 → 点该资源 → 加 `org` scope + orgId + `allow`。

## 6. 开发者快速开始

### 6.1 嵌入 widget（最快路径）
完整教程：[Widget SDK 应用接入指南](./widget-sdk-app-integration-guide.md)。最小步骤：
1. admin 创建一个 application，生成 AppKey（`sap_...`）。
2. 你的后端（BFF）持 AppKey + 用户 JWT，调 `POST /api/apps/:appId/widget-tokens` 拿 widgetToken。
3. 浏览器 iframe 指向 `/embed/apps/:appId/widget?widgetToken=<token>`。
4. 按 §4.3 的 WS 事件渲染对话。

### 6.2 把一个 app 接入平台
1. admin 建应用 + 生成 AppKey + 在「能力资源」页给目标 org 授权 entitlement。
2. 你的应用后端每次调 app-scoped REST 都带 `Authorization: Bearer <用户JWT>` 和 `X-App-Key: <AppKey>`。
3. 需要 agent 推送时连 WS `/api/apps/:appId/ws?token=&appKey=`，按 §4 协议收发。

## 7. 相关文档
- [Widget SDK 应用接入指南](./widget-sdk-app-integration-guide.md) —— widget 嵌入完整教程、context 传递、TokenProvider、布局
- [Admin 控制台指南](./admin-console-guide.md) —— 后台操作
- [应用层历史开发计划](../开发计划/application-layer-dev-plan.md) —— app-scoped 实施记录与 Phase 6 决策
- [部署](../06-deployment/deployment.md) / [运维 runbook](../06-deployment/operations-runbook.md)
