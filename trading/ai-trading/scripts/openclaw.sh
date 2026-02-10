#!/usr/bin/env bash
set -euo pipefail

SERVICES=(
  openclaw-market-monitor
  openclaw-trading-engine
  openclaw-dashboard-api
)

usage() {
  echo "Usage: openclaw.sh {start|stop|restart|status|logs|enable|disable}"
  echo ""
  echo "Commands:"
  echo "  start    - Start all OpenClaw services"
  echo "  stop     - Stop all OpenClaw services"
  echo "  restart  - Restart all OpenClaw services"
  echo "  status   - Show status of all services"
  echo "  logs     - Tail logs from all services (Ctrl+C to exit)"
  echo "  enable   - Enable all services to start on boot"
  echo "  disable  - Disable all services from starting on boot"
  exit 1
}

cmd_start() {
  echo "Starting OpenClaw services..."
  for svc in "${SERVICES[@]}"; do
    sudo systemctl start "$svc"
    echo "  Started $svc"
  done
  echo "All services started."
}

cmd_stop() {
  echo "Stopping OpenClaw services..."
  for svc in "${SERVICES[@]}"; do
    sudo systemctl stop "$svc" 2>/dev/null || true
    echo "  Stopped $svc"
  done
  echo "All services stopped."
}

cmd_restart() {
  echo "Restarting OpenClaw services..."
  for svc in "${SERVICES[@]}"; do
    sudo systemctl restart "$svc"
    echo "  Restarted $svc"
  done
  echo "All services restarted."
}

cmd_status() {
  echo "========================================="
  echo "  OpenClaw Service Status"
  echo "========================================="
  for svc in "${SERVICES[@]}"; do
    local state enabled
    state="$(systemctl is-active "$svc" 2>/dev/null || true)"
    enabled="$(systemctl is-enabled "$svc" 2>/dev/null || true)"
    : "${state:=unknown}" "${enabled:=unknown}"
    printf "  %-35s %-10s boot: %s\n" "$svc" "$state" "$enabled"
  done
  echo "========================================="
}

cmd_logs() {
  echo "Tailing OpenClaw logs (Ctrl+C to exit)..."
  local units=""
  for svc in "${SERVICES[@]}"; do
    units="$units -u $svc"
  done
  sudo journalctl $units -f --no-hostname
}

cmd_enable() {
  echo "Enabling OpenClaw services for boot..."
  for svc in "${SERVICES[@]}"; do
    sudo systemctl enable "$svc"
    echo "  Enabled $svc"
  done
  echo "All services enabled."
}

cmd_disable() {
  echo "Disabling OpenClaw services from boot..."
  for svc in "${SERVICES[@]}"; do
    sudo systemctl disable "$svc"
    echo "  Disabled $svc"
  done
  echo "All services disabled."
}

if [[ $# -lt 1 ]]; then
  usage
fi

case "$1" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_restart ;;
  status)  cmd_status ;;
  logs)    cmd_logs ;;
  enable)  cmd_enable ;;
  disable) cmd_disable ;;
  *)       usage ;;
esac
