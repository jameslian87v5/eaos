# MCP 导入说明（当前项目状态）

> 目的：说明当前项目里 MCP 到底怎么接入、已经留了哪些接口、还缺哪些实现，以及 Cascade 后续应该按什么最小方案落地。
>
> 适用版本：`@anthropic-ai/claude-agent-sdk@^0.3.183`。
>
> 与 Skill 一致采用 **混合方案**：MCP 包以本地包形态（`mcp/<id>/run.sh + mcp.json`）
> 只读挂载到 `/opt/agent/mcp/<id>`，由 `resolve()` 产出 `sdkOptions.mcpServers` +
> `mounts` 注入，命令固定由后端生成（不接受前端任意 command）。Skill 侧使用
> `skills` 选项 + mount 物理隔离的混合方案（见 `skill-injection-mechanism.md` §2.6），
> `CapabilityBundle.sdkOptions` 包含 `skills` 字段（entitlement-gated skill 名列表）。

---

## 1. 当前结论

当前项目 **还没有完成 MCP 导入功能**。

也就是说，现在没有：

- `data/mcp.json`
- `server/mcp-config.ts`
- Admin Console 的 MCP tab
- `/api/admin/mcp` API
- 可点击上传/启用 MCP 的 UI

当前已经有的是 **底层注入通道**：

```text
CapabilityProvider
  -> CapabilityBundle.sdkOptions.mcpServers
  -> DockerRuntime 写入 AGENT_SDK_OPTIONS
  -> docker/agent-entry.ts 校验 /opt/agent/mcp/
  -> Claude Agent SDK query({ options: { mcpServers } })
```

所以现在不是“已经能导入 MCP”，而是“后端和容器入口已经预留了 MCP 注入接口”。

---

## 2. 已有接口

### 2.1 `CapabilityBundle.sdkOptions.mcpServers`

文件：`server/capability-provider.ts`

当前类型已经有：

```ts
export interface CapabilityBundle {
  sdkOptions: {
    plugins?: Array<{ type: "local"; path: string }>;
    mcpServers?: Record<string, unknown>;
    tools?: string[];
    allowedTools?: string[];
    disallowedTools?: string[];
    systemPrompt?: string;
    appendSystemPrompt?: string;
    additionalDirectories?: string[];
    maxTurns?: number;
  };
  mounts: CapabilityMount[];
  env: Record<string, string>;
}
```

但当前实现仍是空：

```ts
mcpServers: {}
```

这表示 MCP 入口存在，但没有任何 MCP server 被解析和注入。

### 2.2 `CapabilityBundle.mounts`

文件：`server/capability-provider.ts`、`server/docker-runtime.ts`

`mounts` 已经支持把宿主机目录挂载进容器：

```ts
mounts.push({
  hostPath,
  containerPath,
  readonly: true
});
```

`server/docker-runtime.ts` 会把这些 mount 追加到 Docker `Binds`：

```text
hostPath -> containerPath:ro
```

MCP 后续应该复用这个机制，把：

```text
项目 mcp/<name>
```

只读挂载到：

```text
/opt/agent/mcp/<name>
```

### 2.3 容器入口的 MCP 校验

文件：`docker/agent-entry.ts`

当前容器入口已经会读取：

```ts
sdkOptions.mcpServers
```

并做前缀校验：

```ts
const VALID_MCP_PREFIX = "/opt/agent/mcp/";

if (cfg?.command && typeof cfg.command === "string" && !cfg.command.startsWith(VALID_MCP_PREFIX)) {
  console.warn(`[agent-entry] BLOCKED MCP server '${name}': command must start with ${VALID_MCP_PREFIX}`);
  continue;
}
```

通过校验后，会传给 Claude Agent SDK：

```ts
...(Object.keys(validatedMcpServers).length > 0
  ? { mcpServers: validatedMcpServers as any }
  : {})
```

这说明当前设计更适合：

```ts
command: "/opt/agent/mcp/<name>/run.sh"
```

不适合：

```ts
command: "node",
args: ["/opt/agent/mcp/<name>/server.js"]
```

因为后者会被当前前缀校验拦截。

---

## 3. 推荐的 MCP 包结构

MVP 只支持 **local stdio MCP**。

项目内建议使用：

```text
mcp/
  smoke-mcp/
    mcp.json
    run.sh
    server.js

  workspace-readonly-mcp/
    mcp.json
    run.sh
    server.js

  sqlite-readonly-mcp/
    mcp.json
    run.sh
    server.js
```

运行时挂载为：

```text
/opt/agent/mcp/smoke-mcp
/opt/agent/mcp/workspace-readonly-mcp
/opt/agent/mcp/sqlite-readonly-mcp
```

每个 MCP 包必须提供固定入口：

```text
run.sh
```

`run.sh` 必须可执行。

MVP 不允许从 Admin UI 输入任意 command。

---

## 4. 推荐先导入的 3 个 MCP

### 4.1 `smoke-mcp`

用途：最小冒烟测试。

工具建议：

- `ping`
- `runtime_info`

特点：

- 不读文件
- 不写文件
- 不访问网络
- 不需要 secret

验收目标：

- SDK init 里出现 `smoke-mcp`
- 调用 MCP tool 时触发 approval
- approve 后返回 `{ ok: true }`

### 4.2 `workspace-readonly-mcp`

用途：验证 MCP 能访问 `/workspace`，但只能只读。

工具建议：

- `list_workspace_files`
- `read_text_file`

安全要求：

- 只能访问 `/workspace`
- 必须 `realpath` 校验，禁止路径逃逸
- 限制读取大小，例如 128KB
- 禁止写入

### 4.3 `sqlite-readonly-mcp`

用途：验证更接近企业场景的数据查询 MCP。

工具建议：

- `list_databases`
- `query_readonly`

安全要求：

- 只允许访问 `/workspace/input/*.db`、`/workspace/input/*.sqlite`
- 只允许 `SELECT` / `WITH`
- 拒绝 `INSERT`、`UPDATE`、`DELETE`、`ALTER`、`DROP`、`ATTACH`、危险 `PRAGMA`
- 强制 `LIMIT`

---

## 5. 推荐新增配置文件

新增：

```text
data/mcp.json
```

MVP 格式：

```json
[
  {
    "name": "smoke-mcp",
    "type": "local",
    "enabled": true,
    "path": "mcp/smoke-mcp",
    "description": "MCP stdio smoke test server"
  },
  {
    "name": "workspace-readonly-mcp",
    "type": "local",
    "enabled": false,
    "path": "mcp/workspace-readonly-mcp",
    "description": "Read-only workspace inspection MCP"
  },
  {
    "name": "sqlite-readonly-mcp",
    "type": "local",
    "enabled": false,
    "path": "mcp/sqlite-readonly-mcp",
    "description": "Read-only SQLite query MCP"
  }
]
```

注意：

- 配置里不保存 `command`
- 配置里不保存 raw secret
- 配置里不允许 remote URL
- `path` 必须在项目 `mcp/` 目录下

---

## 6. 推荐新增 `server/mcp-config.ts`

职责类似 `server/skill-config.ts`，但不要和 skill 逻辑混在一起。

### 6.1 校验规则

必须校验：

```ts
const MCP_ROOT = path.resolve(PROJECT_ROOT, "mcp");
const MCP_CONFIG = path.resolve(PROJECT_ROOT, "data", "mcp.json");
const VALID_MCP_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
```

规则：

1. `type` 必须是 `"local"`。
2. `name` 必须匹配 `VALID_MCP_NAME`。
3. `path` 经 `realpath` 后必须留在 `mcp/` 内。
4. MCP 目录必须存在 `run.sh`。
5. `run.sh` 必须可执行。
6. 不从配置读取任意 `command`。

### 6.2 输出结构

建议：

```ts
export interface ResolvedMcpServer {
  name: string;
  type: "local";
  enabled: boolean;
  path: string;
  description?: string;
  absolutePath: string;
  containerPath: string;
  command: string;
  args: string[];
  valid: boolean;
  error?: string;
}
```

`command` 由后端固定生成：

```ts
const containerPath = `/opt/agent/mcp/${cfg.name}`;
const command = `${containerPath}/run.sh`;
```

### 6.3 对外 API

建议和 skill-config 对齐：

```ts
export function getAllMcpServers(): ResolvedMcpServer[];
export function getEnabledMcpServers(): ResolvedMcpServer[];
export function setMcpServerEnabled(name: string, enabled: boolean): ResolvedMcpServer | null;
```

---

## 7. `CapabilityProvider` 应如何注入 MCP

修改 `server/capability-provider.ts`：

```ts
import { getEnabledMcpServers, type ResolvedMcpServer } from "./mcp-config.js";
```

在 `resolve()` 里：

```ts
const enabledMcp = getEnabledMcpServers();
const mcpServers: Record<string, unknown> = {};

for (const mcp of enabledMcp) {
  mcpServers[mcp.name] = {
    command: mcp.command,
    args: mcp.args,
  };

  mounts.push({
    hostPath: mcp.absolutePath,
    containerPath: mcp.containerPath,
    readonly: true,
  });
}
```

返回时：

```ts
sdkOptions: {
  plugins,
  mcpServers,
  tools: DEFAULT_PROFILE.tools,
  allowedTools: DEFAULT_PROFILE.allowedTools,
  disallowedTools: DEFAULT_PROFILE.disallowedTools,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  appendSystemPrompt: buildAppendSystemPrompt(enabledSkills),
  maxTurns: getRuntimeSettings().maxTurns,
}
```

不要把 MCP tools 加入 `allowedTools`。

原因：MCP server 一旦启用，会动态暴露自己的 tools。MVP 阶段所有 MCP tool 都应该走现有 `PreToolUse` approval。

---

## 8. 推荐 Admin API

新增：

```text
GET  /api/admin/mcp
POST /api/admin/mcp/:name/enable
POST /api/admin/mcp/:name/disable
```

行为：

- `GET` 返回所有 MCP 配置和校验状态。
- `enable` / `disable` 写回 `data/mcp.json`。
- 变更只对新 runtime 生效。

不要做：

- 上传 MCP 包
- 远程 MCP URL 配置
- command 编辑器
- env/secret 编辑器
- tool 级 allowlist

---

## 9. 推荐 Admin UI

新增一个 MCP tab。

展示字段：

```text
name
enabled
type
path
containerPath
valid/error
SDK init status
操作
```

其中 `SDK init status` 后续应来自 SDK `system/init` 的：

```ts
mcp_servers: Array<{ name: string; status: string }>
```

当前项目还没有把 `mcp_servers` 捕获到 `sdkInitSnapshot` 里，所以这一步需要同步补：

- `server/session.ts` 的 `SDKInitSnapshot` 增加 `mcpServers`
- 收到 SDK init 消息时保存 `message.mcp_servers`
- Admin runtime table 显示 MCP status

---

## 10. 导入流程（MVP）

### Step 1：放 MCP 包

把 MCP server 放到：

```text
mcp/<name>/
```

例如：

```text
mcp/smoke-mcp/run.sh
mcp/smoke-mcp/server.js
```

### Step 2：保证入口可执行

```bash
chmod +x mcp/smoke-mcp/run.sh
```

### Step 3：写 `data/mcp.json`

```json
[
  {
    "name": "smoke-mcp",
    "type": "local",
    "enabled": true,
    "path": "mcp/smoke-mcp",
    "description": "MCP stdio smoke test server"
  }
]
```

### Step 4：后端解析并注入

`server/mcp-config.ts` 解析后生成：

```ts
{
  name: "smoke-mcp",
  absolutePath: "<project>/mcp/smoke-mcp",
  containerPath: "/opt/agent/mcp/smoke-mcp",
  command: "/opt/agent/mcp/smoke-mcp/run.sh",
  args: [],
  valid: true
}
```

`CapabilityProvider` 生成：

```ts
mcpServers: {
  "smoke-mcp": {
    command: "/opt/agent/mcp/smoke-mcp/run.sh",
    args: []
  }
}
```

并添加 mount：

```ts
{
  hostPath: "<project>/mcp/smoke-mcp",
  containerPath: "/opt/agent/mcp/smoke-mcp",
  readonly: true
}
```

### Step 5：重建 runtime

MCP 变更只对新容器生效。

启用/禁用 MCP 后必须：

1. Stop 当前 chat 的 runtime。
2. 发新消息触发 cold resume。
3. 新容器启动后检查 SDK init。

---

## 11. 验收方式

### 11.1 后端/容器日志

容器入口应打印：

```text
[agent-entry] Plugins: N, MCP: 1, AdditionalDirs: 0
```

如果是：

```text
MCP: 0
```

说明 MCP 没有被传入 SDK，优先检查：

- `data/mcp.json` 是否 enabled
- `mcp-config.ts` 是否判定 valid
- `CapabilityProvider` 是否把 `mcpServers` 放进 `sdkOptions`
- mount 是否加入 `CapabilityBundle.mounts`
- command 是否以 `/opt/agent/mcp/` 开头

### 11.2 SDK init

Admin 应展示：

```text
mcp_servers:
  smoke-mcp connected
```

如果 status 是 `failed`：

- 检查 `run.sh` 是否可执行
- 检查容器内路径是否存在
- 检查 MCP server 是否使用 stdio 协议
- 检查 server 是否往 stdout 打了非 MCP JSON 内容

### 11.3 对话验证

用户可以问：

```text
使用 smoke-mcp 的 ping 工具做一次测试
```

预期：

1. 前端出现 approval 请求。
2. 用户批准。
3. MCP tool 返回 `ok: true`。

---

## 12. 当前不要做的事情

MVP 暂时不要做：

- remote SSE/HTTP MCP
- `npx @xxx/mcp@latest` 运行时下载
- Admin UI 任意 command 编辑
- Admin UI secret/env 编辑
- MCP tool 自动放行
- tool 级 allowlist
- MCP 包上传/市场
- 按用户/组织分配 MCP

这些都属于后续 MCP Hub / 企业策略层，不属于当前最小导入闭环。

---

## 13. 一句话总结

当前项目已经有 MCP 的 **SDK 注入通道**，但还没有 MCP 的 **配置管理和导入实现**。

最小落地方式是：

```text
mcp/<name>/run.sh
data/mcp.json
server/mcp-config.ts
CapabilityProvider 注入 mcpServers + readonly mount
Admin 显示 enabled/valid/SDK status
新 runtime 生效
```

这样就能在不做 MCP Hub 的情况下，完成 local stdio MCP 的企业 MVP 导入闭环。
