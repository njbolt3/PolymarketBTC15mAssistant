import WebSocket from "ws";
import { CONFIG } from "../config.js";
import { wsAgentForUrl } from "../net/proxy.js";

function toNumber(x) {
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
}

const WS_URL = "wss://ws-feed.exchange.coinbase.com";

/**
 * Start a WebSocket connection to Coinbase Exchange ticker feed.
 * @param {Object} options
 * @param {string} [options.productId] - Product ID to subscribe to (default: CONFIG.productId)
 * @param {Function} [options.onUpdate] - Callback for price updates
 * @returns {{ getLast: () => { price: number|null, ts: number|null }, close: () => void }}
 */
export function startCoinbaseTickerStream({ productId = CONFIG.productId, onUpdate } = {}) {
    let ws = null;
    let closed = false;
    let reconnectMs = 500;
    let lastPrice = null;
    let lastTs = null;

    const connect = () => {
        if (closed) return;

        ws = new WebSocket(WS_URL, { agent: wsAgentForUrl(WS_URL) });

        ws.on("open", () => {
            reconnectMs = 500;

            // Subscribe to the ticker channel
            const subscribeMessage = JSON.stringify({
                type: "subscribe",
                product_ids: [productId],
                channels: ["ticker"]
            });
            ws.send(subscribeMessage);
        });

        ws.on("message", (buf) => {
            try {
                const msg = JSON.parse(buf.toString());

                // Only process ticker messages
                if (msg.type !== "ticker") return;

                const p = toNumber(msg.price);
                if (p === null) return;

                lastPrice = p;
                lastTs = Date.now();
                if (typeof onUpdate === "function") onUpdate({ price: lastPrice, ts: lastTs });
            } catch {
                return;
            }
        });

        const scheduleReconnect = () => {
            if (closed) return;
            try {
                ws?.terminate();
            } catch {
                // ignore
            }
            ws = null;
            const wait = reconnectMs;
            reconnectMs = Math.min(10_000, Math.floor(reconnectMs * 1.5));
            setTimeout(connect, wait);
        };

        ws.on("close", scheduleReconnect);
        ws.on("error", scheduleReconnect);
    };

    connect();

    return {
        getLast() {
            return { price: lastPrice, ts: lastTs };
        },
        close() {
            closed = true;
            try {
                ws?.close();
            } catch {
                // ignore
            }
            ws = null;
        }
    };
}
