import logger from './logger.js';

const BRAVE_API_URL = 'https://api.search.brave.com/res/v1/news/search';
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

const cache = new Map();

function getCacheKey(query) {
  return `brave:${query}`;
}

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
}

/**
 * Search Brave News API.
 * @param {string} query - Search query
 * @param {number} count - Number of results (max 20)
 * @returns {Promise<Array<{ title, description, url, age }>>}
 */
export async function searchNews(query, count = 5) {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) {
    logger.warn('BRAVE_API_KEY not set — skipping news search');
    return [];
  }

  const cacheKey = getCacheKey(query);
  const cached = getCached(cacheKey);
  if (cached) {
    logger.debug(`Brave cache hit: "${query}"`);
    return cached;
  }

  try {
    const params = new URLSearchParams({ q: query, count: String(count) });
    const response = await fetch(`${BRAVE_API_URL}?${params}`, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
      },
    });

    if (!response.ok) {
      throw new Error(`Brave API ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    const results = (data.results || []).map(r => ({
      title: r.title || '',
      description: r.description || '',
      url: r.url || '',
      age: r.age || '',
    }));

    setCache(cacheKey, results);
    logger.debug(`Brave search: "${query}" → ${results.length} results`);
    return results;
  } catch (err) {
    logger.error(`Brave search failed for "${query}": ${err.message}`);
    return [];
  }
}

/**
 * Get crypto market news for all tracked symbols.
 * Returns aggregated news from multiple queries.
 * @returns {Promise<Array<{ title, description, url, age }>>}
 */
export async function getCryptoNews() {
  const queries = [
    'cryptocurrency market news today',
    'bitcoin ethereum crypto trading',
  ];

  const allResults = [];
  for (const q of queries) {
    const results = await searchNews(q, 5);
    allResults.push(...results);
  }

  // Deduplicate by title
  const seen = new Set();
  const unique = allResults.filter(r => {
    if (seen.has(r.title)) return false;
    seen.add(r.title);
    return true;
  });

  return unique.slice(0, 10);
}

/**
 * Analyze news headlines for basic sentiment.
 * Returns a summary string suitable for inclusion in AI prompts.
 * @returns {Promise<string>}
 */
export async function getMarketSentiment() {
  const news = await getCryptoNews();

  if (news.length === 0) {
    return 'No recent news available.';
  }

  const lines = ['Recent crypto news:'];
  for (const item of news) {
    const age = item.age ? ` (${item.age})` : '';
    lines.push(`- ${item.title}${age}`);
    if (item.description) {
      // Trim description to 150 chars
      const desc = item.description.length > 150
        ? item.description.slice(0, 147) + '...'
        : item.description;
      lines.push(`  ${desc}`);
    }
  }

  return lines.join('\n');
}
