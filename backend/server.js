// ============================================================
//  NEURO DETECT - Backend Server
//  Node.js + Express + WebSocket
//  Polls ESP32 every 50ms and broadcasts to all browser clients
// ============================================================

// ── Load backend/.env into process.env FIRST — everything below reads
//    process.env at module-load time, so this must run before any of it. ──
(function loadDotEnv() {
  const fs   = require("fs");
  const path = require("path");
  try {
    const envPath = path.join(__dirname, ".env");
    if (!fs.existsSync(envPath)) return;
    fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const eq = trimmed.indexOf("=");
      if (eq === -1) return;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    });
    console.log("[CONFIG] Loaded backend/.env");
  } catch (e) {
    console.warn("[CONFIG] Could not read .env:", e.message);
  }
})();

const express   = require("express");
const http      = require("http");
const https     = require("https");
const WebSocket = require("ws");
const path      = require("path");
const historyDb = require("./db");
const llm       = require("./llm");

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

// How long readings are kept in the history database before being
// automatically pruned. Change here or via HISTORY_RETENTION_DAYS env var.
const HISTORY_RETENTION_DAYS = parseInt(process.env.HISTORY_RETENTION_DAYS || "90", 10);

// ─────────────────────────────────────────────
//  SERVE STATIC FRONTEND
// ─────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ─────────────────────────────────────────────
//  STATE & ALERT LOGS
// ─────────────────────────────────────────────
let latestData     = null;
let esp32Connected = false;
let pollFailCount  = 0;
let totalReadings  = 0;
let tremorEvents   = 0;
const alertHistory = []; // Stores recent emergency & tremor notifications

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
//  WHATSAPP & SMS ALERT DISPATCHER (CallMeBot & wa.me)
// ─────────────────────────────────────────────
function cleanPhoneNumber(phone) {
  if (!phone) return "";
  // Strip all non-digit characters except leading plus if handled, but CallMeBot / wa.me prefer digits only
  return phone.replace(/[^\d]/g, "");
}

// 
// ── Twilio config (set these as environment variables — see README) ──
const TWILIO_SID          = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH         = process.env.TWILIO_AUTH_TOKEN  || "";
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM || "";
const TWILIO_CONFIGURED   = !!(TWILIO_SID && TWILIO_AUTH);

function postForm(urlStr, formData, authHeader) {
  return new Promise((resolve) => {
    const body = new URLSearchParams(formData).toString();
    const u = new URL(urlStr);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
        "Authorization": authHeader,
      },
    }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => resolve({ success: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, response: raw.slice(0, 200) }));
    });
    req.on("error", (err) => resolve({ success: false, error: err.message }));
    req.write(body);
    req.end();
  });
}

async function sendTwilioWhatsApp(phone, message) {
  if (!TWILIO_CONFIGURED) return { success: false, reason: "Twilio not configured" };
  const auth = "Basic " + Buffer.from(`${TWILIO_SID}:${TWILIO_AUTH}`).toString("base64");
  const url  = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`;
  const to   = phone.startsWith("+") ? phone : `+${phone}`;
  return postForm(url, { To: `whatsapp:${to}`, From: TWILIO_WHATSAPP_FROM, Body: message }, auth);
}

async function sendCallMeBotWhatsApp(phone, message, apiKey) {
  const cleanPhone = cleanPhoneNumber(phone);
  if (!cleanPhone || !apiKey) {
    return { success: false, reason: !cleanPhone ? "Missing phone number" : "Missing CallMeBot API key" };
  }
  const encodedMsg = encodeURIComponent(message);
  const url = `https://api.callmebot.com/whatsapp.php?phone=${cleanPhone}&text=${encodedMsg}&apikey=${apiKey}`;
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 8000 }, (res) => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => {
        const isSuccess = res.statusCode >= 200 && res.statusCode < 300 && !body.toLowerCase().includes("error");
        resolve({ success: isSuccess, status: res.statusCode, response: body.slice(0, 150) });
      });
    });
    req.on("error", (err) => resolve({ success: false, error: err.message }));
    req.on("timeout", () => { req.destroy(); resolve({ success: false, error: "CallMeBot API request timed out" }); });
  });
}

// Tries Twilio first (if configured); falls back to CallMeBot automatically.
async function sendWhatsAppMessage(phone, message, callMeBotApiKey) {
  if (TWILIO_CONFIGURED) {
    const result = await sendTwilioWhatsApp(phone, message);
    if (result.success) return { ...result, channel: "twilio" };
    console.log("[ALERT] Twilio failed, falling back to CallMeBot:", result.error || result.response);
  }
  const fallback = await sendCallMeBotWhatsApp(phone, message, callMeBotApiKey);
  return { ...fallback, channel: "callmebot" };
}

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

// Send emergency / tremor alerts to Caretaker & Patient
app.post("/api/send-alert", async (req, res) => {
  const {
    patientId,
    patientName,
    alertType,        // 'FALL_INTENSE_SPIKE' | 'CONTINUOUS_HIGH_TREMOR' | 'MANUAL_TEST'
    message,
    recipients        // array of { role: 'caretaker' | 'patient', name, phone, apiKey }
  } = req.body;

  if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({ error: "Recipients list required" });
  }

  const results = [];

  for (const r of recipients) {
    const cleanPhone = cleanPhoneNumber(r.phone);
    const waWebUrl = cleanPhone
      ? `https://wa.me/${cleanPhone}?text=${encodeURIComponent(message)}`
      : null;

    let apiResult = null;
    if (cleanPhone) {
      apiResult = await sendWhatsAppMessage(cleanPhone, message, r.apiKey);
      console.log(`[ALERT-WHATSAPP] Sent to ${r.role} (${cleanPhone}) via ${apiResult.channel}:`, apiResult);
    }

    results.push({
      role: r.role,
      name: r.name,
      phone: r.phone,
      cleanPhone,
      waWebUrl,
      apiSent: apiResult ? apiResult.success : false,
      apiDetails: apiResult
    });
  }

  const alertRecord = {
    id: "ALT-" + Date.now().toString(36).toUpperCase(),
    timestamp: Date.now(),
    timeFormatted: new Date().toLocaleTimeString(),
    dateFormatted: new Date().toLocaleDateString(),
    patientId: patientId || "UNKNOWN",
    patientName: patientName || "Patient",
    alertType: alertType || "TREMOR_ALERT",
    message,
    recipients: results
  };

  alertHistory.unshift(alertRecord);
  if (alertHistory.length > 50) alertHistory.pop();

  // Persist (type + time only, no phone numbers) so AI summaries can use it and it survives restarts
  try {
    if (patientId) historyDb.insertAlert({ id: alertRecord.id, patientId, alertType: alertRecord.alertType, ts: alertRecord.timestamp });
  } catch (err) { console.error("[DB] Failed to persist alert:", err.message); }

  // Broadcast alert event over WebSocket so all connected dashboards show instant siren/alert
  broadcast({
    type: "EMERGENCY_ALERT",
    alert: alertRecord
  });

  res.json({
    success: true,
    alertRecord
  });
});

// Get alert log history
app.get("/api/alerts", (req, res) => {
  res.json({ alerts: alertHistory });
});

// Test alert dispatch
app.post("/api/test-alert", async (req, res) => {
  const { phone, apiKey, message } = req.body;
  const cleanPhone = cleanPhoneNumber(phone);
  const testMsg = message || "🧪 Neuro Detect: Test Alert message successful!";
  const waWebUrl = cleanPhone ? `https://wa.me/${cleanPhone}?text=${encodeURIComponent(testMsg)}` : null;

  let apiResult = null;
  if (cleanPhone) {
    apiResult = await sendWhatsAppMessage(cleanPhone, testMsg, apiKey);
  }

  res.json({
    success: true,
    phone: cleanPhone,
    waWebUrl,
    apiResult
  });
});

// ─────────────────────────────────────────────
//  READING HISTORY (SQLite) — for the dashboard's History panel
// ─────────────────────────────────────────────

// Dashboard calls this every few seconds (while a patient is active)
// to log the current reading for later review.
app.post("/api/history/log", (req, res) => {
  const { patientId, patientName, intensity, tremor, gyroMag, motionLevel } = req.body || {};
  if (!patientId || !intensity) {
    return res.status(400).json({ error: "patientId and intensity are required" });
  }
  try {
    historyDb.insertReading({ patientId, patientName, intensity, tremor, gyroMag, motionLevel });
    res.json({ success: true });
  } catch (err) {
    console.error("[DB] Failed to log reading:", err.message);
    res.status(500).json({ error: "Failed to log reading" });
  }
});

// Full detail + summary for one patient on one calendar date (YYYY-MM-DD).
app.get("/api/history/day", (req, res) => {
  const { patientId, date } = req.query;
  if (!patientId || !date) {
    return res.status(400).json({ error: "patientId and date query params are required" });
  }
  try {
    const readings = historyDb.getReadingsForDate(patientId, date);
    const summary  = historyDb.getSummaryForDate(patientId, date);
    res.json({ patientId, date, readings, summary });
  } catch (err) {
    console.error("[DB] Failed to fetch day history:", err.message);
    res.status(500).json({ error: "Failed to fetch history" });
  }
});

// Which calendar dates have any logged data for this patient (newest first).
app.get("/api/history/dates", (req, res) => {
  const { patientId } = req.query;
  if (!patientId) return res.status(400).json({ error: "patientId query param is required" });
  try {
    res.json({ patientId, dates: historyDb.getAvailableDates(patientId) });
  } catch (err) {
    console.error("[DB] Failed to fetch available dates:", err.message);
    res.status(500).json({ error: "Failed to fetch dates" });
  }
});

// Per-day summaries across an inclusive date range — for a multi-day trend view.
app.get("/api/history/range", (req, res) => {
  const { patientId, from, to } = req.query;
  if (!patientId || !from || !to) {
    return res.status(400).json({ error: "patientId, from and to query params are required" });
  }
  try {
    res.json({ patientId, from, to, days: historyDb.getRangeSummary(patientId, from, to) });
  } catch (err) {
    console.error("[DB] Failed to fetch range history:", err.message);
    res.status(500).json({ error: "Failed to fetch range" });
  }
});

41// ─────────────────────────────────────────────
//  AI INSIGHTS (LLM) — summaries + Q&A over stored history
//  Never on the alert path. See llm.js for privacy notes.
// ─────────────────────────────────────────────
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const AI_MAX_DAYS = 60;
const aiHits = new Map(); // ip -> [timestamps]  (simple rate limit: 10 requests / minute)

function aiRateLimited(ip) {
  const now = Date.now();
  const hits = (aiHits.get(ip) || []).filter(t => now - t < 60000);
  hits.push(now);
  aiHits.set(ip, hits);
  return hits.length > 10;
}

function buildAiContext(patientId, from, to) {
  const days = historyDb.getRangeSummary(patientId, from, to).map(({ date, summary: s }) => ({
    date,
    readings: s.total,
    monitoredMinutes: Math.round(s.total * 5 / 60),
    tremorPct: s.tremorPct,
    counts: s.counts,
    avgGyro: s.avgGyroMag,
    maxGyro: s.maxGyroMag,
  }));
  const alerts = historyDb.getAlertsInRange(patientId, from, to).map(a => ({ date: a.date, time: a.time, type: a.alertType }));
  const hourly = historyDb.getHourlyProfile(patientId, from, to);
  return { period: { from, to }, days, alerts, hourly };
}

app.get("/api/ai/status", (req, res) => res.json({ configured: llm.isConfigured() }));

async function handleAi(req, res, kind) {
  const { patientId, from, to, question, audience, patientName } = req.body || {};
  if (!patientId || !DATE_RE.test(from || "") || !DATE_RE.test(to || "")) {
    return res.status(400).json({ error: "patientId, from and to (YYYY-MM-DD) are required" });
  }
  const spanDays = (new Date(to) - new Date(from)) / 86400000 + 1;
  if (!(spanDays >= 1) || spanDays > AI_MAX_DAYS) {
    return res.status(400).json({ error: `Date range must be 1–${AI_MAX_DAYS} days` });
  }
  if (kind === "ask" && (typeof question !== "string" || !question.trim() || question.length > 400)) {
    return res.status(400).json({ error: "A question (max 400 characters) is required" });
  }
  if (aiRateLimited(req.ip)) return res.status(429).json({ error: "Too many AI requests — wait a minute and try again." });

  try {
    const context = buildAiContext(patientId, from, to);
    if (context.days.length === 0 && context.alerts.length === 0) {
      return res.json({ text: "No readings were logged for this patient in the selected period, so there is nothing to summarise yet." });
    }
    const text = await llm.complete({
      kind: kind === "ask" ? "ask" : (audience === "clinical" ? "clinical" : "caretaker"),
      context,
      question: kind === "ask" ? question.trim() : undefined,
      patientName: typeof patientName === "string" ? patientName.slice(0, 80) : "",
    });
    res.json({ text });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "AI request failed" });
  }
}

app.post("/api/ai/summary", (req, res) => handleAi(req, res, "summary"));
app.post("/api/ai/ask",     (req, res) => handleAi(req, res, "ask"));

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

  // Prune old history rows now, then once every 24h
  historyDb.pruneOldReadings(HISTORY_RETENTION_DAYS);
  setInterval(() => historyDb.pruneOldReadings(HISTORY_RETENTION_DAYS), 24 * 60 * 60 * 1000);

  // Start polling after 1 second
  setTimeout(pollLoop, 1000);
});

process.on("SIGINT", () => {
  console.log("\n[SERVER] Shutting down...");
  server.close(() => process.exit(0));
});
