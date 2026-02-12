# OpenClaw Ollama Bot - Windows Setup

## Prerequisites
- Python 3.10+
- Ollama installed with llama3.1:8b model
- Discord bot token
- VPS dashboard API accessible via Tailscale (100.79.158.90)

## Setup
1. Copy these files to C:\Users\Slander\openclaw-local\
2. Edit config.json with your actual API keys
3. Install dependencies: `pip install -r requirements.txt`
4. Verify Ollama running: `ollama list`
5. Run: `python ollama-bot.py`

## Auto-Start with Task Scheduler

Run this PowerShell command as Administrator:

```powershell
$action = New-ScheduledTaskAction -Execute "python" -Argument "ollama-bot.py" -WorkingDirectory "C:\Users\Slander\openclaw-local"
$trigger = New-ScheduledTaskTrigger -AtLogon -User "Slander"
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "OpenClaw-OllamaBot" -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest
```

## Discord Channels Required
- #daily_report - Bot posts trade events here automatically
- #dashboard - Users ask questions, bot responds with AI

## How It Works
1. Bot polls VPS API every 30 seconds for new trade events
2. Each event is formatted using local Ollama (llama3.1:8b)
3. Formatted messages are posted to #daily_report
4. Users can ask questions in #dashboard and get AI-powered answers
5. If Ollama is unavailable, fallback templates are used
