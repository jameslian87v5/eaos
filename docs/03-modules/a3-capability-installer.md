# A3 Capability Installer — 内网 HTTP API → MCP 能力注入

> Status: **implemented (Phase 6 A3)**
> Scope: A3 阶段的设计决策、实现模式、经验教训。
> Related: `docs/03-modules/capability-injection-paths.md`（四条注入路径总览）、
> `docs/02-architecture/platform-application-layer-architecture.md`（应用层架构决策）、
> `docs/03-modules/application-extension-points.md`（扩展点契约）。

---

## 1. A3 解决了什么

**核心问题**：企业内网有大量 HTTP API（如 `GET_CUSTOMER_ERPID`），Agent 无法直接调用。
A3 把这些 API 包装成 stdio MCP server，注入 Agent runtime，让 Claude 能像调用原生工具一样调用内网 API。

**一句话**：`internal HTTP API → registered_apis 表 → MCP wrapper 生成 → data/mcp.json 注册 → capability resolve() 注入 → Agent 容器内 /opt/agent/mcp/ 只读挂载`。

---

## 2. 架构设计

### 2.1 数据流

```text
Admin REST API (/api/admin/apis)
  → registered-api-service.ts (CRUD + 校验)
  → registered_apis 表 (SQLite)
  → capability-installer.ts (installApiAsMcp)
  → mcp/<name>/server.cjs + run.sh + mcp.json (文件系统)
  → data/mcp.json (全局 MCP 注册表，原子更新)
  → mcp-config.ts (resolveOne 校验)
  → capability-provider.ts (resolve: app allowlist ∩ entitlement ∩ activation)
  → CapabilityBundle.sdkOptions.mcpServers + mounts (只读挂载)
  → agent-entry.ts (容器内 /opt/agent/mcp/ 前缀校验)
  → Claude Agent SDK query() (Agent 调用 tool)
```

### 2.2 关键设计决策

| 决策 | 理由 |
|---|---|
| API metadata 作为 JSON 常量嵌入 `server.cjs` | 避免 `eval()`/`Function()`，安全；wrapper 自包含，不依赖外部文件 |
| `data/mcp.json` 原子写入（tmp → rename） | 防止部分写入导致全局 MCP 注册表损坏 |
| wrapper 只读挂载到容器 (`/opt/agent/mcp/<name>:ro`) | 防止 Agent 篡改 wrapper 代码 |
| `strictMcpConfig: true` 注入 SDK | SDK 层面拒绝未注册的 MCP server |
| MCP `command` 必须以 `/opt/agent/mcp/` 开头 | `agent-entry.ts` 强制路径前缀校验，防路径逃逸 |

---

## 3. 实现模式与经验

### 3.1 DB + 文件系统原子性（Codex 两轮 review 的核心）

**问题**：`registered_apis` 表（DB）和 `mcp/<name>/`（文件系统）是两个独立存储。
create/update/delete 操作需要同时修改两者，任一失败都会导致不一致。

**模式：snapshot + rollback**

```typescript
// admin-app-routes.ts — update 路径
const oldApi = service.getById(id);  // 1. 快照旧状态
const updated = service.update(id, input);  // 2. 写 DB（新值）
try {
  installApiAsMcp(updated);  // 3. 生成 wrapper（新值）
} catch {
  service.restore(oldApi);   // 4a. 回滚 DB（旧值）
  installApiAsMcp(oldApi);   // 4b. 重装 wrapper（旧值）
}
```

**三条路径的原子性策略**：

| 路径 | 策略 |
|---|---|
| **Create** | DB insert → install；失败 → DB delete |
| **Update** | snapshot old → DB update → install；失败 → `restore(old)` + 重装旧 wrapper |
| **Delete** | uninstall → DB delete；失败 → DB row 保留（wrapper 也保留，可重试） |

**经验**：DB + 文件系统的原子性不可能用单一事务保证。snapshot + rollback 是最实用的补偿模式。
如果 rollback 也失败，返回 `rollback: "partial"` 让运维介入。

### 3.2 Schema 校验复用（create/update 对齐）

**问题**：create 和 update 的校验逻辑容易分叉。

**模式：提取共享校验方法**

```typescript
class RegisteredApiService {
  validateInput(input): void {       // create 用
    this.validateUrl(input.apiUrl);
    this.validateSchemaFields(input.requestParamsSchema, input.responseMapping);
  }
  private validateUrl(url): void { ... }
  private validateSchemaFields(schema, mapping): void { ... }  // create + update 共用
  update(id, input): RegisteredApi | null {
    this.validateUrl(apiUrl);        // update 用
    this.validateSchemaFields(...);  // 同一套规则
  }
}
```

**校验规则**：
- `requestParamsSchema`：必须是 object，`type` 若有必须为 `"object"`，`properties` 若有必须是 object
- `responseMapping`：必须是 object，所有 value 必须是 string
- `apiUrl`：必须是 `http:` 或 `https:` 协议
- `name`：必须匹配 `^[a-z][a-z0-9_]*$`（防路径穿越）

### 3.3 MCP Wrapper 生成模式

生成的 `server.cjs` 结构：

```javascript
// 1. CONFIG 作为 JSON 常量嵌入（不是字符串拼接）
var CONFIG = {"apiUrl":"http://...","method":"GET","timeoutMs":61000,...};

// 2. JSON-RPC 2.0 over stdio
var rl = readline.createInterface({ input: stdin });
rl.on("line", function(line) {
  var msg = JSON.parse(line);
  if (msg.method === "initialize") { ... }
  if (msg.method === "tools/list") { ... }
  if (msg.method === "tools/call") {
    fetch(CONFIG.apiUrl, fetchOpts)  // 3. 异步 fetch
      .then(function(r) { return r.text(); })
      .then(function(text) {
        send({ result: { content: [{ type: "text", text: text }] } });
      });
  }
});
```

**安全要点**：
- CONFIG 用 `JSON.stringify()` 嵌入，不是字符串拼接 — 防注入
- 无 `eval()`、无 `new Function()` — wrapper 代码是固定模板，只有 CONFIG 变化
- `run.sh` 只调用 `node server.cjs`，不传任何用户输入

### 3.4 App Allowlist 机制（deny-by-intersection）

能力注入的三层过滤：

```text
app allowlist (上界) ∩ entitlement (权限) ∩ agent activation (激活)
```

**关键语义**（`application-capabilities.ts`）：
- `null` = 该 app 无 `application_capabilities` 行 = **passthrough**（无上界，legacy 兼容）
- `string[]` = 有行，enabled resource_ids 是上界
- `[]`（所有行 enabled=0）= **deny all**

**测试要点**：测试 exclusion 时不能用空 allowlist（那是 passthrough），必须设置一个**包含其他资源但排除目标 MCP** 的 allowlist。

### 3.5 真实 API 测试策略

**问题**：内网 API 可能返回 403、超时、DNS 不可达 — 如何写一个有意义的测试？

**模式：区分 protocol smoke vs API readiness**

| 层面 | 断言类型 | 失败含义 |
|---|---|---|
| initialize + tools/list | **Hard assert** | wrapper 生成有 bug |
| tools/call 有 JSON-RPC 响应 | **Hard assert** | wrapper 进程崩溃 |
| tools/call 响应内容 | **Soft check** | 取决于网络/网关状态 |

```typescript
// 有响应（result 或 error）= wrapper 正确工作了
if (callResp.result?.content?.[0]?.text !== undefined) {
  // 403/empty = 网关拒绝，wrapper 正确转发了
  // JSON with code/data = API 集成健康
} else if (callResp.error) {
  // 网络错误 = wrapper 正确报告了 fetch 失败
}
// 完全无响应 = wrapper 崩溃 = 硬失败
```

**经验**：测试 wrapper 的协议正确性（JSON-RPC 格式、tool 暴露、fetch 转发）比测试 API 本身的可用性更有价值。
后者属于集成测试，应在部署环境里做。

---

## 4. 文件清单

| 文件 | 职责 |
|---|---|
| `server/database.ts` | `registered_apis` 表定义 |
| `server/types.ts` | `RegisteredApi`、`ApiRegistrationInput` 类型 |
| `server/registered-api-service.ts` | CRUD + 校验 + `restore()` |
| `server/capability-installer.ts` | wrapper 生成 + `data/mcp.json` 原子更新 |
| `server/admin-app-routes.ts` | Admin REST API + 原子性 rollback |
| `server/a3-capability-installer.test.ts` | 60 个测试（wrapper/协议/链路/安全/allowlist/schema/rollback） |
| `server/a3-real-api-test.ts` | 真实内网 API 协议测试 |

---

## 5. 后续应用开发者需要知道的

### 5.1 如何注册一个新的内网 API

```bash
# 1. Admin 创建 API 记录
curl -X POST http://localhost:3001/api/admin/apis \
  -H "Authorization: Bearer <admin-jwt>" \
  -d '{
    "name": "get_order_detail",
    "displayName": "查询订单详情",
    "apiUrl": "http://internal-api/orders/detail",
    "method": "GET",
    "timeoutMs": 30000
  }'

# 2. API 自动生成 MCP wrapper 并注册到 data/mcp.json
# 3. 在 capability_resources 中注册为 MCP 类型资源
# 4. 通过 entitlement + app allowlist + agent activation 控制可见性
```

### 5.2 POST API 带参数

```json
{
  "name": "create_order",
  "apiUrl": "http://internal-api/orders/create",
  "method": "POST",
  "requestParamsSchema": {
    "type": "object",
    "properties": {
      "customerId": { "type": "string" },
      "productId": { "type": "string" }
    }
  }
}
```

wrapper 会把 `tools/call` 的 `arguments` 作为 POST body 发送。

### 5.3 平台升级者注意

- **wrapper 模板变更**：修改 `capability-installer.ts` 中的模板字符串，所有已安装的 wrapper 需要 `uninstall` → `install` 重新生成
- **MCP 协议升级**：`server.cjs` 中的 JSON-RPC 处理需要同步更新
- **新增 HTTP method**（PUT/DELETE）：需要同时改 `validateInput`、wrapper 模板、`agent-entry.ts` 的 method 白名单
- **`data/mcp.json` 格式变更**：需要迁移脚本，旧格式 → 新格式，保持原子写入

---

## 6. Codex Review 经验

两轮 review 的关键发现：

| 轮次 | 发现 | 根因 | 修复模式 |
|---|---|---|---|
| R1 | DB+installer 不原子 | create/update/delete 无 rollback | try/catch + 补偿删除 |
| R1 | 无 app allowlist 测试 | 只测了 default-app passthrough | 创建真实 app + agent 测 include/exclude |
| R1 | 无 schema 校验 | `requestParamsSchema`/`responseMapping` 接受任意值 | 写入时校验 |
| R2 | update 路径仍不原子 | update 先写 DB 再 install，失败不回滚 | snapshot old → restore + 重装 |
| R2 | update 校验比 create 弱 | 内联校验逻辑分叉 | 提取 `validateSchemaFields()` 共用 |
| R2 | 真实 API 测试太宽松 | error/timeout 也算 pass | 区分 hard/soft assert |

**经验**：DB + 文件系统的原子性是 review 的常见靶点。第一轮的 "try/catch + 补偿" 只解决了 create 路径；
update 路径需要更完整的 snapshot + rollback 模式。校验逻辑一旦在两处重复，就一定会分叉 — 提取共享方法是唯一可靠的做法。
