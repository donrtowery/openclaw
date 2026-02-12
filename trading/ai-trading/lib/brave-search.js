import dotenv from 'dotenv';
import logger from './logger.js';
dotenv.config();

const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
const BRAVE_API_URL = 'https://api.search.brave.com/res/v1/web/search';

// Cache: symbol -> { news, timestamp }
const newsCache = new Map();
const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours — crypto news cycles are slow, saves API calls

/**
 * Get news context for a cryptocurrency.
 * Cached for 1 hour to minimize Brave API calls.
 */
export async function getNewsContext(symbol, coinName) {
  const cached = newsCache.get(symbol);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
    return cached.news;
  }

  if (!BRAVE_API_KEY) {
    return 'News unavailable — no Brave API key configured.';
  }

  try {
    const searchQuery = `${coinName} cryptocurrency news`;
    const url = `${BRAVE_API_URL}?q=${encodeURIComponent(searchQuery)}&count=5&freshness=pw`;

    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': BRAVE_API_KEY,
      },
    });

    if (!response.ok) {
      throw new Error(`Brave API ${response.status}`);
    }

    const data = await response.json();
    const results = data.web?.results || [];

    if (results.length === 0) {
      const fallback = 'No recent news found.';
      newsCache.set(symbol, { news: fallback, timestamp: Date.now() });
      return fallback;
    }

    // Compact format — minimize tokens sent to Sonnet
    let newsText = `Recent news for ${coinName}:\n`;
    for (const r of results.slice(0, 3)) {
      newsText += `- ${r.title}`;
      if (r.age) newsText += ` (${r.age})`;
      newsText += '\n';
      if (r.description) newsText += `  ${r.description.substring(0, 150)}\n`;
    }

    newsCache.set(symbol, { news: newsText, timestamp: Date.now() });
    logger.info(`[Brave] Fetched news for ${symbol} (${results.length} results)`);

    return newsText;
  } catch (error) {
    logger.error(`[Brave] Error: ${error.message}`);
    return 'News unavailable — API error.';
  }
}

/**
 * Clear cache (for testing)
 */
export function clearNewsCache() {
  newsCache.clear();
}
