#!/usr/bin/env node
/**
 * local-sandbox 生产部署前置检查（Claude-only closure）。
 *
 * 一次收集全部阻塞原因（诊断用，非逐一失败）：
 *   ① msb 二进制（固定清单：版本 + sha256）
 *   ② hypervisor（macOS HVF / Linux KVM）
 *   ③ Guest 镜像 digest 探针（msb image inspect，已加载镜像 vs pin）
 *   ④ 镜像证明清单（digest + ed25519 release 签名 + 资产证明）
 *   ⑤ 资源策略可表达性（integer cpu / 内存 / 配额界）
 *   ⑥ 模型凭证代理配置（credential kind + sanitized endpoint — 永不输出
 *     凭证值，也永不输出 userinfo/query/path——env 派生 URL 可能携带它们）
 *
 * 退出码：0 = 全部通过；2 = 存在阻塞项（报告 reasons，绝不假通过）。
 * 本脚本不做真实模型调用（那是 smoke:local-sandbox 的职责）。
 *
 * msb 解析（M4.5-R1）：只接受显式 `MSB_PATH`（必须存在）或受控 PATH 查找；
 * 不做任何机器特定路径回退（如 /private/tmp/...）。
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  PINNED_GUEST_IMAGE,
  PINNED_GUEST_IMAGE_DIGEST,
  PINNED_MSB_VERSION,
  pinnedMsbChecksum,
  guestEngineStatus,
  probeGuestImageDigest,
  probeMicrosandboxRuntime,
} from "../server/microsandbox-policy.ts";
import { resolveModelEgressTarget } from "../server/model-egress-proxy.ts";
import { getRuntimeSettings, validateLocalSandboxSettings } from "../server/runtime-settings.ts";

/** Explicit MSB_PATH (must exist) or controlled PATH lookup. No machine-specific fallback. */
export function findMsb(env = process.env) {
  if (env.MSB_PATH) return existsSync(env.MSB_PATH) ? env.MSB_PATH : null;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "msb");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Endpoint for REPORTING only: protocol + host[:port]. Userinfo, path, query
 * and fragment are ALWAYS dropped — env-derived URLs may carry credentials in
 * any of them. Never report the raw baseUrl.
 */
export function redactEndpointForReport(baseUrl) {
  try {
    const u = new URL(baseUrl);
    return { protocol: u.protocol.replace(/:$/, ""), host: u.host };
  } catch {
    return { protocol: "unparseable", host: "unparseable" };
  }
}

function probeHypervisor() {
  if (process.platform === "darwin") {
    try {
      const v = execFileSync("sysctl", ["-n", "kern.hv_support"], { encoding: "utf8" }).trim();
      return v === "1"
        ? { ok: true, detail: "HVF available (kern.hv_support=1)" }
        : { ok: false, detail: `HVF unavailable (kern.hv_support=${v})` };
    } catch (e) {
      return { ok: false, detail: `sysctl kern.hv_support failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  if (process.platform === "linux") {
    return existsSync("/dev/kvm")
      ? { ok: true, detail: "KVM present (/dev/kvm)" }
      : { ok: false, detail: "KVM absent (/dev/kvm missing — microsandbox/libkrun requires KVM on Linux)" };
  }
  return { ok: false, detail: `unsupported platform ${process.platform} (macOS HVF or Linux KVM required)` };
}

function main() {
  const reasons = [];
  const report = {
    outcome: "blocked",
    mode: "local-sandbox",
    pinned: { msbVersion: PINNED_MSB_VERSION, guestImage: PINNED_GUEST_IMAGE, guestImageDigest: PINNED_GUEST_IMAGE_DIGEST },
    checks: {},
    reasons,
  };

  // ① msb binary + pinned manifest
  const msbPath = findMsb();
  if (!msbPath) {
    reasons.push(`msb binary not found (set MSB_PATH to a verified msb ${PINNED_MSB_VERSION} binary or put msb on PATH — no machine-specific fallback)`);
    report.checks.msb = { ok: false };
  } else {
    const sha = pinnedMsbChecksum(); // platform-fixed manifest pin
    if (!sha) {
      report.checks.msb = { ok: false, detail: `platform ${process.platform}-${process.arch} has no checksum manifest entry` };
      reasons.push(report.checks.msb.detail);
    } else {
      const probe = probeMicrosandboxRuntime({ msbPath, msbVersion: PINNED_MSB_VERSION, msbSha256: sha });
      report.checks.msb = { ok: probe.available, version: probe.version, ...(probe.available ? {} : { detail: probe.reason }) };
      if (!probe.available) reasons.push(`msb probe failed: ${probe.reason}`);
    }
  }

  // ② hypervisor
  const hv = probeHypervisor();
  report.checks.hypervisor = hv;
  if (!hv.ok) reasons.push(`hypervisor: ${hv.detail}`);

  // ③+④ guest image digest + proof manifest (digest + release signature + assets)
  if (msbPath) {
    const digest = probeGuestImageDigest(msbPath, PINNED_GUEST_IMAGE);
    const engine = guestEngineStatus(PINNED_GUEST_IMAGE, digest);
    report.checks.guestEngine = { ok: engine.ok, probedDigest: digest, ...(engine.ok ? {} : { missing: engine.missing }) };
    if (!engine.ok) reasons.push(`guest engine unavailable on pinned image '${PINNED_GUEST_IMAGE}': ${engine.missing.join("; ")}`);
  } else {
    report.checks.guestEngine = { ok: false, detail: "skipped (no msb)" };
  }

  // ⑤ resource policy expressibility (settings → validated config; integer cpu etc.)
  try {
    const cfg = validateLocalSandboxSettings(getRuntimeSettings());
    if (!Number.isInteger(cfg.cpuCores)) {
      reasons.push(`cpuCores ${cfg.cpuCores} is fractional — msb only accepts integer --max-cpus (inexpressible, fail closed)`);
    }
    report.checks.resourcePolicy = { ok: Number.isInteger(cfg.cpuCores), cpuCores: cfg.cpuCores, memoryMb: cfg.memoryMb, maxTurns: cfg.maxTurns };
  } catch (e) {
    report.checks.resourcePolicy = { ok: false, detail: e instanceof Error ? e.message : String(e) };
    reasons.push(`resource policy invalid: ${report.checks.resourcePolicy.detail}`);
  }

  // ⑥ credential proxy config (credential kind + sanitized endpoint only)
  const egress = resolveModelEgressTarget();
  report.checks.credentialProxy = egress
    ? { ok: true, credentialKind: egress.credentialKind, endpoint: redactEndpointForReport(egress.baseUrl) }
    : { ok: false };
  if (!egress) reasons.push("model egress proxy not configured (MODEL_EGRESS_BASE_URL/ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN/ANTHROPIC_API_KEY absent — long-term model keys never enter the Guest)");

  report.outcome = reasons.length === 0 ? "ready" : "blocked";
  console.log(JSON.stringify(report, null, 2));
  process.exit(reasons.length === 0 ? 0 : 2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
