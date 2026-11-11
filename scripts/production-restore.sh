#!/usr/bin/env bash
# Task 4 — restore a backup produced by production-backup.sh (format=2:
# full data dir + skills dir + plugins dir + agent named volumes).
# STAGING-ONLY by design. Five fail-closed guards run BEFORE any write:
#   0. Docker daemon MUST be reachable (else volume/container queries are
#      silent and get mis-read as "no conflict" → half-restored state);
#   1. target data dir must be EMPTY (no DB, no JSON configs, no user-memory);
#   2. no same-name agent volumes may exist; target skills + plugins dirs
#      must be absent or empty;
#   3. chit-agentos service must not be running;
#   4. no agent containers may be running (docker ps errors also refuse).
# Volumes are restored under their ORIGINAL names. The script never uses
# --force, never deletes conflicting state, and exits non-zero instead.
#
# Usage:
#   sudo bash scripts/production-restore.sh <backup.tar.gz> \
#        [--data-dir /var/lib/chit-agentos/data] \
#        [--skills-dir /var/lib/chit-agentos/skills] \
#        [--plugins-dir /var/lib/chit-agentos/plugins]

set -uo pipefail

DATA_DIR="${DATA_DIR:-/var/lib/chit-agentos/data}"
SKILLS_DIR="${SKILLS_DIR:-/var/lib/chit-agentos/skills}"
PLUGINS_DIR="${PLUGINS_DIR:-/var/lib/chit-agentos/plugins}"

if [[ $# -lt 1 || "$1" == --* ]]; then
  echo "usage: $0 <backup.tar.gz> [--data-dir DIR] [--skills-dir DIR] [--plugins-dir DIR]" >&2
  exit 2
fi
BACKUP_FILE="$1"; shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    --data-dir)    DATA_DIR="$2"; shift 2 ;;
    --skills-dir)  SKILLS_DIR="$2"; shift 2 ;;
    --plugins-dir) PLUGINS_DIR="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

die() { echo "RESTORE REFUSED: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "must run as root (sudo)"
[[ -f "$BACKUP_FILE" ]] || die "backup file not found: $BACKUP_FILE"

echo "── Pre-flight guards (staging-only tool; all four must pass) ──"

# Guard 0: Docker daemon MUST be reachable (round-5 fail-closed). Without
# this, `docker volume inspect` / `docker ps` failures below are silent
# (stderr suppressed) and get mis-read as "no conflict / no containers",
# then the script writes data/skills/plugins before finally failing at
# volume creation — leaving a half-restored state. Refuse up front instead.
if ! command -v docker >/dev/null 2>&1; then
  die "guard 0: docker CLI not found — cannot verify volume/container state; refusing to restore"
fi
if ! docker info >/dev/null 2>&1; then
  die "guard 0: docker daemon unreachable — cannot verify volume/container state; refusing to restore (start docker first)"
fi
echo "  [ok] guard 0: docker daemon reachable"

# Guard 1: target data dir must be completely EMPTY.
mkdir -p "$DATA_DIR"
if [[ -n "$(ls -A "$DATA_DIR" 2>/dev/null)" ]]; then
  die "guard 1: target data dir is not empty: $DATA_DIR — restore requires an EMPTY target (refusing to overwrite)"
fi
echo "  [ok] guard 1: target data dir is empty"

# Guard 2: no same-name agent volumes; skills target absent or empty.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
tar -xzf "$BACKUP_FILE" -C "$STAGE" || die "cannot read archive"
[[ -f "$STAGE/manifest.txt" ]] || die "archive has no manifest.txt — not a chit-agentos backup?"

CLASH=0
while IFS= read -r v; do
  [[ -z "$v" ]] && continue
  if docker volume inspect "$v" >/dev/null 2>&1; then
    echo "  [!!] conflicting volume exists: $v" >&2
    CLASH=1
  fi
done <<<"$(grep '^volumes=' "$STAGE/manifest.txt" | cut -d= -f2- | tr ',' '\n')"
[[ $CLASH -eq 0 ]] || die "guard 2: same-name volumes exist (listed above) — refusing"
if [[ -d "$STAGE/skills" ]] && [[ -n "$(ls -A "$SKILLS_DIR" 2>/dev/null)" ]]; then
  die "guard 2: skills target not empty: $SKILLS_DIR — refusing to overwrite"
fi
if [[ -d "$STAGE/plugins" ]] && [[ -n "$(ls -A "$PLUGINS_DIR" 2>/dev/null)" ]]; then
  die "guard 2: plugins target not empty: $PLUGINS_DIR — refusing to overwrite"
fi
echo "  [ok] guard 2: no same-name volumes; skills + plugins targets clean"

# Guard 3: service must not be running.
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet chit-agentos 2>/dev/null; then
  die "guard 3: chit-agentos is running — systemctl stop chit-agentos first"
fi
echo "  [ok] guard 3: chit-agentos not running"

# Guard 4: no agent containers. Fail-closed (round-5): a `docker ps` error
# (daemon down mid-run) must NOT be read as "no containers". Capture exit
# status; empty output + exit 0 = genuinely no containers; non-zero = refuse.
LEFT_OUTPUT="$(docker ps -q --filter label=app=eaos-agent 2>/dev/null)"
DOCKER_PS_EXIT=$?
if [[ $DOCKER_PS_EXIT -ne 0 ]]; then
  die "guard 4: docker ps failed (exit $DOCKER_PS_EXIT) — cannot verify container state; refusing to restore"
fi
[[ -z "$LEFT_OUTPUT" ]] || die "guard 4: agent containers running — stop them first"
echo "  [ok] guard 4: no agent containers"

echo "── Restoring ──"

[[ -d "$STAGE/data" ]] || die "archive contains no data/ directory — wrong format? (expect format=2)"
cp -a "$STAGE/data/." "$DATA_DIR/" || die "failed to restore data dir into $DATA_DIR"
echo "  data dir restored: $(ls -1 "$DATA_DIR" | wc -l) entries"

if [[ -d "$STAGE/skills" ]]; then
  mkdir -p "$SKILLS_DIR"
  cp -a "$STAGE/skills/." "$SKILLS_DIR/" || die "failed to restore skills dir"
  echo "  skills dir restored: $(ls -1 "$SKILLS_DIR" | wc -l) entries"
else
  echo "  (archive contains no skills/ directory — skipped)"
fi

if [[ -d "$STAGE/plugins" ]]; then
  mkdir -p "$PLUGINS_DIR"
  cp -a "$STAGE/plugins/." "$PLUGINS_DIR/" || die "failed to restore plugins dir"
  echo "  plugins dir restored: $(ls -1 "$PLUGINS_DIR" | wc -l) entries"
else
  echo "  (archive contains no plugins/ directory — skipped)"
fi

VOL_RESTORED=0
if compgen -G "$STAGE/volumes/*.tar.gz" >/dev/null; then
  mkdir -p "$STAGE/restore"
  cp "$STAGE"/volumes/*.tar.gz "$STAGE/restore/"
fi
shopt -s nullglob
for vtgz in "$STAGE/restore/"*.tar.gz; do
  v="$(basename "$vtgz" .tar.gz)"
  docker volume create "$v" >/dev/null || die "failed to create volume $v"
  docker run --rm -v "$v:/volume" -v "$STAGE/restore:/src:ro" \
    alpine:3 sh -c "tar -xzf /src/$(basename "$vtgz") -C /volume" \
    || die "failed to extract volume $v"
  echo "  volume restored: $v"
  VOL_RESTORED=$((VOL_RESTORED+1))
done
shopt -u nullglob

echo "── Manifest ──"
cat "$STAGE/manifest.txt"
echo
echo "RESTORE OK: data dir + skills + plugins + $VOL_RESTORED volume(s) under original names."
echo "Next: systemctl start chit-agentos && curl http://127.0.0.1:3001/health (runbook §6)."
exit 0
