const axios = require('axios');
const fs = require('fs');

const OLLAMA_ENDPOINT = process.env.OLLAMA_ENDPOINT || 'http://100.74.17.84:11434';
const CHECK_INTERVAL = 60000; // 60 seconds
const FAILURE_THRESHOLD = 3; // Offline after 3 failures
const STATE_FILE = '/home/node/.openclaw/trading_state.json';

let failureCount = 0;
let tradingEnabled = false;

async function checkOllama() {
    try {
        const response = await axios.get(`${OLLAMA_ENDPOINT}/v1/models`, { timeout: 5000 });
        if (response.status === 200) {
            failureCount = 0;
            if (!tradingEnabled) {
                console.log('✅ Ollama ONLINE - Trading ENABLED');
                tradingEnabled = true;
                saveState();
            }
            return true;
        }
    } catch (error) {
        failureCount++;
        console.log(`❌ Ollama check failed (${failureCount}/${FAILURE_THRESHOLD}): ${error.message}`);
        
        if (failureCount >= FAILURE_THRESHOLD && tradingEnabled) {
            console.log('🛑 Ollama OFFLINE - Trading DISABLED');
            tradingEnabled = false;
            saveState();
        }
        return false;
    }
}

function saveState() {
    const state = {
        tradingEnabled,
        lastCheck: new Date().toISOString(),
        failureCount,
        ollamaEndpoint: OLLAMA_ENDPOINT
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        }
    } catch (error) {
        console.error('Error reading state:', error);
    }
    return { tradingEnabled: false };
}

// Expose state via simple HTTP server
const http = require('http');
const server = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(getState()));
    } else {
        res.writeHead(404);
        res.end();
    }
});

server.listen(18791, '0.0.0.0', () => {
    console.log('Heartbeat service listening on 0.0.0.0:18791');
});

// Start checking
setInterval(checkOllama, CHECK_INTERVAL);
checkOllama(); // Initial check
