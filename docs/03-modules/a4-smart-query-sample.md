# A4 智能问数样本 — 事件流端点与 E2E 验证

> Status: **implemented (Phase 6 A4)**
> Scope: A4 阶段的设计决策、实现模式、经验教训。
> Related: `docs/开发计划/a4-smart-query-dev-plan.md`（开发计划）、
> `docs/03-modules/capability-injection-paths.md`（四条注入路径总览）、
> `docs/02-architecture/platform-application-layer-architecture.md`（应用层架构决策）。

---

## 1. A4 解决了什么

**核心问题**：应用后端需要消费 Agent 事件流（异步分析、落库、导出），但只有 WS 实时通道，没有 REST 拉取能力。

A4 补了一个 app-scoped events 端点，让应用后端可以随时拉取 Agent 的结构化事件流。

**一句话**：`GET /api/apps/:appId/agents/:agentId/events?from=<seq>&limit=<n>` → 分页返回 Agent 事件，默认脱敏，admin 可 raw。

---

## 2. 架构设计

### 2.1 数据流

```text
应用后端 ──HTTP GET──→ /api/apps/:appId/agents/:agentId/events
                          │  双身份鉴权 (X-App-Key + JWT)
                          │  getOwnedAppAgent 校验 agent 属于该 app
                          ▼
                    eventStore.getEventsByChatPaginated(userId, agentId, fromSeq, limit+1)
                          │  LIMIT+1 计算 hasMore
                          ▼
                    { events: EventDTO[], nextFrom, hasMore }
                          │  payload 默认 redacted
                          │  ?raw=true 仅 admin
                          ▼
                    应用后端自行处理（落库/分析/导出）
```

### 2.2 关键设计决策

| 决策 | 理由 |
|---|---|
| REST polling 而非 SSE | WS 已覆盖实时场景；REST 适合后端异步消费，简单可靠 |
| `from` 用 sequence（inclusive `>=`） | sequence 已有序且稳定，无需 cursor 层 |
| `LIMIT+1` 计算 `hasMore` | 一次查询同时获取数据和 hasMore，无需二次 count |
| `nextFrom = last.sequence + 1` | 客户端无需推断下一页起始 |
| 默认 payload 脱敏 | 事件可能含 tool_input（用户数据）、approval 等敏感字段 |
| `?raw=true` 仅 admin | 普通用户始终看到脱敏版；admin 可看原始数据用于调试 |
| 非法 `from`/`limit` → 400 | 显式拒绝而非静默 fallback 到默认值 |

---

## 3. 实现模式

### 3.1 Event DTO + 脱敏

```typescript
// 敏感 key 黑名单（递归扫描）
const SENSITIVE_KEYS = /^(password|secret|token|apikey|api_key|authorization|credential|private_key)$/i;

function redactObj(obj: any): any {
  // 递归：匹配 key → "[REDACTED]"，不匹配 → 递归处理 value
}

function toEventDTO(event: AgentEvent, raw: boolean) {
  return {
    id: event.id,
    sequence: event.sequence,
    eventType: event.eventType,
    createdAt: event.createdAt,
    payload: raw ? JSON.parse(event.payloadJson) : JSON.parse(redactPayload(event.payloadJson)),
  };
}
```

**设计要点**：
- 脱敏在序列化层做，不改原始数据（DB 中的 `payload_json` 不变）
- 递归处理嵌套对象和数组
- 黑名单用正则匹配 key 名（大小写不敏感）
- `raw=true` 需要同时满足 admin 角色

### 3.2 分页模式

```typescript
// 内部查 limit+1 条
const events = eventStore.getEventsByChatPaginated(userId, agentId, fromSeq, limit + 1);
const hasMore = events.length > limit;
const pageEvents = hasMore ? events.slice(0, limit) : events;
const nextFrom = pageEvents.length > 0
  ? pageEvents[pageEvents.length - 1].sequence + 1
  : fromSeq;
```

**客户端使用模式**：
```text
GET events?from=1&limit=100  → { events: [...100], nextFrom: 101, hasMore: true }
GET events?from=101&limit=100 → { events: [...50], nextFrom: 151, hasMore: false }
// 停止
```

### 3.3 E2E 测试模式 — 真实 HTTP 路由

Codex review 核心要求：**不能只测 service 层，必须打真实 HTTP 路由验证鉴权链路**。

```typescript
// 启动真实 Express app
const app = express();
app.use(express.json());
app.use("/api", createAppRoutes());

// 通过 HTTP 调用，带真实 JWT + app key
const res = await httpRequest(app, "GET", `/api/apps/${APP}/agents/${agentId}/events`, {
  token: userToken,
  appKey: sqAppKey,
});
assert(res.status === 200);
```

**负面用例覆盖**：
- 缺少 X-App-Key → 401
- 错误 appKey → 401
- 跨 app 访问别人的 agent → 404（`getOwnedAppAgent` 拦截）

---

## 4. 文件清单

| 文件 | 职责 |
|---|---|
| `server/app-routes.ts` | events 端点 + 脱敏 + 分页 |
| `server/event-store.ts` | `getEventsByChatPaginated` 方法 + prepared statement |
| `server/a4-smart-query-e2e.test.ts` | 35 个测试（全链路 + 鉴权 + 分页 + 脱敏 + 负面用例） |
| `docs/开发计划/a4-smart-query-dev-plan.md` | 开发计划（含 Codex review 纳入） |

---

## 5. 后续应用开发者需要知道的

### 5.1 如何消费事件流

```bash
# 第一页
curl -X GET "http://platform/api/apps/:appId/agents/:agentId/events?from=1&limit=100" \
  -H "X-App-Key: sap_xxx" \
  -H "Authorization: Bearer <jwt>"

# 响应
{
  "events": [
    { "id": "...", "sequence": 1, "eventType": "assistant_message", "payload": {...}, "createdAt": "..." },
    ...
  ],
  "nextFrom": 101,
  "hasMore": true
}

# 下一页
curl -X GET "http://platform/api/apps/:appId/agents/:agentId/events?from=101&limit=100" ...
```

### 5.2 事件类型说明

| eventType | 含义 | payload 关键字段 |
|---|---|---|
| `assistant_message` | Agent 回复 | `content` |
| `tool_use` | Agent 调用工具 | `toolName`, `toolInput` |
| `tool_result` | 工具返回 | `output` |
| `result` | 一轮对话结束 | `success`, `cost`, `duration` |
| `approval_request` | 请求审批 | `toolName` |
| `error` / `stopped` | 异常/中止 | `error` |

### 5.3 脱敏规则

默认返回脱敏版 payload。以下 key 的值会被替换为 `"[REDACTED]"`：
- `password`, `secret`, `token`, `apiKey`, `api_key`, `authorization`, `credential`, `private_key`

如需原始数据（仅 admin）：
```bash
curl "...?raw=true" -H "Authorization: Bearer <admin-jwt>" -H "X-App-Key: ..."
```

---

## 6. 平台边界验证

A4 的核心原则是 **平台不建领域层**。E2E 测试验证了：

| 平台侧 | 应用侧（不在平台仓库） |
|---|---|
| events 端点 | 异步分析逻辑 |
| 事件存储 | 落库到应用 DB |
| 脱敏 | 导出报表 |
| 鉴权 | 问数前端 |
| capability resolve | 语义层/口径/知识库 |

E2E 测试中不出现任何 SQL 生成、指标定义、口径映射代码。

---

## 7. Codex Review 经验

| 发现 | 根因 | 修复 |
|---|---|---|
| E2E 不能只测 service 层 | 原计划不启动 Express | 改为真实 HTTP + `createAppRoutes()` |
| payload 不能原样返回 | tool_input 含用户数据 | 默认脱敏 + `?raw=true` admin only |
| 分页需要 `nextFrom` | 客户端不应推断 | 返回 `nextFrom = last.sequence + 1` |
| `capability_resources` 不是 DB 表 | 是内存服务 | 用 MCP name 作 resourceId |
| `agent_capabilities` 不是 DB 表 | 是 JSON 文件 | 用 `agentCapabilityService` API |

**经验**：E2E 测试的最高价值不是验证数据查询，而是验证 **鉴权链路**（appAuthMiddleware → getOwnedAppAgent → 跨 app 拒绝）。
service 层测试覆盖业务逻辑，HTTP 层测试覆盖安全边界。
