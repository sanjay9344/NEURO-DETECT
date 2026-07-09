// ============================================================
//  NEURO DETECT - Backend Server
//  Node.js + Express + WebSocket
//  Polls ESP32 every 50ms and broadcasts to all browser clients
// ============================================================

const express   = require("express");
const http      = require("http");
const WebSocket = require("ws");
const path      = require("path");

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// ─────────────────────────────────────────────
//  CONFIGURATION  →  Set your ESP32 IP here
//  (Printed in Serial Monitor after boot)
// ─────────────────────────────────────────────
const ESP32_IP      = process.env.ESP32_IP   || "192.168.1.100";
const ESP32_PORT    = process.env.ESP32_PORT  || 80;
const SERVER_PORT   = process.env.PORT        || 3000;
const POLL_INTERVAL = 50;   // ms — 20 Hz polling from ESP32

// ─────────────────────────────────────────────
//  SERVE STATIC FRONTEND
// ─────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ─────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────
let latestData     = null;
let esp32Connected = false;
let pollFailCount  = 0;
let totalReadings  = 0;
let tremorEvents   = 0;

// ─────────────────────────────────────────────
//  FETCH DATA FROM ESP32
// ─────────────────────────────────────────────
async function fetchFromESP32() {
  try {
    // Use built-in fetch (Node 18+) or fall back to http module
    const url = `http://${ESP32_IP}:${ESP32_PORT}/data`;

    let data;
    if (typeof fetch !== "undefined") {
      // Node 18+ native fetch
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      data = await res.json();
    } else {
      // Fallback: http module
      data = await httpGet(url);
    }

    // Enrich with server-side metadata
    data.timestamp    = Date.now();
    data.serverTime   = new Date().toISOString();
    data.esp32Online  = true;

    // Stats tracking
    totalReadings++;
    if (data.tremor) tremorEvents++;
    data.totalReadings = totalReadings;
    data.tremorEvents  = tremorEvents;
    data.tremorRate    = totalReadings > 0
      ? ((tremorEvents / totalReadings) * 100).toFixed(1)
      : "0.0";

    latestData     = data;
    esp32Connected = true;
    pollFailCount  = 0;

    return data;
  } catch (err) {
    pollFailCount++;
    esp32Connected = false;

    if (pollFailCount === 1 || pollFailCount % 20 === 0) {
      console.warn(`[POLL] ESP32 unreachable (${ESP32_IP}) — attempt ${pollFailCount}: ${err.message}`);
    }

    // Return offline placeholder
    return {
      tremor: false,
      intensity: "NONE",
      gyroMag: 0, motionLevel: 0,
      gx: 0, gy: 0, gz: 0,
      ax: 0, ay: 0, az: 0,
      rssi: 0, uptime: 0,
      timestamp: Date.now(),
      serverTime: new Date().toISOString(),
      esp32Online: false,
      totalReadings,
      tremorEvents,
      tremorRate: "0.0"
    };
  }
}

// ─────────────────────────────────────────────
//  HTTP GET HELPER (Node < 18 fallback)
// ─────────────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 1000 }, (res) => {
      let raw = "";
      res.on("data", chunk => raw += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error("JSON parse error")); }
      });
    });
    req.on("error",   reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

// ─────────────────────────────────────────────
//  WEBSOCKET BROADCAST
// ─────────────────────────────────────────────
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

// ─────────────────────────────────────────────
//  POLL LOOP
// ─────────────────────────────────────────────
async function pollLoop() {
  const data = await fetchFromESP32();
  broadcast(data);
  setTimeout(pollLoop, POLL_INTERVAL);
}

// ─────────────────────────────────────────────
//  WEBSOCKET CONNECTION HANDLER
// ─────────────────────────────────────────────
wss.on("connection", (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`[WS] Client connected: ${ip} | Total: ${wss.clients.size}`);

  // Send latest data immediately on connect
  if (latestData) ws.send(JSON.stringify(latestData));

  ws.on("close",   () => console.log(`[WS] Client disconnected | Total: ${wss.clients.size}`));
  ws.on("error",   (err) => console.error(`[WS] Client error: ${err.message}`));
});

// ─────────────────────────────────────────────
//  REST ENDPOINTS
// ─────────────────────────────────────────────
app.get("/api/data", async (req, res) => {
  const data = await fetchFromESP32();
  res.json(data);
});

app.get("/api/status", (req, res) => {
  res.json({
    esp32Connected,
    pollFailCount,
    totalReadings,
    tremorEvents,
    connectedClients: wss.clients.size,
    esp32IP: ESP32_IP,
    uptime: process.uptime()
  });
});

// Configure ESP32 IP at runtime without restart
app.post("/api/config", (req, res) => {
  const { ip } = req.body;
  if (ip) {
    process.env.ESP32_IP = ip;
    console.log(`[CONFIG] ESP32 IP updated to: ${ip}`);
    res.json({ success: true, ip });
  } else {
    res.status(400).json({ error: "IP required" });
  }
});

// ─────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────
server.listen(SERVER_PORT, () => {
  console.log("╔══════════════════════════════════════╗");
  console.log("║     NEURO DETECT  Backend v1.0       ║");
  console.log("╚══════════════════════════════════════╝");
  console.log(`[SERVER] Running at: http://localhost:${SERVER_PORT}`);
  console.log(`[SERVER] WebSocket:  ws://localhost:${SERVER_PORT}`);
  console.log(`[ESP32]  Polling:    http://${ESP32_IP}:${ESP32_PORT}/data`);
  console.log(`[ESP32]  Change IP:  ESP32_IP=x.x.x.x node server.js`);
  console.log("─────────────────────────────────────────");

  // Start polling after 1 second
  setTimeout(pollLoop, 1000);
});

process.on("SIGINT", () => {
  console.log("\n[SERVER] Shutting down...");
  server.close(() => process.exit(0));
});
