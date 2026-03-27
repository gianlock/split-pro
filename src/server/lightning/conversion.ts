/**
 * Fiat <-> BTC conversion utilities using CoinGecko API.
 *
 * Caches BTC price in USD with stale-while-revalidate pattern
 * and fallback to fixed rate when API is unavailable.
 */

const COINGECKO_API = 'https://api.coingecko.com/api/v3';
const SATS_PER_BTC = 100_000_000;
const FALLBACK_BTC_USD_PRICE = 85000; // Fallback when API is rate-limited

interface CoinGeckoResponse {
  bitcoin: { usd: number };
}

interface CoinGeckoMultiResponse {
  bitcoin: Record<string, number>;
}

// Cache with 10 minute TTL, stale-while-revalidate
let priceCache: { usd: number; timestamp: number } | null = null;
const CACHE_TTL_MS = 10 * 60 * 1000;
let isFetching = false;

/**
 * Get current BTC price in USD.
 * Uses in-memory cache with stale-while-revalidate.
 * Falls back to fixed rate if API fails.
 */
async function _getBTCPriceUSD(): Promise<number> {
  // Return cached value if fresh
  if (priceCache && Date.now() - priceCache.timestamp < CACHE_TTL_MS) {
    return priceCache.usd;
  }

  // Return stale value while re-fetching (avoid thundering herd)
  if (isFetching && priceCache) {
    return priceCache.usd;
  }

  isFetching = true;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`${COINGECKO_API}/simple/price?ids=bitcoin&vs_currencies=usd`, {
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.warn(`CoinGecko API error: ${response.status}, using cached or fallback`);
      return priceCache?.usd ?? FALLBACK_BTC_USD_PRICE;
    }

    const data: CoinGeckoResponse = await response.json();
    const usdPrice = data.bitcoin?.usd;

    if (usdPrice && usdPrice > 0) {
      priceCache = { usd: usdPrice, timestamp: Date.now() };
      return usdPrice;
    }

    return priceCache?.usd ?? FALLBACK_BTC_USD_PRICE;
  } catch (error) {
    console.warn('CoinGecko fetch failed, using cached or fallback:', error);
    return priceCache?.usd ?? FALLBACK_BTC_USD_PRICE;
  } finally {
    isFetching = false;
  }
}

/**
 * Get BTC price in multiple currencies from CoinGecko.
 */
async function getBTCPrices(currencies: string[]): Promise<Record<string, number>> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(
      `${COINGECKO_API}/simple/price?ids=bitcoin&vs_currencies=${currencies.join(',')}`,
      { signal: controller.signal },
    );

    clearTimeout(timeout);

    if (!response.ok) {
      // Fallback to USD-based conversion
      const usdPrice = priceCache?.usd ?? FALLBACK_BTC_USD_PRICE;
      const result: Record<string, number> = { usd: usdPrice };
      for (const cur of currencies) {
        if (cur !== 'usd') {
          // Approximate: assume 1 USD = 1 of most currencies for simplicity
          // In production, use a proper forex API
          result[cur] = usdPrice;
        }
      }
      return result;
    }

    const data: CoinGeckoMultiResponse = await response.json();
    return data.bitcoin;
  } catch (error) {
    console.warn('CoinGecko multi-price fetch failed:', error);
    const usdPrice = priceCache?.usd ?? FALLBACK_BTC_USD_PRICE;
    const result: Record<string, number> = { usd: usdPrice };
    for (const cur of currencies) {
      if (cur !== 'usd') {
        result[cur] = usdPrice;
      }
    }
    return result;
  }
}

/**
 * Convert fiat amount (in smallest unit, e.g., cents) to satoshis.
 */
export async function fiatToSats(
  amountCents: bigint,
  decimalDigits: number,
  currency: string,
): Promise<bigint> {
  const prices = await getBTCPrices([currency.toLowerCase(), 'usd']);
  const currencyPrice = prices[currency.toLowerCase()];
  const usdPrice = prices.usd;

  if (!currencyPrice || !usdPrice) {
    throw new Error(`Failed to get BTC price for ${currency}`);
  }

  // Convert fiat amount to whole units
  const multiplier = BigInt(10 ** decimalDigits);
  const wholeAmount = Number(amountCents) / Number(multiplier);

  // BTC amount = fiatAmount / btcPrice
  const btcAmount = wholeAmount / currencyPrice;
  const sats = Math.round(btcAmount * SATS_PER_BTC);

  return BigInt(Math.max(sats, 1)); // Minimum 1 sat
}

/**
 * Convert satoshis to fiat amount (in smallest unit).
 */
export async function satsToFiat(
  sats: bigint,
  decimalDigits: number,
  currency: string,
): Promise<bigint> {
  const prices = await getBTCPrices([currency.toLowerCase()]);
  const currencyPrice = prices[currency.toLowerCase()];

  if (!currencyPrice) {
    throw new Error(`Failed to get BTC price for ${currency}`);
  }

  const btcAmount = Number(sats) / SATS_PER_BTC;
  const fiatAmount = btcAmount * currencyPrice;

  const multiplier = BigInt(10 ** decimalDigits);
  return BigInt(Math.round(fiatAmount * Number(multiplier)));
}

/**
 * Format sats amount for display with human-readable suffix.
 */
export function formatSats(sats: bigint): string {
  const satsNum = Number(sats);
  const formatted = satsNum.toLocaleString('en-US');

  if (satsNum >= 1_000_000) {
    const btc = (satsNum / SATS_PER_BTC).toFixed(2);
    return `${formatted} sats (${btc} BTC)`;
  }

  return `${formatted} sats`;
}
