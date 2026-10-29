// ============================================================
//  NEURO DETECT - Reading History Database
//  Stores periodic tremor readings (intensity, gyro magnitude,
//  motion level) per patient so past days can be reviewed from
//  the dashboard's History panel. Uses better-sqlite3 — a small
//  embedded, file-based database (no separate DB server needed).
//
//  The database file lives at backend/data/neuro_detect.db and
//  is created automatically on first run.
// ============================================================

const path = require("path");
const fs   = require("fs");
const Database = require("better-sqlite3");

const DATA_DIR = path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "neuro_detect.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS readings (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id   TEXT NOT NULL,
    patient_name TEXT,
    ts           INTEGER NOT NULL,   -- epoch ms
    date         TEXT NOT NULL,      -- YYYY-MM-DD (server local time)
    time         TEXT NOT NULL,      -- HH:MM:SS (server local time)
    intensity    TEXT NOT NULL,      -- NONE | MINIMAL | MILD | MODERATE | SEVERE
    tremor       INTEGER NOT NULL,   -- 0 or 1
    gyro_mag     REAL,
    motion_level REAL
  );
  CREATE INDEX IF NOT EXISTS idx_readings_patient_date ON readings(patient_id, date);
  CREATE INDEX IF NOT EXISTS idx_readings_ts ON readings(ts);

  -- Alerts that fired (1-min continuous tremor, manual tests, ...) so they survive a
  -- server restart and can be included in AI summaries. Phone numbers are NOT stored here.
  CREATE TABLE IF NOT EXISTS alerts (
    id         TEXT PRIMARY KEY,
    patient_id TEXT NOT NULL,
    ts         INTEGER NOT NULL,
    date       TEXT NOT NULL,
    time       TEXT NOT NULL,
    alert_type TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_alerts_patient_date ON alerts(patient_id, date);
`);

const INTENSITY_LEVELS = ["NONE", "MINIMAL", "MILD", "MODERATE", "SEVERE"];

// ─────────────────────────────────────────────
//  DATE HELPERS (server's local timezone)
// ─────────────────────────────────────────────
function localDateStr(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function localTimeStr(ts) {
  return new Date(ts).toTimeString().split(" ")[0]; // HH:MM:SS
}

// ─────────────────────────────────────────────
//  WRITE
// ─────────────────────────────────────────────
const insertStmt = db.prepare(`
  INSERT INTO readings (patient_id, patient_name, ts, date, time, intensity, tremor, gyro_mag, motion_level)
  VALUES (@patientId, @patientName, @ts, @date, @time, @intensity, @tremor, @gyroMag, @motionLevel)
`);

function insertReading({ patientId, patientName, intensity, tremor, gyroMag, motionLevel, ts }) {
  if (!patientId || !intensity) return null;
  const t = ts || Date.now();
  return insertStmt.run({
    patientId,
    patientName: patientName || "",
    ts: t,
    date: localDateStr(t),
    time: localTimeStr(t),
    intensity,
    tremor: tremor ? 1 : 0,
    gyroMag: typeof gyroMag === "number" ? gyroMag : 0,
    motionLevel: typeof motionLevel === "number" ? motionLevel : 0,
  });
}

// ─────────────────────────────────────────────
//  READ
// ─────────────────────────────────────────────

// All readings for one patient on one calendar date, oldest first.
function getReadingsForDate(patientId, date) {
  return db.prepare(`
    SELECT ts, date, time, intensity, tremor, gyro_mag AS gyroMag, motion_level AS motionLevel
    FROM readings
    WHERE patient_id = ? AND date = ?
    ORDER BY ts ASC
  `).all(patientId, date);
}

// Aggregate stats for one patient on one calendar date.
function getSummaryForDate(patientId, date) {
  const rows = getReadingsForDate(patientId, date);
  const counts = { NONE: 0, MINIMAL: 0, MILD: 0, MODERATE: 0, SEVERE: 0 };
  let tremorCount = 0, sumGyro = 0, maxGyro = 0;

  for (const r of rows) {
    if (counts[r.intensity] !== undefined) counts[r.intensity]++;
    if (r.tremor) tremorCount++;
    sumGyro += r.gyroMag || 0;
    if ((r.gyroMag || 0) > maxGyro) maxGyro = r.gyroMag;
  }

  const total = rows.length;
  return {
    total,
    counts,
    tremorCount,
    tremorPct: total > 0 ? +(tremorCount / total * 100).toFixed(1) : 0,
    avgGyroMag: total > 0 ? +(sumGyro / total).toFixed(3) : 0,
    maxGyroMag: +maxGyro.toFixed(3),
    firstTs: total > 0 ? rows[0].ts : null,
    lastTs: total > 0 ? rows[total - 1].ts : null,
  };
}

// Every distinct calendar date that has at least one reading for this patient, newest first.
function getAvailableDates(patientId) {
  const rows = db.prepare(`
    SELECT DISTINCT date FROM readings WHERE patient_id = ? ORDER BY date DESC
  `).all(patientId);
  return rows.map(r => r.date);
}

// Per-day summaries across a date range (inclusive), for a trend/overview view.
function getRangeSummary(patientId, fromDate, toDate) {
  const dates = db.prepare(`
    SELECT DISTINCT date FROM readings
    WHERE patient_id = ? AND date >= ? AND date <= ?
    ORDER BY date ASC
  `).all(patientId, fromDate, toDate).map(r => r.date);

  return dates.map(date => ({ date, summary: getSummaryForDate(patientId, date) }));
}

// ─────────────────────────────────────────────
//  ALERTS + HOURLY PROFILE (used by AI summaries)
// ─────────────────────────────────────────────
const insertAlertStmt = db.prepare(`
  INSERT OR IGNORE INTO alerts (id, patient_id, ts, date, time, alert_type)
  VALUES (@id, @patientId, @ts, @date, @time, @alertType)
`);
function insertAlert({ id, patientId, alertType, ts }) {
  if (!id || !patientId) return null;
  const t = ts || Date.now();
  return insertAlertStmt.run({ id, patientId, ts: t, date: localDateStr(t), time: localTimeStr(t), alertType: alertType || "TREMOR_ALERT" });
}

function getAlertsInRange(patientId, fromDate, toDate) {
  return db.prepare(`
    SELECT id, date, time, alert_type AS alertType
    FROM alerts WHERE patient_id = ? AND date >= ? AND date <= ?
    ORDER BY ts ASC
  `).all(patientId, fromDate, toDate);
}

// Per hour-of-day: how many readings, and how many were MODERATE/SEVERE, across the range.
function getHourlyProfile(patientId, fromDate, toDate) {
  return db.prepare(`
    SELECT CAST(substr(time, 1, 2) AS INTEGER) AS hour,
           COUNT(*) AS readings,
           SUM(CASE WHEN intensity IN ('MODERATE','SEVERE') THEN 1 ELSE 0 END) AS highReadings
    FROM readings
    WHERE patient_id = ? AND date >= ? AND date <= ?
    GROUP BY hour ORDER BY hour ASC
  `).all(patientId, fromDate, toDate);
}

// ─────────────────────────────────────────────
//  MAINTENANCE
// ─────────────────────────────────────────────
// Deletes readings older than `retentionDays` to keep the database
// from growing forever. Safe to call periodically; a no-op if there's
// nothing old enough to remove.
function pruneOldReadings(retentionDays) {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  db.prepare(`DELETE FROM alerts WHERE ts < ?`).run(cutoff);
  const result = db.prepare(`DELETE FROM readings WHERE ts < ?`).run(cutoff);
  if (result.changes > 0) {
    console.log(`[DB] Pruned ${result.changes} readings older than ${retentionDays} days`);
  }
  return result.changes;
}

module.exports = {
  INTENSITY_LEVELS,
  insertReading,
  getReadingsForDate,
  getSummaryForDate,
  getAvailableDates,
  getRangeSummary,
  insertAlert,
  getAlertsInRange,
  getHourlyProfile,
  pruneOldReadings,
};
