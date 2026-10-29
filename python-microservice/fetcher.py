import os
import sys
import time
import datetime
import logging
import traceback
import requests

from zk import ZK

# =========================================================
# CONFIGURATION
# =========================================================

DEVICE_IP = "192.168.18.101"
DEVICE_PORT = 4370
COMM_KEY = 11

WEBHOOK_URL = "http://localhost:5000/api/webhooks/attendance"

SYNC_FILE = "last_sync_time.txt"
LOG_FILE = "biometric_fetcher.log"

SYNC_INTERVAL = 300          # 5 minutes
MAX_CONNECT_ATTEMPTS = 5
RETRY_DELAY = 10             # Seconds between connection attempts
DEVICE_TIMEOUT = 30
HTTP_TIMEOUT = (5, 30)       # HTTP connect and read timeouts

START_DATE = datetime.datetime(2026, 6, 1, 0, 0, 0)

# IMPORTANT:
# Device clock is correct. Do not adjust attendance timestamps.

# =========================================================
# LOGGING
# =========================================================

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

SYNC_FILE = os.path.join(BASE_DIR, SYNC_FILE)
LOG_FILE = os.path.join(BASE_DIR, LOG_FILE)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(LOG_FILE, encoding="utf-8"),
    ],
    force=True,
)

# =========================================================
# CHECKPOINT MANAGEMENT
# =========================================================

def get_last_sync_time():
    if os.path.exists(SYNC_FILE):
        try:
            with open(SYNC_FILE, "r", encoding="utf-8") as file:
                value = file.read().strip()

            if value:
                return datetime.datetime.fromisoformat(value)

        except (OSError, ValueError):
            logging.exception("Could not read last sync time")

    # First run: process records starting from START_DATE.
    set_last_sync_time(START_DATE)
    return START_DATE


def set_last_sync_time(sync_time):
    temp_file = SYNC_FILE + ".tmp"

    try:
        with open(temp_file, "w", encoding="utf-8") as file:
            file.write(sync_time.isoformat())
            file.flush()
            os.fsync(file.fileno())

        os.replace(temp_file, SYNC_FILE)

    except OSError:
        logging.exception("Could not save last sync time")


# =========================================================
# BIOMETRIC DEVICE CONNECTION
# =========================================================

def connect_device():
    zk = ZK(
        DEVICE_IP,
        port=DEVICE_PORT,
        timeout=DEVICE_TIMEOUT,
        password=COMM_KEY,
        force_udp=True,
    )

    for attempt in range(1, MAX_CONNECT_ATTEMPTS + 1):
        try:
            logging.info(
                "Connecting to device %s (attempt %d/%d)",
                DEVICE_IP,
                attempt,
                MAX_CONNECT_ATTEMPTS,
            )

            conn = zk.connect()

            if conn:
                logging.info("Connected to biometric device successfully")
                return conn

        except Exception:
            logging.exception(
                "Device connection attempt %d failed",
                attempt,
            )

        if attempt < MAX_CONNECT_ATTEMPTS:
            logging.info("Retrying connection in %d seconds", RETRY_DELAY)
            time.sleep(RETRY_DELAY)

    logging.error(
        "Device unavailable after %d attempts. "
        "Will retry during the next sync cycle.",
        MAX_CONNECT_ATTEMPTS,
    )

    return None


# =========================================================
# FETCH AND POST ATTENDANCE
# =========================================================

def fetch_and_post_logs():
    conn = None
    device_disabled = False

    try:
        conn = connect_device()

        if conn is None:
            return

        try:
            conn.disable_device()
            device_disabled = True

            last_sync = get_last_sync_time()
            now = datetime.datetime.now()

            logging.info("Last successful sync: %s", last_sync)

            attendance = conn.get_attendance()

            logging.info(
                "Retrieved %d records from biometric device",
                len(attendance),
            )

            logs_payload = []
            latest_timestamp = last_sync

            for log in attendance:
                try:
                    # Keep original device timestamp. No clock correction.
                    device_time = log.timestamp

                    if device_time <= START_DATE:
                        continue

                    if device_time <= last_sync:
                        continue

                    if device_time > now:
                        logging.warning(
                            "Skipping future-dated attendance record: %s",
                            device_time,
                        )
                        continue

                    logs_payload.append({
                        "user_id": str(log.user_id),
                        "timestamp": device_time.isoformat(),
                        "status": log.punch,
                        "punch": log.punch,
                    })

                    if device_time > latest_timestamp:
                        latest_timestamp = device_time

                except (AttributeError, TypeError, ValueError):
                    logging.exception(
                        "Skipping invalid attendance record"
                    )

            if not logs_payload:
                logging.info("No new attendance records found")
                return

            # Keep records in chronological order.
            logs_payload.sort(key=lambda item: item["timestamp"])

            logging.info(
                "Sending %d attendance records to Node.js",
                len(logs_payload),
            )

            response = requests.post(
                WEBHOOK_URL,
                json=logs_payload,
                timeout=HTTP_TIMEOUT,
            )

            response.raise_for_status()

            try:
                result = response.json()
            except ValueError:
                result = {}

            logging.info(
                "Webhook succeeded. HTTP %s; inserted: %s",
                response.status_code,
                result.get("inserted", "not reported"),
            )

            # Advance the checkpoint only after successful HTTP delivery.
            set_last_sync_time(latest_timestamp)

            logging.info(
                "Last sync checkpoint updated to %s",
                latest_timestamp,
            )

        finally:
            # Re-enable the device even if fetching or posting fails.
            if device_disabled:
                try:
                    conn.enable_device()
                    logging.info("Biometric device re-enabled")
                except Exception:
                    logging.exception(
                        "WARNING: Could not re-enable biometric device"
                    )

    except requests.RequestException:
        logging.exception(
            "Webhook/network request failed; records will be retried"
        )

    except Exception:
        logging.error(
            "Unexpected error during attendance sync:\n%s",
            traceback.format_exc(),
        )

    finally:
        if conn is not None:
            try:
                conn.disconnect()
                logging.info("Disconnected from biometric device")
            except Exception:
                logging.exception("Error disconnecting device")


# =========================================================
# MAIN LOOP
# =========================================================

def main():
    logging.info("=" * 60)
    logging.info("BIOMETRIC FETCHER SERVICE STARTED")
    logging.info("Device IP: %s", DEVICE_IP)
    logging.info("Device port: %s", DEVICE_PORT)
    logging.info("Sync interval: %s seconds", SYNC_INTERVAL)
    logging.info("Device timestamps will remain unchanged")
    logging.info("=" * 60)

    while True:
        cycle_start = time.monotonic()

        try:
            fetch_and_post_logs()

        except KeyboardInterrupt:
            raise

        except Exception:
            logging.error(
                "Unexpected sync-cycle failure:\n%s",
                traceback.format_exc(),
            )

        elapsed = time.monotonic() - cycle_start
        wait_time = max(1, SYNC_INTERVAL - elapsed)

        logging.info(
            "Sync cycle completed. Next sync in %.0f seconds",
            wait_time,
        )

        try:
            time.sleep(wait_time)
        except KeyboardInterrupt:
            raise


# =========================================================
# START SERVICE
# =========================================================

if __name__ == "__main__":
    try:
        main()

    except KeyboardInterrupt:
        logging.info("Service stopped manually by user")

    except BaseException:
        logging.critical(
            "FATAL ERROR:\n%s",
            traceback.format_exc(),
        )

    finally:
        logging.info("Biometric fetcher stopped")

        # Keep the console open if launched by double-clicking on Windows.
        if os.name == "nt":
            try:
                input("Press Enter to close this window...")
            except (EOFError, KeyboardInterrupt):
                pass