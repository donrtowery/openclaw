# OpenClaw Automated Trading System - Complete Documentation

**Date Created:** February 7, 2026  
**System Status:** Operational (Paper Trading Mode)  
**Monthly Cost:** ~$26-27  
**Trading Mode:** Paper (Simulated with $10,000 starting balance)

---

## Table of Contents
1. [System Overview](#system-overview)
2. [Architecture Diagram](#architecture-diagram)
3. [Components & Services](#components--services)
4. [File Structure](#file-structure)
5. [Configuration Details](#configuration-details)
6. [How It Works (Data Flow)](#how-it-works-data-flow)
7. [Safety Features](#safety-features)
8. [Network & Security](#network--security)
9. [Cost Breakdown](#cost-breakdown)
10. [Monitoring & Maintenance](#monitoring--maintenance)
11. [Troubleshooting](#troubleshooting)
12. [Useful Commands](#useful-commands)
13. [Next Steps](#next-steps)

---

## System Overview

**What:** Automated cryptocurrency trading system with hybrid cloud/local architecture  
**Where:** Linode VPS (always-on) + Windows PC with GPU (LLM inference)  
**Trading:** BinanceUS API (currently paper trading mode)  
**Strategy:** Simple Moving Average (SMA) Crossover (10/30 periods)  
**Symbols:** BTCUSDT, ETHUSDT, SOLUSDT (expandable to 10)  
**Fail-Safe:** Automatically stops trading if Windows PC goes offline

---

## Architecture Diagram
```
┌─────────────────────────────────────────────────────────────┐
│ WINDOWS PC (Home)                                           │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ Ollama (LLM Inference on GTX 2060 Super)               │ │
│ │ - Endpoint: http://100.74.17.84:11434                  │ │
│ │ - Model: llama3.1:8b                                   │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                               │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ Browser (Control UI Access)                             │ │
│ │ - http://127.0.0.1:18788 via SSH tunnel               │ │
│ └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                      │
                      │ SSH Tunnel + Tailscale
                      ▼
┌─────────────────────────────────────────────────────────────┐
│ LINODE VPS (Cloud - Always On)                              │
│                                                               │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ DOCKER CONTAINERS (All on 127.0.0.1 only)              │ │
│ │                                                          │ │
│ │ 1. nginx-proxy (18788) → gateway                       │ │
│ │ 2. openclaw-gateway (18789-18790)                      │ │
│ │ 3. heartbeat (18791) - PC health monitor               │ │
│ │ 4. market-data - BinanceUS price feeds                 │ │
│ │ 5. strategy - Signal generation (SMA crossover)        │ │
│ │ 6. risk-manager - Trade validation                     │ │
│ │ 7. execution - Paper trading engine                    │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                               │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ DATA STORAGE                                            │ │
│ │ - ~/openclaw/.openclaw/ (configs, state)               │ │
│ │ - ~/openclaw/trading/data/ (candles, positions, logs)  │ │
│ └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                      │
                      │ BinanceUS API (HTTPS)
                      ▼
┌─────────────────────────────────────────────────────────────┐
│ BinanceUS                                                    │
│ - Market data (5m candles)                                  │
│ - Paper trading (simulated orders)                          │
└─────────────────────────────────────────────────────────────┘
```

---

## Components & Services

### 1. **nginx-proxy**
- **Purpose:** Reverse proxy for OpenClaw Control UI
- **Port:** 127.0.0.1:18788
- **Function:** Token injection, WebSocket handling
- **Config:** `~/openclaw/nginx/openclaw.conf`

### 2. **openclaw-gateway**
- **Purpose:** OpenClaw control plane
- **Ports:** 127.0.0.1:18789 (API), 18790 (bridge)
- **Function:** AI agent coordination, LLM integration
- **LLM Endpoint:** http://100.74.17.84:11434 (via Tailscale)

### 3. **heartbeat**
- **Purpose:** Monitor Windows PC health
- **Port:** 127.0.0.1:18791
- **Interval:** 60 seconds
- **Fail-Safe:** Disables trading after 3 failed checks (90s)
- **API:** `curl http://127.0.0.1:18791/health`

### 4. **market-data**
- **Purpose:** Fetch price data from BinanceUS
- **Interval:** Every 5 minutes
- **Data:** 100 candles per symbol (5m interval)
- **Output:** `~/.openclaw/data/candles/SYMBOL_5m.json`

### 5. **strategy**
- **Purpose:** Generate buy/sell signals
- **Strategy:** SMA Crossover (Fast: 10, Slow: 30)
- **Interval:** Every 5 minutes (after market data update)
- **Output:** `~/.openclaw/data/signals.json`

### 6. **risk-manager**
- **Purpose:** Validate signals against risk rules
- **Interval:** Every 1 minute
- **Checks:** Position size, exposure, circuit breaker, stop loss
- **Output:** `~/.openclaw/data/validated_trades.json`

### 7. **execution**
- **Purpose:** Execute paper trades
- **Mode:** Paper trading (simulated orders)
- **Interval:** Every 1 minute
- **Monitors:** Stop loss, take profit on open positions
- **Output:** `~/.openclaw/data/positions.json`, `trade_history.json`

---

## File Structure
```
~/openclaw/
├── docker-compose.yml           # Main compose file (all services)
├── .env                         # OpenClaw environment vars
├── .env.trading                 # BinanceUS API keys (SECURED, chmod 600)
├── .gitignore                   # Excludes secrets
├── health-check.sh              # System health check script
├── kill-switch.sh               # Emergency stop trading
├── SYSTEM_SUMMARY.md            # This document
│
├── nginx/
│   └── openclaw.conf            # Proxy config (token injection)
│
├── trading/
│   ├── package.json             # Node.js dependencies
│   ├── node_modules/            # Installed packages
│   │
│   ├── services/                # Trading services
│   │   ├── heartbeat.js         # Local test version
│   │   ├── market-data.js       # Local test version
│   │   ├── market-data-docker.js    # Docker version
│   │   ├── strategy.js          # Local test version
│   │   ├── strategy-docker.js       # Docker version
│   │   ├── risk-manager.js      # Local test version
│   │   ├── risk-manager-docker.js   # Docker version
│   │   ├── execution.js         # Local test version
│   │   └── execution-docker.js      # Docker version
│   │
│   ├── config/
│   │   ├── symbols.json         # Tradable symbols allowlist
│   │   ├── strategy.json        # Strategy parameters
│   │   └── risk.json            # Risk limits & rules
│   │
│   ├── logs/                    # Audit logs (auto-rotated)
│   │
│   └── data/                    # Runtime data
│       ├── candles/             # Market data cache
│       │   ├── BTCUSDT_5m.json
│       │   ├── ETHUSDT_5m.json
│       │   └── SOLUSDT_5m.json
│       ├── signals.json         # Generated signals
│       ├── validated_trades.json    # Risk-approved trades
│       ├── positions.json       # Open positions
│       └── trade_history.json   # Completed trades with P&L
│
└── .openclaw/                   # OpenClaw data directory
    ├── openclaw.json            # Gateway config (token)
    ├── trading_state.json       # Trading enabled flag
    └── data/                    # Same as trading/data (mounted)
```

---

## Configuration Details

### Symbols (config/symbols.json)
```json
{
  "enabled": true,
  "symbols": ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
  "candleInterval": "5m",
  "maxConcurrentPositions": 1
}
```

### Risk Rules (config/risk.json)
```json
{
  "positionSizing": {
    "maxPositionSizePercent": 2.0,      // 2% max per position
    "maxTotalExposurePercent": 10.0,    // 10% max total
    "minOrderValueUSD": 10.0            // $10 minimum order
  },
  "stopLoss": {
    "enabled": true,
    "defaultPercent": 3.0                // 3% stop loss
  },
  "takeProfit": {
    "enabled": true,
    "defaultPercent": 6.0                // 6% take profit (2:1 R/R)
  },
  "circuitBreaker": {
    "enabled": true,
    "consecutiveLosses": 3,              // Stop after 3 losses
    "maxDrawdownPercent": 5.0,           // Stop at 5% drawdown
    "cooldownMinutes": 60                // 1 hour cooldown
  },
  "paperTrading": {
    "enabled": true,                     // PAPER MODE ONLY
    "startingBalanceUSD": 10000.0
  }
}
```

### Strategy (config/strategy.json)
```json
{
  "strategyType": "sma_crossover",
  "parameters": {
    "fastPeriod": 10,                    // Fast SMA
    "slowPeriod": 30                     // Slow SMA
  },
  "filters": {
    "minVolumeUSD": 100000,              // $100k min volume
    "minPriceChangePercent": 0.5         // 0.5% min price movement
  },
  "llm": {
    "enabled": true,
    "role": "analysis_only"              // LLM does NOT execute
  }
}
```

### Environment Variables (.env.trading)
```bash
BINANCE_API_KEY=your_api_key_here
BINANCE_SECRET_KEY=your_secret_key_here
OLLAMA_ENDPOINT=http://100.74.17.84:11434
TRADING_MODE=paper
PAPER_BALANCE_USD=10000
BINANCE_API_URL=https://api.binance.us
```

**Security:** File has `chmod 600` (read/write by owner only)

---

## How It Works (Data Flow)

### Every 5 Minutes (Market Data & Signals)
```
1. market-data: Fetch candles from BinanceUS
   → Saves to: data/candles/SYMBOL_5m.json

2. strategy: Read candles, calculate SMAs, detect crossovers
   → If crossover: Generate BUY or SELL signal
   → Saves to: data/signals.json
```

### Every 1 Minute (Risk & Execution)
```
3. risk-manager: Read signals.json
   → Check position size, exposure, circuit breaker
   → If approved: Save to validated_trades.json
   → If rejected: Log reason

4. execution: Read validated_trades.json
   → Execute paper BUY: Open position with stop/take profit
   → Execute paper SELL: Close position, calculate P&L
   → Check open positions: Trigger stop loss or take profit
   → Saves to: positions.json, trade_history.json
```

### Every 60 Seconds (Heartbeat)
```
5. heartbeat: Poll Ollama at http://100.74.17.84:11434/v1/models
   → Success: Set tradingEnabled = true
   → 3 failures (90s): Set tradingEnabled = false
   → All services check this flag before acting
```

---

## Safety Features

### 1. **Fail-Safe (PC Offline Protection)**
- Heartbeat monitors Windows PC every 60 seconds
- Trading stops automatically after 3 failed checks (90 seconds)
- All services pause (data collection continues, execution stops)
- Resumes automatically when PC comes back online

### 2. **Circuit Breaker**
- Stops trading after **3 consecutive losses**
- Stops trading at **5% drawdown** from starting balance
- **60-minute cooldown** before resuming

### 3. **Position Limits**
- Max **2% per position** (of portfolio value)
- Max **10% total exposure** across all positions
- Max **1 concurrent position** (configurable)

### 4. **Stop Loss & Take Profit**
- Every position has a **3% stop loss** (auto-closes on breach)
- Every position has a **6% take profit** (auto-closes on hit)
- Checked every 1 minute by execution engine

### 5. **Paper Trading Mode**
- Currently in simulation mode (no real money)
- All trades are logged as if real
- Full P&L tracking with $10,000 starting balance
- Must manually switch to live mode after validation

### 6. **API Key Security**
- BinanceUS keys stored in `.env.trading` with `chmod 600`
- Never committed to git (in `.gitignore`)
- API key restricted to VPS public IP (whitelist)
- **Withdrawals disabled** on BinanceUS API key

### 7. **Emergency Kill Switch**
- One command: `./kill-switch.sh`
- Immediately disables trading (sets tradingEnabled = false)
- Manual restart required (`sudo docker compose restart heartbeat`)

---

## Network & Security

### VPS Bindings (All Loopback Only)
- **OpenClaw Gateway:** 127.0.0.1:18789-18790
- **nginx Proxy:** 127.0.0.1:18788
- **Heartbeat API:** 127.0.0.1:18791
- **No public internet exposure**

### Access Methods
1. **Control UI:** SSH tunnel from Windows → VPS port 18788
2. **Ollama (LLM):** VPS → Tailscale → Windows PC (100.74.17.84:11434)
3. **BinanceUS API:** VPS → HTTPS (whitelisted by VPS public IP)

### Firewall
- VPS: Only SSH (port 22) open to internet
- All services bound to loopback (127.0.0.1)
- Tailscale provides encrypted tunnel for LLM calls

### API Key Restrictions
- **Enabled:** Read, Spot & Margin Trading
- **Disabled:** Withdrawals (critical!)
- **IP Whitelist:** VPS public IP only
- **Stored:** `.env.trading` with 600 permissions

---

## Cost Breakdown

### Monthly Infrastructure
| Item | Cost |
|------|------|
| Linode VPS (4GB) | $24/month |
| Windows PC (idle 24/7) | ~$2-3/month (electricity) |
| LLM inference (local Ollama) | $0 (GPU already owned) |
| Tailscale | $0 (free tier) |
| BinanceUS API | $0 (no API fees) |
| **TOTAL** | **~$26-27/month** |

### Trading Fees (When Live)
- BinanceUS: 0.1-0.4% per trade
- Example: $100 trade = $0.10-$0.40 fee

### Scaling Considerations
- 10 symbols (vs current 3): No additional cost
- More frequent candles (1m vs 5m): No additional cost
- VPS can be downgraded to 2GB ($12/month) to save $12/month

---

## Monitoring & Maintenance

### Daily Checks (5 minutes)
```bash
# System health
./health-check.sh

# Check for open positions
cat ~/.openclaw/data/positions.json

# Check recent trades
cat ~/.openclaw/data/trade_history.json | tail -20

# Check if trading is enabled
curl http://127.0.0.1:18791/health
```

### Weekly Checks (15 minutes)
```bash
# Review all trades
cat ~/.openclaw/data/trade_history.json

# Check for errors in logs
sudo docker compose logs --tail 500 | grep -i error

# Verify all containers running
sudo docker compose ps

# Check disk space
df -h ~
```

### Monthly Maintenance
```bash
# Review strategy performance
# Analyze: Win rate, avg profit/loss, drawdowns
cat ~/.openclaw/data/trade_history.json

# Rotate API keys (optional but recommended every 90 days)
# 1. Create new keys on BinanceUS
# 2. Update .env.trading
# 3. Restart: sudo docker compose restart

# Update system packages
sudo apt update && sudo apt upgrade

# Backup configuration
tar -czf openclaw-backup-$(date +%Y%m%d).tar.gz \
  ~/openclaw/trading/config/ \
  ~/openclaw/.env.trading \
  ~/.openclaw/openclaw.json
```

---

## Troubleshooting

### Problem: Container Keeps Restarting
```bash
# Check logs for errors
sudo docker compose logs <service-name> --tail 50

# Common causes:
# - Syntax error in service script
# - Missing dependencies (npm install)
# - File permission issues
```

### Problem: No Signals Being Generated
```bash
# Check if market data is updating
ls -lh ~/.openclaw/data/candles/
cat ~/.openclaw/data/candles/BTCUSDT_5m.json | tail -5

# Check strategy logs
sudo docker compose logs strategy --tail 50

# Note: Crossovers are rare (2-5 per day per symbol is normal)
```

### Problem: Trading Disabled
```bash
# Check heartbeat status
curl http://127.0.0.1:18791/health

# If PC is offline:
# - Verify Ollama is running on Windows
# - Check Tailscale connection on both machines

# If manual kill switch was triggered:
sudo docker compose restart heartbeat
```

### Problem: Execution Not Running Trades
```bash
# Check if trades were validated
cat ~/.openclaw/data/validated_trades.json

# Check execution logs
sudo docker compose logs execution --tail 50

# Verify paper trading is enabled
cat ~/openclaw/trading/config/risk.json | grep paperTrading
```

### Problem: Cannot Access Control UI
```bash
# Verify SSH tunnel is active (on Windows)
# ssh -L 18788:127.0.0.1:18788 don@<VPS_IP>

# Check proxy is running
sudo docker compose ps | grep proxy

# Check proxy logs
sudo docker compose logs openclaw-proxy --tail 20
```

---

## Useful Commands

### System Management
```bash
# Check all container status
sudo docker compose ps

# Start all services
cd ~/openclaw
sudo docker compose up -d

# Stop all services
sudo docker compose down

# Restart specific service
sudo docker compose restart <service-name>

# Restart all services
sudo docker compose restart

# View logs (live)
sudo docker compose logs -f <service-name>

# View logs (last N lines)
sudo docker compose logs --tail 50 <service-name>

# View logs for all services
sudo docker compose logs --tail 100
```

### Health & Status
```bash
# Run complete health check
cd ~/openclaw
./health-check.sh

# Check heartbeat status
curl http://127.0.0.1:18791/health

# Check if PC is online
curl http://100.74.17.84:11434/v1/models

# Emergency stop trading
./kill-switch.sh

# Re-enable trading after kill switch
sudo docker compose restart heartbeat
```

### Data & Trading
```bash
# View current positions
cat ~/.openclaw/data/positions.json | jq

# View trade history
cat ~/.openclaw/data/trade_history.json | jq

# View recent signals
cat ~/.openclaw/data/signals.json | tail -20

# View validated trades
cat ~/.openclaw/data/validated_trades.json | jq

# View market data (latest candles)
cat ~/.openclaw/data/candles/BTCUSDT_5m.json | tail -10

# Calculate total P&L from trade history
cat ~/.openclaw/data/trade_history.json | \
  jq '[.[] | select(.pnl) | .pnl] | add'

# Count winning vs losing trades
cat ~/.openclaw/data/trade_history.json | \
  jq '[.[] | select(.pnl)] | group_by(.pnl > 0) | map({status: .[0].pnl > 0, count: length})'
```

### Configuration
```bash
# Edit symbol allowlist
nano ~/openclaw/trading/config/symbols.json

# Edit risk rules
nano ~/openclaw/trading/config/risk.json

# Edit strategy parameters
nano ~/openclaw/trading/config/strategy.json

# View API keys (DO NOT share output!)
cat ~/openclaw/.env.trading

# After config changes, restart affected services
sudo docker compose restart strategy risk-manager execution
```

### Maintenance
```bash
# Check disk space
df -h ~

# Check Docker disk usage
sudo docker system df

# Clean up old Docker images (saves space)
sudo docker system prune -a

# Backup configuration
tar -czf ~/openclaw-backup-$(date +%Y%m%d).tar.gz \
  ~/openclaw/trading/config/ \
  ~/openclaw/.env.trading \
  ~/.openclaw/openclaw.json \
  ~/.openclaw/data/

# View log rotation status
ls -lh ~/openclaw/trading/logs/

# Manually rotate logs
sudo logrotate -f /etc/logrotate.d/openclaw
```

### Debugging
```bash
# Check network connectivity to BinanceUS
curl -I https://api.binance.us

# Test market data fetch manually
cd ~/openclaw/trading
node services/market-data.js
# (Press Ctrl+C after a few seconds)

# Test strategy engine manually
node services/strategy.js
# (Press Ctrl+C after a few seconds)

# Check if all containers can reach each other
sudo docker network inspect openclaw_default

# View container resource usage
sudo docker stats

# Enter a running container for debugging
sudo docker compose exec <service-name> sh

# Check file permissions
ls -la ~/.openclaw/
ls -la ~/openclaw/.env.trading
```

### SSH Tunnel (Run on Windows)
```bash
# Create SSH tunnel for Control UI access
ssh -L 18788:127.0.0.1:18788 don@<VPS_PUBLIC_IP>

# Keep tunnel alive in background
ssh -fN -L 18788:127.0.0.1:18788 don@<VPS_PUBLIC_IP>

# Then access UI in browser:
# http://127.0.0.1:18788
```

---

## Next Steps

### Immediate (Next 24 Hours)
1. ✅ **Monitor logs** - Watch for any errors or issues
```bash
   sudo docker compose logs -f
```

2. ✅ **Verify data collection** - Ensure candles are updating
```bash
   watch -n 60 "ls -lh ~/.openclaw/data/candles/"
```

3. ✅ **Test fail-safe** - Stop Ollama on Windows, verify trading pauses

### Short Term (Next 7 Days)
4. **Collect paper trading data** - Let it run for 3-7 days
5. **Review performance** - Check win rate, P&L, trade frequency
```bash
   cat ~/.openclaw/data/trade_history.json | jq
```

6. **Analyze signals** - Are crossovers generating good trades?
7. **Monitor circuit breaker** - Does it trigger appropriately?

### Medium Term (1-2 Weeks)
8. **Tune strategy** - Adjust SMA periods if needed (e.g., 8/21, 12/26)
9. **Add more symbols** - Scale from 3 to 10 coins
10. **Optimize timing** - Consider 1m or 15m candles based on results

### Before Going Live (When Ready)
11. **Validate paper results** - Ensure profitable over 2+ weeks
12. **Review all safety features** - Test kill switch, circuit breaker
13. **Reduce position sizes** - Start with 1% (not 2%) for live trading
14. **Set up alerts** - Monitoring for errors, large losses
15. **Enable live trading:**
```bash
    nano ~/openclaw/trading/config/risk.json
    # Change: "enabled": false (under paperTrading)
    sudo docker compose restart execution
```

16. **Monitor closely** - First 24 hours of live trading require close attention

---

## Support & Resources

### Documentation
- OpenClaw: https://github.com/cyanheads/claw (check for updates)
- BinanceUS API: https://docs.binance.us/

### Your System Details
- **VPS:** Linode 4GB, Ubuntu
- **VPS IP:** Run `curl -4 ifconfig.me` on VPS
- **Tailscale Network:** 100.74.17.84 (Windows PC)
- **OpenClaw Token:** Stored in `~/.openclaw/openclaw.json`
- **BinanceUS Keys:** Stored in `~/openclaw/.env.trading`

### Emergency Contacts
- Linode Support: https://www.linode.com/support/
- BinanceUS Support: https://support.binance.us/

---

## Document Version History

- **v1.0** - February 7, 2026 - Initial system deployment
  - Complete trading pipeline operational
  - Paper trading mode enabled
  - All safety features tested and verified

---

**END OF DOCUMENT**

Last Updated: February 7, 2026  
Status: System Operational ✅  
Mode: Paper Trading 📄  
Monthly Cost: ~$26-27 💵
