#!/usr/bin/env bash
# KubeEZ Gateway Agent installer (Linux / macOS)
#
#   curl -sfL "<kubeez>/agent-install.sh" | bash -s -- --token T --agent-id A --server wss://…
#
# Installs to ~/.kubeez-agent, saves the connection settings there (config.json,
# readable only by you) and runs the agent as a SERVICE, so it comes back after
# reboots and crashes — no new token needed:
#   Linux, root or passwordless sudo  → systemd service "kubeez-agent" (starts at boot)
#   Linux, no sudo                    → systemd user service (+ linger when allowed)
#   macOS                             → launchd agent
#   anything else                     → background process + cron (@reboot, every 5 min)
# Safe to run again: it replaces the running agent — never two copies.
set -euo pipefail

TOKEN=""; AGENT_ID=""; SERVER=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --token) TOKEN="${2:-}"; shift 2 ;;
    --agent-id) AGENT_ID="${2:-}"; shift 2 ;;
    --server) SERVER="${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done
if [ -z "$TOKEN" ] || [ -z "$AGENT_ID" ] || [ -z "$SERVER" ]; then
  echo "ERROR: missing --token, --agent-id or --server (copy the full command from the KubeEZ Tunnels page)"
  exit 1
fi

say() { echo "[KubeEZ Gateway] $*"; }
AGENT_DIR="$HOME/.kubeez-agent"
SERVICE=kubeez-agent
mkdir -p "$AGENT_DIR"; chmod 700 "$AGENT_DIR"; cd "$AGENT_DIR"

# ── Node.js (system node ≥ 16, otherwise a portable copy) ────────────────────
NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -n "$NODE_BIN" ] && [ "$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 16 ]; then NODE_BIN=""; fi
if [ -z "$NODE_BIN" ]; then
  if [ ! -x "$AGENT_DIR/bin/node" ]; then
    say "Node.js not found — downloading a portable copy..."
    OS=$(uname -s | tr '[:upper:]' '[:lower:]'); ARCH=$(uname -m)
    case "$ARCH" in x86_64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; esac
    NODE_VER=v18.20.2; NODE_DIR="node-$NODE_VER-$OS-$ARCH"
    curl -sfL -o node.tar.gz "https://nodejs.org/dist/$NODE_VER/$NODE_DIR.tar.gz" || { echo "ERROR: could not download Node.js for $OS-$ARCH"; exit 1; }
    tar -xzf node.tar.gz && mkdir -p bin && mv "$NODE_DIR/bin/node" bin/node && rm -rf "$NODE_DIR" node.tar.gz
  fi
  NODE_BIN="$AGENT_DIR/bin/node"
fi

# ── Agent + settings ─────────────────────────────────────────────────────────
HOST_URL=$(echo "$SERVER" | sed 's|^wss|https|; s|^ws|http|')
curl -sfL "$HOST_URL/agent-bundle.js" -o agent-bundle.js.new || { echo "ERROR: could not download the agent from $HOST_URL"; exit 1; }
mv -f agent-bundle.js.new agent-bundle.js
# The bundle is CommonJS — pin it, so a package.json with "type":"module" in a
# parent folder (e.g. $HOME) cannot make Node load it as an ES module.
echo '{"type":"commonjs"}' > package.json
json() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
( umask 077; printf '{"token":"%s","agentId":"%s","server":"%s"}\n' "$(json "$TOKEN")" "$(json "$AGENT_ID")" "$(json "$SERVER")" > config.json )
RUN_ARGS="$AGENT_DIR/agent-bundle.js --config $AGENT_DIR/config.json"

# ── Stop any earlier copy (re-install / upgrade) ─────────────────────────────
SUDO=""
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then SUDO="sudo"; fi
CAN_ROOT=false; { [ "$(id -u)" -eq 0 ] || [ -n "$SUDO" ]; } && CAN_ROOT=true
if command -v systemctl >/dev/null 2>&1; then
  $CAN_ROOT && $SUDO systemctl stop "$SERVICE" 2>/dev/null || true
  systemctl --user stop "$SERVICE" 2>/dev/null || true
fi
[ "$(uname -s)" = Darwin ] && launchctl unload "$HOME/Library/LaunchAgents/com.kubeez.agent.plist" 2>/dev/null || true
[ -f agent.pid ] && kill "$(cat agent.pid)" 2>/dev/null || true
pkill -f "$AGENT_DIR/agent-bundle.js" 2>/dev/null || true
sleep 1

MODE=""
# ── macOS: launchd ───────────────────────────────────────────────────────────
if [ "$(uname -s)" = Darwin ]; then
  PLIST="$HOME/Library/LaunchAgents/com.kubeez.agent.plist"; mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.kubeez.agent</string>
  <key>ProgramArguments</key><array>
    <string>$NODE_BIN</string><string>$AGENT_DIR/agent-bundle.js</string>
    <string>--config</string><string>$AGENT_DIR/config.json</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>$AGENT_DIR/agent.log</string>
  <key>StandardErrorPath</key><string>$AGENT_DIR/agent.log</string>
</dict></plist>
EOF
  launchctl load -w "$PLIST" && MODE=launchd
fi

# ── Linux: systemd ───────────────────────────────────────────────────────────
UNIT="[Unit]
Description=KubeEZ Gateway Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$NODE_BIN $RUN_ARGS
Restart=always
RestartSec=5
# 78 = removed in KubeEZ: do not restart a revoked agent
RestartPreventExitStatus=78"
if [ -z "$MODE" ] && [ -d /run/systemd/system ]; then
  if $CAN_ROOT; then
    printf '%s\nUser=%s\n\n[Install]\nWantedBy=multi-user.target\n' "$UNIT" "$(id -un)" | $SUDO tee /etc/systemd/system/$SERVICE.service >/dev/null
    $SUDO systemctl daemon-reload && $SUDO systemctl enable --now "$SERVICE" >/dev/null 2>&1 && MODE=systemd
  elif systemctl --user show-environment >/dev/null 2>&1; then
    mkdir -p "$HOME/.config/systemd/user"
    printf '%s\n\n[Install]\nWantedBy=default.target\n' "$UNIT" > "$HOME/.config/systemd/user/$SERVICE.service"
    systemctl --user daemon-reload && systemctl --user enable --now "$SERVICE" >/dev/null 2>&1 && MODE=systemd-user
    loginctl enable-linger "$(id -un)" 2>/dev/null || LINGER_WARN=1
  fi
fi

# ── Anything else: background process + cron watchdog ────────────────────────
if [ -z "$MODE" ]; then
  # [a]gent: the pattern must not match this cron command line itself
  START="pgrep -f '$AGENT_DIR/[a]gent-bundle.js' >/dev/null || nohup $NODE_BIN $RUN_ARGS >> $AGENT_DIR/agent.log 2>&1 &"
  nohup $NODE_BIN $RUN_ARGS >> agent.log 2>&1 &
  echo $! > agent.pid
  MODE=background
  if command -v crontab >/dev/null 2>&1; then
    ( crontab -l 2>/dev/null | grep -v 'kubeez-agent' || true
      echo "@reboot $START # kubeez-agent"
      echo "*/5 * * * * $START # kubeez-agent" ) | crontab - && MODE=cron
  fi
fi

# ── Verify ───────────────────────────────────────────────────────────────────
for _ in $(seq 1 15); do pgrep -f "$AGENT_DIR/agent-bundle.js" >/dev/null && break; sleep 1; done
if ! pgrep -f "$AGENT_DIR/agent-bundle.js" >/dev/null; then
  echo "ERROR: the agent did not start. Last log lines:"
  { journalctl -u "$SERVICE" -n 15 --no-pager 2>/dev/null || tail -15 "$AGENT_DIR/agent.log" 2>/dev/null; } | sed 's/^/   /'
  exit 1
fi

echo "=========================================================="
echo " [SUCCESS] KubeEZ Gateway Agent is running ($MODE)"
case "$MODE" in
  systemd)      echo " Starts at boot and restarts by itself after a crash."
                echo " Logs:    journalctl -u $SERVICE -f"
                echo " Restart: sudo systemctl restart $SERVICE" ;;
  systemd-user) echo " Restarts by itself after a crash."
                [ -n "${LINGER_WARN:-}" ] && echo " To also start at boot (without logging in), an admin runs: sudo loginctl enable-linger $(id -un)"
                echo " Logs:    journalctl --user -u $SERVICE -f" ;;
  launchd)      echo " Starts at login and restarts by itself after a crash."
                echo " Logs:    tail -f $AGENT_DIR/agent.log" ;;
  cron)         echo " Started again at boot and checked every 5 minutes (cron)."
                echo " Logs:    tail -f $AGENT_DIR/agent.log" ;;
  *)            echo " WARNING: no service manager found — it will NOT start after a reboot."
                echo " Run this installer with sudo for a boot-time service."
                echo " Logs:    tail -f $AGENT_DIR/agent.log" ;;
esac
echo " Running this command again is safe (it replaces the agent)."
echo "=========================================================="
