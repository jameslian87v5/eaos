# Platform image: Node API server + agent engine (RUNTIME_MODE=local by default).
# Runs `tsx server/server.ts` and serves the API, /health, and WebSocket.
#
# Scope note: this image targets the API/agent engine. The main React UI currently
# requires the Vite dev server (client/index.html references /index.tsx); a
# containerized main UI needs a main-app bundle build (tracked as P1 debt).
# `npm run build` here produces the embeddable widget bundle under dist/.
FROM node:20-bookworm

WORKDIR /app

# Install deps (includes tsx + vite which the runtime/build use)
COPY package*.json ./
RUN npm ci

# Source + build the widget bundle
COPY . .
RUN npm run build && mkdir -p data logs

# Defaults — override via env_file (.env) in compose
ENV PORT=3001 \
    DB_PATH=/app/data/eaos.db \
    RUNTIME_MODE=local

EXPOSE 3001
CMD ["npm", "start"]
