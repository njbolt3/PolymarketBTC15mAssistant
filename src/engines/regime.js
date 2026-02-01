export function detectRegime({
  price, vwap, vwapSlope, vwapCrossCount,
  volumeRecent, volumeAvg,
  atr, atrAvg,
  bb
}) {
  if (price === null || vwap === null || vwapSlope === null) return { regime: "CHOP", reason: "missing_inputs" };

  const above = price > vwap;

  // 1. CHOP / SQUEEZE DETECTOR
  // If ATR is low compared to average, or Bollinger Bands are narrowing significantly
  const lowVolatility = atr !== null && atrAvg !== null ? atr < 0.8 * atrAvg : false;
  const bbWidth = bb ? (bb.upper - bb.lower) / bb.basis : null;
  const isSqueeze = bbWidth !== null && bbWidth < 0.002; // Very narrow bands

  const lowVolume = volumeRecent !== null && volumeAvg !== null ? volumeRecent < 0.7 * volumeAvg : false;

  if ((lowVolatility || isSqueeze) && Math.abs((price - vwap) / vwap) < 0.001) {
    return { regime: "CHOP", reason: isSqueeze ? "bb_squeeze" : "low_vol_flat" };
  }

  // 2. TREND DETECTOR
  const strongSlope = Math.abs(vwapSlope) > 0.5; // Threshold for trend strength

  if (above && vwapSlope > 0) {
    return {
      regime: "TREND_UP",
      reason: strongSlope ? "strong_trend_up" : "price_above_vwap_slope_up"
    };
  }

  if (!above && vwapSlope < 0) {
    return {
      regime: "TREND_DOWN",
      reason: strongSlope ? "strong_trend_down" : "price_below_vwap_slope_down"
    };
  }

  // 3. RANGE DETECTOR
  if (vwapCrossCount !== null && vwapCrossCount >= 3) {
    return { regime: "RANGE", reason: "frequent_vwap_cross" };
  }

  return { regime: "RANGE", reason: "default" };
}
