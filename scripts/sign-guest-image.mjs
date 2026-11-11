#!/usr/bin/env node
/**
 * sign-guest-image.mjs — release-holder helper for guest-image re-pinning.
 *
 * Re-pinning a rebuilt guest image requires THREE steps, in order
 * (docs/开发计划/local-microvm-runtime-整体研发计划.md, M3 supply-chain rules):
 *   1. re-prove the new image with real Guest probes and update
 *      GUEST_IMAGE_ASSET_PROOFS in server/microsandbox-policy.ts;
 *   2. re-sign the new digest with the platform release key (THIS SCRIPT);
 *   3. update GUEST_IMAGE_RELEASE_SIGNATURES with the emitted hex.
 *
 * The private key is held OFFLINE by the release holder and is never
 * committed. Usage:
 *
 *   node scripts/sign-guest-image.mjs <path-to-release-private.pem> <image>@<digest>
 *
 * Example:
 *   node scripts/sign-guest-image.mjs /secure/keys/guest-release.pem \
 *     'eaos-guest:0.1.4@sha256:<digest>'
 */
import { readFileSync } from "node:fs";
import { createPrivateKey, sign } from "node:crypto";

const [keyPath, payloadArg] = process.argv.slice(2);
if (!keyPath || !payloadArg || !/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(payloadArg)) {
  console.error("usage: node scripts/sign-guest-image.mjs <private.pem> '<image>@sha256:<digest>'");
  process.exit(2);
}
const privateKey = createPrivateKey(readFileSync(keyPath, "utf8"));
if (privateKey.asymmetricKeyType !== "ed25519") {
  console.error(`refusing: key is ${privateKey.asymmetricKeyType ?? "unknown"}, expected ed25519 (platform release key)`);
  process.exit(2);
}
const signature = sign(null, Buffer.from(payloadArg, "utf8"), privateKey).toString("hex");
console.log(`payload:   ${payloadArg}`);
console.log(`signature: ${signature}`);
console.log("\nadd to GUEST_IMAGE_RELEASE_SIGNATURES in server/microsandbox-policy.ts:");
console.log(`  [${payloadArg.split("@")[0]}]:\n    "${signature}",`);
