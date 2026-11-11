# Plugin Installer 设计方案 (v2 — Codex Review 修订)

## 核心原则

Installer 是**供应链边界**，不是插件运行时。它接收 SDK 原生 plugin 包，校验、staged 安装、注册到现有 capability resource 管线。

**不重新定义 plugin 语义**：skill 和 hook-plugin 都是 SDK native plugin，installer 只做 import + register，不创建平台特定的 manifest 或运行时契约。

## 职责边界

| Skill Hub（另一个项目） | Installer（本项目） |
|---|---|
| git clone 仓库到本地缓存 | 接收本地路径 + 元数据 |
| catalog 浏览/搜索 | 校验包格式（复用现有 validators） |
| entitlement 过滤 | staged 复制到目标目录 |
| 展示可选 plugin | 写入配置文件 |
| 用户点选 plugin | 注册为 capability resource |
| — | 审计记录 |

## 接口定义

### NativePluginImportRequest

```typescript
interface NativePluginImportRequest {
  path: string;              // 本地缓存中的 plugin 包路径（绝对路径）
                             // realpath 必须在配置的 import root 内
  name: string;              // 安装后的名称（必须匹配 /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/）
  registryCategory: "skill" | "hook-plugin";  // 注册分类，不影响 runtime 机制
  enabled?: boolean;         // 默认 true
  commitHash?: string;       // 来源审计
  hubSourceId?: string;      // 来源标识
}
```

### PluginImportResult

```typescript
interface PluginImportResult {
  resourceId: string;        // = name（全局唯一）
  installedPath: string;     // 安装后的绝对路径
  version: string;           // 从 plugin.json 读取（manifest 为真相源）
  type: "skill" | "hook-plugin";
  valid: boolean;            // staged 校验结果
  warnings: string[];        // 非致命警告（如 unknown hook events）
}
```

> 失败时 throw Error，不返回 `{ success: false }`。

### UninstallRequest

```typescript
interface UninstallRequest {
  name: string;
  force?: boolean;           // 即使被 allowlist/entitlement/activation 引用也强制删除
}
```

## 校验规则

### 通用校验

1. `path` 必须存在、是目录、realpath 在配置的 import root 内
   - import root 由环境变量 `PLUGIN_IMPORT_ROOT` 配置，默认 `data/skill-hub-cache`
   - 不接受 import root 外的任意绝对路径
2. `name` 必须匹配 `/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/`
3. **resourceId 全局唯一**：跨 skill / mcp / hook-plugin 检查 name 冲突
   - 查 `capability-resource.ts` 的 `listResources()`，如有同名 → 拒绝（MVP 不支持覆盖，先 uninstall 再 import）
4. version 从 `plugin.json` 读取为真相源；request 里的 version（如有）只做比对，不覆盖

### 按 registryCategory 校验（复用现有 validators）

| category | 校验器 | 必须存在 |
|---|---|---|
| `skill` | `skill-config.ts` resolveOne 逻辑 | `.claude-plugin/plugin.json` + `skills/*/SKILL.md` |
| `hook-plugin` | `hook-plugin-config.ts` resolveOne 逻辑 | `.claude-plugin/plugin.json` + `hooks/hooks.json` |

> 两种 category 都是 SDK native plugin，runtime 机制相同（mount `/opt/agent/plugins/<name>` + SDK `plugins` 透传）。
> category 只影响注册到 `data/skills.json` 还是 `data/hook-plugins.json`。

### hook 未知事件：warn-but-allow

保持现有 `hook-plugin-config.ts` 行为：未知 hook 事件名只 warn 不 reject。

## 安装行为（staged + rollback）

```
1. 校验 path 在 import root 内
2. 校验 name 合法 + 全局唯一
3. 确定目标目录:
   - skill → skills/<name>/
   - hook-plugin → hooks/<name>/
4. STAGED INSTALL:
   a. 复制到 <targetRoot>/<name>.staging/
   b. 用现有 validator（skill-config / hook-plugin-config）校验 staging 目录
   c. 校验通过 → 原子 rename 到 <targetRoot>/<name>/
      - 如果已存在 → 拒绝（MVP 不支持覆盖）
   d. 校验失败 → 删除 staging 目录，throw error
   e. rename 后失败（config 写入/验证）→ 清理 targetDir + config entry（late failure rollback）
5. 写入配置文件（write-temp-and-rename）:
   - skill → data/skills.json (upsert)
   - hook-plugin → data/hook-plugins.json (upsert)
6. 验证 capability resource 注册成功（listResources 能查到）
7. 审计: { action: "plugin_import", type, name, version, hubSourceId, commitHash, actorUserId, installedPath, result: "ok" }
8. 返回 PluginImportResult
```

## 卸载行为

```
1. 检查是否被引用（app allowlist / entitlement / agent activation）
   - 被引用且无 force → throw，列出引用方
   - force → 继续
2. 删除目标目录 (skills/<name>/ | hooks/<name>/)
3. 从配置文件移除条目（write-temp-and-rename）
4. 审计: { action: "plugin_uninstall", type, name, actorUserId, result: "ok" }
```

## API 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/admin/plugins/import` | 导入 native plugin |
| POST | `/api/admin/plugins/uninstall` | 卸载 plugin |
| GET | `/api/admin/plugins/installed` | 列出已安装的 plugin |

### POST /api/admin/plugins/import

请求体：
```json
{
  "path": "/data/skill-hub-cache/internal-skills/plugins/code-review",
  "name": "code-review",
  "registryCategory": "skill",
  "enabled": true,
  "commitHash": "abc123def",
  "hubSourceId": "internal-skills"
}
```

响应：
```json
{
  "resourceId": "code-review",
  "installedPath": "/path/to/skills/code-review",
  "version": "1.0.0",
  "type": "skill",
  "valid": true,
  "warnings": []
}
```

## 与现有 installApiAsMcp 的关系

- `installApiAsMcp()` 保持不变（HTTP API → MCP wrapper，平台生成 command）
- `importNativePlugin()` 是并行路径（本地 SDK native 包 → skill/hook-plugin）
- MCP import 暂不实现：MCP 受 `strictMcpConfig` 治理，command 必须是 `/opt/agent/mcp/<name>/run.sh`，需要明确的 translation step

## 安全

- **import root allowlist**：`path` realpath 必须在 `PLUGIN_IMPORT_ROOT` 内
- **名称安全**：`name` 正则防 `../` 注入
- **staged install + late failure rollback**：不直接覆盖活跃包；rename 后失败也清理
- **全局唯一**：跨 type 检查 resourceId 冲突
- **配置文件原子写入**：write-temp-and-rename
- **审计**：完整字段，不存 payload
- **后续迭代**：静态扫描、脚本审批

## 实现文件

| 文件 | 改动 |
|---|---|
| `server/capability-installer.ts` | 新增 `importNativePlugin()` / `uninstallNativePlugin()` / `listInstalledPlugins()` |
| `server/admin-app-routes.ts` | 新增 3 个 API 端点 |
| `server/types.ts` | 新增 `NativePluginImportRequest` / `PluginImportResult` / `UninstallRequest` |

## 测试计划

1. 导入 skill：从 import root 内路径 → staged → 校验 → 安装 → 注册
2. 导入 hook-plugin：从 import root 内路径 → staged → 校验 → 安装 → 注册
3. 全局名称冲突：skill name 与已有 mcp name 冲突 → 拒绝
4. force 覆盖：MVP 不支持，先 uninstall 再 import
6. 路径逃逸：path 在 import root 外 → 拒绝
7. name 注入：`name="../evil"` → 拒绝
8. 缺少 SKILL.md：staging 校验失败 → 清理 → throw
9. 卸载：删除目录 + 移除配置
10. 卸载被引用：未 force → 拒绝 + 列出引用方
11. 审计记录：import/uninstall 都有审计
12. late failure：rename 后 config 写入失败 → 清理 targetDir + config entry
