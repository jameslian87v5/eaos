#!/usr/bin/env bash
# Task 4 — production backup: FULL platform runtime state, consistent
# (service stopped during snapshot), never destructive.
#
# Covers (review P0.2): the entire data dir (SQLite DB + WAL/SHM + all
# runtime JSON configs: entitlements / agent activation / skills / mcp /
# hook-plugins / prompt-settings / runtime-settings / sync state + host-side
# user-memory files), the installed skills package dir, and EVERY agent
# named volume (agent-workspace-*, agent-claude-home-*, agent-user-memory-*).
#
# Secrets: JWT/provider keys live ONLY in /etc/chit-agentos/prod.env, which
# this script never reads or archives. If a real secret ever lands inside
# DATA_DIR or SKILLS_DIR, that is a bug to fix BEFORE backing up.
#
# Failure semantics (review P1.1): any staging/archive/restart/health failure
# exits non-zero; an archive with the same name is NEVER overwritten; old
# backups are never deleted.

set -uo pipefail

ENV_FILE="${ENV_FILE:-/etc/chit-agentos/prod.env}"
APP_DIR="${APP_DIR:-/opt/chit-agentos/current}"
DATA_DIR="${DATA_DIR:-/var/lib/chit-agentos/data}"
SKILLS_DIR="${SKILLS_DIR:-/var/lib/chit-agentos/skills}"
PLUGINS_DIR="${PLUGINS_DIR:-/var/lib/chit-agentos/plugins}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/chit-agentos}"
BASE_URL="http://127.0.0.1:3001"
VOLUME_PREFIXES=("agent-workspace-" "agent-claude-home-" "agent-user-memory-")

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)    ENV_FILE="$2"; shift 2 ;;
    --app-dir)     APP_DIR="$2"; shift 2 ;;
    --data-dir)    DATA_DIR="$2"; shift 2 ;;
    --skills-dir)  SKILLS_DIR="$2"; shift 2 ;;
    --plugins-dir) PLUGINS_DIR="$2"; shift 2 ;;
    --backup-dir)  BACKUP_DIR="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

die() { echo "BACKUP FAILED: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "must run as root (sudo)"
[[ -d "$DATA_DIR" ]] || die "data dir not found: $DATA_DIR (runbook §2)"
mkdir -p "$BACKUP_DIR" || die "cannot create backup dir: $BACKUP_DIR"

service_installed() {
  command -v systemctl >/dev/null 2>&1 && \
    systemctl list-unit-files 2>/dev/null | grep -q '^chit-agentos\.service'
}
start_service() {  # hard-fail wrapper (P1.1: restart failure must be fatal)
  service_installed && systemctl start chit-agentos
}

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/chit-agentos-backup-$STAMP.tar.gz"
[[ ! -e "$OUT" ]] || die "refusing to overwrite existing archive: $OUT (same-second rerun)"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/volumes"

echo "[1/6] stopping chit-agentos ..."
WAS_RUNNING=0
if ! service_installed; then
  die "chit-agentos.service unit not installed — cannot safely stop/start; install the unit first (runbook §4)"
fi
if systemctl is-active --quiet chit-agentos 2>/dev/null; then
  WAS_RUNNING=1
  systemctl stop chit-agentos || die "cannot stop chit-agentos — aborting BEFORE touching data"
else
  echo "  service not running (clean or already stopped)"
fi

echo "[2/6] verifying no agent containers remain ..."
# Hard-fail if docker itself is unreachable (review P1.4): a query failure must
# not be mistaken for "no containers running".
if ! docker ps >/dev/null 2>&1; then
  [[ $WAS_RUNNING -eq 1 ]] && start_service || true
  die "docker ps failed (daemon down?) — cannot verify no agent containers are running"
fi
LEFT="$(docker ps -q --filter label=app=eaos-agent 2>/dev/null)"
if [[ -n "$LEFT" ]]; then
  [[ $WAS_RUNNING -eq 1 ]] && start_service || true
  die "agent containers still running after service stop — stop them and retry"
fi

echo "[3/6] staging full data dir: $DATA_DIR ..."
cp -a "$DATA_DIR" "$STAGE/data" || { [[ $WAS_RUNNING -eq 1 ]] && start_service || true; die "failed to stage data dir"; }
DB_SEEN=0
# eaos.db is the post-rename name; a data dir not yet booted into the new code
# may still carry chatapp.db — accept either.
[[ -f "$STAGE/data/eaos.db" || -f "$STAGE/data/chatapp.db" ]] && DB_SEEN=1
[[ $DB_SEEN -eq 1 ]] || { [[ $WAS_RUNNING -eq 1 ]] && start_service || true; die "data dir staged but eaos.db missing — is DATA_DIR correct?"; }

echo "[4/6] staging skills + plugins dirs + agent named volumes ..."
SKILLS_SEEN=0
if [[ -d "$SKILLS_DIR" ]]; then
  cp -a "$SKILLS_DIR" "$STAGE/skills" || { [[ $WAS_RUNNING -eq 1 ]] && start_service || true; die "failed to stage skills dir"; }
  SKILLS_SEEN=1
fi
PLUGINS_SEEN=0
if [[ -d "$PLUGINS_DIR" ]]; then
  cp -a "$PLUGINS_DIR" "$STAGE/plugins" || { [[ $WAS_RUNNING -eq 1 ]] && start_service || true; die "failed to stage plugins dir"; }
  PLUGINS_SEEN=1
fi

VOL_COUNT=0
VOLUME_LIST=""
VOL_RAW="$(docker volume ls --format '{{.Name}}' 2>/dev/null)" \
  || { [[ $WAS_RUNNING -eq 1 ]] && start_service || true; die "docker volume ls failed"; }
while IFS= read -r v; do
  [[ -z "$v" ]] && continue
  echo "  volume: $v"
  docker run --rm -v "$v:/volume:ro" -v "$STAGE:/stage" \
    alpine:3 tar -czf "/stage/volumes/$v.tar.gz" -C /volume . >/dev/null 2>&1 \
    || { [[ $WAS_RUNNING -eq 1 ]] && start_service || true; die "failed to archive volume $v"; }
  VOL_COUNT=$((VOL_COUNT+1))
  VOLUME_LIST="${VOLUME_LIST:+$VOLUME_LIST,}$v"
done < <(awk -v p1="${VOLUME_PREFIXES[0]}" -v p2="${VOLUME_PREFIXES[1]}" -v p3="${VOLUME_PREFIXES[2]}" \
           'index($0,p1)==1 || index($0,p2)==1 || index($0,p3)==1' <<<"$VOL_RAW")

GIT_REV="unknown"
git -C "$APP_DIR" rev-parse HEAD >/dev/null 2>&1 && GIT_REV="$(git -C "$APP_DIR" rev-parse HEAD)"

# Manifest write is a hard dependency (review P1.4) — an unwritten manifest
# would make the archive unrestorable / unauditable.
{
  echo "format=2"
  echo "backup_utc=$STAMP"
  echo "git_revision=$GIT_REV"
  echo "data_dir=$DATA_DIR"
  echo "skills_dir=$SKILLS_DIR"
  echo "skills_included=$SKILLS_SEEN"
  echo "plugins_dir=$PLUGINS_DIR"
  echo "plugins_included=$PLUGINS_SEEN"
  echo "volume_count=$VOL_COUNT"
  echo "volumes=$VOLUME_LIST"
} > "$STAGE/manifest.txt" || { [[ $WAS_RUNNING -eq 1 ]] && start_service || true; die "failed to write manifest.txt"; }
[[ -s "$STAGE/manifest.txt" ]] || { [[ $WAS_RUNNING -eq 1 ]] && start_service || true; die "manifest.txt is empty"; }

tar -czf "$OUT" -C "$STAGE" . \
  || { [[ $WAS_RUNNING -eq 1 ]] && start_service || true; die "failed to write archive $OUT"; }
[[ -s "$OUT" ]] || { [[ $WAS_RUNNING -eq 1 ]] && start_service || true; die "archive is empty: $OUT"; }

echo "[5/6] restarting chit-agentos ..."
if [[ $WAS_RUNNING -eq 1 ]]; then
  start_service || die "failed to restart chit-agentos after backup — manual intervention required"
else
  echo "  service was not running before backup; leaving it stopped"
fi

echo "[6/6] health check ..."
if [[ $WAS_RUNNING -eq 1 ]]; then
  sleep 3
  HEALTH_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE_URL/health" 2>/dev/null || echo 000)"
  [[ "$HEALTH_CODE" == "200" ]] || die "/health returned $HEALTH_CODE after restart — check journalctl -u chit-agentos"
  echo "  /health → 200 OK"
fi

echo "BACKUP OK: $OUT"
echo "  size: $(du -h "$OUT" | cut -f1)   data dir: yes   skills: $SKILLS_SEEN   volumes: $VOL_COUNT   git: $GIT_REV"
echo "  (old backups are never touched or overwritten by this script)"
exit 0
