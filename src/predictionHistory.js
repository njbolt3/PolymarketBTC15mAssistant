import fs from "node:fs";
import path from "node:path";

import { appendCsvRow } from "./utils.js";

const HISTORY_FILE = "./logs/prediction_history.json";
const CSV_HISTORY_FILE = "./logs/full_history.csv";
const MAX_HISTORY = 10;

const CSV_HEADER = [
    "SettledAt",
    "Time",
    "MarketSlug",
    "StartPrice",
    "EndPrice",
    "ActualOutcome",
    "ModelPrediction",
    "ModelLong",
    "ModelShort",
    "PolyUp",
    "PolyDown",
    "Correct"
];

let state = {
    pending: null,
    history: []
};

/**
 * Load prediction history from disk.
 */
export function loadHistory() {
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            const data = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
            state.history = Array.isArray(data.history) ? data.history.slice(-MAX_HISTORY) : [];
            state.pending = data.pending || null;
        }
    } catch {
        // Start fresh if file is corrupted
        state = { pending: null, history: [] };
    }
}

/**
 * Save prediction history to disk.
 */
function saveHistory() {
    try {
        fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(state, null, 2), "utf8");
    } catch {
        // Ignore write errors
    }
}

/**
 * Set the current pending prediction for this window.
 * @param {Object} data
 * @param {string} data.marketSlug
 * @param {number} data.startPrice - Price at window start (price to beat)
 * @param {number} data.modelLong - Model's long probability (0-1)
 * @param {number} data.modelShort - Model's short probability (0-1)
 * @param {number} data.polyUp - Polymarket up price (cents)
 * @param {number} data.polyDown - Polymarket down price (cents)
 */
export function setPending(data) {
    state.pending = {
        marketSlug: data.marketSlug,
        startPrice: data.startPrice,
        modelLong: data.modelLong,
        modelShort: data.modelShort,
        polyUp: data.polyUp,
        polyDown: data.polyDown,
        timestamp: Date.now()
    };
    saveHistory();
}

/**
 * Get the current pending prediction.
 */
export function getPending() {
    return state.pending;
}

/**
 * Settle the current prediction and add to history.
 * @param {number} endPrice - The final price at window end
 * @returns {Object|null} The settled prediction or null if no pending
 */
export function settlePrediction(endPrice) {
    if (!state.pending || state.pending.startPrice === null) {
        return null;
    }

    const actualOutcome = endPrice > state.pending.startPrice ? "UP" :
        endPrice < state.pending.startPrice ? "DOWN" : "FLAT";

    const modelPrediction = state.pending.modelLong > state.pending.modelShort ? "LONG" : "SHORT";

    // LONG predicts UP, SHORT predicts DOWN
    const correct = (modelPrediction === "LONG" && actualOutcome === "UP") ||
        (modelPrediction === "SHORT" && actualOutcome === "DOWN");

    const settledAt = Date.now();
    const settled = {
        marketSlug: state.pending.marketSlug,
        startPrice: state.pending.startPrice,
        endPrice,
        actualOutcome,
        modelPrediction,
        modelLong: state.pending.modelLong,
        modelShort: state.pending.modelShort,
        polyUp: state.pending.polyUp,
        polyDown: state.pending.polyDown,
        correct: actualOutcome === "FLAT" ? null : correct,
        settledAt
    };

    state.history.push(settled);

    // Keep only last N predictions for JSON/UI
    if (state.history.length > MAX_HISTORY) {
        state.history = state.history.slice(-MAX_HISTORY);
    }

    // Push to Full CSV History
    try {
        const timeStr = new Date(settledAt).toISOString();
        const row = [
            settledAt,
            timeStr,
            settled.marketSlug,
            settled.startPrice,
            settled.endPrice,
            settled.actualOutcome,
            settled.modelPrediction,
            settled.modelLong,
            settled.modelShort,
            settled.polyUp,
            settled.polyDown,
            settled.correct === null ? "FLAT" : settled.correct
        ];
        appendCsvRow(CSV_HISTORY_FILE, CSV_HEADER, row);
    } catch {
        // Ignore CSV write errors
    }

    state.pending = null;
    saveHistory();

    return settled;
}

/**
 * Get the prediction history (last 5).
 */
export function getHistory() {
    return state.history;
}

/**
 * Get accuracy stats from history.
 * @returns {{ wins: number, losses: number, total: number, winRate: number|null }}
 */
export function getAccuracyStats() {
    const validPredictions = state.history.filter(p => p.correct !== null);
    const wins = validPredictions.filter(p => p.correct).length;
    const losses = validPredictions.filter(p => !p.correct).length;
    const total = validPredictions.length;
    const winRate = total > 0 ? wins / total : null;

    return { wins, losses, total, winRate };
}

/**
 * Build the Polymarket event URL from a market slug.
 * @param {string} slug - The market slug
 * @returns {string} The full Polymarket URL
 */
export function buildPolymarketUrl(slug) {
    if (!slug) return null;
    return `https://polymarket.com/event/${slug}`;
}

// Load history on module initialization
loadHistory();
