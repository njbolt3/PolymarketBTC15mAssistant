import { sma, slopeLast } from "./rsi.js";

/**
 * Rate of Change (ROC) - Momentum indicator
 * Measures the percentage change in price over a period.
 * Positive = upward momentum, Negative = downward momentum
 * @param {number[]} values - Array of close prices
 * @param {number} period - Lookback period (default 5 for short-term)
 * @returns {number|null} ROC percentage
 */
export function computeRoc(values, period = 5) {
    if (!Array.isArray(values) || values.length < period + 1) return null;

    const current = values[values.length - 1];
    const past = values[values.length - 1 - period];

    if (past === 0) return null;

    return ((current - past) / past) * 100;
}

/**
 * ROC Acceleration - Is momentum speeding up or slowing down?
 * @param {number[]} values - Array of close prices
 * @param {number} period - ROC lookback period
 * @param {number} accelPeriod - Acceleration lookback (default 3)
 * @returns {{ roc: number, acceleration: number, isAccelerating: boolean } | null}
 */
export function computeRocWithAcceleration(values, period = 5, accelPeriod = 3) {
    if (!Array.isArray(values) || values.length < period + accelPeriod + 1) return null;

    // Calculate ROC series
    const rocSeries = [];
    for (let i = period; i < values.length; i++) {
        const current = values[i];
        const past = values[i - period];
        if (past !== 0) {
            rocSeries.push(((current - past) / past) * 100);
        }
    }

    if (rocSeries.length < accelPeriod) return null;

    const currentRoc = rocSeries[rocSeries.length - 1];
    const prevRoc = rocSeries[rocSeries.length - accelPeriod];
    const acceleration = currentRoc - prevRoc;

    return {
        roc: currentRoc,
        acceleration,
        isAccelerating: (currentRoc > 0 && acceleration > 0) || (currentRoc < 0 && acceleration < 0)
    };
}

/**
 * Exponential Moving Average (EMA)
 * @param {number[]} values - Array of values
 * @param {number} period - EMA period
 * @returns {number|null} Current EMA value
 */
export function computeEma(values, period) {
    if (!Array.isArray(values) || values.length < period) return null;

    const multiplier = 2 / (period + 1);

    // Start with SMA for first EMA value
    let ema = sma(values.slice(0, period), period);
    if (ema === null) return null;

    // Calculate EMA for remaining values
    for (let i = period; i < values.length; i++) {
        ema = (values[i] - ema) * multiplier + ema;
    }

    return ema;
}

/**
 * EMA Crossover Signal
 * Fast EMA crossing above Slow EMA = bullish
 * Fast EMA crossing below Slow EMA = bearish
 * @param {number[]} values - Array of close prices
 * @param {number} fastPeriod - Fast EMA period (default 3)
 * @param {number} slowPeriod - Slow EMA period (default 8)
 * @returns {{ fastEma: number, slowEma: number, signal: string, strength: number } | null}
 */
export function computeEmaCrossover(values, fastPeriod = 3, slowPeriod = 8) {
    if (!Array.isArray(values) || values.length < slowPeriod + 2) return null;

    // Current EMAs
    const fastEma = computeEma(values, fastPeriod);
    const slowEma = computeEma(values, slowPeriod);

    // Previous EMAs (one bar ago)
    const prevValues = values.slice(0, -1);
    const prevFastEma = computeEma(prevValues, fastPeriod);
    const prevSlowEma = computeEma(prevValues, slowPeriod);

    if (fastEma === null || slowEma === null || prevFastEma === null || prevSlowEma === null) {
        return null;
    }

    // Detect crossover
    const wasBelowOrEqual = prevFastEma <= prevSlowEma;
    const isAbove = fastEma > slowEma;
    const wasAboveOrEqual = prevFastEma >= prevSlowEma;
    const isBelow = fastEma < slowEma;

    let signal = "NEUTRAL";
    if (wasBelowOrEqual && isAbove) {
        signal = "BULLISH_CROSS";
    } else if (wasAboveOrEqual && isBelow) {
        signal = "BEARISH_CROSS";
    } else if (isAbove) {
        signal = "BULLISH";
    } else if (isBelow) {
        signal = "BEARISH";
    }

    // Strength: how far apart are the EMAs (as % of slow EMA)
    const strength = Math.abs((fastEma - slowEma) / slowEma) * 100;

    return {
        fastEma,
        slowEma,
        signal,
        strength,
        isCrossover: signal.includes("CROSS")
    };
}

/**
 * RSI Divergence Detection
 * Bullish Divergence: Price makes lower low, RSI makes higher low
 * Bearish Divergence: Price makes higher high, RSI makes lower high
 * @param {number[]} prices - Array of close prices
 * @param {number[]} rsiValues - Array of RSI values (same length)
 * @param {number} lookback - How many bars to look back for divergence (default 5)
 * @returns {{ type: string, strength: number } | null}
 */
export function detectRsiDivergence(prices, rsiValues, lookback = 5) {
    if (!Array.isArray(prices) || !Array.isArray(rsiValues)) return null;
    if (prices.length < lookback + 1 || rsiValues.length < lookback + 1) return null;

    const recentPrices = prices.slice(-lookback - 1);
    const recentRsi = rsiValues.slice(-lookback - 1);

    const priceNow = recentPrices[recentPrices.length - 1];
    const pricePast = Math.min(...recentPrices.slice(0, -1));
    const pricePastHigh = Math.max(...recentPrices.slice(0, -1));

    const rsiNow = recentRsi[recentRsi.length - 1];
    const rsiAtPriceLow = recentRsi[recentPrices.indexOf(pricePast)];
    const rsiAtPriceHigh = recentRsi[recentPrices.indexOf(pricePastHigh)];

    // Bullish Divergence: Price lower than past low, but RSI higher
    if (priceNow <= pricePast && rsiNow > rsiAtPriceLow) {
        const strength = rsiNow - rsiAtPriceLow;
        return { type: "BULLISH", strength };
    }

    // Bearish Divergence: Price higher than past high, but RSI lower
    if (priceNow >= pricePastHigh && rsiNow < rsiAtPriceHigh) {
        const strength = rsiAtPriceHigh - rsiNow;
        return { type: "BEARISH", strength };
    }

    return { type: "NONE", strength: 0 };
}
