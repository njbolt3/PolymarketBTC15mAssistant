import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import { CONFIG } from "./config.js";

const MIME_TYPES = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".csv": "text/csv"
};

let wss = null;
let httpServer = null;

/**
 * Start the web server and WebSocket server.
 */
export function startWebServer() {
    if (!CONFIG.web?.enabled) {
        return { broadcastData: () => { } };
    }

    const port = CONFIG.web?.port ?? 3000;
    const publicDir = path.resolve(import.meta.dirname, "../public");
    const logsDir = path.resolve(import.meta.dirname, "../logs");

    httpServer = http.createServer((req, res) => {
        // Special route for prediction history download
        if (req.url === "/download-history") {
            const historyPath = path.join(logsDir, "full_history.csv");
            fs.readFile(historyPath, (err, data) => {
                if (err) {
                    res.writeHead(404);
                    res.end("History file not found");
                    return;
                }
                res.writeHead(200, {
                    "Content-Type": "text/csv",
                    "Content-Disposition": 'attachment; filename="polymarket_btc_history.csv"'
                });
                res.end(data);
            });
            return;
        }

        let filePath = req.url === "/" ? "/index.html" : req.url;
        filePath = path.join(publicDir, filePath);

        // Prevent directory traversal
        if (!filePath.startsWith(publicDir)) {
            res.writeHead(403);
            res.end("Forbidden");
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || "application/octet-stream";

        fs.readFile(filePath, (err, data) => {
            if (err) {
                if (err.code === "ENOENT") {
                    res.writeHead(404);
                    res.end("Not Found");
                } else {
                    res.writeHead(500);
                    res.end("Internal Server Error");
                }
                return;
            }
            res.writeHead(200, { "Content-Type": contentType });
            res.end(data);
        });
    });

    wss = new WebSocketServer({ server: httpServer });

    wss.on("connection", (ws) => {
        ws.on("error", () => { });
    });

    httpServer.listen(port, () => {
        console.log(`\n🌐 Web dashboard: http://localhost:${port}\n`);
    });

    return { broadcastData };
}

/**
 * Broadcast data to all connected WebSocket clients.
 * @param {Object} data - The data payload to broadcast
 */
export function broadcastData(data) {
    if (!wss) return;

    const message = JSON.stringify(data);
    for (const client of wss.clients) {
        if (client.readyState === 1) { // WebSocket.OPEN
            try {
                client.send(message);
            } catch {
                // ignore send errors
            }
        }
    }
}
