# VERDE sensor data-collection handoff

Prepared: 2026-10-24 (Asia/Manila)
Scope: inspection and documentation only
Production changes made by this task: none

## Evidence labels

- **VERIFIED - SOURCE:** confirmed by the inspected source snapshot.
- **VERIFIED - LIVE 2026-10-23:** confirmed by saved Raspberry Pi command output from 2026-10-23.
- **VERIFIED - HISTORICAL 2026-10-04:** confirmed by an older successful Pi verification, but not current proof.
- **USER-REPORTED:** stated by the project operator but not independently confirmed by a current API/hardware check.
- **CURRENT LIVE CHECK REQUIRED:** the available evidence is stale, incomplete, or does not show the requested value.
- **PENDING:** required evidence or work does not yet exist.

Do not interpret an active dashboard as proof that CSV or SQLite persistence is
correct. The live sensor API, integrated CSV, application SQLite database, and
frontend are separate paths.

## 1. Software location

### Production Raspberry Pi paths

| Purpose | Exact path | Evidence/status |
|---|---|---|
| Active project | `/home/verde/VERDE-Sensor-Integration` | VERIFIED - LIVE 2026-10-23 |
| Application entry point | `/home/verde/VERDE-Sensor-Integration/run.py` | VERIFIED - LIVE 2026-10-23 |
| Authoritative hardware owner | `/home/verde/VERDE-Sensor-Integration/verde_sensor_service.py` | VERIFIED - SOURCE and LIVE |
| Main application orchestration | `/home/verde/VERDE-Sensor-Integration/app/service.py` | VERIFIED - SOURCE |
| Sensor adapter package | `/home/verde/VERDE-Sensor-Integration/app/sensors/` | VERIFIED - SOURCE |
| Example configuration | `/home/verde/VERDE-Sensor-Integration/config.example.json` | VERIFIED - SOURCE |
| Machine-local configuration | `/home/verde/VERDE-Sensor-Integration/config.local.json` | Exists on Pi; private; do not commit |
| Application database schema | `/home/verde/VERDE-Sensor-Integration/app/database/schema.sql` | VERIFIED - SOURCE |
| Application database implementation | `/home/verde/VERDE-Sensor-Integration/app/database/__init__.py` | VERIFIED - SOURCE |
| Runtime SQLite database | `/home/verde/VERDE-Sensor-Integration/data/verde.sqlite3` | Expected production path; current contents require live check |
| Integrated CSV implementation | `/home/verde/VERDE-Sensor-Integration/verde_sensor_service.py` (`CSV_COLUMNS`, `_write_csv`) | VERIFIED - SOURCE |
| Integrated CSV output | `/home/verde/logs/sensors/verde_integrated_session_*.csv` | VERIFIED - SOURCE; historical output confirmed |
| EC V2 calibration record | `/home/verde/ec_calibration_1467_27C_v2.json` | Required at runtime; private machine-local record; current contents require inspection |
| Expected turbidity record | `/home/verde/turbidity_calibration_ntu.json` | No genuine record has been verified; treat as absent/pending |
| Turbidity utility | `/home/verde/VERDE-Sensor-Integration/tools/calibrate_turbidity_1ntu.py` | VERIFIED - SOURCE; do not run without a real traceable standard |
| Service log | `/home/verde/VERDE-Sensor-Integration/logs/verde.log` | Runtime file; do not commit |

The systemd command verified on 2026-10-23 was:

```text
/home/verde/VERDE-Sensor-Integration/.venv/bin/python
/home/verde/VERDE-Sensor-Integration/run.py
--port 8001
--web-root /home/verde/VERDEapp
--trusted-origin https://<private-tailscale-host>
```

The production checkout was historically based on `feature/gsm-alerts` at
`ac7edf4`, with substantial uncommitted integration work. Do not replace it with
a clean clone. The Windows inspection snapshot used for this handoff is a
reconstruction based on `Application-of-Pi` commit `9db9f76` plus uncommitted
partial-hardware and AI changes; it is evidence, not proof of byte-for-byte Pi
identity.

## 2. Current sensor configuration

| Sensor/component | Exact model documented | Connection | Supply / logic voltage | Current connection status | Calibration status | Unit recorded | Relevant source/configuration |
|---|---|---|---|---|---|---|---|
| ADS1115 ADC | ADS1115 | Raspberry Pi I2C bus 1; expected address `0x48`; gain `1` | **UNKNOWN** - exact deployed supply and I2C logic voltage were not recorded | USER-REPORTED unplugged on 2026-10-23; current `i2cdetect` required | ADC itself does not provide chemical calibration | Raw ADC counts and volts | `verde_sensor_service.py`: `ADS1115_ADDRESS`, `ADS1115_GAIN` |
| pH | Exact probe/interface-board model **UNKNOWN** | ADS1115 A1 | **UNKNOWN** | USER-REPORTED unplugged; current live check required | Formula exists, but source record/date are undocumented; thesis-valid reference verification pending | pH; raw/filtered V | `verde_sensor_service.py`: `PH_SLOPE`, `PH_INTERCEPT`, A1 initialization |
| EC | Exact probe/interface-board model **UNKNOWN** | ADS1115 A2 | **UNKNOWN** | USER-REPORTED unplugged; current live check required | Software accepts EC V2 record; physical reference revalidation and record inspection pending | uS/cm and mS/cm; raw/filtered V | `verde_sensor_service.py`; `/home/verde/ec_calibration_1467_27C_v2.json` |
| Turbidity | Utility labels it “SEN0189-compatible”; exact physical model not verified | ADS1115 A3 | **UNKNOWN** | USER-REPORTED unplugged; current live check required | **CALIBRATION PENDING**; no genuine 1.00 NTU reference record verified | Intended NTU; raw/filtered V | `verde_sensor_service.py`; `tools/calibrate_turbidity_1ntu.py` |
| DS18B20 | DS18B20; historical ID `28-00000048b3b1` | Linux 1-Wire sysfs | **UNKNOWN in project record** | USER-REPORTED unplugged; historical communication worked; current live check required | No software offset; comparison with reference thermometer pending | degrees Celsius | `verde_sensor_service.py`; `app/sensors/ds18b20.py` |
| DHT11 | DHT11 | BCM GPIO17, physical pin 11 | VCC 3.3 V; DATA 3.3 V logic; GND physical pin 6, per project wiring record | USER-REPORTED plugged; `/api/status` showed `DISABLED` due the known legacy-status mapping, so integrated API confirmation is required | Response was hardware-observed; accuracy comparison with reference hygrometer pending | % RH | `verde_sensor_service.py`; `app/sensors/dht11.py` |
| TDS | No independent active sensor; A2 was historically shared/labeled EC/TDS | Historical A2 compatibility only | Same unknown interface details as EC | Disabled/removed from active API and frontend | No active TDS calibration; must not be derived from EC | No active unit; historical SQLite `tds REAL` column retained | `app/database/schema.sql`; `app/database/__init__.py`; CSV names retain `ec_tds_*` for history |

Important distinction: `app/sensors/default_sensors()` intentionally exposes
placeholder/disabled adapters so it does not open duplicate hardware. The
authoritative physical acquisition path is `verde_sensor_service.py`, exposed
through `/api/sensors/latest` and `/api/sensors/health`.

## 3. Calibration evidence

### pH

The source currently applies:

```text
pH = -6.15727193 * filtered_voltage_V + 22.99548395
```

- Source: hard-coded `PH_SLOPE` and `PH_INTERCEPT` in `verde_sensor_service.py`.
- Calibration identifier in CSV: none.
- Calibration record path: none documented.
- Calibration date/source standards: not documented in the inspected files.
- Status: **formula present, provenance insufficient; CALIBRATION VERIFICATION PENDING**.

These constants are not proof that current probes, cables, interface board, and
reference buffers still produce accurate pH values.

### EC V2

The accepted software path is:

```text
EC_uScm = EC_SCALE * filtered_voltage_V
EC_mScm = EC_uScm / 1000
```

The expected scale evidenced by tests and prior live values is:

```text
EC_SCALE = 1922.3587223587222 uS/cm/V
```

The runtime loader requires:

- path: `/home/verde/ec_calibration_1467_27C_v2.json`
- coefficient field: `ec_scale_uScm_per_V` as a precision-preserving string
- formula: `EC_uScm = EC_SCALE * voltage_V`
- status: `ACCEPTED SINGLE-POINT DIRECT EC CALIBRATION - POST-HARDWARE-FIX`

The actual Pi JSON was not copied or inspected in this task. Its creation date,
reference-solution certificate/value, temperature record, and raw calibration
observations remain **CURRENT LIVE CHECK REQUIRED**. The source labels output
`EC V2 post-hardware-fix`, but the integrated CSV does not store a unique
calibration-record identifier or record hash.

### Turbidity

- Expected runtime path: `/home/verde/turbidity_calibration_ntu.json`.
- No genuine runtime JSON or measured reference voltage is available in the
  inspected workspace or saved live evidence.
- Earlier project instructions explicitly stated that the live reference
  voltage had not been measured and prohibited fabrication.
- Tests use synthetic values such as `1.45 V`/`1.50 V`; those are fixtures, not
  calibration evidence.
- Status: **CALIBRATION PENDING**.

The utility requires at least 60 unique cached A3 samples and writes a median
reference-voltage record only when stability checks pass. Its current metadata
describes a drinking-water sample “assigned” as 1.00 NTU. That assignment is not
a traceable certified turbidity standard. Do not run or accept its JSON for
final thesis data until the reference sample/meter is scientifically approved.

### Calibration traceability in stored data

| Evidence | CSV | SQLite scalar columns | SQLite JSON payload |
|---|---|---|---|
| pH calibration ID | No | No | No explicit ID |
| EC calibration ID | No | No | API snapshot may contain label only |
| Turbidity reference voltage | Yes | No | Only if authoritative integrated snapshot is persisted |
| Calibration record hash/path | No | No | No verified field |
| Calibration date | No | No | No verified field |

Final collection should not begin until each session can be tied to reviewed
calibration evidence by ID/hash and date without changing historical records.

## 4. Logging readiness

### Integrated CSV

The authoritative sensor owner creates a new exclusive session file under
`/home/verde/logs/sensors/` and flushes every row. Source interval is currently
`MEASUREMENT_INTERVAL_SECONDS = 2.0`, which does not match the manuscript's
5–10 second data-acquisition interval.

Exact CSV columns:

```text
sample
timestamp
ph_raw_adc
ph_raw_voltage_V
ph_filtered_voltage_V
ph
ph_classification
ph_status
ph_spike_flag
ec_tds_raw_adc
ec_tds_raw_voltage_V
ec_tds_filtered_voltage_V
ec_uScm
ec_mScm
ec_classification
ec_status
ec_tds_spike_flag
turbidity_raw_adc
turbidity_raw_voltage_V
turbidity_filtered_voltage_V
turbidity_reference_voltage_V
turbidity_ntu
turbidity_classification
turbidity_status
turbidity_spike_flag
water_temp_C
water_temp_classification
water_temp_status
humidity_percent
humidity_status
overall_status
```

CSV retention summary:

- Timestamp: yes.
- Connection/status text: yes, per sensor.
- Raw ADC/raw voltage/filtered voltage: yes for pH, EC/A2, and turbidity.
- Classification: yes for pH, EC, turbidity, and water temperature.
- Spike flags: yes for all three analog channels.
- Error counters: no dedicated CSV columns; they exist in the cached API
  `system.error_counts` object.
- Calibration ID/hash/date: no.
- Turbidity reference voltage: yes.
- DS18B20 and DHT11 raw evidence: no; only value/status.

Historical 2026-10-04 evidence reported an integrated CSV with 238 rows, actual
pH/EC/water-temperature values, no sensor error counts, and false A1/A2/A3
spike flags. This is **historical**, not proof of the present unplugged state.

### SQLite

Database type: SQLite. Expected path:
`/home/verde/VERDE-Sensor-Integration/data/verde.sqlite3`.

Tables:

```sql
snapshots(
  id, timestamp,
  ph, ec, tds, water_temperature, turbidity, ambient_humidity,
  water_quality, plant_condition, pest_detection, fusion_confidence,
  selected_mode, operating_mode, system_status,
  payload
)

events(id, timestamp, category, message, payload)
```

The scalar schema does not include raw/filtered voltages, statuses,
classifications, spike flags, error counters, or calibration identifiers. The
`payload` JSON can retain extra evidence only if the correct integrated sensor
snapshot is included before insertion.

### Known History blocker

**VERIFIED - SOURCE and LIVE 2026-10-23:** the deployed main monitoring loop
built `/api/status` and SQLite rows from placeholder `default_sensors()` while
the real cached values were exposed separately through `/api/sensors/latest`.
Consequently, History contained null sensor scalar fields even while the live
sensor endpoint had values.

A local uncommitted repair exists that builds SQLite rows from the cached
integrated snapshot, skips duplicate/all-null acquisition rows, stores the full
integrated evidence in `payload`, and adds 24-hour/7-day downsampling. There is
no evidence that this repair was committed, pushed, deployed, or reverified on
the Pi. Do not deploy it as part of this documentation task.

Current recent stored rows: **CURRENT LIVE CHECK REQUIRED**. The last known
History symptom was null/unavailable sensor fields. Therefore logging is not
ready for final collection.

## 5. Raspberry Pi readiness evidence

### Recent verified outputs

| Check | Evidence | Result |
|---|---|---|
| `verde.service` | VERIFIED - LIVE 2026-10-23 14:22 PST | `active` |
| `verde-ai.service` | VERIFIED - LIVE 2026-10-23 14:22 PST | `active` |
| `run.py` hardware-owner processes | VERIFIED - LIVE 2026-10-23 | Exactly one (`PID 74362` at that check) |
| AI worker processes | VERIFIED - LIVE 2026-10-23 | Exactly one (`PID 44939` at that check) |
| ADS1115 detection | Historical detection at `0x48`; subsequently unplugged | **CURRENT LIVE CHECK REQUIRED** |
| DS18B20 detection | Historical ID `28-00000048b3b1`; subsequently unplugged | **CURRENT LIVE CHECK REQUIRED** |
| `/api/sensors/health` | Endpoint returned HTTP 200 on 2026-10-23, but payload was not captured | **CURRENT LIVE CHECK REQUIRED** |
| `/api/sensors/latest` | Endpoint returned HTTP 200 on 2026-10-23, but payload was not captured | **CURRENT LIVE CHECK REQUIRED** |
| Error-count change | No errors in the historical 238-row verification | **CURRENT LIVE CHECK REQUIRED** |
| Spike-flag change | A1/A2/A3 false historically | **CURRENT LIVE CHECK REQUIRED** |

The 2026-10-23 service log showed pH, EC, turbidity, and water temperature as
`HARDWARE TEST PENDING` in `/api/status`, and humidity as `DISABLED`. Those are
the legacy placeholder adapters, not the authoritative integrated endpoint.
This mismatch is itself a blocker because operators can confuse two different
sensor states.

### Safe read-only checks for later

These commands do not write GPIO, drive pumps, change modes, calibrate sensors,
or restart services. Run only after the hardware is intentionally connected.

```bash
cd /home/verde/VERDE-Sensor-Integration || exit 1

echo "=== SERVICES ==="
systemctl is-active verde.service
systemctl is-active verde-ai.service

echo "=== PROCESS OWNERS ==="
pgrep -af '/home/verde/VERDE-Sensor-Integration/run.py' || true

echo "=== I2C DETECTION (READ-ONLY BUS SCAN) ==="
i2cdetect -y 1

echo "=== DS18B20 DETECTION ==="
ls -d /sys/bus/w1/devices/28-* 2>/dev/null || echo "No DS18B20 detected"

echo "=== INTEGRATED SENSOR HEALTH ==="
curl --max-time 10 -sS http://127.0.0.1:8001/api/sensors/health |
  python3 -m json.tool

echo "=== INTEGRATED LATEST SAMPLE ==="
curl --max-time 10 -sS http://127.0.0.1:8001/api/sensors/latest |
  python3 -m json.tool

echo "=== RECENT SQLITE SENSOR COLUMNS ==="
./.venv/bin/python - <<'PY'
import sqlite3
from pathlib import Path

path = Path('data/verde.sqlite3')
print('Database:', path.resolve(), 'exists=', path.exists())
if path.exists():
    connection = sqlite3.connect(path)
    try:
        rows = connection.execute(
            'SELECT id,timestamp,ph,ec,tds,water_temperature,turbidity,'
            'ambient_humidity FROM snapshots ORDER BY id DESC LIMIT 5'
        ).fetchall()
        for row in rows:
            print(row)
    finally:
        connection.close()
PY

echo "=== LATEST CSV HEADER AND TAIL ==="
LATEST_CSV="$(ls -1t /home/verde/logs/sensors/verde_integrated_session_*.csv 2>/dev/null | head -1)"
echo "CSV=$LATEST_CSV"
if [ -n "$LATEST_CSV" ]; then
  head -1 "$LATEST_CSV"
  tail -5 "$LATEST_CSV"
fi
```

Do not use the `i2cdetect` result alone as proof of sensor accuracy; it only
confirms that a device acknowledges an I2C address.

## 6. Materials and missing requirements

No current physical inventory was supplied. Historical calibration labels do
not prove that standards/meters remain available or in date.

| Material | Status | Evidence needed |
|---|---|---|
| pH reference buffers and values | **UNKNOWN** | Photograph/label, values, lot, expiry, and current availability |
| Certified EC solution and value/unit | **UNKNOWN** | Certificate/label, conductivity value, temperature basis, lot/expiry |
| Turbidity standard or calibrated turbidity meter | **UNKNOWN / NOT VERIFIED** | Traceable standard value or meter calibration record; drinking water assigned 1 NTU is insufficient |
| Reference pH meter | **UNKNOWN** | Model, calibration status/date, and availability |
| Reference EC meter | **UNKNOWN** | Model, calibration status/date, and availability |
| Reference thermometer | **UNKNOWN** | Model, accuracy/specification, and availability |
| Reference hygrometer | **UNKNOWN** | Model, accuracy/specification, and availability |
| Clean labeled containers and rinse water | **UNKNOWN** | Physical inventory confirmation |

## 7. Thesis methodology verification

Source manuscript: `D:\ZAMBALES\J3-Revised-Chapter-1-3-1.pdf`.

| Question | Manuscript requirement | Location |
|---|---|---|
| Sensor readings every 5–10 seconds? | **YES** | Section 1.5 Scope and Limitations, printed page 9 (PDF page 18); Section 3.3.4.3 procedure item 5, printed pages 75–76 (PDF pages 84–85) |
| Dashboard/fusion updates every 30 seconds? | **YES** | Section 3.3.4.3 item 7, printed page 76 (PDF page 85); dashboard test in Section 3.3.4.9, printed page 83 (PDF page 92) |
| At least 30 timed latency trials? | **YES** | Section 3.3.4.10 item 5, printed page 84 (PDF page 93); also performance discussion on printed page 71/72 area (PDF page 81) |
| Specific number of sensor-accuracy trials? | **NO** | Section 3.3.4.3 says to repeat measurements under varying nutrient-solution conditions and validate against reference instruments, but gives no numeric minimum |

The minimum of 30 applies to timed system-response latency trials. It must not
be misreported as “30 calibration trials per sensor” or “30 sensor-accuracy
trials” without an approved methodology amendment.

The manuscript also requires all sensor outputs to be stored in the system
database and validated against corresponding reference instruments. That makes
the null-History issue and missing reference inventory direct blockers.

## 8. Blockers and readiness

### Ready for pilot: NO

A complete sensor pilot is not ready. A limited camera/GSM or DHT11 engineering
check is possible, but it is not the requested pH/EC/turbidity/temperature data
pilot.

### Ready for final thesis collection: NO

Exact blockers:

1. ADS1115, pH, EC, turbidity, and DS18B20 were reported unplugged and require a
   current read-only detection/API check after reconnection.
2. DHT11 is reported plugged, but its current authoritative integrated API
   result has not been captured; `/api/status` still shows a misleading disabled
   placeholder.
3. No genuine turbidity calibration JSON/reference voltage has been verified.
4. pH constants lack a documented calibration record, date, source standards,
   ID, and record hash.
5. The actual EC V2 JSON and its supporting reference evidence have not been
   inspected; current reference revalidation is pending.
6. DS18B20 and DHT11 accuracy have not been compared with reference instruments.
7. The physical reference-material and reference-meter inventory is unknown.
8. SQLite History historically stores null sensor fields while the integrated
   CSV/API has real values. The local repair is uncommitted and undeployed.
9. Integrated CSV sampling is 2 seconds, while the manuscript specifies 5–10
   seconds; app polling is 5 seconds rather than a documented 30-second
   dashboard/fusion cycle. The approved collection protocol must be reconciled.
10. Calibration ID/hash/date are not retained in each CSV/database session.
11. The last complete backend suite available from 2026-10-23 had one turbidity
    calibration test failure caused by an equation-text mismatch. Later targeted
    AI/frontend tests do not clear that backend failure.
12. Current sensor error-count and spike-flag trends are unknown.

## Files to provide to the next Codex chat

Safe starting document:

- `HANDOFF.md` from this repository.

Then provide or grant read-only access to these production-source files, without
private configuration or runtime data:

- `run.py`
- `verde_sensor_service.py`
- `config.example.json`
- `requirements.txt`
- `app/service.py`
- `app/config.py`
- `app/components.py`
- `app/sensors/__init__.py`
- `app/sensors/ads1115.py`
- `app/sensors/ds18b20.py`
- `app/sensors/dht11.py`
- `app/database/__init__.py`
- `app/database/schema.sql`
- `app/web/__init__.py`
- `tools/calibrate_turbidity_1ntu.py`
- `tests/test_live_sensor_backend.py`
- `tests/test_turbidity_calibration.py`

Do **not** send or commit:

- `config.local.json`
- phone numbers, credentials, tokens, or Tailscale identity data
- `/home/verde/ec_calibration_1467_27C_v2.json` until reviewed/redacted
- any claimed turbidity calibration JSON unless it is genuine and reviewed
- `data/verde.sqlite3` or journals
- raw CSV sessions or logs without explicit privacy/data review
- camera images, datasets, or model weights
- virtual environments, caches, backups, or temporary files

## Recommended next action

1. Keep production unchanged.
2. Inventory the physical standards/reference meters and record labels,
   values/units, lots, expiries, and calibration dates.
3. Power down appropriately before reconnecting sensor wiring; do not alter
   wiring while energized.
4. Run the safe read-only checks above after deliberate reconnection and save
   their complete output.
5. Inspect the actual EC JSON and confirm whether a genuine turbidity JSON is
   absent. Do not fabricate either record.
6. Decide and document the approved 5–10 second acquisition and 30-second
   dashboard/fusion protocol before collection.
7. In a separate code-change task, review/test/deploy the integrated-History
   repair and add calibration-session traceability. Re-run the entire backend
   suite and require all tests to pass.
8. Perform a short pilot with paired reference readings and verify both CSV and
   SQLite persistence before declaring final collection ready.

Do not begin final data collection merely because the frontend displays live
numbers.
