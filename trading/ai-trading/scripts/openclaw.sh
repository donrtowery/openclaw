#!/bin/bash
# OpenClaw v2 Management Script

set -e

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SERVICES=("openclaw-engine" "openclaw-api")
TIMER="openclaw-learning.timer"
PROJECT_DIR="/home/don/openclaw/trading/ai-trading"
LOG_DIR="$PROJECT_DIR/logs"

check_service() {
    if systemctl is-active --quiet "$1" 2>/dev/null; then
        echo -e "  ${GREEN}✅ $1: active${NC}"
    else
        echo -e "  ${RED}❌ $1: inactive${NC}"
    fi
}

check_timer() {
    if systemctl is-active --quiet "$1" 2>/dev/null; then
        local next=$(systemctl show "$1" --property=NextElapseUSecRealtime --value 2>/dev/null)
        echo -e "  ${BLUE}⏰ $1: active${NC} (next: $next)"
    else
        echo -e "  ${RED}❌ $1: inactive${NC}"
    fi
}

cmd_start() {
    echo -e "${GREEN}Starting OpenClaw services...${NC}"
    for svc in "${SERVICES[@]}"; do
        sudo systemctl start "$svc"
        echo "  Started $svc"
    done
    sudo systemctl start "$TIMER"
    echo "  Started $TIMER"
    echo -e "${GREEN}All services started.${NC}"
}

cmd_stop() {
    echo -e "${YELLOW}Stopping OpenClaw services...${NC}"
    for svc in "${SERVICES[@]}"; do
        sudo systemctl stop "$svc" 2>/dev/null || true
        echo "  Stopped $svc"
    done
    sudo systemctl stop "$TIMER" 2>/dev/null || true
    echo "  Stopped $TIMER"
    echo -e "${YELLOW}All services stopped.${NC}"
}

cmd_restart() {
    cmd_stop
    sleep 2
    cmd_start
}

cmd_status() {
    echo -e "\n${BLUE}=== OpenClaw v2 Status ===${NC}\n"

    echo "Services:"
    for svc in "${SERVICES[@]}"; do
        check_service "$svc"
    done
    check_timer "$TIMER"

    echo ""
    echo "Database:"
    local symbols=$(cd "$PROJECT_DIR" && node --input-type=module -e "
import { query } from './db/connection.js';
const r = await query('SELECT COUNT(*) as c FROM symbols WHERE is_active = true');
const p = await query(\"SELECT COUNT(*) as c FROM positions WHERE status = 'OPEN'\");
const e = await query('SELECT COUNT(*) as c FROM trade_events WHERE posted_to_discord = false');
console.log(r.rows[0].c + ' symbols | ' + p.rows[0].c + ' open positions | ' + e.rows[0].c + ' pending events');
process.exit(0);
" 2>/dev/null || echo "unavailable")
    echo -e "  ${GREEN}📊 $symbols${NC}"

    echo ""
    echo "API:"
    local health=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/health 2>/dev/null || echo "000")
    if [ "$health" = "200" ]; then
        echo -e "  ${GREEN}🌐 Dashboard API: healthy (HTTP 200)${NC}"
    else
        echo -e "  ${RED}❌ Dashboard API: unreachable (HTTP $health)${NC}"
    fi

    echo ""
}

cmd_logs() {
    local target="${1:-all}"
    case "$target" in
        engine)   tail -f "$LOG_DIR/engine.log" ;;
        api)      tail -f "$LOG_DIR/api.log" ;;
        learning) tail -f "$LOG_DIR/learning.log" ;;
        error)    tail -f "$LOG_DIR"/*-error.log ;;
        all)      tail -f "$LOG_DIR"/*.log ;;
        *)        echo "Usage: $0 logs [engine|api|learning|error|all]"; exit 1 ;;
    esac
}

cmd_enable() {
    echo "Enabling OpenClaw services on boot..."
    for svc in "${SERVICES[@]}"; do
        sudo systemctl enable "$svc"
    done
    sudo systemctl enable "$TIMER"
    echo -e "${GREEN}Services enabled.${NC}"
}

cmd_disable() {
    echo "Disabling OpenClaw services on boot..."
    for svc in "${SERVICES[@]}"; do
        sudo systemctl disable "$svc"
    done
    sudo systemctl disable "$TIMER"
    echo -e "${YELLOW}Services disabled.${NC}"
}

case "${1:-}" in
    start)   cmd_start ;;
    stop)    cmd_stop ;;
    restart) cmd_restart ;;
    status)  cmd_status ;;
    logs)    cmd_logs "$2" ;;
    enable)  cmd_enable ;;
    disable) cmd_disable ;;
    *)
        echo "OpenClaw v2 Management"
        echo ""
        echo "Usage: $0 {start|stop|restart|status|logs|enable|disable}"
        echo ""
        echo "  start    Start all services (engine, api, timer)"
        echo "  stop     Stop all services"
        echo "  restart  Restart all services"
        echo "  status   Show service status and system info"
        echo "  logs     Tail logs: logs [engine|api|learning|error|all]"
        echo "  enable   Enable auto-start on boot"
        echo "  disable  Disable auto-start on boot"
        exit 1
        ;;
esac
