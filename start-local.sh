#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# PoCW — local development stack
# Starts: FalkorDB · Redis · Anvil chain · deploys contracts · Oracle service
#         Otterscan block explorer (Docker)
#
# Usage:  ./start-local.sh
# Stop:   Ctrl+C  (cleans up only what this script started)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$ROOT/.logs"
mkdir -p "$LOG_DIR"

# ── Colours ───────────────────────────────────────────────────────────────────
G='\033[0;32m'; Y='\033[1;33m'; B='\033[0;34m'; R='\033[0;31m'; N='\033[0m'
log()  { echo -e "${G}✔${N}  $1"; }
info() { echo -e "${B}→${N}  $1"; }
warn() { echo -e "${Y}⚠${N}  $1"; }
skip() { echo -e "${Y}↷${N}  $1"; }
die()  { echo -e "${R}✘${N}  $1"; exit 1; }

banner() {
  echo ""
  echo -e "${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
  echo -e "${B}  PoCW local stack — all services running${N}"
  echo -e "${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
  echo -e "  Anvil RPC     ${G}http://127.0.0.1:8545${N}  (chain 31337)"
  echo -e "  Oracle API    ${G}http://localhost:3000${N}"
  echo -e "  Otterscan     ${G}http://localhost:5100${N}"
  echo -e "  Frontend      run  ${Y}cd ../PoCW-WEB && npm run dev${N}  (port 3001)"
  echo -e "${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
  echo -e "  Logs in ${Y}.logs/${N}  •  ${Y}Ctrl+C${N} to stop what this script started"
  echo ""

  # Display Anvil test accounts (only the startup section, before RPC traffic)
  if [ -f "$LOG_DIR/anvil.log" ]; then
    local acct_line key_line
    acct_line=$(grep -n "^Available Accounts" "$LOG_DIR/anvil.log" | head -1 | cut -d: -f1)
    key_line=$(grep -n "^Private Keys" "$LOG_DIR/anvil.log" | head -1 | cut -d: -f1)

    if [ -n "$acct_line" ] && [ -n "$key_line" ]; then
      echo -e "${B}━━ Anvil Test Accounts ━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
      echo -e "  ${Y}#   Address${N}                                          ${Y}Private Key${N}"
      echo -e "  ${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"

      # Extract addresses (between Available Accounts and Private Keys)
      local -a addrs=()
      while IFS= read -r line; do
        local addr=$(echo "$line" | sed -n 's/.*\(0x[0-9a-fA-F]\{40\}\).*/\1/p')
        if [ -n "$addr" ]; then
          addrs+=("$addr")
        fi
      done < <(sed -n "${acct_line},${key_line}p" "$LOG_DIR/anvil.log")

      # Extract keys (10 lines after Private Keys header)
      local -a keys=()
      local keys_start=$((key_line + 3))
      local keys_end=$((key_line + 12))
      while IFS= read -r line; do
        local key=$(echo "$line" | sed -n 's/.*\(0x[0-9a-fA-F]\{64\}\).*/\1/p')
        if [ -n "$key" ]; then
          keys+=("$key")
        fi
      done < <(sed -n "${keys_start},${keys_end}p" "$LOG_DIR/anvil.log")

      local count=${#addrs[@]}
      for ((i=0; i<count; i++)); do
        printf "  ${G}%2d${N}  ${addrs[$i]}  ${Y}%s${N}\n" "$i" "${keys[$i]:-???}"
      done
      echo ""
    fi
  fi
}

# ── Port helpers ──────────────────────────────────────────────────────────────
port_in_use() { nc -z 127.0.0.1 "$1" 2>/dev/null; }

wait_for_port() {
  local port=$1 label=$2
  for i in $(seq 1 30); do
    if port_in_use "$port"; then return 0; fi
    if [ "$i" -eq 30 ]; then die "$label failed to start — check .logs/"; fi
    sleep 1
  done
}

# ── Track compose files we started (for cleanup on Ctrl+C) ────────────────────
STARTED_PIDS=()
STARTED_COMPOSE_FILES=()  # full paths to docker-compose files we launched

cleanup() {
  echo ""
  info "Stopping services started by this script..."
  if [ ${#STARTED_PIDS[@]} -gt 0 ]; then
    for pid in "${STARTED_PIDS[@]}"; do
      kill "$pid" 2>/dev/null || true
    done
  fi
  # Tear down docker-compose projects (networks, volumes, containers)
  if [ ${#STARTED_COMPOSE_FILES[@]} -gt 0 ]; then
    for compose_file in "${STARTED_COMPOSE_FILES[@]}"; do
      docker compose -f "$compose_file" down 2>/dev/null || true
    done
  fi
  # Stop Otterscan container (single container, not compose)
  docker rm -f pocw-otterscan 2>/dev/null || true
  log "Done."
}
trap cleanup EXIT INT TERM

# ── Prerequisites ─────────────────────────────────────────────────────────────
for cmd in node npm docker; do
  command -v "$cmd" >/dev/null 2>&1 || die "$cmd not found — please install it first"
done
# Anvil (Foundry) — check PATH first, then known install location
if command -v anvil >/dev/null 2>&1; then
  ANVIL_BIN="anvil"
elif [ -x "$HOME/.foundry/bin/anvil" ]; then
  ANVIL_BIN="$HOME/.foundry/bin/anvil"
else
  die "Anvil not found — run: curl -L https://foundry.paradigm.xyz | bash && foundryup"
fi
docker info >/dev/null 2>&1 || die "Docker daemon not running — start Docker Desktop first"

# ── .env check ────────────────────────────────────────────────────────────────
[ -f "$ROOT/.env" ] || die ".env not found — copy .env.example and fill in your keys"

# shellcheck disable=SC1091
set -o allexport
source "$ROOT/.env"
set +o allexport

[ -n "${ORACLE_PRIVATE_KEY:-}" ] || die "ORACLE_PRIVATE_KEY not set in .env"
[ -n "${OPENROUTER_API_KEY:-}" ] || warn "OPENROUTER_API_KEY not set — LLM calls will fail"

# ── Install dependencies ──────────────────────────────────────────────────────
info "Checking dependencies..."
[ -d "$ROOT/node_modules" ]                || npm install --prefix "$ROOT" --silent
[ -d "$ROOT/oracle-service/node_modules" ] || npm install --prefix "$ROOT/oracle-service" --silent
log "Dependencies OK"

# ── Compile contracts ─────────────────────────────────────────────────────────
info "Compiling contracts..."
cd "$ROOT"
npx hardhat compile --quiet 2>&1 | grep -v "^$" || true
log "Contracts compiled"

# ── Docker infra (FalkorDB + Redis) ───────────────────────────────────────────
info "Starting FalkorDB and Redis..."
docker compose -f "$ROOT/docker-compose.yml" up -d falkordb redis \
  --remove-orphans >/dev/null 2>&1
STARTED_COMPOSE_FILES+=("$ROOT/docker-compose.yml")
log "FalkorDB and Redis running"

# ── Anvil chain ───────────────────────────────────────────────────────────────
if port_in_use 8545; then
  skip "Anvil already running on :8545 — skipping start, skipping deploy"
  ANVIL_ALREADY_RUNNING=true
else
  info "Starting Anvil (chain 31337)..."
  "$ANVIL_BIN" --chain-id 31337 --port 8545 --host 0.0.0.0 \
    > "$LOG_DIR/anvil.log" 2>&1 &
  ANVIL_PID=$!
  STARTED_PIDS+=("$ANVIL_PID")
  wait_for_port 8545 "Anvil"
  log "Anvil ready  (log: .logs/anvil.log)"
  ANVIL_ALREADY_RUNNING=false
fi

# ── Deploy contracts ──────────────────────────────────────────────────────────
if [ "$ANVIL_ALREADY_RUNNING" = false ]; then
  info "Deploying contracts to localhost..."
  npx hardhat run scripts/deploy.ts --network localhost \
    > "$LOG_DIR/deploy.log" 2>&1
  log "Contracts deployed  (log: .logs/deploy.log)"
  if [ -f "$ROOT/deployments/localhost.json" ]; then
    CTRL=$(node -e "console.log(require('./deployments/localhost.json').controllerAddress)")
    SBT=$(node  -e "console.log(require('./deployments/localhost.json').sbtAddress)")
    echo -e "     Controller  ${G}${CTRL}${N}"
    echo -e "     SBT         ${G}${SBT}${N}"
  fi
fi

# ── Oracle service ────────────────────────────────────────────────────────────
if port_in_use 3000; then
  skip "Oracle service already running on :3000 — skipping"
else
  info "Starting Oracle service..."
  cd "$ROOT/oracle-service"
  npm run dev > "$LOG_DIR/oracle.log" 2>&1 &
  ORACLE_PID=$!
  STARTED_PIDS+=("$ORACLE_PID")
  cd "$ROOT"
  wait_for_port 3000 "Oracle service"
  log "Oracle service ready  (log: .logs/oracle.log)"
fi

# ── Otterscan ─────────────────────────────────────────────────────────────────
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^pocw-otterscan$'; then
  skip "Otterscan already running — skipping"
elif port_in_use 5100; then
  skip "Port 5100 already in use — skipping Otterscan"
else
  docker rm -f pocw-otterscan >/dev/null 2>&1 || true
  info "Starting Otterscan (block explorer)..."
  docker run -d --name pocw-otterscan -p 5100:80 \
    -e ERIGON_URL="http://localhost:8545" \
    otterscan/otterscan:latest \
    >/dev/null 2>&1 \
    && { log "Otterscan ready  (http://localhost:5100)"; } \
    || warn "Otterscan failed to start — skipping"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
banner

# Keep running so Ctrl+C triggers cleanup
if [ ${#STARTED_PIDS[@]} -gt 0 ]; then
  wait "${STARTED_PIDS[0]}" 2>/dev/null || true
else
  echo -e "  ${Y}Nothing was started by this script — all services were already running.${N}"
fi
