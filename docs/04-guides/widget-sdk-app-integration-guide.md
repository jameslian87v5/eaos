# Widget SDK 应用接入指南

> 读者：业务应用开发者。
> 目标：把平台 Agent Widget 嵌入到自己的业务系统页面，并正确传入轻量页面上下文。
> 前置：平台侧已部署 `/sdk/agent-widget.js`、`/embed/apps/:appId/widget`、`POST /api/apps/:appId/widget-tokens`。
> 相关平台契约：`docs/开发计划/widget-w4-page-context-contract.md`。
> 集成面速查（认证 / app-scoped REST / WS 协议 / 角色与能力边界）：[集成与 API 参考](./integration-api-reference.md)。

## 1. 你要做什么

应用侧只需要做三件事：

1. 后端提供一个安全的 `tokenProvider` 接口，用来向平台换取短期 `widgetToken`。
2. 前端引入平台 SDK，初始化 iframe Widget。
3. 页面状态变化时，主动调用 `widget.updateContext()`。

最小链路：

```text
用户打开业务页面
→ 业务前端调用业务后端 /api/agent-widget-token
→ 业务后端带 AppKey 调平台 POST /api/apps/:appId/widget-tokens
→ 业务前端拿到短期 widgetToken
→ 平台 SDK 创建 iframe Widget
→ 用户提问
→ Widget 把用户原文 + 当前 pageContext 发给平台
→ 平台 Agent 回答
```

平台不会自动读取你的页面，也不会自动知道用户选中了哪一行、切换了哪个筛选条件。你必须主动告诉 Widget。

## 2. 责任边界

| 角色 | 负责什么 |
|---|---|
| 平台 | iframe Widget、薄 SDK、短期 token、WS、消息流、审批、停止、审计、Agent runtime |
| 业务后端 | 保管 AppKey、确认当前用户身份、向平台签发 widgetToken |
| 业务前端 | 嵌入 Widget、监听页面变化、调用 `updateContext()` |
| 应用 MCP/Skill | 后续按 ID 查询业务数据、解释 context 字段含义、执行业务 API |

平台不负责：

- 自动抓 DOM。
- 自动截图。
- 自动读取表格。
- 自动操作业务页面。
- 定义你的业务字段含义。
- 存储完整页面数据。

## 3. 后端接入

### 3.1 为什么必须有后端

AppKey 是应用密钥，不能放在浏览器代码里。

禁止：

```js
// 错误：不要在浏览器里写 AppKey
fetch("https://platform.internal/api/apps/app_x/widget-tokens", {
  headers: { "X-App-Key": "ak_live_xxx" }
});
```

正确做法：

```text
浏览器
→ 调业务后端 /api/agent-widget-token
→ 业务后端持有 AppKey
→ 业务后端调平台 widget-tokens
→ 浏览器只拿短期 widgetToken
```

### 3.2 业务后端示例

下面是 Express 示例。其他后端语言照这个逻辑实现即可。

```ts
import express from "express";

const router = express.Router();

const PLATFORM_URL = process.env.PLATFORM_URL!;
const APP_ID = process.env.PLATFORM_APP_ID!;
const APP_KEY = process.env.PLATFORM_APP_KEY!;

router.post("/api/agent-widget-token", async (req, res) => {
  const user = req.user;
  if (!user) {
    return res.status(401).json({ error: "not logged in" });
  }

  const pageSessionId =
    typeof req.body?.pageSessionId === "string"
      ? req.body.pageSessionId
      : `ps_${crypto.randomUUID()}`;

  const platformResp = await fetch(
    `${PLATFORM_URL}/api/apps/${encodeURIComponent(APP_ID)}/widget-tokens`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${await getPlatformUserJwt(user)}`,
        "X-App-Key": APP_KEY
      },
      body: JSON.stringify({
        pageSessionId,
        origin: req.headers.origin
      })
    }
  );

  if (!platformResp.ok) {
    const text = await platformResp.text();
    return res.status(502).json({ error: "platform token failed", detail: text });
  }

  const data = await platformResp.json();
  res.json({
    token: data.token,
    expiresIn: data.expiresIn,
    pageSessionId: data.pageSessionId,
    agentId: data.agentId
  });
});
```

注意：

- `APP_KEY` 只能在后端环境变量里。
- `getPlatformUserJwt(user)` 必须代表当前登录用户，不能随便用一个管理员冒充所有人。
- `origin` 应该传真实浏览器 Origin，平台可据此做 allowed origin 校验。
- tokenProvider 要能重复调用，因为 token 过期或 Widget 需要刷新时会再次取 token。

## 4. 前端最小嵌入

### 4.1 HTML 页面

```html
<div id="agent-widget" style="width: 380px; height: 560px;"></div>

<script src="https://platform.internal/sdk/agent-widget.js"></script>
<script>
  const widget = AgentWidget.init({
    platformUrl: "https://platform.internal",
    appId: "smart-query",
    container: "#agent-widget",
    tokenProvider: async () => {
      const resp = await fetch("/api/agent-widget-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pageSessionId: window.__pageSessionId })
      });
      if (!resp.ok) throw new Error("failed to mint widget token");
      const data = await resp.json();
      window.__pageSessionId = data.pageSessionId;
      return data.token;
    },
    context: {
      page: {
        type: "product_list",
        route: location.pathname,
        title: document.title
      }
    },
    handlers: {
      onReady(info) {
        console.log("Widget ready", info);
      },
      onError(error) {
        console.warn("Widget error", error);
      }
    }
  });
</script>
```

### 4.2 React 示例

```tsx
import { useEffect, useMemo, useRef } from "react";
import { useLocation } from "react-router-dom";

declare global {
  interface Window {
    AgentWidget: {
      init(options: any): any;
    };
  }
}

export function AgentWidgetPanel() {
  const location = useLocation();
  const widgetRef = useRef<any>(null);
  const pageSessionIdRef = useRef<string | undefined>();

  const tokenProvider = useMemo(() => {
    return async () => {
      const resp = await fetch("/api/agent-widget-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pageSessionId: pageSessionIdRef.current })
      });
      if (!resp.ok) throw new Error("failed to mint widget token");
      const data = await resp.json();
      pageSessionIdRef.current = data.pageSessionId;
      return data.token;
    };
  }, []);

  useEffect(() => {
    if (widgetRef.current) return;

    widgetRef.current = window.AgentWidget.init({
      platformUrl: "https://platform.internal",
      appId: "smart-query",
      container: "#agent-widget",
      tokenProvider,
      context: {
        page: {
          type: "dashboard",
          route: location.pathname,
          title: document.title
        }
      }
    });

    return () => {
      widgetRef.current?.destroy?.();
      widgetRef.current = null;
    };
  }, [tokenProvider]);

  useEffect(() => {
    widgetRef.current?.updateContext({
      page: {
        type: "dashboard",
        route: location.pathname,
        title: document.title
      }
    });
  }, [location.pathname]);

  return <div id="agent-widget" style={{ width: 380, height: 560 }} />;
}
```

### 4.3 Vue Router 示例

```ts
const widget = window.AgentWidget.init({
  platformUrl: "https://platform.internal",
  appId: "smart-query",
  container: "#agent-widget",
  tokenProvider
});

router.afterEach((to) => {
  widget.updateContext({
    page: {
      route: to.path,
      title: document.title
    },
    view: {
      query: to.query
    }
  });
});
```

## 5. `context` 应该传什么

`context` 是轻量页面状态，不是页面全量数据。

推荐结构：

```js
widget.updateContext({
  page: {
    type: "product_detail",
    route: "/products/P001",
    title: "iPhone 16 商品详情"
  },
  selection: {
    productId: "P001",
    selectedRowIds: ["P001"]
  },
  view: {
    filters: {
      region: "华东",
      period: "2026-07",
      category: "手机"
    },
    sortBy: "sales_desc"
  },
  refs: {
    visibleTableSnapshotId: "snap_abc123"
  }
});
```

### 5.1 推荐传

| 类型 | 示例 | 作用 |
|---|---|---|
| 页面定位 | `page.type`, `page.route`, `page.title` | 告诉 Agent 用户在哪个页面 |
| 业务对象 ID | `productId`, `orderId`, `customerId` | 让 Agent 知道“这个商品/订单/客户”是谁 |
| 筛选状态 | `region`, `period`, `category` | 让 Agent 理解当前数据范围 |
| 选中状态 | `selectedRowIds` | 让 Agent 理解用户当前选中了什么 |
| 引用 ID | `snapshotId`, `fileId`, `resourceId` | 大数据后续由应用后端/MCP 按 ID 查询 |

### 5.2 不要传

| 不要传 | 原因 | 替代方式 |
|---|---|---|
| 整个 DOM | 太大、脏、敏感 | 传 `page.type`、`route`、业务 ID |
| 整张表格所有行 | 容易超限，泄露明细 | 传 `snapshotId`、`rowCount`、`columns` |
| 截图/图片二进制 | 不是 context 通道职责 | 后续走文件/resource |
| cookie/token/AppKey | 密钥泄露 | 不允许传 |
| 身份证/手机号/完整客户资料 | 敏感数据 | 传 `customerId`，由后端鉴权查询 |
| 完整订单明细 | 数据过多 | 传 `orderId` |

## 6. 页面变化时怎么更新

### 6.1 路由变化

SPA 页面切路由不会刷新 iframe，必须主动更新：

```js
function onRouteChanged(route) {
  widget.updateContext({
    page: {
      route,
      title: document.title
    }
  });
}
```

### 6.2 筛选变化

```js
function onFilterChange(filters) {
  applyFilters(filters);
  widget.updateContext({
    view: { filters }
  });
}
```

如果变化很频繁，要防抖：

```js
function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

const updateContextDebounced = debounce((context) => {
  widget.updateContext(context);
}, 500);

function onSliderChange(value) {
  updateChart(value);
  updateContextDebounced({
    view: {
      filters: { amountRange: value }
    }
  });
}
```

### 6.3 选中行变化

```js
function onRowSelect(row) {
  widget.updateContext({
    selection: {
      productId: row.id,
      selectedRowIds: [row.id]
    }
  });
}
```

不要这样：

```js
widget.updateContext({
  selection: {
    selectedRow: row
  }
});
```

`row` 可能包含大量字段和敏感字段。优先传 ID。

## 7. 当前轮和下一轮

Context 在用户点击发送时固定。

```text
T1: 用户在华东区筛选下提问
→ T1 使用华东区 context

T1 处理中，用户切到华南区
→ 不影响 T1

T2: 用户再提问
→ T2 使用华南区 context
```

原因：如果处理中还读取可变页面状态，Agent 会基于前后不一致的页面理解回答。

## 8. 大数据怎么传

不要把大数据塞进 `context`。传引用。

错误：

```js
widget.updateContext({
  visibleRows: rows.slice(0, 100)
});
```

正确：

```js
const snapshot = await fetch("/api/table-snapshots", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    tableId: "sales-products",
    filters,
    selectedRowIds
  })
}).then((r) => r.json());

widget.updateContext({
  page: { type: "sales_product_table", route: location.pathname },
  view: {
    filters,
    rowCount: snapshot.rowCount,
    columns: snapshot.columns
  },
  refs: {
    visibleTableSnapshotId: snapshot.id
  }
});
```

后续如果 Agent 需要明细，应由应用 MCP/API 按 `snapshot.id` 查询，并由应用后端做权限控制。

## 9. TokenProvider 要求

`tokenProvider` 必须满足：

- 可以重复调用。
- 过期后能重新签发。
- 不在浏览器里暴露 AppKey。
- 不把 widgetToken 存 localStorage。
- 失败时抛出错误，让 Widget 显示登录/连接失败。

推荐：

```js
async function tokenProvider() {
  const resp = await fetch("/api/agent-widget-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ pageSessionId: window.__pageSessionId })
  });

  if (resp.status === 401) {
    throw new Error("请先登录业务系统");
  }

  if (!resp.ok) {
    throw new Error("Agent Widget token 签发失败");
  }

  const data = await resp.json();
  window.__pageSessionId = data.pageSessionId;
  return data.token;
}
```

## 10. 布局建议

### 10.1 固定侧栏

适合后台系统、看板、CRM：

```html
<aside id="agent-widget" style="
  width: 380px;
  height: 100vh;
  border-left: 1px solid #e5e7eb;
"></aside>
```

### 10.2 右下角浮窗

适合不想长期占用屏幕的页面：

```html
<div id="agent-widget" style="
  position: fixed;
  right: 24px;
  bottom: 24px;
  width: 380px;
  height: 560px;
  z-index: 1000;
  box-shadow: 0 12px 32px rgba(0,0,0,.18);
"></div>
```

### 10.3 内嵌面板

适合某个详情页里的“助手”区域：

```html
<section>
  <h2>智能助手</h2>
  <div id="agent-widget" style="width: 100%; height: 520px;"></div>
</section>
```

## 11. 安全检查清单

上线前逐项检查：

- 浏览器源码里搜不到 AppKey。
- 浏览器 Network 面板里搜不到 AppKey。
- `widgetToken` 不写入 localStorage/sessionStorage/IndexedDB。
- `context` 不包含 token/cookie/密钥。
- `context` 不包含完整客户资料、身份证号、手机号等敏感明细。
- `context` 大小保持在 8KB 内。
- 页面频繁变化时做了 debounce。
- 用户退出业务系统后，后端不再签发 widgetToken。
- iframe 所在页面有明确的访问权限控制。
- 业务后端签发 token 时校验当前用户身份。

## 12. 自测清单

### 12.1 最小可用

1. 打开业务页面。
2. Widget 正常加载。
3. 输入一句“我现在在哪个页面？”。
4. Agent 能根据 `page.type` / `route` 回答。
5. 页面刷新后 Widget 仍能重新连接。

### 12.2 Context 更新

1. 进入商品详情页，传入 `productId=P001`。
2. 问“这个商品是谁？”。
3. 切换到 `productId=P002`。
4. 再问“现在这个商品是谁？”。
5. Agent 应基于 P002 回答。

### 12.3 历史不污染

1. 发送带 context 的问题。
2. 打开消息历史或刷新页面。
3. 用户气泡里只能看到用户原文。
4. 不应该看到 `<page-context>` 或 `[page context]`。

### 12.4 超限处理

1. 故意传一个很大的 context。
2. 用户消息仍应发送。
3. context 本轮应被忽略。
4. 前端应能看到 warning/error。

### 12.5 敏感信息检查

1. 在前端全局搜索 `AppKey`、`token`、`cookie`。
2. 检查 `updateContext()` 参数。
3. 确认没有把密钥或敏感明细传给 Widget。

## 13. 常见错误

### 错误 1：把 AppKey 写进前端

```js
// 错误
const APP_KEY = "ak_live_xxx";
```

修正：AppKey 放后端，前端只拿 widgetToken。

### 错误 2：把整行数据传给 context

```js
// 错误
widget.updateContext({ selectedRow: row });
```

修正：

```js
widget.updateContext({
  selection: {
    productId: row.id
  }
});
```

### 错误 3：以为 SDK 会自动知道页面变化

```js
// 错误理解：路由变了，Widget 会自动知道
```

修正：路由变化、筛选变化、选中变化时主动 `updateContext()`。

### 错误 4：每次输入框变化都 updateContext

```js
// 错误：太频繁
searchInput.oninput = () => {
  widget.updateContext({ keyword: searchInput.value });
};
```

修正：debounce 后再更新。

### 错误 5：把 context 当成后端查询结果通道

```js
// 错误
widget.updateContext({ allOrders: orders });
```

修正：

```js
widget.updateContext({
  refs: {
    orderSnapshotId: snapshot.id
  }
});
```

## 14. 后续深度集成

如果应用需要让 Agent 主动获取页面数据或请求页面执行动作，不要在 W4 里做。

后续正确方向：

```text
Agent 调应用 MCP tool
→ 应用 MCP server / 后端
→ 按 pageSessionId 找到页面 bridge 或 snapshot
→ 应用侧鉴权
→ 返回 tool_result 给 Agent
```

这属于 v1 应用深度集成。当前 Widget SDK 接入只负责让 Agent 在当前轮知道轻量页面状态。

## 15. 交付给平台团队的信息

接入前，应用团队需要提供：

```text
appId:
业务系统域名:
允许嵌入页面 origin:
tokenProvider 后端接口路径:
默认页面 context 字段说明:
是否需要 MCP/Skill:
是否有文件上传/预览需求:
是否有页面动作需求:
```

示例：

```text
appId: smart-query
业务系统域名: https://bi.internal.example.com
允许 origin: https://bi.internal.example.com
tokenProvider: POST /api/agent-widget-token
context:
  page.type: dashboard | product_detail | order_detail
  selection.productId: 当前商品 ID
  view.filters.region: 区域
  view.filters.period: 时间区间
MCP/Skill: 需要智能问数 MCP
文件需求: 暂无
页面动作: 暂无
```
