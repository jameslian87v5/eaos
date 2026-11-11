# Skill 发现 → 注册 → Agent 问答使用：完整链路排查与风险测试

> 目的：端到端梳理一个 skill 从「在磁盘上被发现」到「Agent 在对话里真正能调用」的完整链路，逐节点排查问题与风险，并附确定性探针 + 真机端到端测试结果。
>
> 适用版本：`@anthropic-ai/claude-agent-sdk@^0.3.183`，`RUNTIME_MODE=docker`。
>
> 配套文档：机制原理见 `docs/03-modules/skill-injection-mechanism.md`；本文是**实测排查报告**。
>
> 排查日期：2026-06-24。代码状态：`capability-provider.ts` 在 `skillNames` 非空时把 `"Skill"` 注入 `sdkOptions.tools`（混合方案的关键修正）。

---

## 0. 结论速览

| 项 | 结论 |
| --- | --- |
| 链路是否打通 | ✅ 真机端到端测试通过：模型成功列出 `hello-skill:hello-skill`、`minimal-plugin:minimal-plugin-skill` |
| Skill 工具暴露 | ✅ `tools` 在 `skillNames.length>0` 时注入 `"Skill"`（实证：不注入则模型对全部 skill 失明） |
| entitlement 门控 | ✅ 探针验证 deny-default + 撤销兜底 + admin-bypass 全部正确 |
| 物理隔离 | ✅ 未授权 skill 不挂载（`mounts` 为空），容器内无文件 |
| 主要风险 | ⚠️ warm-resume 配置陈旧、`ALLOWED_TOOLS` 环境变量覆盖会绕过 Skill 注入与审批拆分、若干陈旧代码注释 |

---

## 1. 完整链路（7 段）

```
[1] data/skills.json                 注册表（name/type/enabled/path）
        │  loadConfig()
        ▼
[2] server/skill-config.ts           解析 + 安全校验 + 发现 SKILL.md
        │  getEnabledPlugins(): ResolvedSkill[]（仅 enabled && valid）
        │  getAllSkills(): 供 Admin/资源池
        ▼
[3] 控制面三件套
    ├─ capability-resource.ts         资源池统一视图（skill|mcp）
    ├─ entitlement.ts                 canConfigure(ctx, resourceId)：谁能配
    └─ agent-capabilities.ts          per-agentId 激活集 + 撤销兜底
        ▼
[4] server/capability-provider.ts    resolve({userId, chatId, role, runtimeType})
        │  - 选 skill 集：有激活 → 激活∩entitled∩valid；无激活 → legacy 全量
        │  - 产出 CapabilityBundle：plugins + mounts(ro) + skills[] + tools(含Skill)
        ▼
[5] server/server.ts getOrCreateSession
        │  resolve() → ensureRuntime({tools, allowedTools, capabilityBundle})
        ▼
[6] server/container-manager.ts → docker-runtime.ts
        │  warm/cold/fresh 决策 → 容器创建时烤入：
        │  env: AGENT_TOOLS / AGENT_ALLOWED_TOOLS / AGENT_SDK_OPTIONS(skills,plugins,prompt)
        │  binds: hostSkillDir → /opt/agent/plugins/<name>:ro
        ▼
[7] docker/agent-entry.ts            容器内消费
        │  解析 env → 校验 plugins 路径前缀(/opt/agent/plugins/) → query()
        │  query.options: tools(含Skill) + skills[] + plugins + PreToolUse hook
        ▼
    Claude Agent SDK query()         加载 plugin → Skill 工具描述动态列出 skill
        ▼
    模型在对话里看到并调用 skill
```

### 各段关键文件与职责

| 段 | 文件 | 职责 | 关键不变量 |
| --- | --- | --- | --- |
| 1 | `data/skills.json` | 本地注册表 | `path` 必须在 `skills/` 内；`type` 仅 `plugin`（gitignored） |
| 2 | `skill-config.ts` | 校验 native plugin 包形 + 发现 SKILL.md | realpath 根检查防穿越；7 步校验链；`declaredSkillNames` 静态扫描 |
| 3a | `capability-resource.ts` | 资源池视图 | `resourceId === skill.name`；`plugin`→`skill` 映射 |
| 3b | `entitlement.ts` | 谁能配 | admin-bypass；deny-default；user>org；deny-overrides-allow |
| 3c | `agent-capabilities.ts` | 激活集 + 撤销兜底 | key 存在性区分"配置空"vs"从未配置"；read 时 re-check entitlement |
| 4 | `capability-provider.ts` | 解析 bundle | **`tools` 含 `"Skill"` ⟺ `skillNames` 非空**；mounts 物理隔离 |
| 5 | `server.ts` | 编排 | `userRole` 从 JWT 透传到 `resolve()`（admin-bypass 生效前提） |
| 6 | `docker-runtime.ts` | 容器注入 | 配置在容器**创建时**烤入 env+mounts，不可热改 |
| 7 | `agent-entry.ts` | 容器内消费 | plugins 路径前缀校验；PreToolUse 兜底放行 `"Skill"` |

---

## 2. 三层职责（混合方案的核心）

| 层 | 机制 | 代码位置 | 实证 |
| --- | --- | --- | --- |
| **entitlement 强制** | `mounts` 只挂载授权 skill（未授权→容器内无文件） | `capability-provider.ts` resolve | 探针 #4：未授权 → `mounts:[]` |
| **Skill 工具暴露** | `skillNames.length>0` 时 `tools` 注入 `"Skill"` | `capability-provider.ts:186` | 真机：模型能列出 skill |
| **skill 清单过滤** | `sdkOptions.skills`（授权过的名列表） | `capability-provider.ts:197` | 探针：skills 与 mounts 一致 |
| **免审批** | PreToolUse hook 兜底放行 `"Skill"` | `agent-entry.ts:218` | — |

> **关键实证**：SDK 的 `skills` 选项**只过滤、不暴露** Skill 工具。仅传 `skills` 而 `tools` 不含 `"Skill"`，模型对全部 skill 失明（即使 discovered + mounted + gated 都正确）。必须 `tools` 含 `"Skill"`。这与早期迁移（commit `91fb30f`）误删 `tools` 里的 `"Skill"` 导致的失明 bug 一致，现已修正。

---

## 3. 测试结果

### 3.1 确定性探针（`scripts/skill-chain-probe.mjs`）

直接调用 `capabilityProvider.resolve()`，针对真实控制面数据（`entitlements.json` / `agent-capabilities.json`），不依赖 LLM API。

| # | 场景 | ctx | tools 含 Skill | skills | mounts | 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 无 agent（startup/legacy 兜底） | `{runtimeType}` | ✅ | `[hello-skill, minimal-plugin-skill]` | 2 个 ro | ✅ legacy 全量 |
| 2 | 配置空 agent | `{user, chatId=85424175, user}` | ❌ | `[]` | `[]` | ✅ 不回退全量 |
| 3 | hello 启用 + 授权用户 | `{tester, chatId=93c538f3, user}` | ✅ | `[hello-skill]` | 1 个 ro | ✅ 精确注入 |
| 4 | hello 启用 + 未授权用户 | `{nobody, chatId=93c538f3, user}` | ❌ | `[]` | `[]` | ✅ **撤销兜底** |
| 5 | hello 启用 + 未授权但 admin | `{nobody, chatId=93c538f3, admin}` | ✅ | `[hello-skill]` | 1 个 ro | ✅ **admin-bypass** |

5/5 通过。证明：Skill 注入逻辑、entitlement deny-default、撤销兜底、admin-bypass、配置空不回退，全部正确。

### 3.2 真机端到端（`scripts/ws-skill-test.mjs`）

`RUNTIME_MODE=docker`，admin 新建 agent（无激活 → legacy 全量），WS 发问 "What skills do you have?"：

```
[event] type=slash_commands
[event] type=assistant_message
Available skills:
- hello-skill:hello-skill
- minimal-plugin:minimal-plugin-skill
```

模型**真实列出**两个 skill（`plugin:skill` 前缀），证明 SDK 加载 plugin + Skill 工具暴露 + 清单可见全链路打通。

### 3.3 复跑命令

```bash
# 确定性探针（无需 API）
npx tsx scripts/skill-chain-probe.mjs

# 真机端到端（需 docker runtime + API 额度）
TOKEN=$(curl -s -X POST localhost:3001/api/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
CHAT_ID=$(curl -s -X POST localhost:3001/api/chats -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{}' | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
node scripts/ws-skill-test.mjs "$CHAT_ID" "$TOKEN"
```

---

## 4. 风险排查表

| ID | 等级 | 节点 | 问题 | 影响 | 缓解 |
| --- | --- | --- | --- | --- | --- |
| **R1** | 高 | [6] docker-runtime | **warm-resume 配置陈旧**：tools/plugins/skills 在容器创建时烤入 env+mounts；skill 启停 / entitlement / 激活变更不会传播到 warm 重连的旧容器 | 改了配置但 agent 行为不变 | 改完 `POST /api/admin/containers/:chatId/stop` 停 runtime → 下条消息 cold resume 重建（容器 `AutoRemove:true`） |
| **R2** | 高 | [5] server.ts | **`ALLOWED_TOOLS` 环境变量覆盖**：若设 `process.env.ALLOWED_TOOLS`，会同时覆盖 `tools` 与 `allowedTools` 为同一列表（`server.ts:88-97,114-115`） | (a) `"Skill"` 不在 tools → 模型对 skill 失明；(b) tools===allowedTools → Write/Edit/Bash 被自动放行，**审批被绕过** | 生产环境不要设 `ALLOWED_TOOLS`；如需调试，务必手动包含 `"Skill"` 且理解审批后果 |
| **R3** | 中 | [4][7] | **陈旧代码注释**：`capability-provider.ts:82,88` 仍写"Skill 由 skills 选项启用，不在此列出"；`agent-entry.ts:215-217` 写"no longer in allowedTools"——均与"现在 resolve() 会把 Skill 注入 tools"矛盾 | 误导后续开发者 | 更新注释以反映混合方案（见 §2） |
| **R4** | 中 | [4] | **local runtime 无 skill**：`resolve()` 仅 docker 模式调用；`ai-client.ts` 的 `DEFAULT_TOOLS` 不含 Skill | `RUNTIME_MODE=local` 时 skill 静默不可用 | MVP 目标是 docker；如需 local 支持需单独接线（明确告知） |
| **R5** | 中 | [3c][4] | **"已配置但不生效"静默分歧**：agent 激活集里显示某 skill enabled，但 resolve 时 owner 未被 entitled → 运行时静默 0 skill（探针 #4） | UI 显示启用，实际无效，难排查 | Phase 4 诊断（configured vs resolved vs mounted vs discovered）闭合此 gap |
| **R6** | 低 | [4][7] | **`skills:[]` 恒传不省略**：激活门控 agent 无 skill 时传 `skills:[]`。SDK 语义：省略=CLI 默认仍生效（非"关闭"），`[]`=显式零 | 无（`[]` 正是 deny-all 的安全选择） | 文档化：`[]` 是有意的"关全部"，非 bug |
| **R7** | 低 | [2] | **plugin.json 非标准字段被 SDK 静默拒绝**：`skill-config.ts` 只校验包结构，不校验完整 Claude Code schema | Admin 显示 valid，但 SDK 不加载该 plugin | 导入阶段加严格 schema 门禁（见 skill-injection-mechanism.md §2.1/§4） |
| **R8** | 低 | [2][4] | **`declaredSkillNames` 是目录名静态扫描**，非 SDK 运行时真值；若 SKILL.md frontmatter `name` 与目录名不一致，`skills` 过滤可能错配 | fixtures 目录名==skill名，当前无碍；自定义名有风险 | 校验 SKILL.md `name` 与目录名一致，或改用 SDK 运行时 `sdkInit.skills` 对账 |
| **R9** | 低 | [7] | **无运行时对账**：agent-entry 只校验 plugin 路径前缀，不交叉核对 skills 清单 vs 实际挂载 plugin 数 | 不一致时无告警 | Phase 4 诊断补对账 |

### 数据卫生（非代码风险）

- `data/agent-capabilities.json` 有 15 个 agent，多为测试残留；`entitlements.json` 仅覆盖 `hello-skill` 的 2 个用户；`minimal-plugin` 无 entitlement（仅 admin 可配）。这导致非 admin 用户的、启用了 `minimal-plugin` 的 agent 会在 resolve 时被过滤为 0（符合 R5）。

---

## 5. 安全不变量（已验证保持）

1. **deny-default**：无 entitlement → 不可配 → 不挂载（探针 #4）。
2. **物理隔离**：未授权 skill 不在 `mounts` → 容器文件系统无该文件 → Read/Bash 也读不到。
3. **路径安全 4 层**：`skill-config` realpath 根检查 → `capability-provider` 固定 `/opt/agent/plugins/<name>` → `docker-runtime` ro 挂载 → `agent-entry` 前缀过滤。
4. **前端零直配**：用户/前端永不直接设 `tools`/`plugins`/`skills`/host path；只声明激活意图，由 `resolve()` 翻译。
5. **撤销兜底**：`resolveEnabledResourceIds` 在 read 时 re-check entitlement，撤销后下次 resolve 即排除。

---

## 6. 建议后续动作

| 优先级 | 动作 |
| --- | --- |
| 高 | 修正 R3 陈旧注释（`capability-provider.ts` + `agent-entry.ts`），避免误导 |
| 高 | 在运维文档强调 R1（改配置必须 stop runtime）+ R2（勿设 `ALLOWED_TOOLS`） |
| 中 | 推进 Phase 4 诊断闭合 R5/R9（configured/resolved/mounted/discovered 四态可见） |
| 低 | 加 SKILL.md `name` 与目录名一致性校验（R8） |
| 低 | 清理 `agent-capabilities.json` 测试残留数据 |

---

## 7. 参考

- 机制原理：`docs/03-modules/skill-injection-mechanism.md`
- 注入管线：`docs/03-modules/capability-injection-paths.md`
- 迁移计划：内部迁移文档（未随开源发布）（Phase 2b/2c/2d、Phase 4 诊断）
- 探针脚本：`scripts/skill-chain-probe.mjs`
- 端到端脚本：`scripts/ws-skill-test.mjs`
- 源码：`server/{skill-config,capability-resource,entitlement,agent-capabilities,capability-provider,server,container-manager,docker-runtime}.ts`、`docker/agent-entry.ts`
