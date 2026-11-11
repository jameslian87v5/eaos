# 应用层开发经验沉淀 (A0–A4)

> Status: **Phase 6 A0–A4 完成**
> Audience: 平台开发者 + 应用开发者
> Scope: A0 到 A4 全链路中的设计模式、踩坑经验、对抗式审查发现，供后续开发者参考。
> Related: `docs/02-architecture/platform-application-layer-architecture.md`（权威架构）、
> `docs/03-modules/a3-capability-installer.md`、`docs/03-modules/a4-smart-query-sample.md`。

---

## 1. 应用层全景

```text
A0 (最小应用模型)
  └─ applications 表 + application_capabilities 表 + agents.app_id
A1 (app-scoped Agent + 能力上界)
  └─ app-routes.ts: CRUD + 双身份鉴权 + deny-by-intersection
A2 (hook 扩展点)
  └─ hook-transport.ts: 薄契约 + 容器边界翻译 + 治理守卫
A3 (capability installer)
  └─ registered-api-service.ts + capability-installer.ts: 原子安装 + 回滚
A4 (智能问数样本)
  └─ events 端点 + e2e 验证: REST polling + 脱敏 + 分页
```

---

## 2. 核心设计模式

### 2.1 双身份鉴权（铁律）

**模式**：每个 app-scoped 请求携带两个独立 principal：
- `Authorization: Bearer <JWT>` — 操作者身份（user/admin）
- `X-App-Key: sap_xxx` — 应用身份

**实现**：`server/app-auth.ts` 的 `appAuthMiddleware` 依次验证 JWT → app key → appId 一致性。

**踩坑**：
- app key 绝不替代用户 auth。即使 S2S 场景也用 key-bound service user。
- `verifyAppKey` 返回 appId，必须和 URL 中的 `:appId` 比对，否则跨 app 访问。
- app key 格式 `sap_<random>`，前 16 字符做 prefix 索引，全量 bcrypt 比对。

**代码位置**：`server/app-auth.ts:30-95`

### 2.2 Deny-by-Intersection（能力合并铁律）

**模式**：有效能力集 = `app allowlist ∩ entitlement ∩ agent activation`，三者取交集，缺一不可。

**不变量**：
- 任何一方移除某个 resource → 该 resource 对 agent 立即失效
- admin bypass 只跳过 entitlement 检查，不跳过 app allowlist 和 agent activation
- `deny-default`：没有 activation 的 agent → 0 skill, 0 mcp

**实现**：`server/capability-provider.ts` 的 `resolve()` 方法。

**对抗式审查发现**：
- 如果 app allowlist 设了一个不存在的 resourceId，不会报错但也不会注入——graceful degradation。
- `configVersion` 机制：app capabilities 变更时递增，触发 resolve 缓存失效。

### 2.3 平台不建领域层（边界铁律）

**模式**：平台 = 引擎 + 治理 + 扩展点透传。语义、口径、知识库、业务前端 = 应用自带。

**A4 中的体现**：
| 平台侧 | 应用侧 |
|---|---|
| events 端点（存储 + 拉取 + 脱敏） | 异步分析（消费 events 做业务处理） |
| capability resolve（注入 MCP） | 语义层（定义查询口径、指标映射） |
| hook envelope（透传 + 守卫） | hook handler（业务逻辑） |
| app key 鉴权 | 问数前端（用户交互） |

**审查要点**：每次 PR 检查是否引入了领域逻辑（SQL 生成、指标定义、口径映射）到平台代码。

---

## 3. E2E 测试模式（Codex review 沉淀）

### 3.1 必须打真实 HTTP 路由

**教训**：service 层测试覆盖业务逻辑，但鉴权链路（appAuthMiddleware → getOwnedAppAgent → 跨 app 拒绝）只能在 HTTP 层验证。

**模式**：
```typescript
const app = express();
app.use(express.json());
app.use("/api", createAppRoutes());

const res = await httpRequest(app, "GET", `/api/apps/${APP}/agents/${id}/events`, {
  token: userToken,
  appKey: sqAppKey,
});
assert(res.status === 200);
```

### 3.2 Hermetic 隔离 — 所有外部文件都要 temp

**踩坑**：测试只设了 `DB_PATH`、`AGENT_CAPABILITIES_FILE`、`ENTITLEMENTS_FILE`，但忘了 `MCP_CONFIG_FILE`，导致测试读写真实 `data/mcp.json`，结果依赖开发者机器状态。

**正确模式**：
```typescript
process.env.DB_PATH = "/tmp/test-a4.db";
process.env.AGENT_CAPABILITIES_FILE = "/tmp/test-a4-caps.json";
process.env.ENTITLEMENTS_FILE = "/tmp/test-a4-ent.json";
process.env.MCP_CONFIG_FILE = "/tmp/test-a4-mcp.json";
// 全部 rmSync 在 setup 阶段
```

**检查清单**：DB、agent-capabilities、entitlements、mcp-config、prompt-settings（如有用到）。

### 3.3 断言不能 unconditional pass

**踩坑**：Test 5 写了 `assert2(true, ...)`，无论 MCP 是否注入都 pass。这掩盖了 A1→A3 集成链路的真实问题。

**正确模式**：
```typescript
assert2(mcpNames.includes("mock_query_api"), `MCP injected (got: [${mcpNames.join(",")}])`);
```

### 3.4 负面用例覆盖

**必须覆盖**：
- 缺少 app key → 401
- 错误 app key → 401
- 跨 app 访问别人的 agent → 404
- 非法分页参数 → 400
- malformed payload → 不 500，返回 parseError

---

## 4. 事件流设计经验

### 4.1 REST polling vs SSE vs WS

| 通道 | 场景 | 消费者 |
|---|---|---|
| WS（已有） | 实时 UI 更新 | 前端 |
| REST polling（A4 新增） | 异步分析、落库、导出 | 应用后端 |
| SSE | 未来考虑 | 暂不需要 |

**决策**：REST polling + WS 足够。SSE 不增加价值，因为应用后端不需要实时性，polling 更简单可靠。

### 4.2 分页模式 — LIMIT+1

**模式**：查 `limit+1` 条，多出的 1 条用于判断 `hasMore`，无需二次 count 查询。

```typescript
const events = eventStore.getEventsByChatPaginated(userId, agentId, fromSeq, limit + 1);
const hasMore = events.length > limit;
const pageEvents = hasMore ? events.slice(0, limit) : events;
const nextFrom = pageEvents.length > 0
  ? pageEvents[pageEvents.length - 1].sequence + 1
  : fromSeq;
```

**客户端使用**：
```text
GET ?from=1&limit=100    → { events: [...100], nextFrom: 101, hasMore: true }
GET ?from=101&limit=100  → { events: [...50], nextFrom: 151, hasMore: false }
// 停止
```

### 4.3 Payload 脱敏

**模式**：默认返回脱敏版，`?raw=true` 仅 admin 可用。

**敏感 key 黑名单**（正则，大小写不敏感）：
```
password, secret, token, apikey, api_key, authorization, credential, private_key
```

**实现**：递归扫描对象，匹配 key → `"[REDACTED]"`，不匹配 → 递归处理 value。脱敏在 DTO 层做，不改原始数据。

### 4.4 Malformed JSON 安全处理

**踩坑**：`toEventDTO` 原先两次 `JSON.parse`（一次脱敏、一次 raw），malformed JSON 会抛异常导致 500。

**修复**：parse 一次，catch 后返回 `{ parseError: true, raw: payloadJson }`。事件日志是 append-only 操作数据，一条坏数据不能 break 整页。

---

## 5. A3 Capability Installer 经验

### 5.1 原子安装 + 回滚

**模式**：
1. 快照旧 DB 行
2. 更新 DB
3. 安装 MCP wrapper
4. 如果安装失败 → 恢复旧 DB 行 + 重装旧 MCP wrapper

**踩坑**：最初 update 方法用 `getById({ id })` 传参，但 prepared statement 期望位置参数。修复为 `getById.get({ id })`。

### 5.2 Schema 验证

**模式**：create 和 update 都验证 `requestParamsSchema`（必须是 JSON object，type 为 object）和 `responseMapping`（必须是 string→string map）。

**教训**：update 路径最初漏了 schema 验证，导致可以通过 update 绕过 create 时的校验。修复为 create/update parity。

---

## 6. Hook 扩展点经验 (A2)

### 6.1 薄契约 — 不透传函数

**模式**：hook 契约是可序列化的 `{event, matcher, handler, timeout, auth, retry, responseFields}`，不是原始 SDK 函数。函数不可序列化，且应用不应直接接触 SDK 内部。

### 6.2 治理守卫不可被应用覆盖

**铁律**：
- deny-default、`/opt/agent/mcp/` 前缀、`strictMcpConfig`、路径校验、审计 → 不可覆盖
- hook 专属守卫：SSRF allowlist、超时、payload 限制、retry 限制、脱敏、precedence（守卫在外、app 只能收窄）
- 审计不存 payload（防止敏感数据落审计日志）

---

## 7. capability_resources 不是 DB 表

**踩坑**：`capability_resources` 在 `database.ts` 的注释中被引用，但实际不是 DB 表。它是 `server/capability-resource.ts` 中的内存服务，由 `data/skills.json` 和 `data/mcp.json` 支持。

**resourceId 规则**：等于 skill/MCP 的 name（如 `"mock_query_api"`），不是 UUID。

**同样**：`agent_capabilities` 也不是 DB 表，是 `data/agent-capabilities.json` 文件，通过 `agentCapabilityService` API 操作。

---

## 8. 开发者上手清单

### 平台开发者
1. 读 `docs/02-architecture/platform-application-layer-architecture.md` 理解平台定位
2. 读 `docs/03-modules/application-extension-points.md` 理解扩展点契约
3. 改 `capability-provider.ts` 前理解 deny-by-intersection 不变量
4. 加新端点前确认走 `appAuthMiddleware` + `getOwnedAppAgent`
5. 测试必须 hermetic（所有 env var 都设 temp）
6. 测试必须打真实 HTTP 路由（不只 service 层）

### 应用开发者
1. 读 `docs/03-modules/a4-smart-query-sample.md` 理解事件消费
2. 读 `docs/04-guides/app-hook-guide.md` 理解 hook 注册
3. 用 app key + JWT 调 app-scoped API（双身份）
4. 消费 events 用 REST polling（`from` + `limit` + `nextFrom`）
5. 敏感数据默认脱敏，需要原始数据用 `?raw=true`（需 admin）
6. 能力声明走 app allowlist → entitlement → agent activation（三方交集）
