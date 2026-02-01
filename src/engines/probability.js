import { clamp } from "../utils.js";

export function scoreDirection(inputs) {
  const {
    price,
    vwap,
    vwapSlope,
    rsi,
    rsiSlope,
    macd,
    heikenColor,
    heikenCount,
    failedVwapReclaim,
    regime, // "TREND_UP", "TREND_DOWN", "RANGE", "CHOP"
    bb      // { basis, upper, lower }
  } = inputs;

  let up = 1;
  let down = 1;

  // REGIME-BASED WEIGHTING MULTIPLIERS
  const isTrend = regime === "TREND_UP" || regime === "TREND_DOWN";
  const isRange = regime === "RANGE";
  const isChop = regime === "CHOP";

  const trendWeight = isTrend ? 1.5 : 1.0;
  const rangeWeight = isRange ? 1.5 : 0.8;
  const chopPenalty = isChop ? 0.5 : 1.0;

  // 1. VWAP & TREND (Stronger in Trending)
  if (price !== null && vwap !== null) {
    if (price > vwap) up += (2 * trendWeight);
    if (price < vwap) down += (2 * trendWeight);
  }

  if (vwapSlope !== null) {
    if (vwapSlope > 0) up += (2 * trendWeight);
    if (vwapSlope < 0) down += (2 * trendWeight);
  }

  // 2. RSI (Stronger in Range for Mean Reversion)
  if (rsi !== null && rsiSlope !== null) {
    if (isRange) {
      // Mean reversion in range
      if (rsi < 35) up += 3;
      if (rsi > 65) down += 3;
    } else {
      // Momentum in trend
      if (rsi > 55 && rsiSlope > 0) up += 2;
      if (rsi < 45 && rsiSlope < 0) down += 2;
    }
  }

  // 3. BOLLINGER BANDS (Mean Reversion)
  if (bb && price !== null) {
    if (price <= bb.lower) up += (2 * rangeWeight);
    if (price >= bb.upper) down += (2 * rangeWeight);
  }

  // 4. MACD (Trend Indicator)
  if (macd?.hist !== null && macd?.histDelta !== null) {
    const expandingGreen = macd.hist > 0 && macd.histDelta > 0;
    const expandingRed = macd.hist < 0 && macd.histDelta < 0;
    if (expandingGreen) up += (2 * trendWeight);
    if (expandingRed) down += (2 * trendWeight);

    if (macd.macd > 0) up += 1;
    if (macd.macd < 0) down += 1;
  }

  // 5. HEIKEN ASHI
  if (heikenColor) {
    if (heikenColor === "green" && heikenCount >= 2) up += 1;
    if (heikenColor === "red" && heikenCount >= 2) down += 1;
  }

  // 6. FAILED RECLAIM (Strong signal)
  if (failedVwapReclaim === true) down += 3;

  // 7. CHOP PENALTY (Dampen signals in chop)
  const rawUp = (up * chopPenalty) / ((up + down) * chopPenalty);

  return { upScore: up, downScore: down, rawUp, regime };
}

export function applyTimeAwareness(rawUp, remainingMinutes, windowMinutes) {
  const timeDecay = clamp(remainingMinutes / windowMinutes, 0, 1);
  const adjustedUp = clamp(0.5 + (rawUp - 0.5) * timeDecay, 0, 1);
  return { timeDecay, adjustedUp, adjustedDown: 1 - adjustedUp };
}
