import { CONFIG } from "../config.js";

function toNumber(x) {
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
}

/**
 * Fetch candle data from Coinbase Exchange.
 * @param {Object} options
 * @param {number} options.granularity - Candle interval in seconds (60, 300, 900, 3600, 21600, 86400)
 * @param {number} options.limit - Number of candles to fetch (max 300)
 * @returns {Promise<Array<{openTime: number, open: number, high: number, low: number, close: number, volume: number, closeTime: number}>>}
 */
export async function fetchKlines({ granularity, limit }) {
    const url = new URL(`/products/${CONFIG.productId}/candles`, CONFIG.coinbaseBaseUrl);
    url.searchParams.set("granularity", String(granularity));

    // Coinbase requires start/end timestamps to limit the number of candles
    const endTime = Math.floor(Date.now() / 1000);
    const startTime = endTime - (granularity * Math.min(limit, 300));
    url.searchParams.set("start", String(startTime));
    url.searchParams.set("end", String(endTime));

    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Coinbase candles error: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();

    // Coinbase format: [time, low, high, open, close, volume]
    // Convert to our internal format matching Binance structure
    return data
        .map((k) => ({
            openTime: Number(k[0]) * 1000, // Convert seconds to milliseconds
            open: toNumber(k[3]),
            high: toNumber(k[2]),
            low: toNumber(k[1]),
            close: toNumber(k[4]),
            volume: toNumber(k[5]),
            closeTime: (Number(k[0]) + granularity) * 1000 - 1
        }))
        .sort((a, b) => a.openTime - b.openTime); // Coinbase returns newest first, we need oldest first
}

/**
 * Fetch the last trade price from Coinbase Exchange.
 * @returns {Promise<number|null>}
 */
export async function fetchLastPrice() {
    const url = new URL(`/products/${CONFIG.productId}/ticker`, CONFIG.coinbaseBaseUrl);
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Coinbase ticker error: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    return toNumber(data.price);
}
