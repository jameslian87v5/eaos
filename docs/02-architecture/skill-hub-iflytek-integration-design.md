# Skill Hub 注入设计 — 集成 iflytek/skillhub

> Status: **设计稿(draft),待评审**
> Date: 2026-08-11
> **作用域:仅 skill 供给与治理。MCP 是另一条路(本平台 `installApiAsMcp`/
> registered-api 现有路径),不进 iflytek,另行设计。** 用户 2026-08-11 确认。
> **取代**:`docs/02-architecture/skill-hub-design.md`(旧 pull 模型设计)与
> `docs/03-modules/skill-hub-interface-contract.md`(冻结契约)—— 本设计改为
> **集成现成开源注册中心 iflytek/skillhub**,不再自建 hub 平台、不再用
> `X-Hub-Key`/`/api/hub/*` 那套自建契约。
> 关联:`docs/03-modules/capability-injection-paths.md`(四条注入路径)、
> `docs/02-architecture/plugin-installer-design.md`(本平台 installer)、
> `docs/02-architecture/platform-application-layer-architecture.md`(应用层)。

---

## 0. 一句话结论

**iflytek/skillhub 当注册中心(独立部署,管发布/版本/审核/扫描/catalog);
本平台只保留运行时注入侧(entitlement + resolve() + /opt/agent/* + 容器沙箱)
+ 建一座薄同步桥。** 不自建审批/版本/catalog/扫描器,不 clone iflytek 源码进本仓。
**仅覆盖 skill;MCP 另路,另设计。**

---

## 1. 背景与已核实事实

### 1.1 本平台现状(代码核实)
- skill/MCP/hook-plugin 注入链已完整实现且纵深防御:`skill-config.ts` +
  `mcp-config.ts` + `capability-provider.ts` `resolve()` + `agent-entry.ts`
  双层前缀校验 + `strictMcpConfig` 双断言。无 stub。
- **本地安装路径已存在**:`capability-installer.ts` 的 `importNativePlugin()`
  + `admin-app-routes.ts` 的 `/api/admin/plugins/import|uninstall|installed`,
  带 `hubSourceId` + `commitHash` 来源字段(前瞻 stub)。
- entitlement 叠加层(`entitlement.ts`):org/user scope,deny-wins,
  `canConfigure`/`listResourcesForCtx` 已 org-aware(Phase 7)。
- **未实现**:审批队列、版本管理、catalog、扫描器、`/api/hub/*` 路由、
  `X-Hub-Key`、`actorRole:"hub"` 审计写入器。旧 `skill-hub-design.md`
  (pull 模型)与冻结契约均为纸面。
- 能力操作(install/uninstall/toggle/entitlement)审计有洞:进 `eventStore`
  而非 `governance_audit_log`;skill/MCP toggle 零审计(独立债务,顺手补)。

### 1.2 iflytek/skillhub 已核实事实
- 仓库 `github.com/iflytek/skillhub`(Apache 2.0,Java 21 + React 19,
  4882★,2026-08-11 仍活跃)。自托管、on-prem、防火墙后、数据主权。
- 部署:`make dev-all` 本地;Docker Compose / K8s charts / ghcr 预构建镜像。
  Web UI `:3000`,后端 API `:8080`。
- **领域模型**(`docs/02-domain-model.md`):
  - `namespace`:type `GLOBAL`(唯一 `@global`)/ `TEAM`(部门/团队);
    status `ACTIVE/FROZEN/ARCHIVED`;slug `[a-z0-9]([a-z0-9-]*[a-z0-9])?` 2-64。
  - `namespace_member`:role `OWNER/ADMIN/MEMBER`,唯一 `(namespace_id,user_id)`。
  - `skill`:属 namespace;slug 来自 SKILL.md `name`(首发后不可变);
    visibility `PUBLIC/NAMESPACE_ONLY/PRIVATE`;status `ACTIVE/ARCHIVED`;
    `latest_version_id`(指向最新 PUBLISHED,可空);`owner_id`(可转让);
    `source_skill_id`(团队→全局提升追溯)。
  - `skill_version`:status `DRAFT/PENDING_REVIEW/PUBLISHED/REJECTED/YANKED`;
    version semver;唯一 `(skill_id,version)`;`parsed_metadata_json`
    (SKILL.md frontmatter 解析)+ `manifest_json`。
  - `skill_tag`:`latest` 系统保留,自动跟最新 PUBLISHED;自定义 tag 指向 PUBLISHED。
  - `review_task`:status `PENDING/APPROVED/REJECTED`;`namespace_id` 决定谁审。
  - `promotion_request`:团队 skill 升全局的独立审批事实来源。
- **生命周期**(`docs/14-skill-lifecycle.md`):普通用户发布 → `PENDING_REVIEW`
  + 建 `PENDING` review_task;`SUPER_ADMIN` 直发 → `PUBLISHED` 跳审 + 跳 membership。
  审核通过 → `PUBLISHED` + 更新 `latest_version_id`。yank → `PUBLISHED→YANKED`
  + 重算 latest。hidden 是独立治理覆盖层,不属于状态机。
- **业务流**(`docs/05-business-flows.md`):发布 = 身份权限校验(MEMBER+) →
  技能包校验(SKILL.md 存在性/frontmatter/文件白名单/大小≤10MB/semver/版本不冲突/
  `PrePublishValidator` 扩展点)→ 写对象存储(`skills/{skillId}/{versionId}/{filePath}`
  + 预打包 zip)→ 持久化 → 审计 → 搜索索引。存储 local FS(dev)/S3/MinIO(prod)。
- **API**(`docs/06-api-design.md`):统一响应 `{code,msg,data,timestamp,requestId}`,
  `code=0` 成功,否则 HTTP 状态。公开(匿名):`GET /api/v1/skills`(搜索,匿名仅 PUBLIC)
  / `GET /api/v1/skills/{namespace}/{slug}` / `versions` / `files` / `download`
  / `resolve`(by version/tag/hash)/ `tags` / `GET /api/v1/namespaces`。
  发布:`/api/v1/publish`。认证:`/api/v1/auth/me|logout|providers|methods`
  + `/api/v1/auth/session/bootstrap`(私有 SSO 扩展点,默认关)
  + `/api/v1/auth/direct/login`(默认关)。CLI:Device Flow + Bearer Token。
  API Token 管理(scope + 前缀哈希)。
- **认证**(`docs/03-authentication-design.md`):5 层(OAuth2/OIDC 登录 →
  准入策略 OPEN/PROVIDER_ALLOWLIST/EMAIL_DOMAIN/SUBJECT_WHITELIST →
  身份映射 identity_binding → Session/Token → RBAC)。Web Spring Session(Redis),
  CLI Device Flow + Bearer。`session/bootstrap` 给私有 SSO 留了扩展点
  (`docs/11-auth-extensibility-and-private-sso.md` + `docs/12-private-sso-integration-playbook.md`)。
- **自带扫描器**(`scanner/` 目录)+ ClawHub 兼容客户端协议。

### 1.3 角色映射(iflytek ↔ 本平台)
| 本平台 | iflytek | 管什么 |
|---|---|---|
| `admin` | `SUPER_ADMIN` | 平台级、跨命名空间、直发跳审、审全局、hide/yank |
| `org_admin` | namespace `ADMIN`/`OWNER` | 审本命名空间发布、管本命名空间成员 |
| `user` | namespace `MEMBER` | 本命名空间内发布(→PENDING_REVIEW)、消费 |
| `org` | `namespace`(TEAM) | 一一对应 |

---

## 2. 设计原则

1. **不重复造轮子**:iflytek 已有发布/版本/审核/扫描/catalog/RBAC/审计 —— 全用它的,
   不自建。本平台只保留 iflytek 没有的:**身份映射 + 同步桥 + agent 运行时注入**。
2. **独立部署 + 薄适配层**:iflytek 作为独立服务(Docker/K8s)部署,**不 clone 源码进本仓**。
   本仓新增唯一集成代码 = `server/skillhub-bridge.ts`(薄 adapter)+ `.env` 配置。
3. **只保留一道人工作业**:iflytek 管「能否发布/进注册中心」。本平台 entitlement
   是 Hub 权限的**自动镜像**，不是第二次审批。TEAM skill 审过后自动允许所属 org；
   GLOBAL skill 经 admin 发布/授权后自动允许所有 active org。运行时只做技术校验和挂载。
4. **默认 namespace 授权，不做逐用户授权**:用户属于 org namespace 即拥有该 namespace
   已发布 Skill 的查看、下载和使用权。user-level deny 只作为例外封禁，不是正常发布流程。
5. **治理铁律不动**:deny-default、`/opt/agent/*` 前缀、`strictMcpConfig`、
   路径校验、deny-by-intersection、容器沙箱 —— 对 iflytek 同步来的资源同等生效。

---

## 3. 架构(三层)

```
┌─ iflytek/skillhub(独立服务,注册中心) ────────────────────────────┐
│  发布/版本/命名空间治理/分档审核/扫描/catalog/搜索/CLI/RBAC/审计     │
│  用户/开发者本地造包 → skillhub publish → 本命名空间待审            │
│  外部源(skillhub.club/腾讯/anthropics/wshobson/任意 git 仓)         │
│    → 摄取网关(本平台薄脚本)拉 → skillhub publish API 进待审         │
│  team ADMIN 审本命名空间;SUPER_ADMIN 审全局/直发;promotion_request  │
│  审过 → skill_version.status=PUBLISHED                              │
└────────────────────────┬───────────────────────────────────────────┘
                         │ 同步桥(sync):本平台 adapter 调 iflytek API
                         │   拉 PUBLISHED 包 → importNativePlugin()
                         │   + hubSourceId="iflytek" + commitHash=<sha256/semver>
┌────────────────────────▼───────────────────────────────────────────┐
│ 本平台(运行时/用侧治理,我们的差异化)                              │
│  entitlement 叠加层(默认镜像 iflytek 命名空间 + admin 可覆盖)     │
│  resolve() → CapabilityBundle → /opt/agent/* 只读挂载               │
│  deny-by-intersection(app allowlist ∩ entitlement ∩ activation)     │
│  agent-entry.ts 前缀校验 + strictMcpConfig + 容器沙箱               │
└────────────────────────────────────────────────────────────────────┘
```

> 注:本架构仅覆盖 **skill**。MCP server(stdio 进程 + `run.sh` + 后端生成 command)
> 走本平台现有 `installApiAsMcp` / registered-api 路径,**不进 iflytek**(格式根本不同,
> iflytek 是 SKILL.md 注册中心)。MCP 供给另设计。

---

## 4. 组件:同步桥 `server/skillhub-bridge.ts`(本平台新建,唯一集成代码)

### 4.1 职责
- 调 iflytek REST API 拉 `PUBLISHED` 版本,下载包,喂现有 `importNativePlugin()`。
- org ↔ namespace 1:1 映射;org 生命周期事件调 iflytek API 建/冻命名空间。
- entitlement 镜像:sync 导入时自动给对应 org 加 allow;yank 时自动 revoke。
- 不承载审批、catalog、版本或逐用户授权；浏览、下载、发布由 iflytek Hub RBAC 决定。

### 4.2 调用的 iflytek 端点(adapter 契约)
| 用途 | iflytek 端点 | 说明 |
|---|---|---|
| 列命名空间 | `GET /api/v1/namespaces` | 找本 org 对应的 TEAM namespace |
| 列已发布 skill | `GET /api/v1/skills?namespace={slug}` | 拉 PUBLISHED 列表 |
| 下载版本包 | `GET /api/v1/skills/{ns}/{slug}/download` | 拉最新 PUBLISHED zip |
| 按版本下载 | `GET /api/v1/skills/{ns}/{slug}/versions/{v}/download` | 指定版本 |
| 版本详情 | `GET /api/v1/skills/{ns}/{slug}/versions/{v}` | 拿 `parsed_metadata_json` + sha256 |
| 建命名空间 | `POST /api/v1/namespaces` | org 创建时触发(若 iflytek 有此端点;待 API 细查) |
| 加成员/设角色 | `POST /api/v1/namespaces/{slug}/members` | org_admin/user 映射(待细查) |
| 发布(摄取外部源) | `POST /api/v1/publish` | 摄取脚本调它进待审 |

> 待细查项(写实现计划前抓 iflytek OpenAPI/`docs/api/authentication.openapi.yaml`):
> 命名空间 CRUD 端点、成员管理端点、webhook/事件订阅机制(iflytek 是否在
> `PUBLISHED`/`yank` 时主动通知,还是我们轮询)。无 webhook 则本平台定时轮询 +
> 管理员手动「立即同步」按钮。

### 4.3 鉴权
- 本平台持一把 iflytek service token(SUPER_ADMIN 或 SKILL_ADMIN 级,可读所有命名空间
  + 建命名空间 + 发布),存 `.env` `SKILLHUB_TOKEN`,前缀哈希由 iflytek 管。
- v1 不为每个 org 维护代理 token；用户在 iflytek Hub 中通过其自身会话/RBAC 发布，
  或由平台后端以受控 service token 代发。service token 绝不暴露给前端/用户。

### 4.4 sync 流程
```
trigger(定时轮询 / 管理员「立即同步」/ iflytek webhook[若有])
  → for each 关心的 namespace(= org):
      GET /api/v1/skills?namespace={slug} → PUBLISHED skill 列表
      for each skill: GET .../versions/{latest} → 拿 sha256 + parsed_metadata
                     GET .../download → 下 zip 到 data/skill-hub-cache/iflytek/{ns}/{slug}/{version}/
      importNativePlugin({
        path: <下载路径>, name: <skill slug>,
        hubSourceId: "iflytek", commitHash: <version sha256 或 semver>
      })
      → 进本平台 skills/<name>/ + data/skills.json + 注册 capability resource
      → entitlement 镜像:namespace 是 TEAM → 给对应 org 加 allow;@global → 给所有 org 加 allow
yank/revoke:iflytek 版本 YANKED → 本平台同步 uninstall 或加 deny(下次 resolve 拿不到)
```

### 4.5 失败与一致性
- 复用 `importNativePlugin` 现有 staged install + rollback + resourceId 全局唯一校验。
- sync 失败(网络/iflytek 不可达):不破坏本平台现有池子,下次重试;admin 可手动重触发。
- 版本冲突:同 name 不同来源(iflytek vs 本地装)→ resourceId 冲突,`importNativePlugin`
  现有逻辑拒绝(MVP 不支持覆盖,先 uninstall 再 import)。文档标注「同 name 不能两来源」。

---

## 5. 组件:外部源摄取(ingestion,薄脚本)

### 5.1 为什么需要
外部库(skillhub.club、腾讯 skillhub、anthropics/skills、wshobson/claude-plugins、
任意 git 仓)不直进本平台池,先进 iflytek 过它的扫描+审核。

### 5.2 形状
- 一个薄摄取任务(cron / 管理员触发),在 `server/skillhub-ingest.ts`(或 scripts/)。
- 流程:从配置的外部源拉包(skillhub.club 用 `npx @skill-hub/cli install`;
  git 仓用 `git clone --depth 1`;腾讯按其 API)→ 调 iflytek `POST /api/v1/publish`
  以 service token 发进**目标命名空间的待审队列**(→ PENDING_REVIEW)→ iflytek scanner
  扫 + 对应档 admin 审 → PUBLISHED → 第 4 节 sync 桥拉进本平台。
- 若 iflytek 以后原生支持「远端源」配置,本脚本可退化为只配源。

### 5.3 边界
- 摄取脚本只干「拉 + 调 iflytek publish」,不审、不扫、不进本平台池。
- 企业从公网拉包 = 供应链风险,必须过 iflytek scanner + 人工审才进命名空间。

---

## 6. org ↔ namespace 集成

### 6.1 1:1 映射规则
- 本平台建 org(`orgs` 表,slug = org slug)→ adapter 调 iflytek 建 TEAM namespace,
  slug = org slug(iflytek slug 校验 `[a-z0-9]([a-z0-9-]*[a-z0-9])?`;本平台 org slug
  需对齐此格式,否则建时映射)。
- org 状态机(`ACTIVE/SUSPENDED/...`)→ namespace `ACTIVE/FROZEN/ARCHIVED`。
  本平台 M1 org 治理生命周期事件(hook)调 adapter 同步 iflytek。

### 6.2 成员/角色同步
- 本平台 `org_admin` 设/撤 → adapter 调 iflytek 加/删 namespace `ADMIN`。
- 本平台 `user` 入/离 org → iflytek namespace `MEMBER` 增减。
- 映射是单向触发(本平台→iflytek),不在 iflytek 侧反向同步(iflytek 自己的成员管理
  不回写本平台;v1 控制权在本平台 control plane)。

### 6.3 用户访问 iflytek(v1 代理 / v2 SSO)
- **v1 集成入口**:直接使用 iflytek 的 UI/API/RBAC；平台只提供 SSO、受控跳转或必要的薄代理。
  不在本平台重做 Hub 页面和审批页面。service token 只在服务端同步/受控摄取集成中使用。
- **v2 SSO(以后)**:用 iflytek `session/bootstrap` 扩展点 + 私有 SSO playbook
  (`docs/12-private-sso-integration-playbook.md`)做身份联邦,用户 SSO 直登 iflytek
  用其 CLI/UI。需身份联邦工程,v1 不做。

### 6.4 平台入口与用户交互契约

平台前端在 `admin`、`org_admin`、`user` 的主导航中提供统一的 `Skill Hub` 入口。该入口是受保护的跳转，不是平台内的 Hub 页面。

```text
平台登录
  → Skill Hub 入口
  → 服务端读取 JWT 的 userId / role / orgId
  → 生成 iflytek Hub 入口地址或短期 handoff
  → iflytek 按 GLOBAL/TEAM namespace 和自身 RBAC 展示内容
  → PUBLISHED
  → skillhub-bridge 同步到平台共享池
  → TEAM 自动镜像所属 org；GLOBAL 自动镜像所有 active org
  → Agent/Application 选择启用
  → 新 Runtime 的 resolve() 挂载 Skill
```

角色范围固定为：`admin` 可管理全局和跨部门内容；`org_admin` 管理本部门 namespace；`user` 查看/下载有权限的 Skill，并可上传进入本部门待审队列。平台不接受 URL/query/body 中的 orgId 作为授权依据，也不把 service token 交给浏览器。

“下载”和“使用”是两个连续动作：下载由 iflytek Hub RBAC 决定；使用由平台的自动 entitlement、Application allowlist、Agent activation 和既有安全守卫共同决定。后面三项是运行时配置/技术检查，不是再次提交审批。

---

## 7. entitlement 自动镜像 + 紧急覆盖(运行时集成,关键设计)

### 7.1 默认镜像
sync 从 iflytek 导入 skill 时,adapter 自动写本平台 entitlement:
- skill 来自 TEAM namespace X(= org X)→ 给 org X 加 `allow`，org 内所有用户继承。
- skill 来自 `@global` 且已由 admin 授权→ 给所有 active org 加 `allow`。
- iflytek 版本 `YANKED`/skill `ARCHIVED` → 自动加 `deny` 或 uninstall。
- 这些写入是同步事实的镜像，不产生申请单、不要求用户逐个授权。

### 7.2 admin 可覆盖
- admin 能在本平台 entitlement 上**手动收紧**(给某 org 加 deny,即便 iflytek 全局可见)。
- org_admin 可下架本部门已发布 Skill；这不是为每个用户重新授权。
- 覆盖优先于镜像(用户 scope > org scope,deny-wins,复用现有 `entitlement.ts` 语义)。

### 7.3 不替代的理由
iflytek 可见性/下载权 = 注册中心里谁能看到和下载；本平台 entitlement = 同一权限在运行时的自动镜像。
平台仍执行 app allowlist、agent activation 和安全守卫，但这些是配置/技术门槛，不是第二次人工审批。

### 7.4 resolve 时仍走现有铁律
`capability-provider.ts` `resolve()` 不变:`app allowlist ∩ entitlement ∩ activation`,
deny-by-intersection。iflytek 同步来的 skill 注册为 capability resource 后,
和本地装的 skill 走完全一样的 resolve 路径。

---

## 8. 建/留/砍汇总

| 项 | 建/留/砍 | 归属 |
|---|---|---|
| 发布/版本/审核/扫描/catalog/搜索/RBAC/审计 | **砍**(iflytek 有) | iflytek |
| 外部源摄取脚本 | **建**(薄) | 本平台(`skillhub-ingest.ts`) |
| 同步桥 `skillhub-bridge.ts` | **建**(薄,唯一集成代码) | 本平台 |
| org ↔ namespace 映射 + 生命周期 hook | **建** | 本平台 org-governance |
| entitlement 镜像 + 覆盖 | **留 + 改**(加镜像逻辑) | 本平台 |
| `importNativePlugin()` + `hubSourceId`/`commitHash` | **留**(已有,adapter 喂它) | 本平台 |
| resolve() + /opt/agent/* + strictMcpConfig + 容器沙箱 | **留**(铁律不动) | 本平台 |
| 三档角色铁律 + org 治理 | **留** | 本平台 |
| Hub UI/审批/catalog/下载 | **砍**(直接使用 iflytek) | iflytek |
| 平台入口(SSO/跳转/必要的薄代理) | **建**(薄) | 本平台 |
| 旧 `X-Hub-Key` / `/api/hub/*` / `actorRole:"hub"` | **废弃**(本设计取代冻结契约) | — |
| 旧 `skill-hub-design.md` pull 模型 | **废弃**(改集成 iflytek) | — |
| MCP 供给 | **不在此设计**(另路,另设计) | 本平台现有路径 |

---

## 9. 治理守卫铁律(对 iflytek 同步资源同等生效)
- **deny-default**:未 entitlement 的 skill,resolve 不注入。
- **`/opt/agent/*` 只读挂载 + 前缀双层校验**(`agent-entry.ts`):iflytek 来的包同样挂这。
- **`strictMcpConfig:true`**:MCP 包同样受(command 后端生成,不读 cwd)。
- **deny-by-intersection**:app allowlist ∩ entitlement ∩ activation。
- **路径校验**:`skill-config.ts`/`mcp-config.ts` realpath + 前缀;`importNativePlugin`
  import root(`data/skill-hub-cache`)约束。
- **审计**:sync 导入/yank 写 `governance_audit_log`(`actorRole:"system"` +
  `hubSourceId:"iflytek"` + resourceId + version + sha256)。补现有能力操作审计洞
  (install/uninstall/toggle/entitlement 也进 governance sink,不再只进 eventStore)。
- **commitHash pin**:sync 时落 version sha256;重 sync 比对,漂移则标记「需复审」。

---

## 10. 诚实成本/风险/debt
1. **多一个 Java 服务**:本地/部署要同时跑 iflytek(`make dev-all`) + 本平台(`npm run dev`)。
   运维成本翻倍但可控(Docker/K8s 预构建)。
2. **两套职责模型**:iflytek RBAC(namespace/role)负责 Hub 内发布与消费；本平台
   `admin/org_admin/user + org`负责身份映射、运行时能力边界和安全守卫。两者不重复审批。
3. **iflytek API 细查 debt**:命名空间 CRUD/成员管理端点、webhook 机制、
   `PrePublishValidator` 扩展点是否暴露 —— 写实现计划前抓
   `docs/api/authentication.openapi.yaml` + dev docs 细化。
4. **轮询 vs webhook**:若 iflytek 无 webhook,sync 走定时轮询 + 手动触发,
   有同步延迟(PUBLISHED 到本平台可用非实时)。文档标注。
5. **同 name 两来源冲突**:iflytek 来的 skill 和本地装的 skill 同 name → resourceId 冲突,
   MVP 拒绝(先 uninstall 再 import)。v1 不支持同 name 多源。
6. **身份集成**:若后续需要平台内无感进入 iflytek，再接 SSO/受控跳转；不提前建设
  per-org token 管理和第二套 Hub 用户系统。
7. **外部源摄取合规**:从公网拉包进企业 = 供应链风险,iflytek scanner + 人工审是必须门,
   不能为了便利跳过。
8. **air-gapped / 无 Docker 环境**:本设计假设能跑 Docker/Java。若部署环境硬约束
   不能跑 Java,本设计不适用(需重写某些模块进 Node/TS,等于造轮子,代价大)。
9. **MCP 不在此设计**:MCP 走本平台现有路径,另设计。iflytek 是 SKILL.md 注册中心,
   不天然支持 MCP stdio 包形。

---

## 11. 不在本设计内(明确砍/延后)
- ❌ 自建审批队列/版本管理/catalog/扫描器(iflytek 有,不重造)。
- ❌ `X-Hub-Key` / `/api/hub/*` / `actorRole:"hub"`(冻结契约废弃)。
- ❌ 旧 pull 模型(`skill-hub-design.md` 的 git-clone-as-source);iflytek 取代之。
- ❌ MCP 供给(另路,另设计;本平台现有 `installApiAsMcp`/registered-api 先用着)。
- 🔜 用户 SSO 直连 iflytek(v2,`session/bootstrap` 扩展点)。
- 🔜 per-agent 版本 pin(现在跟 `latest` PUBLISHED;per-agent 锁版本以后)。
- 🔜 iflytek 原生远端源(若出,摄取脚本退化)。

---

## 12. 落地顺序(实现计划另行编写)
1. 本地起 iflytek(`make dev-all`),抓 API/OpenAPI 细化契约。
2. 建 `server/skillhub-bridge.ts`:sync 拉 PUBLISHED → `importNativePlugin`。
3. org ↔ namespace 映射 + org 生命周期 hook 调 iflytek。
4. entitlement 镜像逻辑 + 审计补洞(能力操作进 governance_audit_log)。
5. 外部源摄取脚本(`skillhub-ingest.ts`)。
6. 接通 Runtime：新 runtime 的 `resolve()` 消费镜像结果，继续执行 app allowlist ∩ activation 和安全守卫。
7. 平台统一 Skill Hub 入口：先做配置化 URL + 受控跳转，后续再接 SSO，不阻塞同步和 Runtime 闭环。

每步的实现计划由 writing-plans skill 单独产出,不在此展开。

---

## 13. 参考
- iflytek/skillhub README + `docs/02-domain-model.md` + `docs/06-api-design.md`
  + `docs/14-skill-lifecycle.md` + `docs/05-business-flows.md`
  + `docs/03-authentication-design.md` + `docs/12-private-sso-integration-playbook.md`
  + `docs/api/authentication.openapi.yaml`
- 本平台:`docs/03-modules/capability-injection-paths.md`、
  `docs/02-architecture/plugin-installer-design.md`、
  `server/capability-provider.ts`、`server/capability-installer.ts`、
  `server/entitlement.ts`、`server/agent-capabilities.ts`
