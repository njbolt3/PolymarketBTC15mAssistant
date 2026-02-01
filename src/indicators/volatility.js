import { sma } from "./rsi.js";

/**
 * Average True Range (ATR)
 * Uses high, low, close from candles.
 */
export function computeAtr(candles, period = 14) {
    if (!Array.isArray(candles) || candles.length < period + 1) return null;

    const trs = [];
    for (let i = 1; i < candles.length; i++) {
        const c = candles[i];
        const p = candles[i - 1];

        const tr = Math.max(
            c.high - c.low,
            Math.abs(c.high - p.close),
            Math.abs(c.low - p.close)
        );
        trs.push(tr);
    }

    // Simple average of TRs for the period
    const recentTrs = trs.slice(-period);
    if (recentTrs.length < period) return null;

    return recentTrs.reduce((a, b) => a + b, 0) / period;
}

/**
 * Bollinger Bands (Basis, Upper, Lower)
 * Basis is SMA, Upper/Lower are offset by stdDev * multiplier.
 */
export function computeBollingerBands(values, period = 20, multiplier = 2) {
    if (!Array.isArray(values) || values.length < period) return null;

    const basis = sma(values, period);
    if (basis === null) return null;

    const slice = values.slice(-period);
    const variance = slice.reduce((sum, val) => sum + Math.pow(val - basis, 2), 0) / period;
    const stdDev = Math.sqrt(variance);

    return {
        basis,
        upper: basis + (stdDev * multiplier),
        lower: basis - (stdDev * multiplier),
        stdDev
    };
}
