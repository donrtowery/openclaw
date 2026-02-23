import dotenv from 'dotenv';
import logger from './logger.js';
dotenv.config();

const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
const BRAVE_API_URL = 'https://api.search.brave.com/res/v1/web/search';
const CRYPTOCOMPARE_NEWS_URL = 'https://min-api.cryptocompare.com/data/v2/news/';

// Cache: symbol -> { results, timestamp }
const newsCache = new Map();
const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours — crypto news cycles are slow, saves API calls

/**
 * Format cached results into compact text for AI consumption.
 */
function formatNewsResults(coinName, results, maxItems) {
  if (results.length === 0) return 'No recent news found.';
  let newsText = `Recent news for ${coinName}:\n`;
  for (const r of results.slice(0, maxItems)) {
    newsText += `- ${r.title}`;
    if (r.age) newsText += ` (${r.age})`;
    newsText += '\n';
    if (r.description) newsText += `  ${r.description.substring(0, 80)}\n`;
  }
  return newsText;
}

/**
 * Calculate relative age string from unix timestamp.
 */
function relativeAge(publishedOn) {
  const diffMs = Date.now() - publishedOn * 1000;
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Fetch news from CryptoCompare (free, no API key required).
 * Falls back to Brave Search if CryptoCompare fails.
 */
async function fetchCryptoCompareNews(symbol, coinName) {
  const ticker = symbol.replace('USDT', '');
  const url = `${CRYPTOCOMPARE_NEWS_URL}?categories=${ticker}&extraParams=openclaw`;

  const response = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    throw new Error(`CryptoCompare API ${response.status}`);
  }

  const data = await response.json();
  const items = data.Data || [];

  return items.slice(0, 3).map(item => ({
    title: item.title,
    age: relativeAge(item.published_on),
    description: item.body,
  }));
}

/**
 * Fetch news from Brave Search (paid, used as fallback).
 */
async function fetchBraveNews(coinName) {
  if (!BRAVE_API_KEY) return [];

  const searchQuery = `${coinName} cryptocurrency news`;
  const url = `${BRAVE_API_URL}?q=${encodeURIComponent(searchQuery)}&count=5&freshness=pw`;

  const response = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': BRAVE_API_KEY,
    },
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    throw new Error(`Brave API ${response.status}`);
  }

  const data = await response.json();
  return (data.web?.results || []).slice(0, 3).map(r => ({
    title: r.title,
    age: r.age,
    description: r.description,
  }));
}

/**
 * Get news context for a cryptocurrency.
 * Primary: CryptoCompare (free). Fallback: Brave Search (paid).
 * Cached for 4 hours. maxItems: T1=3, T2=2, T3=1 (saves tokens for lower tiers)
 */
export async function getNewsContext(symbol, coinName, maxItems = 3) {
  const cached = newsCache.get(symbol);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
    return formatNewsResults(coinName, cached.results, maxItems);
  }

  try {
    // Try CryptoCompare first (free)
    const results = await fetchCryptoCompareNews(symbol, coinName);
    newsCache.set(symbol, { results, timestamp: Date.now() });
    logger.info(`[News] CryptoCompare: ${symbol} (${results.length} results)`);
    return formatNewsResults(coinName, results, maxItems);
  } catch (ccError) {
    logger.warn(`[News] CryptoCompare failed for ${symbol}: ${ccError.message}, trying Brave`);
  }

  try {
    // Fallback to Brave Search (paid)
    const results = await fetchBraveNews(coinName);
    if (results.length > 0) {
      newsCache.set(symbol, { results, timestamp: Date.now() });
      logger.info(`[News] Brave fallback: ${symbol} (${results.length} results)`);
      return formatNewsResults(coinName, results, maxItems);
    }
  } catch (braveError) {
    logger.warn(`[News] Brave also failed for ${symbol}: ${braveError.message}`);
  }

  return 'No recent news available.';
}

/**
 * Clear cache (for testing)
 */
export function clearNewsCache() {
  newsCache.clear();
}
