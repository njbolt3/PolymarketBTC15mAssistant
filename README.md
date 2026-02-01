# Polymarket BTC 15m Assistant

A real-time trading assistant and prediction engine for Polymarket **"Bitcoin Up or Down" 15-minute** markets. 

Version 1.5 features a multi-indicator TA model, persistent prediction history, and a sleek real-time web dashboard.

## Features

### 🚀 Real-time Prediction Engine
- **TA Ensemble**: Combines Heiken Ashi, RSI (slope-aware), MACD, and VWAP to generate probabilistic Long/Short scores.
- **Time Awareness**: Model confidence automatically adjusts based on the 15-minute window's remaining time.
- **Trade Signals**: Real-time recommendations (`BUY UP`, `BUY DOWN`, `NO TRADE`) with strength levels (`STRONG`, `GOOD`, `OPTIONAL`).
- **Phase Detection**: Identifies `EARLY`, `MID`, and `LATE` window phases for refined entry logic.

### 📊 Web Dashboard (`localhost:3000`)
- **Visual UI**: A modern, dark-themed dashboard showing all live indicators and predictions.
- **Market Table**: Persistent prediction history showing the last 10 window results.
- **Pending Status**: Live tracking of the current active prediction window.
- **Link Integration**: Direct clickable links to the active Polymarket event.

### ⛓️ Data & Reliability
- **Coinbase Integration**: Real-time spot price feed from Coinbase Exchange.
- **Chainlink Oracle**: Live BTC/USD price feed directly from the Polymarket/Chainlink source.
- **Fallback Logic**: Automatic fallback to on-chain Polygon Chainlink data if websockets fail.
- **Persistence**: Prediction history and win-rate statistics are saved to `./logs/prediction_history.json`.

---

## Requirements

- Node.js **18+**
- npm (comes with Node)

## Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/FrondEnt/PolymarketBTC15mAssistant.git
   cd PolymarketBTC15mAssistant
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure Environment Variables (Optional):**
   The app works out of the box, but you can customize it:

   | Variable | Description | Default |
   |----------|-------------|---------|
   | `WEB_ENABLED` | Enable web dashboard | `true` |
   | `WEB_PORT` | Port for web server | `3000` |
   | `POLYMARKET_AUTO_SELECT_LATEST` | Auto-pick latest 15m market | `true` |
   | `POLYGON_RPC_URL` | Fallback Chainlink RPC | `https://polygon-rpc.com` |

---

## Usage

Start the assistant:
```bash
npm start
```

### Dashboard
Open `http://localhost:3000` in your browser to view the real-time UI.

### Terminal UI
The terminal provides a compact view of live stats:
- **TA Predict**: Long/Short probabilities.
- **Market**: Live Polymarket prices and liquidity.
- **History**: Win/Loss tracking for the last 10 windows.

---

## Safety

This is an experimental tool and **not financial advice**. Use at your own risk. Trading predictions are probabilistic and based on short-term technical indicators.

created by @krajekis
