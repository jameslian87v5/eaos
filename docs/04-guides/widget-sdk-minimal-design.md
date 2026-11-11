# Widget + 薄 SDK 最小设计要求（v0）

> 写给开发。基于本仓库已有的 app-scoped API（见 `docs/05-migration/a3-a4-detailed-walkthrough.md`），定义"一行嵌入问数"的 **iframe Widget** 和可独立使用的**薄 SDK** 的最小实现要求。
> 目标：v0 最小可用，能给开发直接照着做；不是最终形态。

---

## 0. 目标与范围

**做**：让任意内部页面一行 `<iframe>` 嵌入一个"问数"对话框；同时提供一个不渲染 UI 的薄 SDK，给自建前端（如看板里的 copilot 侧栏）直接用。

**v0 覆盖**：创建会话 → 发问 → 流式收文 → 收一张图（chart directive）→ 审批/停止。

**v0 不做**（明确边界，别扩展）：历史消息加载、多会话切换、事件流 REST 轮询（应用后端异步用）、agent 反驱动看板、移动端深度适配。

**关系**：Widget 内部调用薄 SDK 实现；SDK 也能脱离 Widget 单独使用。

---

## 1. 平台已有的接口（SDK/Widget 必须对接，不要新造）

| 用途 | 方法 | 鉴权 |
|---|---|---|
| 创建 Agent | `POST /api/apps/:appId/agents` | `Authorization: Bearer <JWT>` + `X-App-Key` |
| WebSocket 流式 | `WS /api/apps/:appId/ws?token=<JWT>&appKey=<AppKey>` | query: `token` + `appKey` |
| （v0 不用）事件流 | `GET /api/apps/:appId/agents/:id/events` | 同 REST |
| （v0 不用）历史 | `GET /api/apps/:appId/agents/:id/messages` | 同 REST |

WS 消息类型（以平台为准，SDK 只做映射，不发明协议）：
- 宿主→平台：`{type:"chat", chatId, content, context?}`、`{type:"approval_response",...}`、`{type:"stop",chatId}`
- 平台→宿主：`connected` / `history` / `stream_delta` / `tool_use` / `tool_result` / `assistant_message_done` / `approval_request` / `error`

---

## 2. 硬约束（铁律，违反即返工）

1. **双身份鉴权**：每次 REST/WS 必须同时带 JWT（用户）+ AppKey（应用），缺一不可（平台 `appAuthMiddleware` 会拒）。
2. **AppKey 不得出现在宿主（embedder）页面的源码或网络请求里**。它只能存在于"应用自己后端托管的 iframe 同源上下文"中（见 §4）。宿主页面只拿到一个**短时签名 embed token** 或干脆走 BFF 代理。
3. **不执行 agent 产出的任何代码**。图表只认 chart directive（§5），由前端 renderer 渲染。
4. **不把会话内容/查询结果落 localStorage / sessionStorage / IndexedDB**（数据安全：会议要求核心数据可控、不外泄）。会话状态用内存。
5. **跨域只走 postMessage 且双向校验 `event.origin`**（白名单），非法 origin 一律忽略。
6. **WS 是唯一实时通道**；v0 不要轮询。断线自动重连（指数退避，上限 3 次）。

---

## 3. 薄 SDK 契约（必须实现的最小 API）

包名建议 `@app/ask-sdk`，TS 单包，无 UI 依赖。**只做**：连接 / 鉴权 / 协议序列化 / 事件分发 / chart directive 透传。

```ts
export interface AskClientOptions {
  platformUrl: string;            // 平台基址，如 https://ask.platform
  appId: string;
  getUserJwt: () => Promise<string>;   // 集成方提供：返回当前用户短时 JWT
  getAppKey: () => Promise<string>;    // 集成方提供：返回 AppKey（见 §4 凭证模型，禁止硬编码）
}

export interface AskClient {
  createAgent(title?: string): Promise<Agent>;   // POST /api/apps/:appId/agents
}

export interface Agent {
  id: string;
  send(content: string, opts?: SendOptions): Promise<AssistantResult>;
  stop(): void;       // 发 {type:"stop"}
  dispose(): void;    // 关 WS、清监听
}

export interface SendOptions {
  context?: object;                          // surface context：当前看板/筛选/视图（融合关键）
  onDelta?: (text: string) => void;          // ← stream_delta（逐字）
  onChart?: (directive: ChartDirective) => void;  // ← chart directive（见 §5）
  onTool?: (e: { toolName: string; toolInput: unknown }) => void;
  onApproval?: (req: ApprovalReq) => Promise<boolean>;  // ← approval_request，返回是否同意
  signal?: AbortSignal;                       // 中止
}
```

事件 → 平台 WS 映射（SDK 内部实现）：

| SDK 回调 | 平台 WS 事件 |
|---|---|
| `onDelta` | `stream_delta` |
| `onChart` | 助手消息里的 chart directive（A2UI chart 卡片）解析后透传 |
| `onTool` | `tool_use` / `tool_result` |
| `onApproval` | `approval_request` → SDK 发 `approval_response` |
| `send` resolve | `assistant_message_done` |

**"薄"的边界**：SDK **不**做 UI 渲染、不引 ECharts、不维护消息列表、不持久化。这些归 Widget / 集成方。

---

## 4. iframe Widget 嵌入与凭证模型（关键）

### 4.1 宿主页嵌入（一行）
```html
<iframe
  src="https://ask.platform/widget?appId=APP_X&embedToken=<短时token>"
  sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
  allow="clipboard-write"
  style="width:380px;height:600px;border:0;border-radius:12px">
</iframe>
```

### 4.2 凭证模型（二选一，按部署成熟度选）

**方案 A（推荐，AppKey 不进浏览器）—— 签名 embed token**
1. 宿主**后端**（S2S，持 AppKey + 服务凭证）调平台新增端点 `POST /api/apps/:appId/embed-token` → 拿到短时 token（绑定 userId+appId+exp，如 15 分钟）。
2. iframe 用 `embedToken` 走 WS/REST；平台校验 token 后**内部注入 AppKey**，浏览器全程看不到 AppKey。
3. **平台需新增**：`embed-token` 端点 + WS 鉴权支持 `embedToken` 模式 + 托管 `/widget` 静态页。

**方案 B（v0 最快，平台零改动）—— 宿主 BFF 代理**
- iframe 只与宿主**同源 BFF** 通信（WS/REST 都打到 BFF）；BFF 注入 AppKey + 用宿主会话换 JWT，再代理调平台。
- 代价：宿主写一个 WS 代理（含重连）。内网门户起步推荐这个。

> ❌ **禁止方案 C**：把 AppKey 明文写进宿主页面 JS 或 iframe URL。仅当"纯内网 + AppKey 低权 + 用户已强认证"时可由架构师特批，默认不允许。

### 4.3 iframe ↔ 宿主页 postMessage 协议（跨域双向）
宿主和 iframe 双方维护 origin 白名单，收到消息先 `if (!ALLOWED.has(e.origin)) return;`

| 方向 | `{kind, ...}` | 用途 |
|---|---|---|
| 宿主 → iframe | `{kind:"ask:setContext", context:{dashboard, filters, view}}` | 把看板当前状态推进问数（surface context 融合） |
| 宿主 → iframe | `{kind:"ask:open"}` / `{kind:"ask:close"}` | 开/关面板 |
| iframe → 宿主 | `{kind:"ask:ready", agentId?}` | 加载就绪 |
| iframe → 宿主 | `{kind:"ask:navigate", target:{dashboard, filters}}` | （v1）agent 反驱动看板跳转 |

### 4.4 Widget 内部 UI（最小，仅此四样）
1. 输入框 + 发送按钮（Enter 发送）
2. 消息流：用户气泡 / 助手气泡；助手气泡支持三类内容——流式文本、**chart directive → ECharts**（§5）、审批卡片（同意/拒绝）
3. 停止按钮（生成中可中止）
4. 错误/断线提示 + 自动重连指示

---

## 5. chart directive 渲染契约（复用架构 §3.6，不改）

SDK 透传、Widget/集成方实现 renderer：

```ts
export type ChartDirective = {
  type: "chart";
  chartType: "bar" | "line" | "pie" | "table" | "kpi";
  title?: string;
  dimensions: string[];
  metrics: string[];
  data: Record<string, unknown>[];     // 长表格式
  meta?: { timeRange?: string; filters?: object; sort?: object; topN?: number; compare?: "yoy"|"mom"|null };
  interactions?: ("drill" | "filter" | "export")[];
};
// renderer 签名：
export type ChartRenderer = (d: ChartDirective) => HTMLElement;  // 内部用 ECharts
```

- Widget 自带一个默认 ECharts renderer（覆盖 5 种 chartType）。
- 集成方（自建前端）可传自己的 renderer 覆盖，统一样式。
- **agent 不产出可执行代码**，只产出这个 JSON；renderer 在前端，安全。

---

## 6. v0 验收清单（开发自测 + 评审用）

1. 宿主页一行 iframe 嵌入，能创建会话、发问、流式收文、收到一张柱状图。
2. **AppKey 不出现在宿主页源码、不出现在宿主页发出的任何请求里**（方案 A/B）。浏览器开发者工具网络面板搜不到 AppKey 明文。
3. 跨域 postMessage：非法 origin 的消息被忽略；`ask:setContext` 能把看板筛选带进提问（前端可验证 agent 回答带上了该筛选）。
4. 断网重连：手动断网再恢复，重连 1 次后能继续收消息。
5. 危险操作（如导出写文件）弹审批卡片；点"拒绝"后 agent 停止该动作。
6. **SDK 独立可用**：不用 iframe，在一个自建页面 `import` SDK，跑通同样链路（创建会话→发问→收文→收图）。
7. 无任何会话内容写入 localStorage / IndexedDB。

---

## 7. 产出清单（给开发的交付物）

```
packages/
  ask-sdk/            # 薄 SDK：TS，依赖只有 ws/fetch（浏览器原生）；导出 createAskClient
  ask-widget/         # iframe 页：React（或 Vanilla），import ask-sdk + 默认 ECharts renderer
```
- 平台侧改动（仅方案 A 需要）：`POST /api/apps/:appId/embed-token` 端点 + WS 接受 `embedToken` 鉴权 + `/widget` 静态页托管。
- 宿主侧（方案 B）：薄 BFF（WS 代理 + JWT 交换）+ iframe 托管。

---

## 8. 安全提醒（必读）

- **copilot 一旦提问，查询结果会过 agent 的云端 LLM（智谱）**——这是平台既有的数据出口问题，SDK/Widget 不解决它。在数据安全决策（自托管模型 / 数据最小化 / 批准供应商）落地前，Widget 默认**只接聚合查询、关闭明细导出**（由语义层 MCP 的 `export_detail` gated 控制，SDK 不绕过）。
- iframe 必带 `sandbox`（最小权限）；跨域务必校验 origin。
- AppKey 视同密钥：hash 存储、不入前端 bundle、不入日志、可轮转（平台已支持）。
