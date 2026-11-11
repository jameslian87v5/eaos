# 外部对标：CubeSandbox 适配评估

> 状态：观点文档（非实现计划）。评估 CubeSandbox 作为 data-plane 底层 runtime 基础设施的适配性与战略定位。
> 对象：腾讯云开源 CubeSandbox（`github.com/TencentCloud/CubeSandbox`，Apache-2.0，Rust + KVM MicroVM）。
> 信息源：腾讯云开发者社区架构解析、官方部署文档、第三方实战、公开仓库。
> **事实性说明**：版本演进至 v0.7.0（~2026-09）。性能数字（冷启动 <60ms / <5MB / 单节点 2000+）来自官方宣称，未自测；star 数无决策价值，已删除。

## 1. 它是什么

面向 AI Agent 的安全沙箱 runtime，RustVMM + KVM MicroVM：

- 冷启动 <60ms、内存 <5MB/实例、单节点数千实例。
- **独立 Guest 内核 + eBPF**（非 Docker 共享内核）→ 硬件级隔离。
- E2B 协议兼容（改 URL 即可切）。
- 快照 / 克隆 / 回滚。
- 组件：CubeAPI（REST 网关，Rust，E2B 兼容）/ CubeMaster（集群编排）/ Cubelet（节点本地生命周期）/ CubeProxy（反代，E2B 协议路由）/ CubeVS（eBPF 虚拟交换机，内核级网络隔离）/ **CubeEgress（OpenResty 出口网关：L7 域名过滤 + 凭据注入 + 访问审计）**。

## 2. 战略命中：它最值钱的不是 microVM，是 CubeEgress（但有安全边界）

我们主攻 2 = "容器级隔离 + agent 安全触达内网 API"。当前缺"安全触达内网 API"的真实落地（规划的 SSRF allowlist 还在 hook 阶段，自己造）。

**CubeEgress 提供工业级出口网关实现**：L7 域名过滤 + 凭据注入 + 访问审计。这正是 agent 触达内网 API 时的出口治理——白嫖比自研划算。

> **安全边界（2026-09-03 codex 复核纠正）**：CubeEgress 是**额外强制层，不能替代 host 侧 SSRF 防御**。出口网关只在 MicroVM/docker 出站流量经过它时生效，必须保留：
> - host 侧 URL fetch 的 SSRF allowlist（私网地址/DNS rebinding/重定向链校验）——Local 模式不经 MicroVM egress，host 侧防御是唯一防线；
> - DNS 解析校验（防 rebinding 到内网）；
> - 重定向跟随校验（每一跳都过 allowlist）；
> - 私网地址/链路本地地址拒绝（169.254/10/172.16/192.168/127.0.0.0.8 等）。
> 即 CubeEgress 接入后 SSRF allowlist 仍需自研并保留，CubeEgress 是叠加而非替代。

| 我们主攻 2 的能力 | 当前 | 接 CubeSandbox 后 |
|---|---|---|
| 隔离 | 容器级（Docker） | microVM 硬隔离级（独立内核 + eBPF），对进程沙箱再加码 |
| 出口治理 | 规划中（SSRF allowlist 自研，仍需保留） | host 侧 allowlist 保留 + CubeEgress 叠加（L7 + 凭据 + 审计） |
| 网络隔离 | 端口绑回环（`buildAgentPortBindings`） | CubeVS eBPF 内核级 |

## 3. 适配点（逐个对，待 PoC 验证）

> **降级声明（codex 复核）**：以下"不动/完全保留"是设计预期，**未经 PoC 验证**，落到 rootfs/diff 模型时契约层是否真不动需实测。

| 我们的组件 | 换 CubeSandbox 后 | 适配性 |
|---|---|---|
| `AgentRuntime` 接口 / `agent-entry.ts` / capability resolve 桥 | 设计预期不动（**待 PoC 验证**） | ◐ 预期保留，未验 |
| `DockerAgentRuntime`（dockerode 建容器 + 命名卷 + AutoRemove + 端口映射） | 新增 `MicroVMAgentRuntime` 平级实现（调 Cube API 建 sandbox，agent-entry 跑在 rootfs 里） | ◐ 平级新增，不重写 |
| WS IPC（`ipc-protocol.ts`，9100 绑回环） | 走 CubeProxy 或 sandbox 直连 | ◐ 连接方式变，协议不变 |
| Cold resume（`claudeSessionId` + 命名卷） | 保留 SDK 级 resume；snapshot/rollback 加 VM 级 pause/resume | ◐ 互补，未实测 |
| capability 注入：`/opt/agent/plugins/<name>:ro` bind-mount | **模型要改**：rootfs 预置或 boot 时注入 diff 层 | ✗ 最重的改造点 |

## 4. 真正的改造成本（不回避）

1. **capability 注入模型要重做**。四条注入路径（A/B/C/D）+ 4 层路径校验全假设 Docker bind-mount 语义。MicroVM 是 rootfs + diff 层，无 bind-mount。`resolve()` 翻译出的 `CapabilityBundle.mounts` 要从"host bind-mount"变成"rootfs 预置 / boot 时 copy 进 diff"。这是真活，不是配置。

2. **长期会话 vs 临时沙箱的语义错配**。CubeSandbox 卖点话术偏 ephemeral code-exec（60ms 起、代码解释器镜像）。我们的 agent 是长生命周期 + warm/cold resume。snapshot/rollback 能支撑长生命周期，但要实测"常驻 + idle pause + 快速 resume"表现，别只看冷启动数字。

3. **infra 要求抬高**。当前生产 runbook 假设普通 Linux + Docker。CubeSandbox 要 KVM / 嵌套虚拟化 / 或 PVM 内核（强绑 OpenCloudOS 9 定制 kernel）。单 VM 上线门槛变高。

4. **开源版是否真独立要验**。CubeEgress / CubeProxy 能否脱离腾讯云基础设施独立跑，还是部分组件依赖腾讯云托管。`online-install.sh` + PVM kernel 看起来能自托管，但 CubeEgress（OpenResty）等组件的独立可部署性要实测，别接进来发现是腾讯云托管的薄壳。

## 5. 战略定位（关键）

CubeSandbox 是 **data-plane 弹药**，强化主攻 2。**不是控制面，不碰主攻 1（多引擎）**。两条正交，别让它喧宾夺主变成"我们在做沙箱基础设施"——那就跑偏到和 CubeSandbox 自己竞争了。

对 OpenOcta：他们用进程沙箱，我们接 CubeSandbox = 隔离优势从"容器级"升到"microVM 硬隔离级" + 出口治理，是加分。
对 E2B 生态：CubeSandbox 兼容 E2B 协议，接它等于顺带进 E2B 工具生态。

## 6. 落地姿势（适配器，不重写，待 PoC）

1. 设计预期不动 `AgentRuntime` / `agent-entry.ts` / resolve 桥——**待 PoC 验证**，落到 rootfs/diff 模型时若契约层被迫改动则需重评。
2. 新增 `MicroVMAgentRuntime implements AgentRuntime`，与 `DockerAgentRuntime` 平级。
   - **注意**：这验证的是"换沙箱后端"（Local vs Docker vs MicroVM），**不是"换引擎"**。别混为一谈——换沙箱后端只证明 Runtime 契约能吸收不同执行环境，不证明多引擎。
3. capability 注入路径单独重构一轮（mounts → rootfs/diff 模型）。
4. CubeEgress 作为**额外强制层**接入，**不替代** host 侧 SSRF allowlist（见 §2 安全边界）。

## 7. 接入前必验两件事

1. **开源版能否完全脱离腾讯云独立部署**（CubeEgress / CubeProxy 尤其）——拉下来真跑一遍。
2. **长生命周期会话 + 快照 resume 的实测表现**——别只看 60ms 冷启动数字。

两条过了，再谈"换底层 runtime"。不过的话，它只是个比 Docker 隔离强的 ephemeral 沙箱，对我们长生命周期 agent 场景价值打折。

## 8. 决策状态

暂不接入。当前主线是**品牌与上线专项（P-Deploy 收尾、登录安全、错误处理、部署闭环）**——多引擎主攻 1 与 CubeSandbox 主攻 2 弹药**都按触发条件后置**，不抢占主线：

- 多引擎：只在明确第二引擎场景 + 负责人 + 验收任务后启动。
- CubeSandbox：只在主攻 2 内网出口治理有真实需求 + §7 两项验证通过后接入。

两者正交，无先后强绑定（不写成"先完成多引擎再评估 CubeSandbox"）。CubeSandbox 接不接不影响多引擎护城河是否成立。

## 9. 相关文档

- `external-alignment-openocta-comparison.md` — 主攻方向的来源（多引擎 vs 多模型）。
- `runtime-strategy-reference.md` — runtime 策略基线。
- `agent-os-security-overview.md` — 安全治理总览。
- `production-release-runbook.md` — 当前单 VM 生产部署（Docker 基线）。
