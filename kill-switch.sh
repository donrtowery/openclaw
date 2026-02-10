#!/bin/bash
echo "🛑 EMERGENCY KILL SWITCH ACTIVATED"
echo

# Create a kill switch state file (need sudo because Docker owns the file)
TIMESTAMP=$(date -Iseconds)

sudo bash -c "cat > /home/don/.openclaw/trading_state.json" << EOF
{
  "tradingEnabled": false,
  "reason": "manual_kill_switch",
  "timestamp": "$TIMESTAMP",
  "lastCheck": "$TIMESTAMP",
  "failureCount": 999,
  "ollamaEndpoint": "http://100.74.17.84:11434"
}
EOF

echo "✅ Trading manually disabled"
echo "📊 Current status:"
cat ~/.openclaw/trading_state.json
echo
echo "To re-enable trading, restart the heartbeat service:"
echo "  sudo docker compose restart heartbeat"
