FROM node:20-slim

# APT mirror override (deb822 format on bookworm-slim). Default = upstream;
# pass --build-arg APT_MIRROR=mirrors.aliyun.com (or tuna) when the build host
# cannot reach deb.debian.org at usable speed.
ARG APT_MIRROR=deb.debian.org

# Base tools: python3, pip, venv, git, curl, ca-certificates
# No large packages (pandas/numpy/build-essential) — add later per real need
RUN if [ "$APT_MIRROR" != "deb.debian.org" ]; then \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
    fi \
  && apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    git \
    curl \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Lockfile pinned (SDK drift incident 2026-09-04: ^0.3.183 resolved 0.3.259
# in the image whose CLI dropped the --model flag → provider 400). npm ci
# enforces docker/package-lock.json at build time.
COPY docker/package.json docker/package-lock.json ./
RUN npm ci

COPY docker/agent-entry.ts ./docker/agent-entry.ts
COPY docker/tsconfig.json ./docker/tsconfig.json
COPY server/ipc-protocol.ts ./server/ipc-protocol.ts
COPY server/user-memory-permission-core.ts ./server/user-memory-permission-core.ts
COPY server/ai-client.ts ./server/ai-client.ts
COPY server/types.ts ./server/types.ts
COPY server/platform-web-tools.ts ./server/platform-web-tools.ts
COPY server/declarations.d.ts ./server/declarations.d.ts
# A2UI v2 (S3): schema + in-process show_ui tool (a2ui-tool → a2ui-schema → a2ui-types)
COPY server/a2ui-types.ts ./server/a2ui-types.ts
COPY server/a2ui-schema.ts ./server/a2ui-schema.ts
COPY server/a2ui-tool.ts ./server/a2ui-tool.ts
# S3b (Appendix A.1): runtime-infrastructure streaming switch — imported by
# BOTH agent-entry.ts and ai-client.ts (includePartialMessages gating).
COPY server/streaming-config.ts ./server/streaming-config.ts

RUN npx tsc -p docker/tsconfig.json

ENV AGENT_WS_PORT=9100
EXPOSE 9100

CMD ["node", "/app/dist-agent/docker/agent-entry.js"]
