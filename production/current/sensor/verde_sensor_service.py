#!/usr/bin/env python3
"""Reusable, single-owner VERDE water-sensor acquisition service.

The background acquisition thread is the only hardware owner. API consumers only
read the cached JSON-compatible snapshot, so repeated HTTP requests never trigger
additional ADS1115 or 1-Wire transactions.
"""

import copy
import csv
import json
import math
import re
import statistics
import threading
import time
from collections import Counter, deque
from datetime import datetime
from pathlib import Path

import board
import busio
import adafruit_ads1x15.ads1115 as ADS
from adafruit_ads1x15.analog_in import AnalogIn
from gpiozero import OutputDevice


ADS1115_ADDRESS = 0x48
ADS1115_GAIN = 1
MEASUREMENT_INTERVAL_SECONDS = 30.0
WARMUP_CYCLES = 5
WARMUP_INTERVAL_SECONDS = 1.0
FILTER_SIZE = 5
SPIKE_THRESHOLD_V = 0.050

# EC excitation relay: Raspberry Pi BCM25, physical header pin 22.
# The installed relay board is verified active-LOW: logical off drives GPIO HIGH.
EC_RELAY_BCM_PIN = 25
EC_RELAY_ACTIVE_HIGH = False
PH_SETTLE_SECONDS = 16.0
EC_SETTLE_SECONDS = 8.0
PH_EC_STALE_AFTER_SECONDS = 15.0

PH_SLOPE = -6.15727193
PH_INTERCEPT = 22.99548395
EC_RECORD_PATH = Path("/home/verde/ec_calibration_1467_27C_v2.json")
TURBIDITY_RECORD_PATH = Path("/home/verde/turbidity_calibration_ntu.json")
TURBIDITY_REFERENCE_NTU = 1.0

BASELINE_WINDOW_READINGS = 15
BASELINE_MAX_FILTERED_RANGE_V = 0.010
BASELINE_MAX_ABS_SLOPE_V_PER_SAMPLE = 0.00025

W1_DEVICES_PATH = Path("/sys/bus/w1/devices")
KNOWN_DS18B20_ID = "28-00000048b3b1"
DS18B20_PATTERN = re.compile(r"^28-[0-9a-fA-F]{12}$")

LOG_DIRECTORY = Path("/home/verde/logs/sensors")

CSV_COLUMNS = [
    "sample", "timestamp",
    "ph_raw_adc", "ph_raw_voltage_V", "ph_filtered_voltage_V", "ph",
    "ph_classification", "ph_status", "ph_spike_flag",
    "ec_tds_raw_adc", "ec_tds_raw_voltage_V", "ec_tds_filtered_voltage_V",
    "ec_uScm", "ec_mScm", "ec_classification", "ec_status", "ec_tds_spike_flag",
    "turbidity_raw_adc", "turbidity_raw_voltage_V",
    "turbidity_filtered_voltage_V", "turbidity_reference_voltage_V",
    "turbidity_ntu", "turbidity_classification", "turbidity_status",
    "turbidity_spike_flag", "water_temp_C", "water_temp_classification",
    "water_temp_status", "humidity_percent", "humidity_status", "overall_status",
]


def timestamp_now():
    return datetime.now().astimezone().isoformat(timespec="milliseconds")


def classify_ph(value):
    if value < 4.5 or value > 8.0:
        return "CRITICAL"
    if 5.5 <= value <= 6.5:
        return "OPTIMAL"
    return "SUBOPTIMAL"


def classify_ec(value_uScm):
    value_mScm = value_uScm / 1000.0
    if value_mScm < 0.5 or value_mScm > 4.0:
        return value_mScm, "CRITICAL"
    if 1.2 <= value_mScm <= 1.8:
        return value_mScm, "OPTIMAL"
    return value_mScm, "SUBOPTIMAL"


def classify_water_temperature(value):
    if value > 35.0:
        return "CRITICAL"
    if 18.0 <= value <= 24.0:
        return "OPTIMAL"
    return "SUBOPTIMAL"


def classify_turbidity(value_ntu):
    if value_ntu < 5.0:
        return "OPTIMAL"
    if value_ntu <= 20.0:
        return "SUBOPTIMAL"
    return "CRITICAL"


def calculate_turbidity_ntu(reference_voltage, measured_voltage):
    values = (reference_voltage, measured_voltage)
    if any(isinstance(value, bool) or not isinstance(value, (int, float))
           or not math.isfinite(value) or value == 0 for value in values):
        return None
    return TURBIDITY_REFERENCE_NTU * abs(reference_voltage) / abs(measured_voltage)


def linear_slope(values):
    if len(values) < 2:
        return 0.0
    x_mean = (len(values) + 1) / 2
    y_mean = statistics.mean(values)
    numerator = sum(
        (index - x_mean) * (value - y_mean)
        for index, value in enumerate(values, start=1)
    )
    denominator = sum(
        (index - x_mean) ** 2 for index in range(1, len(values) + 1)
    )
    return numerator / denominator


def load_scale(path, coefficient_field, expected_formula, allowed_statuses):
    with path.open(encoding="utf-8") as handle:
        record = json.load(handle)
    if record.get("calibration_status") not in allowed_statuses:
        raise ValueError(f"{path}: unexpected calibration status")
    if record.get("formula") != expected_formula:
        raise ValueError(f"{path}: unexpected formula")
    coefficient_text = record.get(coefficient_field)
    if not isinstance(coefficient_text, str):
        raise ValueError(f"{path}: precision-preserving coefficient string required")
    coefficient = float(coefficient_text)
    if not math.isfinite(coefficient) or coefficient <= 0:
        raise ValueError(f"{path}: invalid coefficient")
    return coefficient


def load_turbidity_reference(path=TURBIDITY_RECORD_PATH):
    with Path(path).open(encoding="utf-8") as handle:
        record = json.load(handle)
    if record.get("ads_channel") != "A0":
        raise ValueError(f"{path}: turbidity calibration is not for ADS1115 A0")
    if record.get("calibration_status") != "CALIBRATED":
        raise ValueError(f"{path}: turbidity calibration is not CALIBRATED")
    if float(record.get("reference_ntu", 0)) != TURBIDITY_REFERENCE_NTU:
        raise ValueError(f"{path}: reference NTU must be exactly 1.00")
    voltage = record.get("reference_voltage_V")
    if isinstance(voltage, bool) or not isinstance(voltage, (int, float)):
        raise ValueError(f"{path}: numeric reference_voltage_V required")
    if not math.isfinite(voltage) or voltage == 0:
        raise ValueError(f"{path}: invalid reference_voltage_V")
    return float(voltage), record


def open_dht11():
    import adafruit_dht
    return adafruit_dht.DHT11(board.D17, use_pulseio=False)


def read_dht11(device):
    humidity = device.humidity
    if (isinstance(humidity, bool) or not isinstance(humidity, (int, float))
            or not math.isfinite(humidity) or not 0 <= humidity <= 100):
        raise ValueError("no valid DHT11 humidity value")
    return float(humidity)


class RollingAnalogChannel:
    def __init__(self, name, analog_in):
        self.name = name
        self.analog_in = analog_in
        self.voltage_window = deque(maxlen=FILTER_SIZE)

    def clear_filter(self):
        self.voltage_window.clear()

    def warmup_read(self):
        raw_adc = self.analog_in.value
        return raw_adc, self.analog_in.convert_to_voltage(raw_adc)

    def acquire(self):
        raw_adc = self.analog_in.value
        raw_voltage = self.analog_in.convert_to_voltage(raw_adc)
        prior_median = (
            statistics.median(self.voltage_window)
            if len(self.voltage_window) >= 3 else None
        )
        spike = (
            prior_median is not None
            and abs(raw_voltage - prior_median) >= SPIKE_THRESHOLD_V
        )
        self.voltage_window.append(raw_voltage)
        return {
            "raw_adc": raw_adc,
            "raw_voltage_V": raw_voltage,
            "filtered_voltage_V": statistics.median(self.voltage_window),
            "spike": spike,
            "filter_count": len(self.voltage_window),
        }


class TurbidityBaseline:
    def __init__(self):
        self.session_clean_voltage = None
        self.candidates = []

    def observe(self, reading):
        if self.session_clean_voltage is not None or reading["filter_count"] < FILTER_SIZE:
            return False
        self.candidates.append(reading)
        if len(self.candidates) < BASELINE_WINDOW_READINGS:
            return False
        window = self.candidates[-BASELINE_WINDOW_READINGS:]
        filtered = [item["filtered_voltage_V"] for item in window]
        if (
            max(filtered) - min(filtered) <= BASELINE_MAX_FILTERED_RANGE_V
            and abs(linear_slope(filtered)) <= BASELINE_MAX_ABS_SLOPE_V_PER_SAMPLE
            and not any(item["spike"] for item in window)
        ):
            self.session_clean_voltage = statistics.median(
                item["raw_voltage_V"] for item in window
            )
            return True
        return False

    def relative_response(self, filtered_voltage):
        if self.session_clean_voltage is None:
            return None
        return (
            (self.session_clean_voltage - filtered_voltage)
            / self.session_clean_voltage * 100.0
        )


def discover_ds18b20():
    entries = list(W1_DEVICES_PATH.iterdir())
    devices = sorted(
        path for path in entries
        if DS18B20_PATTERN.fullmatch(path.name) and (path / "w1_slave").is_file()
    )
    known = W1_DEVICES_PATH / KNOWN_DS18B20_ID
    if known in devices:
        return known
    return devices[0] if devices else None


def read_ds18b20(device):
    if device is None:
        raise RuntimeError("no valid 28-* DS18B20 device")
    lines = (device / "w1_slave").read_text(encoding="ascii").splitlines()
    if len(lines) < 2:
        raise ValueError("malformed w1_slave data")
    if re.search(r"\bcrc=[0-9a-fA-F]{2}\s+YES\s*$", lines[0]) is None:
        raise ValueError("CRC/read validation failed")
    match = re.search(r"(?:^|\s)t=(-?\d+)(?:\s|$)", lines[1])
    if match is None:
        raise ValueError("temperature field t= is missing")
    value = int(match.group(1)) / 1000.0
    if value in (85.0, -127.0):
        raise ValueError(f"DS18B20 failure sentinel {value}")
    if not math.isfinite(value) or not -55.0 <= value <= 125.0:
        raise ValueError(f"implausible DS18B20 value {value}")
    return value


def sensor_unavailable(unit, status):
    return {
        "value": None,
        "unit": unit,
        "classification": "UNAVAILABLE",
        "status": status,
        "raw_adc": None,
        "raw_voltage_V": None,
        "filtered_voltage_V": None,
        "spike": False,
    }


class VerdeSensorService:
    def __init__(self, log_directory=LOG_DIRECTORY):
        self.lock = threading.RLock()
        self.stop_event = threading.Event()
        self.thread = None
        self.sample_number = 0
        self.error_counts = Counter()
        self.last_valid_ph = None
        self.last_valid_ec = None
        self.last_valid_ph_at = None
        self.last_valid_ec_at = None
        self.ph_consecutive_failures = 0
        self.ec_consecutive_failures = 0
        self.ec_relay = None
        self.ec_relay_setup_error = None
        try:
            self.ec_relay = OutputDevice(
                EC_RELAY_BCM_PIN,
                active_high=EC_RELAY_ACTIVE_HIGH,
                initial_value=False,
            )
            self.ec_relay.off()
        except Exception as exc:
            self.ec_relay_setup_error = f"{type(exc).__name__}: {exc}"
            self.error_counts["ec_relay_setup"] += 1
        self.ec_scale = load_scale(
            EC_RECORD_PATH, "ec_scale_uScm_per_V",
            "EC_uScm = EC_SCALE * voltage_V",
            {"ACCEPTED SINGLE-POINT DIRECT EC CALIBRATION — POST-HARDWARE-FIX"},
        )
        try:
            self.turbidity_reference_voltage, self.turbidity_calibration = (
                load_turbidity_reference()
            )
            self.turbidity_calibration_error = None
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
            self.turbidity_reference_voltage = None
            self.turbidity_calibration = None
            self.turbidity_calibration_error = f"{type(exc).__name__}: {exc}"
        self.i2c = None
        self.ads = None
        self.ph_channel = None
        self.ec_tds_channel = None
        self.turbidity_channel = None
        self.ads_setup_error = None
        try:
            self.i2c = busio.I2C(board.SCL, board.SDA)
            self.ads = ADS.ADS1115(self.i2c, address=ADS1115_ADDRESS)
            self.ads.gain = ADS1115_GAIN
            self.ph_channel = RollingAnalogChannel("ph", AnalogIn(self.ads, ADS.P1))
            self.ec_tds_channel = RollingAnalogChannel("ec_tds", AnalogIn(self.ads, ADS.P2))
            self.turbidity_channel = RollingAnalogChannel(
                "turbidity", AnalogIn(self.ads, ADS.P0)
            )
        except Exception as exc:
            # Analog water sensors may be unplugged during partial-hardware tests.
            # Independent DHT11, camera, GSM, API, History and Alerts must continue.
            self.ads_setup_error = f"{type(exc).__name__}: {exc}"
        self.ds18b20_device = discover_ds18b20()
        try:
            self.dht11_device = open_dht11()
            self.dht11_setup_error = None
        except Exception as exc:
            self.dht11_device = None
            self.dht11_setup_error = f"{type(exc).__name__}: {exc}"
        self.log_directory = Path(log_directory)
        self.log_directory.mkdir(parents=True, exist_ok=True)
        # Include microseconds so rapid test/service constructions cannot
        # select the same exclusive session log filename.
        stamp = datetime.now().astimezone().strftime("%Y%m%d_%H%M%S_%f")
        self.csv_path = self.log_directory / f"verde_integrated_session_{stamp}.csv"
        self.csv_handle = self.csv_path.open("x", newline="", encoding="utf-8")
        self.writer = csv.DictWriter(self.csv_handle, fieldnames=CSV_COLUMNS)
        self.writer.writeheader()
        self.csv_handle.flush()
        self.latest = self._initial_payload("INITIALIZING: warm-up in progress")
        self._warmup()
        self.thread = threading.Thread(
            target=self._run, name="verde-sensor-owner", daemon=True
        )
        self.thread.start()

    def _initial_payload(self, status):
        return {
            "timestamp": timestamp_now(),
            "sensors": {
                "ph": sensor_unavailable("pH", status),
                "ec": {
                    **sensor_unavailable("mS/cm", status),
                    "value_uScm": None, "value_mScm": None,
                    "calibration": "EC V2 post-hardware-fix",
                },
                "turbidity": {
                    **sensor_unavailable("NTU", status),
                    "value_ntu": None,
                    "reference_voltage_V": self.turbidity_reference_voltage,
                    "reference_ntu": TURBIDITY_REFERENCE_NTU,
                    "measurement_type": "CALIBRATED_NTU",
                },
                "water_temperature": {
                    "value_C": None, "unit": "C",
                    "classification": "UNAVAILABLE", "status": status,
                },
                "ambient_humidity": {
                    "value": None, "unit": "%", "classification": None,
                    "status": status,
                },
            },
            "system": {
                "ads1115_address": "0x48", "ads1115_gain": 1,
                "dht11": "INITIALIZING", "dht11_gpio": "BCM17",
                "ec_relay_gpio": "BCM25 (physical pin 22)",
                "ec_relay_polarity": "ACTIVE_LOW",
                "ec_relay_state": "OFF" if self.ec_relay is not None else "UNAVAILABLE",
                "overall_status": "DEGRADED",
                "sample": 0, "csv_path": str(self.csv_path),
            },
        }

    def _warmup(self):
        channels = tuple(channel for channel in (
            self.ph_channel, self.turbidity_channel
        ) if channel is not None)
        if not channels:
            return
        for cycle in range(WARMUP_CYCLES):
            self._relay_off()
            for channel in channels:
                try:
                    channel.warmup_read()
                except Exception:
                    self.error_counts[f"{channel.name}_warmup"] += 1
            if self.ec_tds_channel is not None and self.ec_relay is not None:
                try:
                    self.ec_relay.on()
                    time.sleep(WARMUP_INTERVAL_SECONDS)
                    self.ec_tds_channel.warmup_read()
                except Exception:
                    self.error_counts["ec_tds_warmup"] += 1
                finally:
                    self._relay_off()
            if cycle + 1 < WARMUP_CYCLES:
                time.sleep(WARMUP_INTERVAL_SECONDS)
        for channel in (*channels, self.ec_tds_channel):
            if channel is None:
                continue
            channel.clear_filter()

    def _relay_off(self):
        if self.ec_relay is None:
            return False
        try:
            self.ec_relay.off()
            return True
        except Exception:
            self.error_counts["ec_relay_off"] += 1
            return False

    def _acquire_alternating_ph_ec(self):
        ph_reading = None
        ec_reading = None
        ph_status = "UNAVAILABLE: EC relay on BCM25 could not be forced OFF"
        ec_status = "UNAVAILABLE: EC relay on BCM25 is not configured"

        try:
            if self.ec_relay is None:
                detail = self.ec_relay_setup_error or "relay unavailable"
                ph_status = f"UNAVAILABLE: EC relay fault ({detail})"
                ec_status = ph_status
                self.error_counts["ec_relay_unavailable"] += 1
                return ph_reading, ph_status, ec_reading, ec_status

            self.ec_relay.on()
            time.sleep(PH_SETTLE_SECONDS)
            ph_reading, ph_status = self._safe_analog(self.ph_channel)

            if not self._relay_off():
                raise RuntimeError("could not drive active-LOW EC relay OFF/connect EC")
            time.sleep(EC_SETTLE_SECONDS)
            ec_reading, ec_status = self._safe_analog(self.ec_tds_channel)
        except Exception as exc:
            self.error_counts["ec_relay_cycle"] += 1
            if ph_reading is None:
                ph_status = f"ERROR: alternating acquisition failed: {type(exc).__name__}: {exc}"
            ec_status = f"ERROR: alternating acquisition failed: {type(exc).__name__}: {exc}"
        finally:
            self._relay_off()

        return ph_reading, ph_status, ec_reading, ec_status

    @staticmethod
    def _retained_metadata(measured_at, now):
        age_seconds = max(0.0, (now - measured_at).total_seconds())
        return age_seconds, age_seconds > PH_EC_STALE_AFTER_SECONDS

    def _retain_or_mark_fault(self, name, current, valid, failure_status, now):
        value_attr = f"last_valid_{name}"
        timestamp_attr = f"last_valid_{name}_at"
        failures_attr = f"{name}_consecutive_failures"

        if valid:
            setattr(self, value_attr, copy.deepcopy(current))
            setattr(self, timestamp_attr, now)
            setattr(self, failures_attr, 0)
            current.update({
                "valid": True,
                "retained": False,
                "measured_at": now.isoformat(timespec="milliseconds"),
                "age_seconds": 0.0,
                "stale": False,
                "consecutive_failures": 0,
                "last_error": None,
            })
            return current

        failures = getattr(self, failures_attr) + 1
        setattr(self, failures_attr, failures)
        retained = getattr(self, value_attr)
        measured_at = getattr(self, timestamp_attr)
        if retained is None or measured_at is None:
            current.update({
                "valid": False, "retained": False, "measured_at": None,
                "age_seconds": None, "stale": True,
                "consecutive_failures": failures, "last_error": failure_status,
            })
            return current

        current = copy.deepcopy(retained)
        age_seconds, stale = self._retained_metadata(measured_at, now)
        current.update({
            "status": f"FAULT / RETAINED LAST VALID: {failure_status}",
            "valid": False,
            "retained": True,
            "measured_at": measured_at.isoformat(timespec="milliseconds"),
            "age_seconds": age_seconds,
            "stale": stale,
            "consecutive_failures": failures,
            "last_error": failure_status,
        })
        return current

    def _safe_analog(self, channel):
        if channel is None:
            return None, (
                "UNAVAILABLE: ADS1115 at 0x48 is not connected"
                + (f" ({self.ads_setup_error})" if self.ads_setup_error else "")
            )
        try:
            return channel.acquire(), "OK"
        except Exception as exc:
            self.error_counts[f"{channel.name}_read"] += 1
            return None, f"ERROR: {type(exc).__name__}: {exc}"

    @staticmethod
    def _analog_fields(reading):
        if reading is None:
            return {
                "raw_adc": None, "raw_voltage_V": None,
                "filtered_voltage_V": None, "spike": False,
            }
        return {
            "raw_adc": reading["raw_adc"],
            "raw_voltage_V": reading["raw_voltage_V"],
            "filtered_voltage_V": reading["filtered_voltage_V"],
            "spike": bool(reading["spike"]),
        }

    def _acquire(self):
        self.sample_number += 1
        timestamp = timestamp_now()
        cycle_now = datetime.now().astimezone()
        ph_reading, ph_read_status, a2_reading, a2_read_status = (
            self._acquire_alternating_ph_ec()
        )
        turb_reading, turb_read_status = self._safe_analog(self.turbidity_channel)

        ph = sensor_unavailable("pH", ph_read_status)
        if ph_reading is not None:
            value = PH_SLOPE * ph_reading["filtered_voltage_V"] + PH_INTERCEPT
            ph = {
                "value": value, "unit": "pH",
                "classification": classify_ph(value) if 0 <= value <= 14 else None,
                "status": "OK" if 0 <= value <= 14 else "WARNING: pH outside 0-14",
                **self._analog_fields(ph_reading),
            }
        ph = self._retain_or_mark_fault(
            "ph", ph, ph_reading is not None, ph_read_status, cycle_now
        )

        ec = {
            **sensor_unavailable("mS/cm", a2_read_status),
            "value_uScm": None, "value_mScm": None,
            "calibration": "EC V2 post-hardware-fix",
        }
        if a2_reading is not None:
            ec_uScm = self.ec_scale * a2_reading["filtered_voltage_V"]
            ec_mScm, ec_classification = classify_ec(ec_uScm)
            shared = self._analog_fields(a2_reading)
            ec = {
                "value": ec_mScm, "value_uScm": ec_uScm,
                "value_mScm": ec_mScm, "unit": "mS/cm",
                "classification": ec_classification,
                "status": "OK: ACCEPTED SINGLE-POINT DIRECT EC — POST-HARDWARE-FIX",
                "calibration": "EC V2 post-hardware-fix", **shared,
            }
        ec = self._retain_or_mark_fault(
            "ec", ec, a2_reading is not None, a2_read_status, cycle_now
        )

        turbidity = {
            **sensor_unavailable("NTU", turb_read_status),
            "value_ntu": None,
            "reference_voltage_V": self.turbidity_reference_voltage,
            "reference_ntu": TURBIDITY_REFERENCE_NTU,
            "measurement_type": "CALIBRATED_NTU",
        }
        if turb_reading is not None:
            ntu = calculate_turbidity_ntu(
                self.turbidity_reference_voltage,
                turb_reading["filtered_voltage_V"],
            )
            turbidity = {
                "value": ntu, "value_ntu": ntu,
                "unit": "NTU",
                "classification": classify_turbidity(ntu) if ntu is not None else "UNAVAILABLE",
                "status": (
                    "CALIBRATED" if ntu is not None
                    else "UNAVAILABLE: accepted turbidity calibration record is missing or invalid"
                ),
                "reference_voltage_V": self.turbidity_reference_voltage,
                "reference_ntu": TURBIDITY_REFERENCE_NTU,
                "measurement_type": "CALIBRATED_NTU",
                "calibration_error": self.turbidity_calibration_error,
                **self._analog_fields(turb_reading),
            }

        try:
            water_value = read_ds18b20(self.ds18b20_device)
            water_temperature = {
                "value_C": water_value, "unit": "C",
                "classification": classify_water_temperature(water_value),
                "status": f"OK: {self.ds18b20_device.name}; no software offset",
            }
        except Exception as exc:
            self.error_counts["ds18b20_read"] += 1
            water_temperature = {
                "value_C": None, "unit": "C", "classification": "UNAVAILABLE",
                "status": f"ERROR: {type(exc).__name__}: {exc}",
            }

        try:
            if self.dht11_device is None:
                raise RuntimeError(self.dht11_setup_error or "DHT11 unavailable")
            humidity_value = read_dht11(self.dht11_device)
            ambient_humidity = {
                "value": humidity_value, "unit": "%", "classification": None,
                "status": "CONNECTED: DHT11 on BCM GPIO17",
            }
        except Exception as exc:
            self.error_counts["dht11_read"] += 1
            ambient_humidity = {
                "value": None, "unit": "%", "classification": None,
                "status": f"ERROR: {type(exc).__name__}: {exc}",
            }

        available = [
            ph.get("value") is not None,
            ec.get("value_mScm") is not None,
            turbidity.get("value_ntu") is not None,
            water_temperature.get("value_C") is not None,
            ambient_humidity.get("value") is not None,
        ]
        overall = "OK" if all(available) else ("DEGRADED" if any(available) else "ERROR")
        payload = {
            "timestamp": timestamp,
            "sensors": {
                "ph": ph, "ec": ec,
                "turbidity": turbidity,
                "water_temperature": water_temperature,
                "ambient_humidity": ambient_humidity,
            },
            "system": {
                "ads1115_address": "0x48", "ads1115_gain": 1,
                "dht11": ambient_humidity["status"], "dht11_gpio": "BCM17",
                "ec_relay_gpio": "BCM25 (physical pin 22)",
                "ec_relay_polarity": "ACTIVE_LOW",
                "ec_relay_state": "OFF",
                "ph_settle_seconds": PH_SETTLE_SECONDS,
                "ec_settle_seconds": EC_SETTLE_SECONDS,
                "overall_status": overall,
                "sample": self.sample_number, "csv_path": str(self.csv_path),
                "error_counts": dict(self.error_counts),
            },
        }
        self._write_csv(payload)
        return payload

    def _write_csv(self, payload):
        s = payload["sensors"]
        row = {
            "sample": payload["system"]["sample"], "timestamp": payload["timestamp"],
            "ph_raw_adc": s["ph"].get("raw_adc"),
            "ph_raw_voltage_V": s["ph"].get("raw_voltage_V"),
            "ph_filtered_voltage_V": s["ph"].get("filtered_voltage_V"),
            "ph": s["ph"].get("value"), "ph_classification": s["ph"].get("classification"),
            "ph_status": s["ph"]["status"], "ph_spike_flag": s["ph"].get("spike", False),
            "ec_tds_raw_adc": s["ec"].get("raw_adc"),
            "ec_tds_raw_voltage_V": s["ec"].get("raw_voltage_V"),
            "ec_tds_filtered_voltage_V": s["ec"].get("filtered_voltage_V"),
            "ec_uScm": s["ec"].get("value_uScm"), "ec_mScm": s["ec"].get("value_mScm"),
            "ec_classification": s["ec"].get("classification"), "ec_status": s["ec"]["status"],
            "ec_tds_spike_flag": s["ec"].get("spike", False),
            "turbidity_raw_adc": s["turbidity"].get("raw_adc"),
            "turbidity_raw_voltage_V": s["turbidity"].get("raw_voltage_V"),
            "turbidity_filtered_voltage_V": s["turbidity"].get("filtered_voltage_V"),
            "turbidity_reference_voltage_V": s["turbidity"].get("reference_voltage_V"),
            "turbidity_ntu": s["turbidity"].get("value_ntu"),
            "turbidity_classification": s["turbidity"].get("classification"),
            "turbidity_status": s["turbidity"]["status"],
            "turbidity_spike_flag": s["turbidity"].get("spike", False),
            "water_temp_C": s["water_temperature"].get("value_C"),
            "water_temp_classification": s["water_temperature"].get("classification"),
            "water_temp_status": s["water_temperature"]["status"],
            "humidity_percent": s["ambient_humidity"].get("value"),
            "humidity_status": s["ambient_humidity"]["status"],
            "overall_status": payload["system"]["overall_status"],
        }
        self.writer.writerow(row)
        self.csv_handle.flush()

    def _run(self):
        next_sample = time.monotonic()
        while not self.stop_event.is_set():
            wait = next_sample - time.monotonic()
            if wait > 0 and self.stop_event.wait(wait):
                break
            try:
                payload = self._acquire()
                with self.lock:
                    self.latest = payload
            except Exception as exc:
                self.error_counts["acquisition_cycle"] += 1
                with self.lock:
                    self.latest["timestamp"] = timestamp_now()
                    self.latest["system"]["overall_status"] = "ERROR"
                    self.latest["system"]["last_error"] = f"{type(exc).__name__}: {exc}"
            next_sample += MEASUREMENT_INTERVAL_SECONDS

    def snapshot(self):
        with self.lock:
            return copy.deepcopy(self.latest)

    def health(self):
        snapshot = self.snapshot()
        sensors = snapshot["sensors"]
        return {
            "status": snapshot["system"]["overall_status"],
            "timestamp": snapshot["timestamp"],
            "sample": snapshot["system"]["sample"],
            "sensors": {
                "ph": sensors["ph"]["status"],
                "ec": sensors["ec"]["status"],
                "turbidity": sensors["turbidity"]["status"],
                "water_temperature": sensors["water_temperature"]["status"],
                "ambient_humidity": sensors["ambient_humidity"]["status"],
            },
        }

    def close(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=5)
        try:
            self.csv_handle.flush()
            self.csv_handle.close()
        finally:
            if self.ec_relay is not None:
                try:
                    self.ec_relay.off()
                finally:
                    self.ec_relay.close()
            if self.dht11_device is not None:
                close = getattr(self.dht11_device, "exit", None)
                if callable(close):
                    close()
            deinit = getattr(self.i2c, "deinit", None) if self.i2c is not None else None
            if callable(deinit):
                deinit()


_singleton_lock = threading.Lock()
_singleton = None


def initialize_sensors(log_directory=LOG_DIRECTORY):
    global _singleton
    with _singleton_lock:
        if _singleton is None:
            _singleton = VerdeSensorService(log_directory=log_directory)
        return _singleton


def read_sensor_snapshot():
    return initialize_sensors().snapshot()


def sensor_health():
    return initialize_sensors().health()


def shutdown_sensors():
    global _singleton
    with _singleton_lock:
        if _singleton is not None:
            _singleton.close()
            _singleton = None



