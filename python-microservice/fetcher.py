
import os
import sys
import time
import logging
import traceback
import datetime
import requests

from zk import ZK

# =========================================================
# CONFIGURATION
# =========================================================

DEVICE_IP = "192.168.18.101"
DEVICE_PORT = 4370
COMM_KEY = 11

WEBHOOK_URL = "http://localhost:5000/api/webhooks/attendance"

LOG_FILE = "biometric_fetcher.log"

SYNC_INTERVAL = 300          # 5 minutes
MAX_CONNECT_ATTEMPTS = 5
RETRY_DELAY = 10
DEVICE_TIMEOUT = 30

HTTP_TIMEOUT = (10, 120)

BATCH_SIZE = 500

# Fetch today's records and previous 14 calendar days.
FETCH_DAYS = 15

# =========================================================
# LOGGING
# =========================================================

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

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

                logging.info(
                    "Connected to biometric device successfully"
                )

                return conn

        except Exception:

            logging.exception(
                "Device connection attempt %d failed",
                attempt,
            )

        if attempt < MAX_CONNECT_ATTEMPTS:

            logging.info(
                "Retrying connection in %d seconds",
                RETRY_DELAY,
            )

            time.sleep(RETRY_DELAY)

    logging.error(
        "Device unavailable after %d attempts.",
        MAX_CONNECT_ATTEMPTS,
    )

    return None


# =========================================================
# FETCH AND POST LAST 15 DAYS OF ATTENDANCE
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

            # Calculate rolling 15-day window.
            now = datetime.datetime.now()

            start_date = (
                now - datetime.timedelta(days=FETCH_DAYS - 1)
            ).replace(
                hour=0,
                minute=0,
                second=0,
                microsecond=0,
            )

            end_date = now

            logging.info(
                "Fetching attendance from %s to %s",
                start_date,
                end_date,
            )

            attendance = conn.get_attendance()

            logging.info(
                "Retrieved %d total records from biometric device",
                len(attendance),
            )

            logs_payload = []

            for log in attendance:

                try:

                    # Preserve original device timestamp.
                    device_time = log.timestamp

                    # Only include records within the date range.
                    if not (
                        start_date <= device_time <= end_date
                    ):
                        continue

                    logs_payload.append({

                        "user_id": str(log.user_id),

                        "timestamp": device_time.isoformat(),

                        "status": log.punch,

                        "punch": log.punch,

                    })

                except (
                    AttributeError,
                    TypeError,
                    ValueError
                ):

                    logging.exception(
                        "Skipping invalid attendance record"
                    )

            if not logs_payload:

                logging.info(
                    "No attendance records found within the last 15 days"
                )

                return

            # Sort records chronologically.
            logs_payload.sort(
                key=lambda item: item["timestamp"]
            )

            total_records = len(logs_payload)

            total_batches = (
                total_records + BATCH_SIZE - 1
            ) // BATCH_SIZE

            logging.info(
                "Found %d attendance records within the last 15 days",
                total_records,
            )

            # =================================================
            # SEND RECORDS IN BATCHES
            # =================================================

            total_inserted = 0

            for i in range(0, total_records, BATCH_SIZE):

                batch = logs_payload[i:i + BATCH_SIZE]

                batch_number = (
                    i // BATCH_SIZE
                ) + 1

                logging.info(
                    "Sending batch %d/%d (%d records)",
                    batch_number,
                    total_batches,
                    len(batch),
                )

                response = requests.post(
                    WEBHOOK_URL,
                    json=batch,
                    timeout=HTTP_TIMEOUT,
                )

                response.raise_for_status()

                try:

                    result = response.json()

                except ValueError:

                    result = {}

                inserted = result.get("inserted", 0)

                if isinstance(inserted, int):
                    total_inserted += inserted

                logging.info(
                    "Batch %d/%d successful. HTTP %s; inserted: %s",
                    batch_number,
                    total_batches,
                    response.status_code,
                    inserted,
                )

            logging.info(
                "Attendance sync completed successfully."
            )

            logging.info(
                "Total records submitted: %d",
                total_records,
            )

            logging.info(
                "Total inserted (reported by API): %d",
                total_inserted,
            )

        finally:

            # Re-enable biometric device.
            if device_disabled:

                try:

                    conn.enable_device()

                    logging.info(
                        "Biometric device re-enabled"
                    )

                except Exception:

                    logging.exception(
                        "Could not re-enable biometric device"
                    )

    except requests.RequestException:

        logging.exception(
            "Webhook/network request failed"
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

                logging.info(
                    "Disconnected from biometric device"
                )

            except Exception:

                logging.exception(
                    "Error disconnecting device"
                )


# =========================================================
# MAIN LOOP
# =========================================================

def main():

    logging.info("=" * 60)

    logging.info(
        "BIOMETRIC FETCHER SERVICE STARTED"
    )

    logging.info(
        "Device IP: %s",
        DEVICE_IP
    )

    logging.info(
        "Device port: %s",
        DEVICE_PORT
    )

    logging.info(
        "Sync interval: %s seconds",
        SYNC_INTERVAL
    )

    logging.info(
        "Attendance fetch period: Last %d days including today",
        FETCH_DAYS
    )

    logging.info(
        "Batch size: %d",
        BATCH_SIZE
    )

    logging.info(
        "No last sync checkpoint"
    )

    logging.info(
        "Original device timestamps will remain unchanged"
    )

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

        wait_time = max(
            1,
            SYNC_INTERVAL - elapsed
        )

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

        logging.info(
            "Service stopped manually by user"
        )

    except BaseException:

        logging.critical(
            "FATAL ERROR:\n%s",
            traceback.format_exc(),
        )

    finally:

        logging.info(
            "Biometric fetcher stopped"
        )

        if os.name == "nt":

            try:

                input(
                    "Press Enter to close this window..."
                )

            except (
                EOFError,
                KeyboardInterrupt
            ):

                pass
