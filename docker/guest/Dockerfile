# eaos-guest — MicroVM Guest engine image (M3-S3A; supply-chain pinned in R1).
#
# Reproducible OCI image carrying ONLY: pinned Node, the compiled worker entry
# + its transitive server/adapter files, and the pinned Claude Agent SDK
# runtime (so the committed Claude adapter's dependency resolves). It contains
# NO AppKey/JWT/model credential and NO copied host .env — model calls leave as
# model_request INTENTS answered by the Host credential proxy (M3-S3B); a
# policy without egress authorization still fails closed (deny-all broker).
#
# Supply chain (M3-S3A R1):
#   - Base image pinned by immutable digest (linux/arm64, verified on this
#     host via docker image inspect RepoDigests — the digest the build ran on).
#   - NO apt packages: the runtime stage installs nothing from Debian. npm
#     needs no system CA store (Node bundles its own Mozilla CA list — proven
#     by the build itself), and the Guest has ZERO HTTPS egress today
#     (deny-all broker + networkEgress "none"). A future credential proxy that
#     needs TLS from the Guest must add a snapshot-pinned package step then.
#   - JS deps: npm ci from the committed lockfile (SDK 0.3.185 + platform
#     optional native + build-only typescript/@types/node).
#
# Multi-stage: the build stage carries typescript + @types/node + .ts sources;
# the runtime stage carries ONLY node + compiled dist + prod node_modules
# (SDK). The final self-test asserts typescript did NOT leak in.
#
# Build context = repo root (so worker/ and server/ COPY paths resolve).
#   docker build -t eaos-guest:0.1.4 -f docker/guest/Dockerfile .
#
# Load into msb (immutable identity captured via msb image inspect digest):
#   msb image load -i eaos-guest-0.1.4.tar -t eaos-guest:0.1.4

# ─── Build stage: compile worker entry + transitive server files ────────────
FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS build

WORKDIR /opt/agent

# Pinned deps. npm ci enforces the lockfile. Installed at /opt/agent so the
# compiled dist/ (and the self-test) can resolve the SDK by walking up.
COPY docker/guest/package.json docker/guest/package-lock.json ./
RUN npm ci --include=optional --no-audit --no-fund

# Compile to /opt/agent/dist. rootDir=repo root → dist/worker/... and
# dist/server/... mirroring source, so the worker's `../server/*.js` and the
# adapter's `../../server/*.js` imports hold. The guest package.json copied
# above sits at /opt/agent with "type":"module" — NodeNext decides ESM vs CJS
# per-file from the nearest package.json, and the worker entry uses import.meta
# (same module semantics as the host project).
COPY docker/guest/tsconfig.json ./docker/guest/tsconfig.json
COPY worker/ ./worker/
COPY server/local-agent-worker-protocol.ts server/platform-runtime-protocol.ts server/resolved-execution-policy.ts server/claude-event-normalizer.ts ./server/

RUN npx tsc -p docker/guest/tsconfig.json

# ─── Runtime stage: node + dist + prod deps only, zero package installs ─────
FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0

WORKDIR /opt/agent

# Prod deps only (the SDK + its platform optional native). package.json also
# provides the "type":"module" marker Node needs to run dist/ as ESM.
COPY docker/guest/package.json docker/guest/package-lock.json ./
RUN npm ci --omit=dev --include=optional --no-audit --no-fund

# Compiled engine (no .ts sources, no build toolchain in this stage).
COPY --from=build /opt/agent/dist ./dist

# Guest entry default (overridable per-run): the worker reads newline-delimited
# platform-protocol command frames from stdin.
ENV WORKER_ENTRY=/opt/agent/dist/worker/local-agent-entry.js

# Build-time gate — a failing build beats a faked runtime_ready:
#   node runs, the worker entry exists, the pinned SDK resolves, and the
#   build toolchain did NOT leak into the runtime image. (Zero runtime
#   package installs is structural: this stage contains no apt RUN at all.)
RUN node --version \
  && test -f /opt/agent/dist/worker/local-agent-entry.js \
  && node -e "console.log('sdk:', require.resolve('@anthropic-ai/claude-agent-sdk'))" \
  && if node -e "require.resolve('typescript')" 2>/dev/null; then echo "FAIL: typescript leaked into runtime image"; exit 1; fi

CMD ["node", "/opt/agent/dist/worker/local-agent-entry.js"]
