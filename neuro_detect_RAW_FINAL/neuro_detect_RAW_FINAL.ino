// ============================================================
//  NEURO DETECT - ESP32 Tremor Detection System
//  RAW I2C VERSION — No Adafruit_MPU6050 library needed
//
//  Works with ALL MPU6050 clones (WHO_AM_I = 0x68, 0x70, 0x72)
//  Reads sensor directly via I2C registers — faster and lighter
//
//  ONLY LIBRARIES NEEDED:
//    Wire.h      — built-in
//    WiFi.h      — built-in
//    WebServer.h — built-in
//
//  DO NOT install or include Adafruit_MPU6050 for this sketch.
// ============================================================

#include <Wire.h>
#include <WiFi.h>
#include <WebServer.h>

// ─────────────────────────────────────────────
//  WIFI CREDENTIALS
// ─────────────────────────────────────────────
const char* WIFI_SSID     = "Sannidhi";
const char* WIFI_PASSWORD = "1234abcd";

// ─────────────────────────────────────────────
//  MPU6050 I2C ADDRESS & REGISTERS
// ─────────────────────────────────────────────
#define MPU_ADDR       0x68
#define REG_PWR_MGMT_1 0x6B
#define REG_SMPLRT_DIV 0x19
#define REG_CONFIG     0x1A
#define REG_GYRO_CFG   0x1B
#define REG_ACCEL_CFG  0x1C
#define REG_ACCEL_XOUT 0x3B   // First of 14 bytes: AX_H AX_L AY_H AY_L AZ_H AZ_L TEMP_H TEMP_L GX_H GX_L GY_H GY_L GZ_H GZ_L
#define REG_WHO_AM_I   0x75

// Sensitivity constants (from MPU6050 datasheet)
// Accel ±4g  → 8192 LSB/g  → divide raw by 8192 * 9.81 for m/s²
// Gyro ±500°/s → 65.5 LSB/°/s → divide raw by 65.5, convert to rad/s
#define ACCEL_SCALE    (9.81f / 8192.0f)   // raw → m/s²
#define GYRO_SCALE     (1.0f  / 65.5f * 0.01745329f)  // raw → rad/s  (÷65.5 then °→rad)

// ─────────────────────────────────────────────
//  TREMOR THRESHOLDS
// ─────────────────────────────────────────────
const float TREMOR_GYRO_THRESHOLD     = 0.30f;
const float TREMOR_MILD_THRESHOLD     = 0.50f;
const float TREMOR_MODERATE_THRESHOLD = 1.00f;
const float TREMOR_SEVERE_THRESHOLD   = 2.00f;
const int   SMOOTHING_SAMPLES         = 10;
const int   TREMOR_CONFIRM_COUNT      = 5;
const unsigned long SAMPLE_INTERVAL_MS = 20;   // 50 Hz

// ─────────────────────────────────────────────
//  CALIBRATION
// ─────────────────────────────────────────────
const int CALIB_SAMPLES = 200;
float gyroOffsetX  = 0, gyroOffsetY  = 0, gyroOffsetZ  = 0;
float accelOffsetX = 0, accelOffsetY = 0, accelOffsetZ = 0;

// ─────────────────────────────────────────────
//  MOVING AVERAGE BUFFERS
// ─────────────────────────────────────────────
float gxBuf[SMOOTHING_SAMPLES] = {0};
float gyBuf[SMOOTHING_SAMPLES] = {0};
float gzBuf[SMOOTHING_SAMPLES] = {0};
float axBuf[SMOOTHING_SAMPLES] = {0};
float ayBuf[SMOOTHING_SAMPLES] = {0};
float azBuf[SMOOTHING_SAMPLES] = {0};
int   bufIndex = 0;

// ─────────────────────────────────────────────
//  SERVER OBJECT
// ─────────────────────────────────────────────
WebServer server(80);

// ─────────────────────────────────────────────
//  GLOBAL STATE
// ─────────────────────────────────────────────
float smoothGX = 0, smoothGY = 0, smoothGZ = 0;
float smoothAX = 0, smoothAY = 0, smoothAZ = 0;
float gyroMagnitude    = 0;
float motionLevel      = 0;
bool  tremorDetected   = false;
String tremorIntensity = "NONE";
int   tremorConfirmCounter = 0;
unsigned long lastSampleTime = 0;
unsigned long lastPrintTime  = 0;

// ══════════════════════════════════════════════
//  RAW I2C HELPERS
// ══════════════════════════════════════════════

// Write one byte to a register
void mpuWrite(byte reg, byte value) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  Wire.write(value);
  Wire.endTransmission(true);
}

// Read one byte from a register
byte mpuRead(byte reg) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  Wire.endTransmission(false);
  Wire.requestFrom((uint8_t)MPU_ADDR, (uint8_t)1, (uint8_t)true);
  return Wire.available() ? Wire.read() : 0xFF;
}

// Read N bytes starting from reg into buf[]
void mpuReadBytes(byte reg, byte* buf, int n) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  Wire.endTransmission(false);
  Wire.requestFrom((uint8_t)MPU_ADDR, (uint8_t)n, (uint8_t)true);
  for (int i = 0; i < n && Wire.available(); i++) {
    buf[i] = Wire.read();
  }
}

// Combine two bytes into a signed 16-bit integer
int16_t toInt16(byte hi, byte lo) {
  return (int16_t)((hi << 8) | lo);
}

// ══════════════════════════════════════════════
//  MPU6050 INIT  (raw, no Adafruit library)
// ══════════════════════════════════════════════
bool initMPU() {
  // 1. Full device reset
  mpuWrite(REG_PWR_MGMT_1, 0x80);   // DEVICE_RESET = 1
  delay(200);

  // 2. Wake from sleep, use internal oscillator
  mpuWrite(REG_PWR_MGMT_1, 0x00);   // SLEEP = 0, CLKSEL = internal 8MHz
  delay(100);

  // 3. Verify WHO_AM_I (accept any value — clone or genuine)
  byte whoami = mpuRead(REG_WHO_AM_I);
  Serial.print("[SENSOR] WHO_AM_I = 0x");
  Serial.print(whoami, HEX);
  if      (whoami == 0x68) Serial.println("  (genuine MPU6050) ✓");
  else if (whoami == 0x70) Serial.println("  (clone — WHO_AM_I=0x70, common in India) ✓");
  else if (whoami == 0x72) Serial.println("  (clone variant 0x72) ✓");
  else if (whoami == 0xFF) { Serial.println("  ERROR — no response from sensor"); return false; }
  else                     { Serial.print("  (unknown ID, continuing) ✓\n"); }

  // 4. Set sample rate divider → 1kHz / (1+0) = 1000Hz
  mpuWrite(REG_SMPLRT_DIV, 0x00);

  // 5. Set DLPF bandwidth to ~21Hz (matches Adafruit BAND_21_HZ)
  //    CONFIG register bits[2:0] = 4 → 21Hz bandwidth
  mpuWrite(REG_CONFIG, 0x04);

  // 6. Gyro range ±500°/s  → FS_SEL = 1 → bits[4:3] = 01 → 0x08
  mpuWrite(REG_GYRO_CFG, 0x08);

  // 7. Accel range ±4g  → AFS_SEL = 1 → bits[4:3] = 01 → 0x08
  mpuWrite(REG_ACCEL_CFG, 0x08);

  delay(100);

  // 8. Quick sanity read — accel Z should be ~+8192 (1g) when flat
  byte raw[6];
  mpuReadBytes(REG_ACCEL_XOUT, raw, 6);
  int16_t ax = toInt16(raw[0], raw[1]);
  int16_t ay = toInt16(raw[2], raw[3]);
  int16_t az = toInt16(raw[4], raw[5]);

  Serial.print("[SENSOR] Sanity read — Raw Accel  X=");
  Serial.print(ax); Serial.print("  Y="); Serial.print(ay);
  Serial.print("  Z="); Serial.println(az);
  Serial.println("[SENSOR] (Z should be roughly ±8192 when sensor is flat)");

  if (ax == 0 && ay == 0 && az == 0) {
    Serial.println("[SENSOR] All zeros — sensor not responding to reads.");
    return false;
  }

  Serial.println("[SENSOR] MPU6050 init SUCCESS via raw I2C.");
  return true;
}

// ══════════════════════════════════════════════
//  READ SENSOR RAW → APPLY SCALE + FILTER
// ══════════════════════════════════════════════
void readAndFilter() {
  // Read 14 bytes starting at 0x3B:
  // [0-1]=AX  [2-3]=AY  [4-5]=AZ  [6-7]=TEMP  [8-9]=GX  [10-11]=GY  [12-13]=GZ
  byte raw[14];
  mpuReadBytes(REG_ACCEL_XOUT, raw, 14);

  // Convert raw to physical units
  float ax = toInt16(raw[0],  raw[1])  * ACCEL_SCALE;
  float ay = toInt16(raw[2],  raw[3])  * ACCEL_SCALE;
  float az = toInt16(raw[4],  raw[5])  * ACCEL_SCALE;
  float gx = toInt16(raw[8],  raw[9])  * GYRO_SCALE;
  float gy = toInt16(raw[10], raw[11]) * GYRO_SCALE;
  float gz = toInt16(raw[12], raw[13]) * GYRO_SCALE;

  // Gyro offset subtraction is fine as-is — angular rate isn't affected by
  // device orientation/tilt, so a fixed per-axis offset always cancels correctly.
  gx -= gyroOffsetX;  gy -= gyroOffsetY;  gz -= gyroOffsetZ;

  // Accel is intentionally NOT offset-corrected per-axis here.
  // Per-axis gravity subtraction only cancels gravity for the exact orientation
  // the device was calibrated in — tilt it afterward (worn on a wrist, propped
  // at an angle, held in hand, etc.) and gravity leaks back in as false "motion".
  // Gravity is removed from the MAGNITUDE instead, further down — that's
  // orientation-independent, since |raw accel vector| is always ~9.81 m/s^2
  // at rest no matter which way the device is pointed.

  // Push into circular moving-average buffer
  gxBuf[bufIndex]=gx; gyBuf[bufIndex]=gy; gzBuf[bufIndex]=gz;
  axBuf[bufIndex]=ax; ayBuf[bufIndex]=ay; azBuf[bufIndex]=az;
  bufIndex = (bufIndex + 1) % SMOOTHING_SAMPLES;

  // Compute averages
  float sgx=0,sgy=0,sgz=0,sax=0,say=0,saz=0;
  for (int i=0; i<SMOOTHING_SAMPLES; i++) {
    sgx+=gxBuf[i]; sgy+=gyBuf[i]; sgz+=gzBuf[i];
    sax+=axBuf[i]; say+=ayBuf[i]; saz+=azBuf[i];
  }
  smoothGX=sgx/SMOOTHING_SAMPLES; smoothGY=sgy/SMOOTHING_SAMPLES; smoothGZ=sgz/SMOOTHING_SAMPLES;
  smoothAX=sax/SMOOTHING_SAMPLES; smoothAY=say/SMOOTHING_SAMPLES; smoothAZ=saz/SMOOTHING_SAMPLES;

  gyroMagnitude = sqrt(smoothGX*smoothGX + smoothGY*smoothGY + smoothGZ*smoothGZ);

  // Orientation-independent linear acceleration: how far the total accel vector
  // deviates from gravity's magnitude (9.81 m/s^2), regardless of which axis
  // gravity happens to be split across right now.
  float rawAccelMag = sqrt(smoothAX*smoothAX + smoothAY*smoothAY + smoothAZ*smoothAZ);
  float linearAccel = fabs(rawAccelMag - 9.81f);

  motionLevel = (gyroMagnitude * 0.7f) + (linearAccel * 0.3f);
}

// ══════════════════════════════════════════════
//  CALIBRATION
// ══════════════════════════════════════════════
void calibrateSensor() {
  Serial.println("[CALIB]  Keep sensor PERFECTLY STILL for 4 seconds...");
  delay(2000);

  double sumGX=0,sumGY=0,sumGZ=0;
  double sumAX=0,sumAY=0,sumAZ=0;

  for (int i=0; i<CALIB_SAMPLES; i++) {
    byte raw[14];
    mpuReadBytes(REG_ACCEL_XOUT, raw, 14);

    sumAX += toInt16(raw[0],  raw[1])  * ACCEL_SCALE;
    sumAY += toInt16(raw[2],  raw[3])  * ACCEL_SCALE;
    sumAZ += toInt16(raw[4],  raw[5])  * ACCEL_SCALE;          // gravity removed via offset subtraction at runtime, not here
    sumGX += toInt16(raw[8],  raw[9])  * GYRO_SCALE;
    sumGY += toInt16(raw[10], raw[11]) * GYRO_SCALE;
    sumGZ += toInt16(raw[12], raw[13]) * GYRO_SCALE;

    if (i % 50 == 0) {
      Serial.print("[CALIB]  "); Serial.print((i*100)/CALIB_SAMPLES); Serial.println("%");
    }
    delay(10);
  }

  gyroOffsetX  = sumGX/CALIB_SAMPLES;
  gyroOffsetY  = sumGY/CALIB_SAMPLES;
  gyroOffsetZ  = sumGZ/CALIB_SAMPLES;
  // accelOffsetX/Y/Z below are still computed and printed for visibility, but are
  // no longer applied to live readings (see readAndFilter) — magnitude-based
  // gravity removal replaced them since it doesn't break when the device is tilted.
  accelOffsetX = sumAX/CALIB_SAMPLES;
  accelOffsetY = sumAY/CALIB_SAMPLES;
  accelOffsetZ = sumAZ/CALIB_SAMPLES;

  Serial.println("[CALIB]  100% complete!");
  Serial.print("[CALIB]  Gyro offsets  X="); Serial.print(gyroOffsetX,5);
  Serial.print("  Y="); Serial.print(gyroOffsetY,5);
  Serial.print("  Z="); Serial.println(gyroOffsetZ,5);
  Serial.print("[CALIB]  Accel offsets X="); Serial.print(accelOffsetX,5);
  Serial.print("  Y="); Serial.print(accelOffsetY,5);
  Serial.print("  Z="); Serial.println(accelOffsetZ,5);
  Serial.println("[CALIB]  Done.");
}

// ══════════════════════════════════════════════
//  TREMOR DETECTION
// ══════════════════════════════════════════════
void detectTremor() {
  bool instant = (gyroMagnitude > TREMOR_GYRO_THRESHOLD);

  if (instant) tremorConfirmCounter = min(tremorConfirmCounter+1, TREMOR_CONFIRM_COUNT+2);
  else         tremorConfirmCounter = max(tremorConfirmCounter-1, 0);

  tremorDetected = (tremorConfirmCounter >= TREMOR_CONFIRM_COUNT);

  if      (!tremorDetected || gyroMagnitude <= TREMOR_GYRO_THRESHOLD) tremorIntensity = "NONE";
  else if (gyroMagnitude < TREMOR_MILD_THRESHOLD)                     tremorIntensity = "MINIMAL";
  else if (gyroMagnitude < TREMOR_MODERATE_THRESHOLD)                 tremorIntensity = "MILD";
  else if (gyroMagnitude < TREMOR_SEVERE_THRESHOLD)                   tremorIntensity = "MODERATE";
  else                                                                 tremorIntensity = "SEVERE";
}

// ══════════════════════════════════════════════
//  WIFI
// ══════════════════════════════════════════════
void connectWiFi() {
  Serial.print("[WIFI]   Connecting to "); Serial.println(WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries < 30) {
    delay(500); Serial.print("."); tries++;
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("[WIFI]   Connected! IP: "); Serial.println(WiFi.localIP());
    Serial.print("[WIFI]   RSSI: "); Serial.print(WiFi.RSSI()); Serial.println(" dBm");
  } else {
    Serial.println("[WIFI]   FAILED — running in sensor-only mode.");
  }
}

// ══════════════════════════════════════════════
//  JSON BUILDER
// ══════════════════════════════════════════════
String buildJSON() {
  String j = "{";
  j += "\"tremor\":"      + String(tremorDetected?"true":"false") + ",";
  j += "\"intensity\":\"" + tremorIntensity + "\",";
  j += "\"gyroMag\":"     + String(gyroMagnitude,4) + ",";
  j += "\"motionLevel\":" + String(motionLevel,4)   + ",";
  j += "\"gx\":"          + String(smoothGX,4) + ",";
  j += "\"gy\":"          + String(smoothGY,4) + ",";
  j += "\"gz\":"          + String(smoothGZ,4) + ",";
  j += "\"ax\":"          + String(smoothAX,4) + ",";
  j += "\"ay\":"          + String(smoothAY,4) + ",";
  j += "\"az\":"          + String(smoothAZ,4) + ",";
  j += "\"rssi\":"        + String(WiFi.RSSI())     + ",";
  j += "\"uptime\":"      + String(millis()/1000);
  j += "}";
  return j;
}

// ══════════════════════════════════════════════
//  HTTP HANDLERS
// ══════════════════════════════════════════════
void handleCORS() {
  server.sendHeader("Access-Control-Allow-Origin","*");
  server.sendHeader("Access-Control-Allow-Methods","GET,OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers","Content-Type");
  server.send(204);
}
void handleRoot() {
  server.sendHeader("Access-Control-Allow-Origin","*");
  server.send(200,"text/plain",
    "Neuro Detect ESP32 Online\n"
    "GET /data  ->  live JSON\n");
}
void handleData() {
  server.sendHeader("Access-Control-Allow-Origin","*");
  server.sendHeader("Cache-Control","no-cache");
  server.send(200,"application/json",buildJSON());
}

// ══════════════════════════════════════════════
//  SERIAL MONITOR OUTPUT
// ══════════════════════════════════════════════
void printSerial() {
  Serial.println("──────────────────────────────────────────────");
  Serial.print("[TREMOR] ");
  if (tremorDetected) Serial.print("YES  *** TREMOR DETECTED ***");
  else                Serial.print("NO   (stable)");
  Serial.print("  Intensity: "); Serial.println(tremorIntensity);

  Serial.print("[GYRO]   Mag="); Serial.print(gyroMagnitude,4);
  Serial.print("  X="); Serial.print(smoothGX,4);
  Serial.print("  Y="); Serial.print(smoothGY,4);
  Serial.print("  Z="); Serial.println(smoothGZ,4);

  Serial.print("[ACCEL]  X="); Serial.print(smoothAX,4);
  Serial.print("  Y="); Serial.print(smoothAY,4);
  Serial.print("  Z="); Serial.println(smoothAZ,4);

  Serial.print("[MOTION] "); Serial.println(motionLevel,4);

  if (WiFi.status()==WL_CONNECTED) {
    Serial.print("[WIFI]   "); Serial.print(WiFi.localIP());
    Serial.print("  RSSI="); Serial.print(WiFi.RSSI()); Serial.println(" dBm");
  } else {
    Serial.println("[WIFI]   disconnected");
  }
  Serial.print("[UPTIME] "); Serial.print(millis()/1000); Serial.println("s");
}

// ══════════════════════════════════════════════
//  SETUP
// ══════════════════════════════════════════════
void setup() {
  Serial.begin(115200);
  delay(2000);

  Serial.println();
  Serial.println("╔══════════════════════════════════╗");
  Serial.println("║     NEURO DETECT  v2.0           ║");
  Serial.println("║  Raw I2C — Clone Compatible      ║");
  Serial.println("╚══════════════════════════════════╝");
  Serial.println();

  // Start I2C
  Serial.println("[I2C]    Starting on SDA=21, SCL=22 ...");
  Wire.begin(21, 22);
  Wire.setClock(100000);
  Wire.setTimeOut(50);
  delay(500);
  Serial.println("[I2C]    Ready.");

  // Init sensor via raw registers
  Serial.println("[SENSOR] Initializing MPU6050 (raw I2C) ...");
  if (!initMPU()) {
    Serial.println("[FATAL]  Sensor init failed. Check wiring. Halting.");
    while (true) delay(1000);
  }

  // Calibrate
  Serial.println();
  calibrateSensor();

  // WiFi
  Serial.println();
  connectWiFi();

  // HTTP server
  server.on("/",     HTTP_GET,     handleRoot);
  server.on("/data", HTTP_GET,     handleData);
  server.on("/data", HTTP_OPTIONS, handleCORS);
  server.begin();

  Serial.println();
  Serial.println("[SERVER] HTTP server started.");
  Serial.print  ("[SERVER] Dashboard: http://");
  Serial.println(WiFi.localIP());
  Serial.println("[SYSTEM] Monitoring started. Shake sensor to test.");
  Serial.println("──────────────────────────────────────────────");
}

// ══════════════════════════════════════════════
//  LOOP
// ══════════════════════════════════════════════
void loop() {
  server.handleClient();

  unsigned long now = millis();

  if (now - lastSampleTime >= SAMPLE_INTERVAL_MS) {
    lastSampleTime = now;
    readAndFilter();
    detectTremor();
  }

  if (now - lastPrintTime >= 500) {
    lastPrintTime = now;
    printSerial();
  }
}
