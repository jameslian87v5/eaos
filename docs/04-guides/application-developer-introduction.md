# 应用开发者接入指南

> 读者：基于本平台开发独立业务应用的前端、后端和 Agent 开发者。
> 目标：说明应用团队需要建设什么、平台提供什么，以及如何完成最小接入。
> API 细节：[集成与 API 参考](./integration-api-reference.md)；Widget 专项：[Widget SDK 应用接入指南](./widget-sdk-app-integration-guide.md)。

## 1. 先理解你在开发什么

你开发的是一个独立业务应用，不是平台插件，也不需要修改平台源码。

应用可以有自己的前端、业务后端、数据库、用户体系、角色权限、知识库和业务规则。平台向应用提供统一的 Agent Runtime、能力注入、隔离、审批和审计能力。

```text
业务用户
  -> 你的业务前端
  -> 你的业务后端/BFF
       -> 业务数据库、业务 API、权限系统
       -> Agent 平台 app-scoped REST / WebSocket
            -> Agent Runtime
            -> Skill / MCP / Hook plugin
            -> Tool 审批与运行审计
```

### 平台负责

- Application 与 Agent 的运行边界。
- Agent Runtime、会话恢复、流式消息和工作区。
- Skill、MCP、Hook plugin 的注册、授权和注入。
- Tool allow/deny/approval 策略及用户审批。
- Application、执行主体和 Agent 的隔离。
- 执行事件、Token、成本和 runId 审计。

### 应用团队负责

- 业务前端和业务后端。
- 应用登录、业务用户、角色、部门和数据权限。
- 领域知识、业务口径、知识库和业务数据模型。
- 应用自己的 Skill、MCP、Hook plugin 和内网 API。
- 决定哪些业务操作需要在前端呈现或再次确认。

平台不会替你建设领域层，也不会理解“销售经理”“财务口径”“客户可见范围”等业务概念。这些判断必须先由应用完成，再把允许执行的请求交给 Agent。

## 2. 接入前由管理员完成的配置

应用代码接入前，平台管理员需要完成以下工作：

1. 创建 Application，确定 `appId`、名称和所属组织。
2. 生成 AppKey。明文只返回一次，应用后端必须安全保存。
3. 配置 Application capability allowlist。
4. 给目标组织或平台用户配置 Application access grant（仅平台 JWT 路径需要）。
5. 配置 Skill/MCP entitlement，并在具体 Agent 上激活需要的能力。
6. 配置 Tool profile：自动允许、禁止和需要用户审批的 Tool。

Runtime 最终能加载的能力不是应用单方面决定的：

```text
有效能力 = Application allowlist
         ∩ entitlement
         ∩ Agent activation
         ∩ resource active/enabled
```

任何一层未授权，该能力都不会进入 Runtime。应用不能通过请求参数直接指定 host path、Docker mount、MCP command 或任意 Tool 来绕过治理。

## 3. 选择执行主体接入方式

Application 是一个主体，当前操作用户是另一个主体。两者不能混为一谈。

平台支持两条路径：

| 场景 | 推荐身份 | 应用后端需要做什么 | 浏览器携带什么 |
|---|---|---|---|
| 用户已经是平台用户 | 平台 User JWT | 保管 AppKey；S2S 调用时同时提交 JWT + AppKey | 平台 JWT；不要暴露 AppKey |
| 应用有自己的用户体系 | Runtime Token | 用 AppKey + opaque subject 换短期 Runtime Token | 仅 Runtime Token |

### 推荐：应用自有用户走 Runtime Token

你的应用先完成自己的登录与权限判断，再用一个稳定但无业务含义的 `subject` 表示当前用户。`subject` 不应包含姓名、邮箱、角色、部门或权限声明。

```text
业务用户登录你的应用
-> 应用后端完成业务鉴权
-> 应用后端以 AppKey + opaque subject 请求 Runtime Token
-> 平台创建或复用 opaque principalId
-> 浏览器只拿到短期 Runtime Token
-> 浏览器用 Runtime Token 调 app-scoped REST / WS
```

AppKey 只能保存在应用后端，不得进入浏览器代码、URL、日志或前端环境变量。

## 4. 最小集成：应用自有用户

以下例子使用：

```bash
PLATFORM_URL=https://agent-platform.internal
APP_ID=my-business-app
APP_KEY=sap_xxx
```

### 4.1 应用后端签发 Runtime Token

你的后端先验证当前业务用户，再调用平台：

```ts
// POST /api/agent/runtime-token - 这是你的业务后端接口
app.post("/api/agent/runtime-token", requireBusinessLogin, async (req, res) => {
  const subject = req.user.stableOpaqueId; // 不使用姓名、邮箱或角色

  const upstream = await fetch(
    `${process.env.PLATFORM_URL}/api/apps/${encodeURIComponent(process.env.APP_ID!)}/runtime-tokens`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-App-Key": process.env.APP_KEY!,
      },
      body: JSON.stringify({
        subject,
        agentId: req.body.agentId,       // 可选：绑定已有 Agent
        pageSessionId: req.body.pageSessionId,
        origin: req.headers.origin,
      }),
    }
  );

  if (!upstream.ok) {
    return res.status(upstream.status).json({ error: "Unable to mint runtime token" });
  }

  const token = await upstream.json();
  res.status(201).json(token);
});
```

平台返回：

```json
{
  "token": "<short-lived-runtime-token>",
  "expiresIn": 1800,
  "principalId": "<opaque-platform-id>",
  "pageSessionId": "ps_xxx",
  "agentId": null
}
```

应用不需要保存或解释 `principalId`。平台使用它隔离 Agent、Session、工作区和审计数据。

### 4.2 浏览器调用 app-scoped REST

浏览器只提交 Runtime Token，不提交 AppKey：

```ts
const headers = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${runtimeToken}`,
};

const agents = await fetch(
  `${platformUrl}/api/apps/${appId}/agents`,
  { headers }
).then(r => r.json());

const agent = await fetch(
  `${platformUrl}/api/apps/${appId}/agents`,
  {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "业务助手" }),
  }
).then(r => r.json());
```

常用 REST 端点：

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/api/apps/:appId/agents` | 列出当前执行主体在该应用中的 Agent |
| `POST` | `/api/apps/:appId/agents` | 创建 Agent |
| `GET` | `/api/apps/:appId/agents/:agentId` | 获取 Agent |
| `DELETE` | `/api/apps/:appId/agents/:agentId` | 删除 Agent 及其运行资源 |
| `GET` | `/api/apps/:appId/agents/:agentId/messages` | 获取消息历史 |
| `GET` | `/api/apps/:appId/agents/:agentId/events?from=1&limit=100` | 分页消费执行事件 |

所有 Agent 查询都同时校验 Application、组织、执行主体和 Agent ownership。跨应用或跨用户访问通常返回 `404`，避免泄露资源是否存在。

### 4.3 浏览器连接 WebSocket

```ts
const ws = new WebSocket(
  `${platformWsUrl}/api/apps/${encodeURIComponent(appId)}/ws` +
  `?token=${encodeURIComponent(runtimeToken)}`
);

ws.addEventListener("open", () => {
  ws.send(JSON.stringify({ type: "subscribe", chatId: agentId }));
});

function sendMessage(content: string) {
  ws.send(JSON.stringify({
    type: "chat",
    chatId: agentId,
    content,
    pageSessionId,
    pageContext: { route: location.pathname },
  }));
}
```

至少处理以下出站事件：

| 事件 | 应用动作 |
|---|---|
| `history` | 初始化消息列表 |
| `user_message` | 显示用户消息回显 |
| `assistant_message` | 增量渲染 Agent 文本 |
| `tool_use` / `tool_result` | 展示工具执行状态；不要把 payload 写入普通日志 |
| `approval_request` | 显示审批交互 |
| `result` | 结束本轮 loading，记录成功、耗时和成本摘要 |
| `error` | 显示可恢复错误 |
| `stopped` | 结束本轮运行状态 |

敏感 Tool 审批响应：

```ts
ws.send(JSON.stringify({
  type: "approval_response",
  id: approval.id,
  chatId: agentId,
  approved: true, // false 表示拒绝
  message: "用户已确认",
}));
```

只有收到用户批准后，Runtime 才能执行需要审批的 Tool。拒绝或超时不得产生执行副作用。

## 5. 平台用户 JWT 路径

如果应用直接使用平台用户体系，S2S 请求可以携带：

```http
Authorization: Bearer <platform-user-jwt>
X-App-Key: <app-key>
```

该平台用户还必须命中 Application 的 `org` 或 `user` access grant；即使是 `admin`，进入 Application 执行路径时也不自动绕过 grant。

不要把 AppKey 直接交给浏览器。推荐由你的 BFF 代理 S2S 请求，或者使用 Widget Token。对于已有独立用户体系的新应用，优先使用 Runtime Token 路径，避免把业务用户复制到平台用户目录。

## 6. 最快集成：嵌入 Widget

如果不想自行实现消息流、审批和停止交互，可以直接使用平台 Widget：

1. 应用后端以平台 User JWT + AppKey 调用 `POST /api/apps/:appId/widget-tokens`。
2. 浏览器只接收短期 `widgetToken`。
3. 使用 `/sdk/agent-widget.js` 初始化 iframe。
4. 页面筛选、路由或选中对象变化时调用 `widget.updateContext()`。

Widget 适合平台用户路径。应用自有用户、完全定制交互或自定义业务流程时，使用 Runtime Token + app-scoped REST/WS。

完整示例见 [Widget SDK 应用接入指南](./widget-sdk-app-integration-guide.md)。

## 7. Skill、MCP 与业务 API 如何接入

应用不要在每次请求中动态提交能力配置。能力由管理员先进入共享能力池，再通过治理层授权：

```text
准备 Skill/MCP/Hook plugin
-> 平台校验并注册到共享资源池
-> Application allowlist
-> org/user entitlement
-> Agent activation
-> 新 Runtime resolve 后生效
```

常见选择：

- 业务 API：优先包装为 MCP，让 Agent 通过结构化 Tool 调用。
- 可复用工作方法、提示和资源：包装为 Skill。
- 需要介入 SDK 生命周期：使用 Hook plugin；它是可信代码，不是安全边界。
- 领域口径、业务授权和数据过滤：仍放在你的业务后端或 MCP 内。

配置变更通常只对新 Runtime 生效。验证新 Skill/MCP 前，需要停止旧 Runtime 并让平台重建，不能只刷新前端页面。

## 8. runId 与运行审计

每条用户消息触发一次 Agent execution，对应一个独立 `runId`。平台管理员可以在 Admin 审计页按 runId 查询：

- 执行主体类型与 opaque principalId。
- org、Application、Agent 和 Agent Session。
- 本轮冻结的 configVersion、有效 capability IDs 和模型。
- Tool 审批请求与决定。
- 最终状态、Token、耗时和成本元数据。

审计不会复制消息正文、流式 chunk、原始 subject、AppKey、Token 或 Tool 输入输出。每次执行只新增一条 run 元数据，事件详情复用已有事件并限量返回。

`GET /api/admin/runs/:runId` 是平台管理员接口，不是应用业务 API。应用不要直接调用它，也不要把业务流程建立在该响应结构上。当前公开 WS `result` 事件没有承诺返回 runId；需要把 runId 暴露给应用时，应先形成独立的公开契约。

## 9. 生产接入检查清单

### 后端

- [ ] AppKey 只保存在服务端 secret manager 或环境变量中。
- [ ] Runtime Token 签发接口要求业务用户已登录，并做限流和来源校验。
- [ ] `subject` 稳定、不可猜测、无业务含义，不包含 PII 或权限声明。
- [ ] 不在日志中记录 AppKey、Runtime Token、完整 Tool payload 或用户消息正文。
- [ ] AppKey 轮换后能够处理旧 Runtime Token 失效并重新签发。

### 前端

- [ ] 浏览器只持短期 Runtime Token 或 Widget Token。
- [ ] 正确处理 token 过期、WS `4001/4003` 和重新签发。
- [ ] Agent 切换后重新发送 `subscribe`。
- [ ] `approval_request` 有明确的批准和拒绝交互。
- [ ] 页面卸载或用户停止时发送 `stop` 或关闭 WS。

### 治理与验收

- [ ] 未授权用户不能进入 Application。
- [ ] 用户只能访问自己的 Agent。
- [ ] 未授权、未激活或已禁用的 Skill/MCP 不进入 Runtime。
- [ ] 敏感 Tool 批准后只执行一次，拒绝和超时执行零次。
- [ ] 管理员能用 runId 追溯身份、能力、审批、结果和成本。

## 10. 常见错误

| 错误 | 正确做法 |
|---|---|
| 把 AppKey 放进 React/Vue 环境变量 | AppKey 只放应用后端 |
| 用 AppKey 代表最终用户 | Application principal 与执行主体必须分开 |
| 把应用用户批量同步成平台用户 | 应用自有用户使用 opaque subject + Runtime Token |
| 把业务角色塞进 subject 或 Token | 业务权限由应用后端判断，平台只接收执行主体 |
| 前端直接指定 Skill/MCP/Tool | 通过管理员治理配置和 capability intersection 生效 |
| 修改能力配置后只刷新页面 | 停止旧 Runtime，重建后验证 |
| 把 `/api/admin/runs/:runId` 当应用接口 | 它仅用于平台管理员审计 |

## 11. 推荐的第一个验收场景

用一个真实业务用户完成以下闭环：

1. 管理员创建 Application，配置 access/capability/Tool 策略。
2. 应用后端为业务用户签发 Runtime Token。
3. 浏览器用 Token-only REST 创建 Agent。
4. 浏览器连接 app-scoped WS 并发送消息。
5. Agent 只加载授权且激活的 Skill/MCP。
6. 触发一个敏感 Tool，分别验证批准与拒绝。
7. 验证跨 Application、跨用户 Agent 访问被拒绝。
8. 管理员检查本轮运行审计与成本元数据。

这条链跑通后，应用已经具备 Agent OS 最小接入闭环。后续业务开发主要发生在你的前端、业务后端、MCP、Skill 和领域数据层中，而不是平台 Runtime 内。
