import { CONFIG } from "./config.js";
import { fetchKlines, fetchLastPrice } from "./data/coinbase.js";
import { fetchChainlinkBtcUsd } from "./data/chainlink.js";
import { startChainlinkPriceStream } from "./data/chainlinkWs.js";
import { startPolymarketChainlinkPriceStream } from "./data/polymarketLiveWs.js";
import {
  fetchMarketBySlug,
  fetchLiveEventsBySeriesId,
  flattenEventMarkets,
  pickLatestLiveMarket,
  fetchClobPrice,
  fetchOrderBook,
  summarizeOrderBook
} from "./data/polymarket.js";
import { computeSessionVwap, computeVwapSeries } from "./indicators/vwap.js";
import { computeRsi, sma, slopeLast } from "./indicators/rsi.js";
import { computeMacd } from "./indicators/macd.js";
import { computeHeikenAshi, countConsecutive } from "./indicators/heikenAshi.js";
import { detectRegime } from "./engines/regime.js";
import { scoreDirection, applyTimeAwareness } from "./engines/probability.js";
import { computeEdge, decide } from "./engines/edge.js";
import { computeAtr, computeBollingerBands } from "./indicators/volatility.js";
import { computeRocWithAcceleration, computeEmaCrossover, detectRsiDivergence } from "./indicators/momentum.js";
import { formatNumber, formatPct, getCandleWindowTiming, sleep } from "./utils.js";
import { startCoinbaseTickerStream } from "./data/coinbaseWs.js";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { applyGlobalProxyFromEnv } from "./net/proxy.js";
import { startWebServer, broadcastData } from "./server.js";
import {
  getPending,
  setPending,
  settlePrediction,
  getHistory,
  getAccuracyStats,
  buildPolymarketUrl
} from "./predictionHistory.js";

function countVwapCrosses(closes, vwapSeries, lookback) {
  if (closes.length < lookback || vwapSeries.length < lookback) return null;
  let crosses = 0;
  for (let i = closes.length - lookback + 1; i < closes.length; i += 1) {
    const prev = closes[i - 1] - vwapSeries[i - 1];
    const cur = closes[i] - vwapSeries[i];
    if (prev === 0) continue;
    if ((prev > 0 && cur < 0) || (prev < 0 && cur > 0)) crosses += 1;
  }
  return crosses;
}

applyGlobalProxyFromEnv();

function fmtTimeLeft(mins) {
  const totalSeconds = Math.max(0, Math.floor(mins * 60));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ANSI = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[36m",  // cyan - better visibility on dark backgrounds
  lightRed: "\x1b[91m",
  gray: "\x1b[90m",
  white: "\x1b[97m",
  dim: "\x1b[2m"
};

function screenWidth() {
  const w = Number(process.stdout?.columns);
  return Number.isFinite(w) && w >= 40 ? w : 80;
}

function sepLine(ch = "─") {
  const w = screenWidth();
  return `${ANSI.white}${ch.repeat(w)}${ANSI.reset}`;
}

function renderScreen(text) {
  try {
    readline.cursorTo(process.stdout, 0, 0);
    readline.clearScreenDown(process.stdout);
  } catch {
    // ignore
  }
  process.stdout.write(text);
}

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

function padLabel(label, width) {
  const visible = stripAnsi(label).length;
  if (visible >= width) return label;
  return label + " ".repeat(width - visible);
}

function centerText(text, width) {
  const visible = stripAnsi(text).length;
  if (visible >= width) return text;
  const left = Math.floor((width - visible) / 2);
  const right = width - visible - left;
  return " ".repeat(left) + text + " ".repeat(right);
}

const LABEL_W = 16;
function kv(label, value) {
  const l = padLabel(String(label), LABEL_W);
  return `${l}${value}`;
}

const atrHistory = [];

function section(title) {
  return `${ANSI.white}${title}${ANSI.reset}`;
}

function colorPriceLine({ label, price, prevPrice, decimals = 0, prefix = "" }) {
  if (price === null || price === undefined) {
    return `${label}: ${ANSI.gray}-${ANSI.reset}`;
  }

  const p = Number(price);
  const prev = prevPrice === null || prevPrice === undefined ? null : Number(prevPrice);

  let color = ANSI.reset;
  let arrow = "";
  if (prev !== null && Number.isFinite(prev) && Number.isFinite(p) && p !== prev) {
    if (p > prev) {
      color = ANSI.green;
      arrow = " ↑";
    } else {
      color = ANSI.red;
      arrow = " ↓";
    }
  }

  const formatted = `${prefix}${formatNumber(p, decimals)}`;
  return `${label}: ${color}${formatted}${arrow}${ANSI.reset}`;
}

function formatSignedDelta(delta, base) {
  if (delta === null || base === null || base === 0) return `${ANSI.gray}-${ANSI.reset}`;
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
  const pct = (Math.abs(delta) / Math.abs(base)) * 100;
  return `${sign}$${Math.abs(delta).toFixed(2)}, ${sign}${pct.toFixed(2)}%`;
}

function colorByNarrative(text, narrative) {
  if (narrative === "LONG") return `${ANSI.green}${text}${ANSI.reset}`;
  if (narrative === "SHORT") return `${ANSI.red}${text}${ANSI.reset}`;
  return `${ANSI.gray}${text}${ANSI.reset}`;
}

function formatNarrativeValue(label, value, narrative) {
  return `${label}: ${colorByNarrative(value, narrative)}`;
}

function narrativeFromSign(x) {
  if (x === null || x === undefined || !Number.isFinite(Number(x)) || Number(x) === 0) return "NEUTRAL";
  return Number(x) > 0 ? "LONG" : "SHORT";
}

function narrativeFromRsi(rsi) {
  if (rsi === null || rsi === undefined || !Number.isFinite(Number(rsi))) return "NEUTRAL";
  const v = Number(rsi);
  if (v >= 55) return "LONG";
  if (v <= 45) return "SHORT";
  return "NEUTRAL";
}

function narrativeFromSlope(slope) {
  if (slope === null || slope === undefined || !Number.isFinite(Number(slope)) || Number(slope) === 0) return "NEUTRAL";
  return Number(slope) > 0 ? "LONG" : "SHORT";
}

function formatProbPct(p, digits = 0) {
  if (p === null || p === undefined || !Number.isFinite(Number(p))) return "-";
  return `${(Number(p) * 100).toFixed(digits)}%`;
}

function fmtEtTime(now = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(now);
  } catch {
    return "-";
  }
}

function getBtcSession(now = new Date()) {
  const h = now.getUTCHours();
  const inAsia = h >= 0 && h < 8;
  const inEurope = h >= 7 && h < 16;
  const inUs = h >= 13 && h < 22;

  if (inEurope && inUs) return "Europe/US overlap";
  if (inAsia && inEurope) return "Asia/Europe overlap";
  if (inAsia) return "Asia";
  if (inEurope) return "Europe";
  if (inUs) return "US";
  return "Off-hours";
}

function parsePriceToBeat(market) {
  const text = String(market?.question ?? market?.title ?? "");
  if (!text) return null;
  const m = text.match(/price\s*to\s*beat[^\d$]*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i);
  if (!m) return null;
  const raw = m[1].replace(/,/g, "");
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

const dumpedMarkets = new Set();

function safeFileSlug(x) {
  return String(x ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 120);
}

function extractNumericFromMarket(market) {
  const directKeys = [
    "priceToBeat",
    "price_to_beat",
    "strikePrice",
    "strike_price",
    "strike",
    "threshold",
    "thresholdPrice",
    "threshold_price",
    "targetPrice",
    "target_price",
    "referencePrice",
    "reference_price"
  ];

  for (const k of directKeys) {
    const v = market?.[k];
    const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
    if (Number.isFinite(n)) return n;
  }

  const seen = new Set();
  const stack = [{ obj: market, depth: 0 }];

  while (stack.length) {
    const { obj, depth } = stack.pop();
    if (!obj || typeof obj !== "object") continue;
    if (seen.has(obj) || depth > 6) continue;
    seen.add(obj);

    const entries = Array.isArray(obj) ? obj.entries() : Object.entries(obj);
    for (const [key, value] of entries) {
      const k = String(key).toLowerCase();
      if (value && typeof value === "object") {
        stack.push({ obj: value, depth: depth + 1 });
        continue;
      }

      if (!/(price|strike|threshold|target|beat)/i.test(k)) continue;

      const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
      if (!Number.isFinite(n)) continue;

      if (n > 1000 && n < 2_000_000) return n;
    }
  }

  return null;
}

function priceToBeatFromPolymarketMarket(market) {
  const n = extractNumericFromMarket(market);
  if (n !== null) return n;
  return parsePriceToBeat(market);
}

const marketCache = {
  market: null,
  fetchedAtMs: 0
};

async function resolveCurrentBtc15mMarket() {
  if (CONFIG.polymarket.marketSlug) {
    return await fetchMarketBySlug(CONFIG.polymarket.marketSlug);
  }

  if (!CONFIG.polymarket.autoSelectLatest) return null;

  const now = Date.now();
  if (marketCache.market && now - marketCache.fetchedAtMs < CONFIG.pollIntervalMs) {
    return marketCache.market;
  }

  const events = await fetchLiveEventsBySeriesId({ seriesId: CONFIG.polymarket.seriesId, limit: 25 });
  const markets = flattenEventMarkets(events);
  const picked = pickLatestLiveMarket(markets);

  marketCache.market = picked;
  marketCache.fetchedAtMs = now;
  return picked;
}

function safeJsonParse(str, fallback = []) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

async function fetchPolymarketSnapshot() {
  const market = await resolveCurrentBtc15mMarket();

  if (!market) return { ok: false, reason: "market_not_found" };

  const outcomes = Array.isArray(market.outcomes) ? market.outcomes : (typeof market.outcomes === "string" ? safeJsonParse(market.outcomes, []) : []);
  const outcomePrices = Array.isArray(market.outcomePrices)
    ? market.outcomePrices
    : (typeof market.outcomePrices === "string" ? safeJsonParse(market.outcomePrices, []) : []);

  const clobTokenIds = Array.isArray(market.clobTokenIds)
    ? market.clobTokenIds
    : (typeof market.clobTokenIds === "string" ? safeJsonParse(market.clobTokenIds, []) : []);


  let upTokenId = null;
  let downTokenId = null;
  for (let i = 0; i < outcomes.length; i += 1) {
    const label = String(outcomes[i]);
    const tokenId = clobTokenIds[i] ? String(clobTokenIds[i]) : null;
    if (!tokenId) continue;

    if (label.toLowerCase() === CONFIG.polymarket.upOutcomeLabel.toLowerCase()) upTokenId = tokenId;
    if (label.toLowerCase() === CONFIG.polymarket.downOutcomeLabel.toLowerCase()) downTokenId = tokenId;
  }

  const upIndex = outcomes.findIndex((x) => String(x).toLowerCase() === CONFIG.polymarket.upOutcomeLabel.toLowerCase());
  const downIndex = outcomes.findIndex((x) => String(x).toLowerCase() === CONFIG.polymarket.downOutcomeLabel.toLowerCase());

  const gammaYes = upIndex >= 0 ? Number(outcomePrices[upIndex]) : null;
  const gammaNo = downIndex >= 0 ? Number(outcomePrices[downIndex]) : null;

  if (!upTokenId || !downTokenId) {
    return {
      ok: false,
      reason: "missing_token_ids",
      market,
      outcomes,
      clobTokenIds,
      outcomePrices
    };
  }

  let upBuy = null;
  let downBuy = null;
  let upBookSummary = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null };
  let downBookSummary = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null };

  try {
    const [yesBuy, noBuy, upBook, downBook] = await Promise.all([
      fetchClobPrice({ tokenId: upTokenId, side: "buy" }),
      fetchClobPrice({ tokenId: downTokenId, side: "buy" }),
      fetchOrderBook({ tokenId: upTokenId }),
      fetchOrderBook({ tokenId: downTokenId })
    ]);

    upBuy = yesBuy;
    downBuy = noBuy;
    upBookSummary = summarizeOrderBook(upBook);
    downBookSummary = summarizeOrderBook(downBook);
  } catch {
    upBuy = null;
    downBuy = null;
    upBookSummary = {
      bestBid: Number(market.bestBid) || null,
      bestAsk: Number(market.bestAsk) || null,
      spread: Number(market.spread) || null,
      bidLiquidity: null,
      askLiquidity: null
    };
    downBookSummary = {
      bestBid: null,
      bestAsk: null,
      spread: Number(market.spread) || null,
      bidLiquidity: null,
      askLiquidity: null
    };
  }

  return {
    ok: true,
    market,
    tokens: { upTokenId, downTokenId },
    prices: {
      up: upBuy ?? gammaYes,
      down: downBuy ?? gammaNo
    },
    orderbook: {
      up: upBookSummary,
      down: downBookSummary
    }
  };
}

async function main() {
  const coinbaseStream = startCoinbaseTickerStream({ productId: CONFIG.productId });
  const polymarketLiveStream = startPolymarketChainlinkPriceStream({});
  const chainlinkStream = startChainlinkPriceStream({});

  // Start web server
  startWebServer();

  let prevSpotPrice = null;
  let prevCurrentPrice = null;
  let priceToBeatState = { slug: null, value: null, setAtMs: null };
  let lastTrackedSlug = null;  // Track which market we're monitoring for settlement
  let prevPolyUp = null;  // For Polymarket momentum tracking
  let prevPolyDown = null;
  const rsiHistory = [];  // For RSI divergence detection

  while (true) {
    const timing = getCandleWindowTiming(CONFIG.candleWindowMinutes);

    const wsTick = coinbaseStream.getLast();
    const wsPrice = wsTick?.price ?? null;

    const polymarketWsTick = polymarketLiveStream.getLast();
    const polymarketWsPrice = polymarketWsTick?.price ?? null;

    const chainlinkWsTick = chainlinkStream.getLast();
    const chainlinkWsPrice = chainlinkWsTick?.price ?? null;

    try {
      const chainlinkPromise = polymarketWsPrice !== null
        ? Promise.resolve({ price: polymarketWsPrice, updatedAt: polymarketWsTick?.updatedAt ?? null, source: "polymarket_ws" })
        : chainlinkWsPrice !== null
          ? Promise.resolve({ price: chainlinkWsPrice, updatedAt: chainlinkWsTick?.updatedAt ?? null, source: "chainlink_ws" })
          : fetchChainlinkBtcUsd();

      const [klines1m, klines5m, lastPrice, chainlink, poly] = await Promise.all([
        fetchKlines({ granularity: 60, limit: 240 }),
        fetchKlines({ granularity: 300, limit: 200 }),
        fetchLastPrice(),
        chainlinkPromise,
        fetchPolymarketSnapshot()
      ]);

      const settlementMs = poly.ok && poly.market?.endDate ? new Date(poly.market.endDate).getTime() : null;
      const settlementLeftMin = settlementMs ? (settlementMs - Date.now()) / 60_000 : null;

      const timeLeftMin = settlementLeftMin ?? timing.remainingMinutes;

      const candles = klines1m;
      const closes = candles.map((c) => c.close);

      const vwap = computeSessionVwap(candles);
      const vwapSeries = computeVwapSeries(candles);
      const vwapNow = vwapSeries[vwapSeries.length - 1];

      const lookback = CONFIG.vwapSlopeLookbackMinutes;
      const vwapSlope = vwapSeries.length >= lookback ? (vwapNow - vwapSeries[vwapSeries.length - lookback]) / lookback : null;
      const vwapDist = vwapNow ? (lastPrice - vwapNow) / vwapNow : null;

      const rsiNow = computeRsi(closes, CONFIG.rsiPeriod);
      const rsiSeries = [];
      for (let i = 0; i < closes.length; i += 1) {
        const sub = closes.slice(0, i + 1);
        const r = computeRsi(sub, CONFIG.rsiPeriod);
        if (r !== null) rsiSeries.push(r);
      }
      const rsiMa = sma(rsiSeries, CONFIG.rsiMaPeriod);
      const rsiSlope = slopeLast(rsiSeries, 3);

      const macd = computeMacd(closes, CONFIG.macdFast, CONFIG.macdSlow, CONFIG.macdSignal);

      const ha = computeHeikenAshi(candles);
      const consec = countConsecutive(ha);

      const vwapCrossCount = countVwapCrosses(closes, vwapSeries, 20);
      const volumeRecent = candles.slice(-20).reduce((a, c) => a + c.volume, 0);
      const volumeAvg = candles.slice(-120).reduce((a, c) => a + c.volume, 0) / 6;

      // Volatility Indicators
      const atr = computeAtr(candles, 14);
      if (atr !== null) {
        atrHistory.push(atr);
        if (atrHistory.length > 50) atrHistory.shift();
      }
      const atrAvg = atrHistory.length ? atrHistory.reduce((a, b) => a + b, 0) / atrHistory.length : null;
      const bb = computeBollingerBands(closes, 20, 2);

      const failedVwapReclaim = vwapNow !== null && vwapSeries.length >= 3
        ? closes[closes.length - 1] < vwapNow && closes[closes.length - 2] > vwapSeries[vwapSeries.length - 2]
        : false;

      // ══════════════════════════════════════════════════════════════
      // TIER 1 MOMENTUM INDICATORS
      // ══════════════════════════════════════════════════════════════

      // 1. Rate of Change with Acceleration
      const roc = computeRocWithAcceleration(closes, 5, 3);

      // 2. EMA Crossover (Fast 3 / Slow 8)
      const emaCross = computeEmaCrossover(closes, 3, 8);

      // 3. RSI Divergence Detection
      if (rsiNow !== null) {
        rsiHistory.push(rsiNow);
        if (rsiHistory.length > 20) rsiHistory.shift();
      }
      const rsiDivergence = detectRsiDivergence(closes.slice(-10), rsiHistory.slice(-10), 5);

      // 4. Polymarket Momentum (shift in odds)
      const currentPolyUp = poly.ok ? poly.prices.up : null;
      const currentPolyDown = poly.ok ? poly.prices.down : null;
      let polyMomentum = null;
      if (currentPolyUp !== null && prevPolyUp !== null) {
        const delta = currentPolyUp - prevPolyUp;
        polyMomentum = {
          delta,
          direction: delta > 0 ? "UP" : delta < 0 ? "DOWN" : "FLAT"
        };
      }
      prevPolyUp = currentPolyUp;
      prevPolyDown = currentPolyDown;

      const regimeInfo = detectRegime({
        price: lastPrice,
        vwap: vwapNow,
        vwapSlope,
        vwapCrossCount,
        volumeRecent,
        volumeAvg,
        atr,
        atrAvg,
        bb
      });

      const scored = scoreDirection({
        price: lastPrice,
        vwap: vwapNow,
        vwapSlope,
        rsi: rsiNow,
        rsiSlope,
        macd,
        heikenColor: consec.color,
        heikenCount: consec.count,
        failedVwapReclaim,
        regime: regimeInfo.regime,
        bb,
        // Tier 1 signals
        roc,
        emaCross,
        rsiDivergence,
        polyMomentum
      });

      const timeAware = applyTimeAwareness(scored.rawUp, timeLeftMin, CONFIG.candleWindowMinutes);

      const marketUp = poly.ok ? poly.prices.up : null;
      const marketDown = poly.ok ? poly.prices.down : null;
      const edge = computeEdge({ modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown, marketYes: marketUp, marketNo: marketDown });

      const rec = decide({ remainingMinutes: timeLeftMin, edgeUp: edge.edgeUp, edgeDown: edge.edgeDown, modelUp: timeAware.adjustedUp, modelDown: timeAware.adjustedDown });

      const vwapSlopeLabel = vwapSlope === null ? "-" : vwapSlope > 0 ? "UP" : vwapSlope < 0 ? "DOWN" : "FLAT";

      const macdLabel = macd === null
        ? "-"
        : macd.hist < 0
          ? (macd.histDelta !== null && macd.histDelta < 0 ? "bearish (expanding)" : "bearish")
          : (macd.histDelta !== null && macd.histDelta > 0 ? "bullish (expanding)" : "bullish");

      const lastCandle = klines1m.length ? klines1m[klines1m.length - 1] : null;
      const lastClose = lastCandle?.close ?? null;
      const close1mAgo = klines1m.length >= 2 ? klines1m[klines1m.length - 2]?.close ?? null : null;
      const close3mAgo = klines1m.length >= 4 ? klines1m[klines1m.length - 4]?.close ?? null : null;
      const delta1m = lastClose !== null && close1mAgo !== null ? lastClose - close1mAgo : null;
      const delta3m = lastClose !== null && close3mAgo !== null ? lastClose - close3mAgo : null;

      const haNarrative = (consec.color ?? "").toLowerCase() === "green" ? "LONG" : (consec.color ?? "").toLowerCase() === "red" ? "SHORT" : "NEUTRAL";
      const rsiNarrative = narrativeFromSlope(rsiSlope);
      const macdNarrative = narrativeFromSign(macd?.hist ?? null);
      const vwapNarrative = narrativeFromSign(vwapDist);

      const regimeColor = regimeInfo.regime.includes("UP") ? ANSI.green : regimeInfo.regime.includes("DOWN") ? ANSI.red : ANSI.yellow;
      const regimeLine = `Regime: ${regimeColor}${regimeInfo.regime}${ANSI.reset} (${ANSI.dim}${regimeInfo.reason}${ANSI.reset})`;

      const bbLine = bb ? `BBands: $${formatNumber(bb.lower, 0)} - $${formatNumber(bb.upper, 0)} (ATR: ${formatNumber(atr, 2)})` : "BBands: -";

      const pLong = timeAware?.adjustedUp ?? null;
      const pShort = timeAware?.adjustedDown ?? null;
      const predictNarrative = (pLong !== null && pShort !== null && Number.isFinite(pLong) && Number.isFinite(pShort))
        ? (pLong > pShort ? "LONG" : pShort > pLong ? "SHORT" : "NEUTRAL")
        : "NEUTRAL";
      const predictValue = `${ANSI.green}LONG${ANSI.reset} ${ANSI.green}${formatProbPct(pLong, 0)}${ANSI.reset} / ${ANSI.red}SHORT${ANSI.reset} ${ANSI.red}${formatProbPct(pShort, 0)}${ANSI.reset}`;
      const predictLine = `Predict: ${predictValue}`;

      const marketUpStr = `${marketUp ?? "-"}${marketUp === null || marketUp === undefined ? "" : "¢"}`;
      const marketDownStr = `${marketDown ?? "-"}${marketDown === null || marketDown === undefined ? "" : "¢"}`;
      const polyHeaderValue = `${ANSI.green}↑ UP${ANSI.reset} ${marketUpStr}  |  ${ANSI.red}↓ DOWN${ANSI.reset} ${marketDownStr}`;

      const heikenValue = `${consec.color ?? "-"} x${consec.count}`;
      const heikenLine = formatNarrativeValue("Heiken Ashi", heikenValue, haNarrative);

      const rsiArrow = rsiSlope !== null && rsiSlope < 0 ? "↓" : rsiSlope !== null && rsiSlope > 0 ? "↑" : "-";
      const rsiValue = `${formatNumber(rsiNow, 1)} ${rsiArrow}`;
      const rsiLine = formatNarrativeValue("RSI", rsiValue, rsiNarrative);

      const macdLine = formatNarrativeValue("MACD", macdLabel, macdNarrative);

      const delta1Narrative = narrativeFromSign(delta1m);
      const delta3Narrative = narrativeFromSign(delta3m);
      const deltaValue = `${colorByNarrative(formatSignedDelta(delta1m, lastClose), delta1Narrative)} | ${colorByNarrative(formatSignedDelta(delta3m, lastClose), delta3Narrative)}`;
      const deltaLine = `Delta 1/3Min: ${deltaValue}`;

      const vwapValue = `${formatNumber(vwapNow, 0)} (${formatPct(vwapDist, 2)}) | slope: ${vwapSlopeLabel}`;
      const vwapLine = formatNarrativeValue("VWAP", vwapValue, vwapNarrative);

      const signalColor = rec.action === "ENTER" ? (rec.side === "UP" ? ANSI.green : ANSI.red) : ANSI.gray;
      const strengthColor = rec.strength === "STRONG" ? ANSI.green : rec.strength === "GOOD" ? ANSI.blue : ANSI.white;
      const signalLine = `Signal: ${signalColor}${rec.action === "ENTER" ? (rec.side === "UP" ? "BUY UP" : "BUY DOWN") : "NO TRADE"}${ANSI.reset} | ${strengthColor}${rec.strength || "WAITING"}${ANSI.reset}`;


      const signal = rec.action === "ENTER" ? (rec.side === "UP" ? "BUY UP" : "BUY DOWN") : "NO TRADE";

      const actionLine = rec.action === "ENTER"
        ? `${rec.action} NOW (${rec.phase} ENTRY)`
        : `NO TRADE (${rec.phase})`;

      const spreadUp = poly.ok ? poly.orderbook.up.spread : null;
      const spreadDown = poly.ok ? poly.orderbook.down.spread : null;

      const spread = spreadUp !== null && spreadDown !== null ? Math.max(spreadUp, spreadDown) : (spreadUp ?? spreadDown);
      const liquidity = poly.ok
        ? (Number(poly.market?.liquidityNum) || Number(poly.market?.liquidity) || null)
        : null;

      const spotPrice = wsPrice ?? lastPrice;
      const currentPrice = chainlink?.price ?? null;
      const marketSlug = poly.ok ? String(poly.market?.slug ?? "") : "";
      const marketStartMs = poly.ok && poly.market?.eventStartTime ? new Date(poly.market.eventStartTime).getTime() : null;

      if (marketSlug && priceToBeatState.slug !== marketSlug) {
        priceToBeatState = { slug: marketSlug, value: null, setAtMs: null };
      }

      // Only latch price-to-beat within a 5-second window after eventStartTime
      // This matches when Polymarket captures their reference price
      if (priceToBeatState.slug && priceToBeatState.value === null && currentPrice !== null) {
        const nowMs = Date.now();
        if (marketStartMs !== null) {
          const elapsedSinceStart = nowMs - marketStartMs;
          // Only latch if we're 0-5 seconds after the window start
          const okToLatch = elapsedSinceStart >= 0 && elapsedSinceStart <= 5000;
          if (okToLatch) {
            priceToBeatState = { slug: priceToBeatState.slug, value: Number(currentPrice), setAtMs: nowMs };
          }
        } else {
          // Fallback if no eventStartTime available
          priceToBeatState = { slug: priceToBeatState.slug, value: Number(currentPrice), setAtMs: nowMs };
        }
      }

      const priceToBeat = priceToBeatState.slug === marketSlug ? priceToBeatState.value : null;

      // Handle prediction tracking
      const pending = getPending();

      // Check if market changed (new window started) - settle previous prediction
      if (pending && pending.marketSlug && marketSlug && pending.marketSlug !== marketSlug) {
        // Market changed - settle the prediction with the last known current price
        if (prevCurrentPrice !== null) {
          settlePrediction(prevCurrentPrice);
        }
        lastTrackedSlug = null;
      }

      // Start tracking new prediction when we have a new market with price to beat
      if (marketSlug && priceToBeat !== null && lastTrackedSlug !== marketSlug) {
        const modelLong = timeAware?.adjustedUp ?? null;
        const modelShort = timeAware?.adjustedDown ?? null;
        if (modelLong !== null && modelShort !== null) {
          setPending({
            marketSlug,
            startPrice: priceToBeat,
            modelLong,
            modelShort,
            polyUp: marketUp,
            polyDown: marketDown
          });
          lastTrackedSlug = marketSlug;
        }
      }

      // Get history and accuracy stats for display
      const history = getHistory();
      const accuracyStats = getAccuracyStats();
      const polymarketUrl = buildPolymarketUrl(marketSlug);
      const currentPriceBaseLine = colorPriceLine({
        label: "CURRENT PRICE",
        price: currentPrice,
        prevPrice: prevCurrentPrice,
        decimals: 2,
        prefix: "$"
      });

      const ptbDelta = (currentPrice !== null && priceToBeat !== null && Number.isFinite(currentPrice) && Number.isFinite(priceToBeat))
        ? currentPrice - priceToBeat
        : null;
      const ptbDeltaColor = ptbDelta === null
        ? ANSI.gray
        : ptbDelta > 0
          ? ANSI.green
          : ptbDelta < 0
            ? ANSI.red
            : ANSI.gray;
      const ptbDeltaText = ptbDelta === null
        ? `${ANSI.gray}-${ANSI.reset}`
        : `${ptbDeltaColor}${ptbDelta > 0 ? "+" : ptbDelta < 0 ? "-" : ""}$${Math.abs(ptbDelta).toFixed(2)}${ANSI.reset}`;
      const currentPriceValue = currentPriceBaseLine.split(": ")[1] ?? currentPriceBaseLine;
      const currentPriceLine = kv("CURRENT PRICE:", `${currentPriceValue} (${ptbDeltaText})`);

      if (poly.ok && poly.market && priceToBeatState.value === null) {
        const slug = safeFileSlug(poly.market.slug || poly.market.id || "market");
        if (slug && !dumpedMarkets.has(slug)) {
          dumpedMarkets.add(slug);
          try {
            fs.mkdirSync("./logs", { recursive: true });
            fs.writeFileSync(path.join("./logs", `polymarket_market_${slug}.json`), JSON.stringify(poly.market, null, 2), "utf8");
          } catch {
            // ignore
          }
        }
      }

      const coinbaseSpotBaseLine = colorPriceLine({ label: "BTC (Coinbase)", price: spotPrice, prevPrice: prevSpotPrice, decimals: 0, prefix: "$" });
      const diffLine = (spotPrice !== null && currentPrice !== null && Number.isFinite(spotPrice) && Number.isFinite(currentPrice) && currentPrice !== 0)
        ? (() => {
          const diffUsd = spotPrice - currentPrice;
          const diffPct = (diffUsd / currentPrice) * 100;
          const sign = diffUsd > 0 ? "+" : diffUsd < 0 ? "-" : "";
          return ` (${sign}$${Math.abs(diffUsd).toFixed(2)}, ${sign}${Math.abs(diffPct).toFixed(2)}%)`;
        })()
        : "";
      const coinbaseSpotLine = `${coinbaseSpotBaseLine}${diffLine}`;
      const coinbaseSpotValue = coinbaseSpotLine.split(": ")[1] ?? coinbaseSpotLine;
      const coinbaseSpotKvLine = kv("BTC (Coinbase):", coinbaseSpotValue);

      const titleLine = poly.ok ? `${poly.market?.question ?? "-"}` : "-";
      const marketLine = kv("Market:", poly.ok ? (poly.market?.slug ?? "-") : "-");

      const timeColor = timeLeftMin >= 10 && timeLeftMin <= 15
        ? ANSI.green
        : timeLeftMin >= 5 && timeLeftMin < 10
          ? ANSI.yellow
          : timeLeftMin >= 0 && timeLeftMin < 5
            ? ANSI.red
            : ANSI.reset;
      const timeLeftLine = `⏱ Time left: ${timeColor}${fmtTimeLeft(timeLeftMin)}${ANSI.reset}`;

      const polyTimeLeftColor = settlementLeftMin !== null
        ? (settlementLeftMin >= 10 && settlementLeftMin <= 15
          ? ANSI.green
          : settlementLeftMin >= 5 && settlementLeftMin < 10
            ? ANSI.yellow
            : settlementLeftMin >= 0 && settlementLeftMin < 5
              ? ANSI.red
              : ANSI.reset)
        : ANSI.reset;

      // Format history for display - show 10 items + pending
      const historyLines = history.slice(-10).reverse().map((h, i) => {
        const timeStr = h.settledAt ? new Date(h.settledAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : "--:--";
        const outcome = h.actualOutcome === "UP" ? `${ANSI.green}↑UP${ANSI.reset}` :
          h.actualOutcome === "DOWN" ? `${ANSI.red}↓DOWN${ANSI.reset}` :
            `${ANSI.gray}FLAT${ANSI.reset}`;
        const pred = h.modelPrediction === "LONG" ? `${ANSI.green}L${ANSI.reset}` : `${ANSI.red}S${ANSI.reset}`;
        const result = h.correct === null ? `${ANSI.gray}—${ANSI.reset}` :
          h.correct ? `${ANSI.green}✓${ANSI.reset}` : `${ANSI.red}✗${ANSI.reset}`;

        // Format model prediction percentages
        const modelPct = h.modelLong !== null && h.modelShort !== null
          ? `${Math.round(h.modelLong * 100)}/${Math.round(h.modelShort * 100)}`
          : "-";

        // Format Polymarket prices
        const polyPrices = h.polyUp !== null && h.polyDown !== null
          ? `${h.polyUp}¢/${h.polyDown}¢`
          : "-";

        // Format price change
        const priceDelta = h.startPrice !== null && h.endPrice !== null
          ? (h.endPrice - h.startPrice).toFixed(0)
          : "-";
        const deltaColor = Number(priceDelta) > 0 ? ANSI.green : Number(priceDelta) < 0 ? ANSI.red : ANSI.gray;
        const deltaSign = Number(priceDelta) > 0 ? "+" : "";

        // Format start/end prices
        const startPriceStr = h.startPrice !== null ? `$${formatNumber(h.startPrice, 0)}` : "-";
        const endPriceStr = h.endPrice !== null ? `$${formatNumber(h.endPrice, 0)}` : "-";

        return `  ${timeStr} | ${pred} → ${outcome} ${result} | Model: ${modelPct} | Poly: ${polyPrices} | ${startPriceStr}→${endPriceStr} (${deltaColor}${deltaSign}$${priceDelta}${ANSI.reset})`;
      });

      // Add pending row to terminal display
      if (pending) {
        const timeNow = "NOW  ";
        const pred = pending.modelLong > pending.modelShort ? `${ANSI.green}L${ANSI.reset}` : `${ANSI.red}S${ANSI.reset}`;
        const modelPct = pending.modelLong !== null && pending.modelShort !== null
          ? `${Math.round(pending.modelLong * 100)}/${Math.round(pending.modelShort * 100)}`
          : "-";
        const polyPrices = pending.polyUp !== null && pending.polyDown !== null
          ? `${pending.polyUp}¢/${pending.polyDown}¢`
          : "-";
        const startPriceStr = pending.startPrice !== null ? `$${formatNumber(pending.startPrice, 0)}` : "-";

        const pendingLine = `  ${ANSI.yellow}${timeNow}${ANSI.reset} | ${pred} → ⏳ Pending | Model: ${modelPct} | Poly: ${polyPrices} | ${startPriceStr}→$????`;
        historyLines.unshift(pendingLine);
      }

      const winRateText = accuracyStats.total > 0
        ? `${ANSI.white}${Math.round(accuracyStats.winRate * 100)}%${ANSI.reset} (${accuracyStats.wins}/${accuracyStats.total})`
        : `${ANSI.gray}-${ANSI.reset}`;

      const lines = [
        titleLine,
        marketLine,
        polymarketUrl ? kv("View:", `${ANSI.blue}${polymarketUrl}${ANSI.reset}`) : null,
        kv("Time left:", `${timeColor}${fmtTimeLeft(timeLeftMin)}${ANSI.reset}`),
        "",
        sepLine(),
        "",
        kv("TA Predict:", predictValue),
        regimeLine,
        bbLine,
        "",
        kv("POLYMARKET:", polyHeaderValue),
        kv("Signal:", signalLine),
        kv("Phase:", rec.phase),
        kv("Heiken Ashi:", heikenLine.split(": ")[1] ?? heikenLine),
        kv("RSI:", rsiLine.split(": ")[1] ?? rsiLine),
        kv("MACD:", macdLine.split(": ")[1] ?? macdLine),
        kv("Delta 1/3:", deltaLine.split(": ")[1] ?? deltaLine),
        kv("VWAP:", vwapLine.split(": ")[1] ?? vwapLine),
        "",
        sepLine(),
        "",
        kv("POLYMARKET:", polyHeaderValue),
        liquidity !== null ? kv("Liquidity:", formatNumber(liquidity, 0)) : null,
        settlementLeftMin !== null ? kv("Time left:", `${polyTimeLeftColor}${fmtTimeLeft(settlementLeftMin)}${ANSI.reset}`) : null,
        priceToBeat !== null ? kv("PRICE TO BEAT: ", `$${formatNumber(priceToBeat, 0)}`) : kv("PRICE TO BEAT: ", `${ANSI.gray}-${ANSI.reset}`),
        currentPriceLine,
        "",
        sepLine(),
        "",
        coinbaseSpotKvLine,
        "",
        sepLine(),
        "",
        kv("HISTORY:", `Win Rate: ${winRateText}`),
        ...historyLines,
        "",
        sepLine(),
        "",
        kv("ET | Session:", `${ANSI.white}${fmtEtTime(new Date())}${ANSI.reset} | ${ANSI.white}${getBtcSession(new Date())}${ANSI.reset}`),
        "",
        sepLine(),
        centerText(`${ANSI.dim}${ANSI.gray}created by @krajekis${ANSI.reset}`, screenWidth())
      ].filter((x) => x !== null);

      renderScreen(lines.join("\n") + "\n");

      // Broadcast data to web clients
      broadcastData({
        marketTitle: poly.ok ? (poly.market?.question ?? null) : null,
        marketSlug: poly.ok ? (poly.market?.slug ?? null) : null,
        polymarketUrl,
        timeLeftMin,
        predLong: timeAware?.adjustedUp ?? null,
        predShort: timeAware?.adjustedDown ?? null,
        polyUp: marketUp,
        polyDown: marketDown,
        liquidity,
        heikenAshi: `${consec.color ?? "-"} x${consec.count}`,
        heikenNarrative: haNarrative,
        rsi: `${formatNumber(rsiNow, 1)} ${rsiSlope !== null && rsiSlope < 0 ? "↓" : rsiSlope !== null && rsiSlope > 0 ? "↑" : "-"}`,
        rsiNarrative,
        macd: macdLabel,
        macdNarrative,
        vwap: `${formatNumber(vwapNow, 0)} (${formatPct(vwapDist, 2)}) | slope: ${vwapSlopeLabel}`,
        vwapNarrative,
        delta: `${formatSignedDelta(delta1m, lastClose)} | ${formatSignedDelta(delta3m, lastClose)}`,
        currentPrice,
        priceToBeat,
        ptbDelta,
        coinbasePrice: spotPrice,
        session: `${fmtEtTime(new Date())} | ${getBtcSession(new Date())}`,
        history: history.slice(-10).reverse(),
        accuracyStats,
        pending: getPending(),
        recommendation: rec,
        regime: regimeInfo,
        atr,
        bb
      });

      prevCurrentPrice = currentPrice ?? prevCurrentPrice;
    } catch (err) {
      console.log("────────────────────────────");
      console.log(`Error: ${err?.message ?? String(err)}`);
      console.log("────────────────────────────");
    }

    await sleep(CONFIG.pollIntervalMs);
  }
}

main();
