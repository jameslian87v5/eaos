# 平台内置 Web Tools 方案

> 状态：边界已确认，按 YAGNI 收敛为最小实现
>
> 日期：2026-08-25
>
> 实施入口：[`agent-os-overall-plan.md`](../开发计划/agent-os-overall-plan.md) W1。

## 1. 要解决的问题

当前 Claude SDK 自带的 `WebSearch` / `WebFetch` 在第三方模型和当前网络环境下不稳定。平台只补两个普适能力：

```text
BailianSearch - 搜索互联网
LocalFetch    - 读取公开网页
```

它们与 `Read`、`Write`、`Bash` 同属 Runtime 基础 Tool，不是应用提交的普通 MCP。

## 2. 最小方案

使用 Claude Agent SDK 的 `createSdkMcpServer()` 在 Runtime 进程内创建一个固定的 `platform-web-tools`：

```text
Agent Runtime
  ├── Read / Write / Edit / Bash / Grep / Glob
  └── platform-web-tools
        ├── bailian_search
        └── web_fetch
```

MCP 只是内部 Tool 适配方式。该模块：

- 不进入 `data/mcp.json`；
- 不经过普通 MCP 的安装、entitlement、Application allowlist、Agent activation 和只读挂载；
- 不启动额外 stdio 子进程；
- 仍经过现有 Tool allow / approval / deny 和事件记录；
- 不改变普通 MCP 只在 Docker Runtime 运行的现状。

接入后移除 SDK 自带的 `WebSearch` / `WebFetch`，避免模型同时看到两套同类工具。

## 3. 两个 Tool

### 3.1 BailianSearch

调用百炼原生联网搜索接口：

```text
POST https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation
Authorization: Bearer ${DASHSCOPE_API_KEY}
model: qwen-plus
enable_search: true
search_options: { forced_search: true, enable_source: true }
```

输入只保留：

```ts
{ query: string }
```

- 返回百炼生成的简要回答及 `search_info.search_results` 中的 title、url、site_name；
- Agent 可直接综合；需要核对正文时再调用 LocalFetch；
- 15 秒超时，错误不得带出 API key 或上游完整响应。

### 3.2 LocalFetch

输入只保留：

```ts
{ url: string }
```

- 只允许公开的 HTTP(S) URL；
- 拒绝 localhost、明显的内网 IP 和云 metadata 地址；
- 最多跟随 5 次 HTTP(S) 重定向；
- 15 秒超时，响应最大 2 MiB，返回文本最大 100,000 字符；
- 只处理 HTML、纯文本和 JSON，HTML 用 `html-to-text` 转成文本；
- 不执行页面 JavaScript，不保存 Cookie，不下载文件。

这是演示和当前自托管环境的基础防护，不在本轮建设完整 SSRF 网关或浏览器沙箱。

## 4. Local / Docker

同一份 `createPlatformWebToolsServer()` 分别在两个执行进程里创建一次：

| | Local | Docker |
|---|---|---|
| 创建位置 | `server/ai-client.ts` | `docker/agent-entry.ts` |
| 网络请求位置 | 宿主机 | Agent 容器 |
| 百炼 key | 服务进程环境 | Host 转发到容器环境 |
| 普通业务 MCP | 继续禁用 | 继续走现有 registry/mount/spawn |

进程内 MCP instance 含函数，不能通过 `AGENT_SDK_OPTIONS` JSON 传递，所以 Local 和 Docker 各自调用同一 factory。每个 `query()` 创建一次，不按消息或 Tool 调用重复创建。

## 5. 配置和审批

只新增一个部署配置：

```bash
DASHSCOPE_API_KEY=sk-...
```

- 开发环境放根目录 `.env`；仓库只写 `.env.example`；
- `DASHSCOPE_API_KEY` 使用百炼通用 API Key；
- Docker 通过容器 ENV 获取，不写入 `AGENT_SDK_OPTIONS`；
- 不写入 `data/mcp.json`、数据库、浏览器、日志或事件；
- 不建设通用 SecretProvider、按部门 key 或管理界面。

SDK 实际 Tool 名称：

```text
mcp__platform-web-tools__bailian_search
mcp__platform-web-tools__web_fetch
```

默认策略：搜索自动放行，Fetch 需要当前用户审批。Application/profile 可以继续收紧。

## 6. 不做什么

- 不解决未来所有 MCP 的 key；
- 不建设 MCP Gateway、Remote MCP 或独立 Web 服务；
- 不接百炼联网搜索 Agent、联网搜索 MCP 或其他 MCP 市场能力；
- 不实现浏览器渲染、认证网页、Cookie 或批量爬虫；
- 不改变普通 MCP 的发现、授权和 Docker-only 机制；
- 不新增 Web 专用数据库、审计表或诊断中心。

## 7. 完成标准

1. Local 和 Docker 都能看到 BailianSearch 和 LocalFetch。
2. 百炼原生联网搜索返回回答和带 URL 的真实搜索结果。
3. Fetch 经批准后能读取公开网页，拒绝后不发网络请求。
4. localhost、常见内网 IP、metadata、超时和超限响应被拒绝。
5. SDK 自带 `WebSearch` / `WebFetch` 不再出现。
6. 普通 MCP 的 entitlement、activation、mount 和 Local 禁用行为没有变化。

## 8. 依据

- 百炼联网搜索 API：<https://help.aliyun.com/zh/model-studio/web-search>
- 当前 Claude Agent SDK 已提供 `createSdkMcpServer()` / `tool()`，可在同一进程内定义自定义 Tool。
