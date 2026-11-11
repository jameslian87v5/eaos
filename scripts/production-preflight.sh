#!/usr/bin/env bash
# Task 3 — pre-deployment preflight for the single-VM production.
# Usage:
#   sudo bash scripts/production-preflight.sh \
#        [--env-file /etc/chit-agentos/prod.env] \
#        [--app-dir /opt/chit-agentos/current] \
#        [--data-dir /var/lib/chit-agentos/data] \
#        [--backup-dir /var/backups/chit-agentos]
#
# CONTRACT (plan §Task 3 Step 3):
#   * prints PASS / FAIL / SKIP per check and variable NAMES only — never values;
#   * exits non-zero when any REQUIRED check fails;
#   * DashScope / Skill Hub show SKIP when unconfigured (must not fake a PASS).

set -uo pipefail

# Defaults come from environment variables first (CI/ops friendly), then
# flags override (review P1.3: the script must READ these, not just define them).
ENV_FILE="${ENV_FILE:-/etc/chit-agentos/prod.env}"
APP_DIR="${APP_DIR:-/opt/chit-agentos/current}"
DATA_DIR="${DATA_DIR:-/var/lib/chit-agentos/data}"
SKILLS_DIR="${SKILLS_DIR:-/var/lib/chit-agentos/skills}"
PLUGINS_DIR="${PLUGINS_DIR:-/var/lib/chit-agentos/plugins}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/chit-agentos}"
BASE_URL="${BASE_URL:-http://127.0.0.1:3001}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)   ENV_FILE="$2"; shift 2 ;;
    --app-dir)    APP_DIR="$2"; shift 2 ;;
    --data-dir)   DATA_DIR="$2"; shift 2 ;;
    --skills-dir) SKILLS_DIR="$2"; shift 2 ;;
    --plugins-dir) PLUGINS_DIR="$2"; shift 2 ;;
    --backup-dir) BACKUP_DIR="$2"; shift 2 ;;
    --base-url)   BASE_URL="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

FAILED=0

report() { # report PASS|FAIL|SKIP <name> [detail-without-secrets]
  local status="$1" name="$2" detail="${3:-}"
  printf '[%s] %s%s\n' "$status" "$name" "${detail:+ — $detail}"
  [[ "$status" == "FAIL" ]] && FAILED=1
  return 0
}

# Read one variable's value from the env file WITHOUT executing it and without
# ever printing the value. Handles KEY=value, quotes, trailing comments.
env_value() { # env_value <KEY> → value on stdout (empty if unset)
  [[ -r "$ENV_FILE" ]] || return 0
  awk -v key="$1" '
    $0 ~ /^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*=/ {
      line=$0
      sub(/^[[:space:]]*(export[[:space:]]+)?/, "", line)
      split(line, kv, "=")
      if (kv[1] != key) next
      v=line
      sub(/^[^=]*=/, "", v)
      sub(/[[:space:]]*#.*$/, "", v)
      gsub(/^[[:space:]]*"|"[[:space:]]*$/, "", v)
      gsub(/^[[:space:]]*\047|\047[[:space:]]*$/, "", v)
      print v
      exit
    }
  ' "$ENV_FILE"
}

echo "== Chit AgentOS production preflight =="
echo "env-file: $ENV_FILE   app-dir: $APP_DIR   data-dir: $DATA_DIR"
echo "skills-dir: $SKILLS_DIR   plugins-dir: $PLUGINS_DIR   backup-dir: $BACKUP_DIR"
echo

# ── 1. Host prerequisites: Linux, Node ≥ 20, npm, Docker, Nginx ──────────
[[ "$(uname -s)" == "Linux" ]] && report PASS "host is Linux" || report FAIL "host is Linux" "$(uname -s)"
for cmd in node npm docker nginx ss curl; do
  if command -v "$cmd" >/dev/null 2>&1; then
    report PASS "command present: $cmd"
  else
    report FAIL "command present: $cmd" "not on PATH"
  fi
done
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [[ "${NODE_MAJOR}" -ge 20 ]]; then
    report PASS "node major version ≥ 20"
  else
    report FAIL "node major version ≥ 20" "found ${NODE_MAJOR}"
  fi
fi

# ── 2. Dependencies installed (npm ci --include=dev; tsx needed by npm start) ──
[[ -x "$APP_DIR/node_modules/.bin/tsx" ]] \
  && report PASS "node_modules/.bin/tsx present (deps installed)" \
  || report FAIL "node_modules/.bin/tsx present (deps installed)" "run npm ci --include=dev in $APP_DIR"

# ── 3. Docker daemon reachable + agent image built ───────────────────────
if docker info >/dev/null 2>&1; then
  report PASS "docker daemon reachable"
else
  report FAIL "docker daemon reachable" "systemctl start docker"
fi
if docker image inspect eaos-agent:latest >/dev/null 2>&1; then
  report PASS "image eaos-agent:latest present"
else
  report FAIL "image eaos-agent:latest present" "docker build -f docker/Dockerfile -t eaos-agent:latest ."
fi

# ── 4. Env file exists, sane owner, permissions ≤ 0600 ───────────────────
if [[ -f "$ENV_FILE" ]]; then
  report PASS "env file exists"
  # Allow 400 / 600 only (0640 leaks group-read; 0644 world-read).
  PERMS="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || echo 644)"
  if [[ "$PERMS" == "400" || "$PERMS" == "600" ]]; then
    report PASS "env file permissions ≤ 0600 (found mode $PERMS)"
  else
    report FAIL "env file permissions ≤ 0600" "found mode $PERMS; chmod 600 $ENV_FILE"
  fi
  OWNER="$(stat -c '%U' "$ENV_FILE" 2>/dev/null || echo unknown)"
  if [[ "$OWNER" == "root" || "$OWNER" == "agentos" ]]; then
    report PASS "env file owner is root or agentos"
  else
    report FAIL "env file owner is root or agentos" "found owner '$OWNER'"
  fi
else
  report FAIL "env file exists" "$ENV_FILE missing"
fi

# ── 5. Required variables non-empty (names only!) ────────────────────────
required_nonempty() { # required_nonempty <VAR> <why>
  local v; v="$(env_value "$1")"
  if [[ -n "$v" ]]; then report PASS "$1 set"; else report FAIL "$1 set" "$2"; fi
}
required_nonempty JWT_SECRET   "generate with: openssl rand -hex 32"
required_nonempty ANTHROPIC_API_KEY "LLM provider key"
required_nonempty ANTHROPIC_BASE_URL "provider base URL"
required_nonempty AGENT_MODEL  "model id accepted by provider"
DB_PATH_VALUE="$(env_value DB_PATH)"
DB_PATH_FILE="${DB_PATH_VALUE:-/var/lib/chit-agentos/data/chatapp.db}"
if [[ ! -f "$DB_PATH_FILE" ]]; then
  # First boot on an empty DB: bootstrap admin password is REQUIRED once.
  ADMIN_PW="$(env_value ADMIN_PASSWORD)"
  if [[ -n "$ADMIN_PW" ]]; then
    report PASS "ADMIN_PASSWORD set (first boot, DB absent)"
  else
    report FAIL "ADMIN_PASSWORD set (first boot, DB absent)" "needed to seed the initial admin"
  fi
else
  report PASS "DB file exists (bootstrap admin not required)"
fi

# ── 6. Safety switches in the right position ─────────────────────────────
ALLOW_DEV="$(env_value ALLOW_DEV_JWT_SECRET)"
if [[ -z "$ALLOW_DEV" || "$ALLOW_DEV" == "0" || "$ALLOW_DEV" == "false" ]]; then
  report PASS "ALLOW_DEV_JWT_SECRET not enabled"
else
  report FAIL "ALLOW_DEV_JWT_SECRET not enabled" "remove it from $ENV_FILE"
fi
[[ "$(env_value RUNTIME_MODE)" == "docker" ]] \
  && report PASS "RUNTIME_MODE=docker" \
  || report FAIL "RUNTIME_MODE=docker" "required for production"
[[ "$(env_value HOST)" == "127.0.0.1" ]] \
  && report PASS "HOST=127.0.0.1 (Node loopback-only, Nginx fronts it)" \
  || report FAIL "HOST=127.0.0.1" "Node must not bind a public interface"

# ── 7. Data/skills/plugins/backup dirs writable + persistence symlinks ──────
if id agentos >/dev/null 2>&1; then
  for d in "$DATA_DIR" "$SKILLS_DIR" "$PLUGINS_DIR" "$BACKUP_DIR"; do
    if sudo -u agentos test -w "$d" 2>/dev/null; then
      report PASS "dir writable by agentos: $d"
    else
      report FAIL "dir writable by agentos: $d" "install -d -o agentos -g agentos $d"
    fi
  done
else
  report FAIL "service user agentos exists" "useradd --system --home-dir /opt/chit-agentos agentos"
fi
# Runtime state must live on the persistent disk, not inside a release
# checkout. `current/data` is a symlink into /var/lib (round-2). Skills +
# plugins are decoupled via the SKILLS_ROOT / PLUGINS_ROOT env vars
# (round-3/4) — the repo's bundled skills/ + plugins/ dirs are used only
# for first-time seeding, NOT at runtime.
if [[ -e "$APP_DIR" ]]; then
  LINK="$(readlink -f "$APP_DIR/data" 2>/dev/null || true)"
  if [[ -L "$APP_DIR/data" && "$LINK" == "$DATA_DIR" ]]; then
    report PASS "persistence symlink: \$APP_DIR/data → $DATA_DIR"
  else
    report FAIL "persistence symlink: \$APP_DIR/data → $DATA_DIR" \
      "runbook §2: ln -sfn $DATA_DIR $APP_DIR/data (else release switches lose DB/runtime JSON)"
  fi
  SKILLS_ROOT_VALUE="$(env_value SKILLS_ROOT)"
  if [[ -n "$SKILLS_ROOT_VALUE" && "$SKILLS_ROOT_VALUE" != "skills" && "$SKILLS_ROOT_VALUE" != */skills-in-checkout ]]; then
    # The persistent skills dir must exist and be writable by agentos.
    if sudo -u agentos test -w "$SKILLS_ROOT_VALUE" 2>/dev/null; then
      report PASS "SKILLS_ROOT persistent + writable: $SKILLS_ROOT_VALUE"
    else
      report FAIL "SKILLS_ROOT writable" "$SKILLS_ROOT_VALUE missing or not agentos-writable (install -d -o agentos -g agentos $SKILLS_ROOT_VALUE)"
    fi
  else
    report FAIL "SKILLS_ROOT set to persistent dir" "set SKILLS_ROOT=/var/lib/chit-agentos/skills in prod.env (round-3)"
  fi
  PLUGINS_ROOT_VALUE="$(env_value PLUGINS_ROOT)"
  if [[ -n "$PLUGINS_ROOT_VALUE" && "$PLUGINS_ROOT_VALUE" != "plugins" && "$PLUGINS_ROOT_VALUE" != */plugins-in-checkout ]]; then
    if sudo -u agentos test -w "$PLUGINS_ROOT_VALUE" 2>/dev/null; then
      report PASS "PLUGINS_ROOT persistent + writable: $PLUGINS_ROOT_VALUE"
    else
      report FAIL "PLUGINS_ROOT writable" "$PLUGINS_ROOT_VALUE missing or not agentos-writable (install -d -o agentos -g agentos $PLUGINS_ROOT_VALUE)"
    fi
  else
    report FAIL "PLUGINS_ROOT set to persistent dir" "set PLUGINS_ROOT=/var/lib/chit-agentos/plugins in prod.env (round-4)"
  fi
  # Canonical equality (round-5): the runtime root (env) MUST be the same dir
  # the backup/restore script targets (SKILLS_DIR/PLUGINS_DIR), else runtime
  # reads one disk while backup archives another → silent skipped backup.
  # Compare realpaths so symlinks (/var → /private/var) don't cause false FAIL.
  canon() { readlink -f "$1" 2>/dev/null || echo "$1"; }
  SKILLS_RUNTIME_REAL="$(canon "$SKILLS_ROOT_VALUE")"
  SKILLS_BACKUP_REAL="$(canon "$SKILLS_DIR")"
  if [[ -n "$SKILLS_RUNTIME_REAL" && -n "$SKILLS_BACKUP_REAL" ]]; then
    if [[ "$SKILLS_RUNTIME_REAL" == "$SKILLS_BACKUP_REAL" ]]; then
      report PASS "SKILLS_ROOT == SKILLS_DIR (runtime==backup): $SKILLS_RUNTIME_REAL"
    else
      report FAIL "SKILLS_ROOT == SKILLS_DIR" "runtime=$SKILLS_RUNTIME_REAL backup=$SKILLS_BACKUP_REAL — backup would archive the wrong dir"
    fi
  fi
  PLUGINS_RUNTIME_REAL="$(canon "$PLUGINS_ROOT_VALUE")"
  PLUGINS_BACKUP_REAL="$(canon "$PLUGINS_DIR")"
  if [[ -n "$PLUGINS_RUNTIME_REAL" && -n "$PLUGINS_BACKUP_REAL" ]]; then
    if [[ "$PLUGINS_RUNTIME_REAL" == "$PLUGINS_BACKUP_REAL" ]]; then
      report PASS "PLUGINS_ROOT == PLUGINS_DIR (runtime==backup): $PLUGINS_RUNTIME_REAL"
    else
      report FAIL "PLUGINS_ROOT == PLUGINS_DIR" "runtime=$PLUGINS_RUNTIME_REAL backup=$PLUGINS_BACKUP_REAL — backup would archive the wrong dir"
    fi
  fi
else
  report SKIP "persistence symlinks under \$APP_DIR" "app dir not present yet"
fi

# ── 7.5 Installed Nginx conf: real domain + P0 access_log guard intact ──
NGINX_INSTALLED="/etc/nginx/conf.d/chit-agentos.conf"
if [[ ! -f "$NGINX_INSTALLED" ]]; then
  report FAIL "installed nginx conf present" "$NGINX_INSTALLED missing — install it per runbook §4 (a missing conf is a deployment failure, not a skip)"
else
  report PASS "installed nginx conf present"
  if grep -Eq '^[[:space:]]*server_name[[:space:]].*example\.com' "$NGINX_INSTALLED"; then
    report FAIL "installed nginx conf uses real domain" "replace agentos.example.com + cert paths (runbook §4)"
  else
    report PASS "installed nginx conf uses real domain"
  fi
  # P0 (review): count REAL `access_log off;` directives only — strip comments
  # first so a commented-out directive cannot pass. Then assert each WS
  # location has its OWN directive, bounded by that location's block (brace
  # pairing) so a directive in a *later* block can't be mis-attributed.
  NGINX_NO_COMMENTS="$(sed -E 's/#.*$//' "$NGINX_INSTALLED")"
  REAL_OFF_COUNT="$(printf '%s\n' "$NGINX_NO_COMMENTS" | grep -Ec '^[[:space:]]*access_log[[:space:]]+off[[:space:]]*;' || true)"
  # awk: enter the block when the location line matches; track brace depth so
  # we leave at the block's closing brace; emit "yes" only if access_log off
  # appears INSIDE that bounded block.
  ws_block_awk='
    /location[[:space:]]*=[[:space:]]*\/ws[[:space:]]*\{/ { in_block=1; depth=1; next }
    { if (!in_block) next }
    /\{/ { depth++ }
    /\}/ { depth--; if (depth<=0) { print "no"; exit } }
    /access_log[[:space:]]+off[[:space:]]*;/ { print "yes"; exit }
  '
  appws_block_awk='
    /location[[:space:]]+~[[:space:]]*\^\/api\/apps\// { in_block=1; depth=1; next }
    { if (!in_block) next }
    /\{/ { depth++ }
    /\}/ { depth--; if (depth<=0) { print "no"; exit } }
    /access_log[[:space:]]+off[[:space:]]*;/ { print "yes"; exit }
  '
  WS_LOC_OFF="/ws location: $(printf '%s\n' "$NGINX_NO_COMMENTS" | awk "$ws_block_awk")"
  APPWS_LOC_OFF="api apps ws location: $(printf '%s\n' "$NGINX_NO_COMMENTS" | awk "$appws_block_awk")"
  if [[ "$REAL_OFF_COUNT" -ge 2 && "$WS_LOC_OFF" == *yes* && "$APPWS_LOC_OFF" == *yes* ]]; then
    report PASS "installed nginx conf keeps access_log off on both WS locations" "$REAL_OFF_COUNT real directives"
  else
    report FAIL "installed nginx conf keeps access_log off on both WS locations" \
      "real directives=$REAL_OFF_COUNT; /ws=$WS_LOC_OFF; /api/apps/*/ws=$APPWS_LOC_OFF — P0: WS auth rides ?token=<JWT>"
  fi
fi

# ── 8. Ports: 3001 free (or owned by chit-agentos), 30000-40000 firewalled-in ──
PORT_3001="$(ss -ltn 2>/dev/null | awk '$4 ~ /:3001$/ {print $1}' | head -n1)"
SERVICE_ACTIVE=0
command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet chit-agentos 2>/dev/null && SERVICE_ACTIVE=1
if [[ -z "$PORT_3001" ]]; then
  report PASS "port 3001 free"
elif [[ $SERVICE_ACTIVE -eq 1 ]]; then
  report PASS "port 3001 held by the running platform (chit-agentos active)"
else
  report FAIL "port 3001 free" \
    "held by an unrelated listener while chit-agentos is inactive — identify it via ss -ltnp and stop it"
fi
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  AGENT_RANGE_OPEN="$(ufw status | grep -Ev '(^Status|^\$)' | grep -E '3000[0-9]|300[1-9][0-9]|3[1-9][0-9]{3}' || true)"
  if [[ -z "$AGENT_RANGE_OPEN" ]]; then
    report PASS "ufw: no allow rule exposes agent IPC range 30000-40000"
  else
    report FAIL "ufw: no allow rule exposes agent IPC range 30000-40000" "an allow rule covers the range"
  fi
else
  report SKIP "agent IPC range 30000-40000 firewall check" "ufw inactive/unavailable — verify no cloud SG/security group opens the range"
fi

# ── 9. Service health (only meaningful once it is running) ───────────────
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet chit-agentos 2>/dev/null; then
  HEALTH_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE_URL/health" 2>/dev/null || echo 000)"
  if [[ "$HEALTH_CODE" == "200" ]]; then
    report PASS "GET /health → 200 (service running)"
  else
    report FAIL "GET /health → 200" "got HTTP $HEALTH_CODE"
  fi
else
  report SKIP "GET /health → 200" "service not running yet — re-run preflight after systemctl start"
fi

# ── 10. Optional integrations: SKIP (never fake PASS) when unconfigured ──
if [[ -n "$(env_value DASHSCOPE_API_KEY)" ]]; then
  report PASS "DASHSCOPE_API_KEY set (BailianSearch enabled)"
else
  report SKIP "DASHSCOPE_API_KEY set" "BailianSearch will be disabled"
fi
if [[ -n "$(env_value SKILLHUB_URL)" && -n "$(env_value SKILLHUB_TOKEN)" ]]; then
  report PASS "SKILLHUB_URL + SKILLHUB_TOKEN set (Skill Hub sync enabled)"
else
  report SKIP "SKILLHUB_URL + SKILLHUB_TOKEN set" "Skill Hub sync will be disabled"
fi

echo
if [[ "$FAILED" -ne 0 ]]; then
  echo "== preflight FAILED — fix every [FAIL] above, then re-run =="
  exit 1
fi
echo "== preflight PASSED (SKIP items listed are intentionally optional) =="
exit 0
