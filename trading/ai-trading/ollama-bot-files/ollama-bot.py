"""
OpenClaw Ollama Bot — Discord integration for AI trading system.
Polls VPS API for trade events, formats with local Ollama, posts to Discord.
"""

import discord
import asyncio
import requests
import json
import logging
from datetime import datetime
from pathlib import Path

# ── Config ──────────────────────────────────────────────────

config_path = Path(__file__).parent / "config.json"
with open(config_path) as f:
    CONFIG = json.load(f)

VPS_API_URL = CONFIG["vps_api_url"]
VPS_API_KEY = CONFIG["vps_api_key"]
DISCORD_TOKEN = CONFIG["discord_bot_token"]
OLLAMA_MODEL = CONFIG.get("ollama_model", "llama3.1:8b")
REPORT_CHANNEL = CONFIG.get("daily_report_channel_name", "daily_report")
DASH_CHANNEL = CONFIG.get("dashboard_channel_name", "dashboard")
POLL_INTERVAL = CONFIG.get("poll_interval_seconds", 30)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("ollama-bot")

# ── VPS API ─────────────────────────────────────────────────

def call_vps_api(action, extra_data=None):
    """POST to VPS dashboard API. Returns parsed JSON or None on error."""
    body = {"action": action}
    if extra_data:
        body.update(extra_data)
    try:
        resp = requests.post(
            f"{VPS_API_URL}/api/dashboard",
            headers={"x-api-key": VPS_API_KEY, "Content-Type": "application/json"},
            json=body,
            timeout=15,
        )
        if resp.status_code == 200:
            return resp.json()
        log.error(f"API {action} returned {resp.status_code}: {resp.text[:200]}")
        return None
    except Exception as e:
        log.error(f"API {action} failed: {e}")
        return None

# ── Ollama Formatting ───────────────────────────────────────

def call_ollama(prompt, max_tokens=400):
    """Call local Ollama. Returns generated text or None."""
    try:
        import ollama as ol
        response = ol.chat(
            model=OLLAMA_MODEL,
            messages=[{"role": "user", "content": prompt}],
            options={"num_predict": max_tokens},
        )
        return response["message"]["content"].strip()
    except Exception as e:
        log.error(f"Ollama error: {e}")
        return None


def format_event_with_ollama(event):
    """Format a trade event into a concise Discord message using Ollama."""
    meta = event.get("metadata")
    if isinstance(meta, str):
        try:
            meta = json.loads(meta)
        except:
            pass
    prompt = (
        f"Format this trading event as a short Discord message. "
        f"Use emoji. Keep under 300 characters. Be concise.\n\n"
        f"Type: {event.get('event_type')}\n"
        f"Symbol: {event.get('symbol', 'N/A')}\n"
        f"Data: {json.dumps(meta, default=str)[:500]}\n"
        f"Time: {event.get('created_at', '')}"
    )
    result = call_ollama(prompt, max_tokens=200)
    if result:
        return result[:500]
    return format_event_fallback(event)


def format_event_fallback(event):
    """Simple fallback formatter when Ollama is unavailable."""
    et = event.get("event_type", "UNKNOWN")
    sym = event.get("symbol", "")
    meta = event.get("metadata")
    if isinstance(meta, str):
        try:
            meta = json.loads(meta)
        except:
            meta = {}
    meta = meta or {}

    templates = {
        "BUY": lambda: f"🟢 **BUY** {sym} @ ${meta.get('price', '?')} | Conf: {meta.get('confidence', '?')} | {str(meta.get('reasoning', ''))[:100]}",
        "SELL": lambda: f"🔴 **SELL** {sym} @ ${meta.get('price', '?')} | P&L: ${meta.get('pnl', '?')} ({meta.get('pnl_percent', '?')}%)",
        "DCA": lambda: f"🔵 **DCA** {sym} @ ${meta.get('price', '?')} | New avg: ${meta.get('new_avg_entry', '?')}",
        "PARTIAL_EXIT": lambda: f"💰 **PARTIAL EXIT** {sym} {meta.get('exit_percent', '')}% @ ${meta.get('price', '?')} | P&L: ${meta.get('pnl', '?')}",
        "CIRCUIT_BREAKER": lambda: f"⚠️ **CIRCUIT BREAKER** | {meta.get('consecutive_losses', '?')} losses | Pausing {meta.get('cooldown_hours', '?')}h",
        "HOURLY_SUMMARY": lambda: f"📊 **Hourly** | {meta.get('open_positions', 0)} positions | P&L: ${meta.get('unrealized_pnl', 0):.2f} unrealized, ${meta.get('realized_pnl', 0):.2f} realized",
        "ENGINE_START": lambda: f"🚀 **Engine Started** | {meta.get('symbols', '?')} symbols | ${meta.get('capital', '?')} capital | Paper: {meta.get('paper_trading', '?')}",
        "ENGINE_STOP": lambda: f"🛑 **Engine Stopped** | {meta.get('cycle_count', '?')} cycles completed",
    }

    formatter = templates.get(et, lambda: f"📌 **{et}** {sym} | {json.dumps(meta, default=str)[:200]}")
    return formatter()


# ── User Query Handler ──────────────────────────────────────

def handle_user_query(question):
    """Answer a user's question about the trading system."""
    # Fetch context from VPS
    portfolio = call_vps_api("get_portfolio_summary")
    positions = call_vps_api("get_positions")
    decisions = call_vps_api("get_decisions", {"limit": 5})

    context = "TRADING SYSTEM DATA:\n\n"

    if portfolio and "data" in portfolio:
        p = portfolio["data"]
        context += f"Portfolio: {p.get('open_count', 0)}/{p.get('max_positions', 5)} positions | "
        context += f"Invested: ${p.get('total_invested', 0):.2f} | "
        context += f"Available: ${p.get('available_capital', 0):.2f} | "
        context += f"Unrealized: ${p.get('unrealized_pnl', 0):.2f} ({p.get('unrealized_pnl_percent', 0):.1f}%) | "
        context += f"Realized: ${p.get('realized_pnl', 0):.2f} | "
        context += f"Win rate: {p.get('win_rate', 0):.1f}% ({p.get('total_trades', 0)} trades)\n\n"

    if positions and "data" in positions:
        if len(positions["data"]) > 0:
            context += "Open positions:\n"
            for pos in positions["data"][:5]:
                sym = pos.get("symbol", "?")
                entry = float(pos.get("avg_entry_price", 0))
                live = pos.get("live_price") or float(pos.get("current_price", 0))
                pnl_pct = pos.get("live_pnl_percent", 0)
                context += f"  {sym}: entry ${entry:.2f}, now ${live:.2f} ({pnl_pct:+.1f}%)\n"
            context += "\n"

    if decisions and "data" in decisions:
        if len(decisions["data"]) > 0:
            context += "Recent decisions:\n"
            for d in decisions["data"][:3]:
                context += f"  {d.get('symbol', '?')}: {d.get('action', '?')} conf:{d.get('confidence', '?')} — {str(d.get('reasoning', ''))[:120]}\n"
            context += "\n"

    prompt = (
        f"You are a helpful trading assistant for the OpenClaw crypto trading system. "
        f"Answer the user's question based on the data below. Be concise (under 1800 chars).\n\n"
        f"{context}"
        f"User question: {question}"
    )

    answer = call_ollama(prompt, max_tokens=400)
    if answer:
        return answer[:1900]

    # Fallback: show raw data
    return f"**Portfolio:**\n```json\n{json.dumps(portfolio.get('data', {}), indent=2, default=str)[:1500]}\n```"


# ── Discord Bot ─────────────────────────────────────────────

intents = discord.Intents.default()
intents.message_content = True
client = discord.Client(intents=intents)

report_channel = None
dash_channel = None


@client.event
async def on_ready():
    global report_channel, dash_channel
    log.info(f"Bot ready as {client.user}")

    for guild in client.guilds:
        for ch in guild.text_channels:
            if ch.name == REPORT_CHANNEL:
                report_channel = ch
            if ch.name == DASH_CHANNEL:
                dash_channel = ch

    if report_channel:
        log.info(f"Report channel: #{report_channel.name}")
    else:
        log.warning(f"Channel #{REPORT_CHANNEL} not found")

    if dash_channel:
        log.info(f"Dashboard channel: #{dash_channel.name}")
    else:
        log.warning(f"Channel #{DASH_CHANNEL} not found")

    client.loop.create_task(poll_events())


@client.event
async def on_message(message):
    if message.author == client.user:
        return
    if dash_channel and message.channel.id == dash_channel.id:
        async with message.channel.typing():
            answer = await asyncio.to_thread(handle_user_query, message.content)
            await message.reply(answer)


async def poll_events():
    """Background task: poll VPS for pending events and post to Discord."""
    await client.wait_until_ready()
    log.info(f"Event polling started (every {POLL_INTERVAL}s)")

    while not client.is_closed():
        try:
            result = await asyncio.to_thread(call_vps_api, "get_events")
            if result and "data" in result and len(result["data"]) > 0:
                events = result["data"]
                posted_ids = []

                for event in events:
                    formatted = await asyncio.to_thread(format_event_with_ollama, event)
                    if report_channel:
                        await report_channel.send(formatted)
                        posted_ids.append(event["id"])
                        log.info(f"Posted event #{event['id']} ({event.get('event_type')})")

                if posted_ids:
                    await asyncio.to_thread(
                        call_vps_api, "mark_events_posted", {"eventIds": posted_ids}
                    )
                    log.info(f"Marked {len(posted_ids)} events as posted")

        except Exception as e:
            log.error(f"Poll error: {e}")

        await asyncio.sleep(POLL_INTERVAL)


# ── Main ────────────────────────────────────────────────────

if __name__ == "__main__":
    log.info("Starting OpenClaw Ollama Bot...")
    client.run(DISCORD_TOKEN)
