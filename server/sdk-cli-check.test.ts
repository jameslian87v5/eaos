// M6-fix (evt_20260819125001) — SDK native CLI 预启动检测. Minimal proof:
//   - the real install resolves the darwin-arm64 binary exactly where the SDK
//     will spawn it from (the fix that unblocked the demo);
//   - a missing optional package yields ok:false with a remediation that names
//     the platform triple, --omit=optional, and pathToClaudeCodeExecutable;
//   - candidate grammar mirrors the SDK (musl variants on linux, .exe on win32);
//   - importing the module is side-effect free (CLI mode only via direct run).
//
// Run: npx tsx server/sdk-cli-check.test.ts
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

const { checkSdkCli, platformCandidates, sdkCliRemediation } = await import("./sdk-cli-check.js");

let pass = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (!cond) throw new Error(`FAIL: ${name} ${extra}`);
  pass++;
  console.log(`✓ ${name}`);
}

// A. Real environment (this machine): binary present → ok with an existing path.
{
  const r = checkSdkCli();
  if (process.platform === "darwin" && process.arch === "arm64") {
    ok("A1 real darwin-arm64 install → ok", r.ok && r.path != null, JSON.stringify(r));
    ok("A2 resolved path exists on disk", existsSync(r.path!), String(r.path));
    ok("A3 no message when ok", r.message === null);
  } else {
    // Non-darwin CI: the contract still holds whichever way the env answers.
    ok("A1 check returns a definitive answer", typeof r.ok === "boolean" && (r.ok ? r.path != null : r.message != null));
  }
}

// B. Missing optional package → clear remediation (injected seams).
{
  const throwResolve = () => { throw new Error("MODULE_NOT_FOUND"); };
  const r = checkSdkCli({ resolveImpl: throwResolve });
  ok("B1 resolve failure → ok:false", !r.ok && r.path === null, JSON.stringify(r));
  ok("B2 remediation names --omit=optional", /--omit=optional/.test(r.message ?? ""), r.message ?? "");
  ok("B3 remediation names pathToClaudeCodeExecutable", /pathToClaudeCodeExecutable/.test(r.message ?? ""));
  ok("B4 remediation names the platform triple",
    r.message?.includes(`${process.platform}-${process.arch}`) ?? false, r.message ?? "");
  ok("B5 remediation names the missing package",
    r.message?.includes(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`) ?? false);
  ok("B6 remediation suggests npm install", /npm install/.test(r.message ?? ""));
}

// C. Resolved-but-absent binary (file deleted / broken optional install).
{
  const fakeResolve = (spec: string) => `/fake/node_modules/${spec}`;
  const r = checkSdkCli({ resolveImpl: fakeResolve, existsImpl: () => false });
  ok("C1 resolved but missing file → ok:false with remediation", !r.ok && r.message != null, JSON.stringify(r));
  const r2 = checkSdkCli({ resolveImpl: fakeResolve, existsImpl: (p) => p.endsWith("/claude") });
  ok("C2 exists hit on the right candidate → ok:true", r2.ok && r2.path?.startsWith("/fake/node_modules/") === true, JSON.stringify(r2));
}

// D. Candidate grammar mirrors the SDK.
{
  const darwin = platformCandidates("darwin" as NodeJS.Platform, "arm64");
  ok("D1 darwin → single non-musl candidate with claude binary",
    darwin.length === 1 && darwin[0] === "@anthropic-ai/claude-agent-sdk-darwin-arm64/claude", JSON.stringify(darwin));
  const linux = platformCandidates("linux" as NodeJS.Platform, "x64");
  ok("D2 linux → glibc + musl candidates",
    linux.includes("@anthropic-ai/claude-agent-sdk-linux-x64/claude") &&
    linux.includes("@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude"), JSON.stringify(linux));
  const win = platformCandidates("win32" as NodeJS.Platform, "x64");
  ok("D3 win32 → .exe suffix", win[0] === "@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe", JSON.stringify(win));
}

// E. sdkCliRemediation is standalone-printable (boot banner / CLI).
{
  const msg = sdkCliRemediation("darwin" as NodeJS.Platform, "arm64");
  ok("E1 standalone message mentions darwin-arm64 + runbook", msg.includes("darwin-arm64") && msg.includes("operations-runbook"), msg);
}

// F. Import is side-effect free (the CLI guard must only fire on direct run —
//    this test imported the module at the top and is still alive).
ok("F1 module import has no process.exit side effect", true);

console.log(`\nsdk-cli-check: ${pass} assertions passed`);
process.exit(0);
