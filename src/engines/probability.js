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
    bb,     // { basis, upper, lower }
    // NEW TIER 1 SIGNALS
    roc,           // { roc, acceleration, isAccelerating }
    emaCross,      // { signal, strength, isCrossover }
    rsiDivergence, // { type, strength }
    polyMomentum   // { delta, direction }
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

  // ══════════════════════════════════════════════════════════════
  // TIER 1: NEW HIGH-IMPACT SIGNALS
  // ══════════════════════════════════════════════════════════════

  // 1. RATE OF CHANGE (ROC) with Acceleration
  // Accelerating momentum is a stronger signal than just direction
  if (roc) {
    if (roc.roc > 0) {
      up += roc.isAccelerating ? 3 : 1.5;
    } else if (roc.roc < 0) {
      down += roc.isAccelerating ? 3 : 1.5;
    }
  }

  // 2. EMA CROSSOVER (Fast 3 / Slow 8)
  // Crossovers are strong signals, existing trends are confirmations
  if (emaCross) {
    if (emaCross.signal === "BULLISH_CROSS") {
      up += 4; // Strong buy signal
    } else if (emaCross.signal === "BEARISH_CROSS") {
      down += 4; // Strong sell signal
    } else if (emaCross.signal === "BULLISH") {
      up += 1.5 * trendWeight;
    } else if (emaCross.signal === "BEARISH") {
      down += 1.5 * trendWeight;
    }
  }

  // 3. RSI DIVERGENCE (Contrarian signal - very powerful)
  // Bullish divergence = price down, RSI up = reversal likely
  if (rsiDivergence && rsiDivergence.type !== "NONE") {
    const divStrength = Math.min(rsiDivergence.strength / 10, 3); // Cap at 3
    if (rsiDivergence.type === "BULLISH") {
      up += 2 + divStrength;
    } else if (rsiDivergence.type === "BEARISH") {
      down += 2 + divStrength;
    }
  }

  // 4. POLYMARKET MOMENTUM (Smart money signal)
  // If Poly odds are shifting, that's a leading indicator
  if (polyMomentum && polyMomentum.delta !== null) {
    const polyDelta = Math.abs(polyMomentum.delta);
    if (polyDelta >= 2) { // At least 2 cents movement
      if (polyMomentum.direction === "UP") {
        up += Math.min(polyDelta / 2, 3);
      } else if (polyMomentum.direction === "DOWN") {
        down += Math.min(polyDelta / 2, 3);
      }
    }
  }

  // ══════════════════════════════════════════════════════════════
  // EXISTING SIGNALS (REDUCED WEIGHT - these are more lagging)
  // ══════════════════════════════════════════════════════════════

  // 5. VWAP & TREND (Reduced from 2 to 1.5)
  if (price !== null && vwap !== null) {
    if (price > vwap) up += (1.5 * trendWeight);
    if (price < vwap) down += (1.5 * trendWeight);
  }

  if (vwapSlope !== null) {
    if (vwapSlope > 0) up += (1 * trendWeight);
    if (vwapSlope < 0) down += (1 * trendWeight);
  }

  // 6. RSI (Keep for extreme readings only)
  if (rsi !== null) {
    if (isRange) {
      if (rsi < 30) up += 2;
      if (rsi > 70) down += 2;
    } else {
      if (rsi > 60 && rsiSlope > 0) up += 1;
      if (rsi < 40 && rsiSlope < 0) down += 1;
    }
  }

  // 7. BOLLINGER BANDS (Mean Reversion - keep)
  if (bb && price !== null) {
    if (price <= bb.lower) up += (2 * rangeWeight);
    if (price >= bb.upper) down += (2 * rangeWeight);
  }

  // 8. MACD (Reduced weight - it's a lagging indicator)
  if (macd?.hist !== null && macd?.histDelta !== null) {
    const expandingGreen = macd.hist > 0 && macd.histDelta > 0;
    const expandingRed = macd.hist < 0 && macd.histDelta < 0;
    if (expandingGreen) up += 1;
    if (expandingRed) down += 1;
  }

  // 9. HEIKEN ASHI (Keep but reduce - confirmation only)
  if (heikenColor) {
    if (heikenColor === "green" && heikenCount >= 3) up += 0.5;
    if (heikenColor === "red" && heikenCount >= 3) down += 0.5;
  }

  // 10. FAILED RECLAIM (Strong bearish signal - keep)
  if (failedVwapReclaim === true) down += 3;

  // ══════════════════════════════════════════════════════════════
  // FINAL CALCULATION
  // ══════════════════════════════════════════════════════════════

  // Apply chop penalty
  const adjustedUp = up * chopPenalty;
  const adjustedDown = down * chopPenalty;
  const total = adjustedUp + adjustedDown;
  const rawUp = total > 0 ? adjustedUp / total : 0.5;

  return {
    upScore: up,
    downScore: down,
    rawUp,
    regime,
    // Debug info for new signals
    tier1Signals: {
      roc: roc?.roc ?? null,
      rocAccel: roc?.isAccelerating ?? null,
      emaCross: emaCross?.signal ?? null,
      rsiDiv: rsiDivergence?.type ?? null,
      polyMom: polyMomentum?.direction ?? null
    }
  };
}

export function applyTimeAwareness(rawUp, remainingMinutes, windowMinutes) {
  const timeDecay = clamp(remainingMinutes / windowMinutes, 0, 1);
  const adjustedUp = clamp(0.5 + (rawUp - 0.5) * timeDecay, 0, 1);
  return { timeDecay, adjustedUp, adjustedDown: 1 - adjustedUp };
}
