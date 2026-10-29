# NEURO DETECT — Complete Setup Guide
## ESP32 + MPU6050 Tremor Detection System

---

## 1. PROJECT OVERVIEW

Neuro Detect is a real-time tremor monitoring system that uses an ESP32 microcontroller and MPU6050 IMU sensor to detect and classify hand/limb tremors. Data flows from the sensor → ESP32 → Node.js backend → browser dashboard via WebSocket.

**Architecture:**
```
MPU6050 ──I2C──► ESP32 ──WiFi/HTTP──► Node.js Backend ──WebSocket──► Browser Dashboard
```

---

## 2. WIRING DIAGRAM

```
ESP32 Dev Module          MPU6050
─────────────────         ────────────────
3.3V  ────────────────►  VCC
GND   ────────────────►  GND
GPIO21 (SDA) ─────────►  SDA
GPIO22 (SCL) ─────────►  SCL
                          AD0  →  GND  (I2C address 0x68)
                          INT  →  (not connected)

⚠️  Use 3.3V — NOT 5V — MPU6050 on this breakout is 3.3V tolerant
⚠️  Keep I2C wires short (< 20 cm) for stable readings
⚠️  No pull-up resistors needed (ESP32 has internal pull-ups)
```

**Breadboard Layout:**
```
 [ESP32]              [MPU6050]
  3V3 ●────────────────● VCC
  GND ●────────────────● GND
  G21 ●────────────────● SDA
  G22 ●────────────────● SCL
                        AD0 ●──── GND (same rail)
```

---

## 3. REQUIRED LIBRARIES

### Arduino Libraries
| Library | Purpose | Install via |
|---|---|---|
| `Wire.h` | I2C communication | Built-in (no install needed) |
| `WiFi.h` | ESP32 WiFi | Built-in with ESP32 board package |
| `WebServer.h` | HTTP server on ESP32 | Built-in with ESP32 board package |
| `Adafruit_MPU6050` | MPU6050 driver | Arduino Library Manager |
| `Adafruit_Sensor` | Unified sensor abstraction | Arduino Library Manager |

### Node.js Packages
| Package | Purpose |
|---|---|
| `express` | HTTP server / static file serving |
| `ws` | WebSocket server |

---

## 4. ARDUINO IDE SETUP

### Step 1 — Install Arduino IDE
Download from: https://www.arduino.cc/en/software  
(Version 2.x recommended)

### Step 2 — Add ESP32 Board Package
1. Open Arduino IDE
2. Go to **File → Preferences**
3. In **"Additional boards manager URLs"** paste:
   ```
   https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
   ```
4. Click **OK**
5. Go to **Tools → Board → Boards Manager**
6. Search `esp32`
7. Install **"esp32 by Espressif Systems"** (version 2.x or later)
8. Wait for installation to complete

### Step 3 — Select ESP32 Board
1. Go to **Tools → Board → esp32 → ESP32 Dev Module**
2. Set these settings:
   - **Upload Speed:** 921600
   - **CPU Frequency:** 240MHz
   - **Flash Size:** 4MB
   - **Partition Scheme:** Default 4MB with spiffs
   - **Port:** Select your COM port (Windows: COMx, Mac/Linux: /dev/ttyUSBx)

### Step 4 — Install Adafruit Libraries
1. Go to **Sketch → Include Library → Manage Libraries**
2. Search **`Adafruit MPU6050`** → Install (install all dependencies when prompted)
3. Search **`Adafruit Unified Sensor`** → Install
4. Close the Library Manager

### Step 5 — Upload the Code
1. Open `arduino/neuro_detect.ino`
2. Edit lines 15–16 with your WiFi credentials:
   ```cpp
   const char* WIFI_SSID     = "YourNetworkName";
   const char* WIFI_PASSWORD = "YourPassword";
   ```
3. Click the **Upload** button (→ arrow)
4. Open **Serial Monitor** (Tools → Serial Monitor)
5. Set baud rate to **115200**
6. Press the **EN/RST** button on the ESP32
7. Watch calibration progress, then note the **IP address** printed

---

## 5. BACKEND SETUP

### Requirements
- Node.js v16 or later: https://nodejs.org

### Step 1 — Install dependencies
```bash
cd neuro-detect/backend
npm install
```

### Step 2 — Set ESP32 IP and start server
Replace `192.168.1.100` with the IP shown in your Serial Monitor.

**Windows:**
```cmd
set ESP32_IP=192.168.1.100 && node server.js
```

**Mac / Linux:**
```bash
ESP32_IP=192.168.1.100 node server.js
```

You should see:
```
╔══════════════════════════════════════╗
║     NEURO DETECT  Backend v1.0       ║
╚══════════════════════════════════════╝
[SERVER] Running at: http://localhost:3000
[SERVER] WebSocket:  ws://localhost:3000
[ESP32]  Polling:    http://192.168.1.100/data
```

### Step 3 — Open the Dashboard
Open your browser and go to:
```
http://localhost:3000
```

---

## 6. FRONTEND SETUP (No Build Step Required)

The frontend is a single `index.html` file served automatically by the backend from the `backend/public/` folder.

**No separate setup is needed.**

If you want to run the dashboard WITHOUT the backend (direct ESP32 mode):
1. Open `backend/public/index.html` directly in your browser
2. Enter the ESP32 IP address in the top input field
3. Click **Connect**
4. The dashboard will poll the ESP32 directly (CORS must be open — it is, by default in the Arduino code)

---

## 7. FOLDER STRUCTURE

```
neuro-detect/
│
├── arduino/
│   └── neuro_detect.ino        ← Upload this to ESP32
│
├── backend/
│   ├── server.js               ← Node.js backend
│   ├── package.json            ← Dependencies
│   └── public/
│       └── index.html          ← Dashboard frontend
│
└── README.md                   ← This file
```

---

## 8. HOW IT WORKS

### Data Flow
```
1. MPU6050 reads gyro + accel at 50Hz (every 20ms)
2. ESP32 applies:
   - Calibration offsets (calculated at boot)
   - 10-sample moving-average filter
3. Tremor detection uses gyro magnitude:
   - < 0.30 rad/s  → No tremor
   - 0.30–0.50     → Minimal
   - 0.50–1.00     → Mild
   - 1.00–2.00     → Moderate
   - > 2.00        → Severe
4. Debouncing: requires 5 consecutive detections to confirm
5. ESP32 exposes JSON at GET /data
6. Backend polls /data every 50ms
7. Backend broadcasts via WebSocket to all browser clients
8. Dashboard updates charts and gauges in real time
```

### Serial Monitor Output Sample
```
─────────────────────────────────────────────
[TREMOR] Status: NO  ✓  | Intensity: NONE
[GYRO]   Mag=0.042  X=0.021  Y=-0.018  Z=0.008
[ACCEL]  X=0.031  Y=-0.012  Z=9.803
[MOTION] Level=0.029
[WIFI]   Connected | RSSI=-58 dBm
[UPTIME] 42s
```

---

## 9. TESTING INSTRUCTIONS

### Basic Sensor Test
1. Flash code and open Serial Monitor
2. Hold ESP32+MPU6050 still — gyro magnitude should be < 0.05
3. Shake your hand with ESP32 — you should see:
   - Gyro magnitude spike > 0.3
   - Serial: `[TREMOR] Status: YES ⚠️`

### Dashboard Test
1. Start backend with correct ESP32 IP
2. Open `http://localhost:3000`
3. Watch the charts update in real time
4. Shake the sensor — banner turns red, tremor alert fires

### Direct ESP32 Mode Test
1. Open `index.html` directly in browser
2. Type ESP32 IP in the top field → Connect
3. Should work without any backend

---

## 10. TROUBLESHOOTING

| Problem | Cause | Fix |
|---|---|---|
| `MPU6050 not detected` | Wrong wiring or 5V used | Check SDA=GPIO21, SCL=GPIO22, use 3.3V |
| `WiFi not connecting` | Wrong credentials | Double-check SSID/password, 2.4GHz only |
| `No data on dashboard` | Wrong ESP32 IP | Check Serial Monitor for correct IP |
| `Tremor always YES` | Threshold too low | Increase `TREMOR_GYRO_THRESHOLD` in .ino |
| `Tremor never detected` | Threshold too high | Decrease `TREMOR_GYRO_THRESHOLD` in .ino |
| `Charts not updating` | WebSocket blocked | Try direct mode (enter ESP32 IP in dashboard) |
| `Upload fails` | Wrong COM port | Check Device Manager (Windows) or `ls /dev/tty*` (Mac/Linux) |
| `Compilation error` | Missing library | Re-install Adafruit MPU6050 + Sensor libraries |
| `npm install fails` | Node.js not installed | Install Node.js 18+ from nodejs.org |

### Adjusting Sensitivity
Edit these values in `neuro_detect.ino`:

```cpp
// More sensitive (detects smaller tremors):
const float TREMOR_GYRO_THRESHOLD = 0.15f;

// Less sensitive (ignores small movements):
const float TREMOR_GYRO_THRESHOLD = 0.50f;

// Faster confirmation (more responsive but noisier):
const int TREMOR_CONFIRM_COUNT = 3;

// Slower confirmation (more stable but slower reaction):
const int TREMOR_CONFIRM_COUNT = 8;
```

### Check ESP32 is Serving Data
Open this URL in your browser (replace IP):
```
http://192.168.1.100/data
```
You should see JSON like:
```json
{
  "tremor": false,
  "intensity": "NONE",
  "gyroMag": 0.0421,
  "motionLevel": 0.0312,
  "gx": 0.021, "gy": -0.018, "gz": 0.008,
  "ax": 0.031, "ay": -0.012, "az": 9.803,
  "rssi": -58,
  "uptime": 42
}
```

---

## 11. CALIBRATION NOTES

- Calibration runs automatically at boot (takes ~3 seconds)
- Keep the sensor **completely still** during calibration
- Calibration removes gyro drift and accel bias
- Re-calibrate by pressing the **EN/RST** button on the ESP32
- After calibration, gyro values at rest should be < ±0.05 rad/s

---

*Neuro Detect v1.0 — ESP32 + MPU6050 Tremor Detection System*

---

## 12. VOICE ALERTS & AI INSIGHTS (added)

**Voice note.** When an alert fires (1 minute of continuous MODERATE/SEVERE hand movement, a fall/spike alert if re-enabled, or the Test Alert button) the dashboard speaks a message using the browser's built-in speech synthesis — same trigger point as the siren/chime and WhatsApp dispatch. It repeats every 15 s (max 4 times) while the alert overlay is open and stops on *Mute & Dismiss*. Toggle it with the **🔊 Voice** button in the alerts panel; **🔁 Replay Voice** is in the overlay. Browsers only allow sound after a first click/tap on the page, so click anywhere once after opening the dashboard.

**AI insights (optional).** History panel → *AI Insights*: plain-language summary, clinical-style note, and free-text Q&A over the stored history. Enable by adding `GEMINI_API_KEY` (free tier, Google AI Studio) or `ANTHROPIC_API_KEY` to `backend/.env` (see `.env.example`) and restarting. Needs Node 18+. Only aggregated numbers are sent to the API — never the patient's name, phone numbers or IDs. AI is never in the alert path.
#   N E U R O - D E T E C T  
 