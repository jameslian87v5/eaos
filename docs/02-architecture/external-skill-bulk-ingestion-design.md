# 外部 Skill 批量导入 Skill Hub 方案

> 状态：方案已确认，待实现。
> 目标：不修改 iflytek Skill Hub 源码，通过独立导入工具把公开 Skill 仓库批量送入 Hub 的既有审核流程。

## 1. 结论

**不需要修改 Skill Hub 代码。**

新增一个部署在 Hub 旁边的轻量 `Skill Importer`，提供独立管理页面和后端。它调用 Hub 已有的单包接口：

- `POST /api/cli/v1/skills/{namespace}/publish/validate`
- `POST /api/cli/v1/skills/{namespace}/publish`

Hub 没有批量发布接口，因此 Importer 在服务端逐个提交选中的 Skill。Hub 仍负责扫描、待审、审核、版本和目录；现有平台同步桥仍只拉取 `PUBLISHED` Skill。

该方案不修改：

- iflytek Skill Hub 后端和数据库；
- iflytek Skill Hub Web 页面；
- Agent Runtime、CapabilityProvider 和 entitlement 判定；
- Hub 到平台的现有同步桥。

需要新增的是独立 Importer。其页面使用单独地址，例如 `http://<host>:8090`。如果未来要求把入口嵌入 Hub 左侧菜单，才需要改 Hub Web；这不属于首版。

## 2. 产品流程

```text
管理员打开 Skill Importer
  -> 输入 Git 仓库地址、可选 ref、目标 namespace
  -> Importer 下载仓库并递归查找 SKILL.md
  -> 页面展示可导入 Skill 和被忽略的 Agent/Command/Hook/MCP
  -> 管理员勾选并批量提交
  -> Importer 逐个调用 Hub validate + publish
  -> Skill 进入 Hub 待审队列
  -> org_admin 在 Hub 审核
  -> 审核通过后变为 PUBLISHED
  -> 现有同步桥拉到平台并镜像 org entitlement
  -> 部门用户在 Agent 中使用
```

用户不需要逐个输入 Skill 名称或 URL。一个仓库地址只输入一次，系统自动发现其中全部标准 Skill。

## 3. Importer、Skill Hub 与平台的集成关系

三个系统按供给、治理、消费分工，**Hub 是唯一交接点**：

```text
公开 Git/ZIP 来源
        |
        v
Skill Importer（供给入口）
  发现、预览、选择、打包、批量送审
        |  Hub publish/validate + publish
        v
Skill Hub（治理与事实来源）
  namespace、扫描、审核、版本、PUBLISHED 状态、目录与下载
        |  现有同步桥只读取 PUBLISHED
        v
Agent 平台（消费与运行治理）
  共享池、org entitlement、Application/Agent activation、Runtime 挂载
```

### 3.1 Skill Importer 与 Skill Hub

Importer 是 Hub 的批量供给客户端，不是第二个 Hub：

- 从 Git/ZIP 中发现标准 Skill，并把每个候选打成 Hub 接受的单包；
- 先调用 `publish/validate`，通过后再调用 `publish`；
- 目标 TEAM namespace 由管理员选择；
- 发布身份必须只有向目标 namespace 提交 Skill 的权限，提交结果继续进入 Hub 原有待审流程；
- Importer 展示“已送审/校验失败/发布失败”，最终审核状态以 Hub 为准；
- Importer 不直写 Hub 数据库，不自己修改 `PUBLISHED` 状态，也不替代 org_admin 审核。

若实测 Hub 的 service token 发布会绕过 TEAM 审核，首版必须改用 Hub 支持的普通发布者凭证或受控用户会话；不能为了批量导入而赋予自动审批权限。

### 3.2 Skill Hub 与 Agent 平台

这部分沿用现有同步关系，不因 Importer 改动：

- Hub 是 Skill 包、版本、namespace 和发布状态的事实来源；
- 平台同步桥使用独立的只读凭证，只拉取 `PUBLISHED` Skill；
- TEAM namespace 通过既有 `org <-> namespace` 映射进入对应 org；
- 同步后平台将包放入共享池并镜像 org entitlement；
- Skill 是否真正进入 Agent Runtime，仍由 `PUBLISHED + entitlement + Application allowlist + Agent activation` 共同决定；
- Hub 中仍在待审、已拒绝或未发布的 Skill 不得进入平台。

### 3.3 Skill Importer 与 Agent 平台

两者首版**没有数据同步接口，也不直接传 Skill 包**：

- Importer 只把外部 Skill 送到 Hub；
- 平台只从 Hub 拉已发布 Skill；
- Importer 成功只代表“已送到 Hub”，不代表“平台已可用”；
- 平台可在 admin 导航中增加一个 Importer 外链，但这只是入口，不传 service token；
- 平台已有的 Hub 立即同步/周期同步能力负责发布后的拉取，不由 Importer调用平台内部接口。

因此 Importer 故障不会影响已同步 Skill 的运行，平台故障也不会阻止 Hub 继续审核；恢复后沿原链路继续即可。

### 3.4 身份与凭证

| 调用方 | 目标 | 凭证 | 最小权限 |
|---|---|---|---|
| Importer 后端 | Skill Hub | 独立发布凭证 | 仅向指定 namespace 校验和提交，不能审核 |
| 平台同步桥 | Skill Hub | 独立只读凭证 | `skill:read`，只读已发布包 |
| org_admin / user | Skill Hub Web | Hub 用户会话 | 按 namespace 角色审核或查看 |
| Importer 页面 | Importer 后端 | 企业 admin 的受控管理入口 | 只能发起扫描和送审 |

发布凭证与同步只读凭证不得共用；任何 Hub 凭证都只存在服务端 Secret 中，不进入浏览器、Git、URL、Skill 包或日志。首版不为 Importer 另建用户体系，使用受保护的企业 admin 运维入口；统一 IAM/SSO 留到正式部署时接入。

### 3.5 状态归属

| 状态 | 权威系统 | 含义 |
|---|---|---|
| `discovered / selected` | Importer | 已发现、待送审 |
| `validation_failed / submitted` | Importer + Hub 响应 | 单包校验失败或已提交 Hub |
| `PENDING_REVIEW / PUBLISHED / REJECTED` | Skill Hub | 审核与发布事实 |
| `synced / entitled` | Agent 平台 | 已进入共享池并授权目标 org |
| `runtime_available` | Agent 平台 | 同时满足运行时四道 gate |

页面不得把 `submitted` 展示为“已发布”，也不得把 `PUBLISHED` 展示为“Agent 已可用”。

## 4. 首版输入

首版只支持三种输入，避免为每个来源单独开发：

1. Git 仓库 URL，加可选 branch、tag 或 commit；
2. 一个或多个直接 ZIP URL；
3. 本地批量上传 ZIP。

腾讯 SkillHub 等来源若能提供直接 ZIP 下载地址，就走 ZIP URL；若只能通过登录页面或专用 API 获取，后续增加一个来源 connector，不改变主导入流程。

## 5. 通用识别规则

Importer 递归扫描目录，只有包含有效 `SKILL.md` 的目录才作为 Skill 候选。`scripts/`、`references/`、`assets/` 等同目录资源随包保留。

以下内容不自动转换为 Skill：

- Claude Code Agent persona；
- command、hook、MCP server；
- awesome-list 中的外部链接；
- 只有普通 Markdown、没有 `SKILL.md` 的目录。

自动转换会改变原内容语义，也可能引入错误执行权限，因此首版明确不做。

## 6. 来源适配矩阵

| 来源 | 首版处理 |
|---|---|
| `anthropics/skills` | 直接扫描导入；逐项展示许可证 |
| `K-Dense-AI/scientific-agent-skills` | 直接扫描导入 |
| `obra/superpowers` | 直接扫描导入 |
| `wshobson/agents` | 只导入其中标准 Skill，忽略 agents/commands/hooks |
| `davila7/claude-code-templates` | 只导入 Skill 组件 |
| `alirezarezvani/claude-skills` | 只导入标准 Skill，忽略 persona/agent/command |
| `davepoon/buildwithclaude` | 只导入仓库中真实存在的 Skill；主要作为目录 UI 参考 |
| `agentskills.io` | 作为格式校验依据，不作为内容源 |
| `hesreallyhim/awesome-claude-code` | 只作为来源发现索引，不递归抓取链接 |
| VoltAgent / contains-studio agent 集合 | 不导入，属于 Agent 模板而非 Skill |
| MCP Registry / Docker MCP Registry / awesome-mcp-servers | 不导入，属于 MCP 能力体系 |

## 7. 页面范围

页面只保留四块：

1. **来源**：仓库或 ZIP 地址、ref、目标 namespace；
2. **扫描结果**：名称、描述、来源路径、许可证、是否含脚本、识别状态；
3. **批量选择**：全选、取消选择、只看可导入项；
4. **导入结果**：成功、校验失败、发布失败及 Hub 待审状态。

首版不建设来源市场、定时抓取、自动审批、复杂任务中心或跨来源去重后台。

## 8. 权限与边界

- Importer 只允许企业管理员使用；
- Hub 发布凭证只保存在 Importer 服务端 Secret 中，不进入浏览器、Git、URL或日志；
- namespace 由管理员选择，但最终发布权限仍由 Hub 校验；
- Importer 只负责送审，不自动批准；
- Skill 中存在脚本、外部依赖或未知许可证时，页面明确标记，由管理员决定是否提交；
- 发布后的部门可见性继续由 Hub namespace RBAC 和平台 entitlement 控制。

## 9. 最小数据记录

Importer 只记录一次导入批次所需的元数据：

- 来源 URL 和固定 commit/ref；
- 目标 namespace；
- Skill 名称、相对路径和内容摘要；
- validate/publish 结果；
- 操作人和时间。

不保存 Hub token，不复制 Hub 审核状态机，也不成为新的 Skill 仓库。

## 10. 首轮最小验收

选择 4 个仓库、共 10 个 Skill：

- `anthropics/skills`：3 个；
- `K-Dense-AI/scientific-agent-skills`：3 个；
- `obra/superpowers`：2 个；
- `wshobson/agents`：2 个。

验收流程：

1. 分别输入 4 个仓库 URL，系统自动发现 Skill；
2. 非 Skill 内容被标记为忽略，不进入发布列表；
3. 勾选 10 个 Skill，批量送入一个 TEAM namespace；
4. 10 个 Skill 均进入 Hub 待审队列，失败项能看到具体原因；
5. org_admin 批准 9 个、拒绝 1 个；
6. 平台同步后只出现 9 个 PUBLISHED Skill；
7. 本 org 用户可以使用批准项，其他 org 不可使用；
8. Hub 原有手工上传、审核和平台同步流程不受影响。

## 11. 实施边界

首版交付只有三个部分：

- 一个仓库/ZIP 扫描器；
- 一个批量选择页面；
- 一个逐包调用 Hub validate/publish 的服务端适配器。

这是外部来源到 Hub 的供给入口，不改变 Hub 和平台的职责：

```text
外部来源 -> Importer 批量送审 -> Hub 审核发布 -> 平台同步 -> Runtime 使用
```
