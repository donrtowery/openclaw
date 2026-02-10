#!/bin/bash
set -e

echo "=== OpenClaw Health Check ==="
echo

# Check containers
echo "1. Container Status:"
sudo docker compose ps
echo

# Check Ollama connectivity
echo "2. Ollama Connectivity:"
OLLAMA_IP="100.74.17.84"
if curl -s -f "http://$OLLAMA_IP:11434/v1/models" > /dev/null 2>&1; then
    echo "✅ Ollama reachable"
else
    echo "❌ Ollama OFFLINE"
fi
echo

# Check gateway token
echo "3. Gateway Token:"
if grep -q '"token"' ~/.openclaw/openclaw.json 2>/dev/null; then
    echo "✅ Token configured"
else
    echo "❌ Token missing"
fi
echo

# Check heartbeat status
echo "4. Trading Status:"
HEARTBEAT=$(curl -s http://127.0.0.1:18791/health 2>/dev/null)
if [ -n "$HEARTBEAT" ]; then
    TRADING_ENABLED=$(echo $HEARTBEAT | grep -o '"tradingEnabled":[^,]*' | cut -d':' -f2)
    if [ "$TRADING_ENABLED" = "true" ]; then
        echo "✅ Trading ENABLED (PC online)"
    else
        echo "🛑 Trading DISABLED (PC offline or manual stop)"
    fi
else
    echo "❌ Heartbeat not responding"
fi
echo

# Check recent errors
echo "5. Recent Errors:"
if sudo docker compose logs --tail 100 2>/dev/null | grep -i "error\|fail\|unauthorized" | grep -v "check failed" > /dev/null; then
    echo "⚠️  Found recent errors:"
    sudo docker compose logs --tail 100 2>/dev/null | grep -i "error\|fail\|unauthorized" | grep -v "check failed" | tail -5
else
    echo "✅ No recent errors"
fi
