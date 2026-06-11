import time
import requests
import datetime
import os
import sqlite3
import threading
from flask import Flask, request, jsonify
from zk import ZK

app = Flask(__name__)

DEVICE_IP = '192.168.18.101'
DEVICE_PORT = 4370
COMM_KEY = 11

WEBHOOK_URL = 'http://localhost:5000/api/webhooks/attendance'
WEBHOOK_URL_USER = 'http://localhost:5000/api/webhooks/users'

INITIAL_SYNC_DATE = datetime.datetime(2026, 5, 1)

SYNC_INTERVAL_SEC = 300
OVERLAP_SECONDS = 60
MAX_BATCH_SIZE = 500
DB_PATH = os.path.join(os.path.dirname(__file__), 'sync_queue.db')

start_time = datetime.datetime.now()
consecutive_failures = 0
last_sync_time = None
state_lock = threading.Lock()


def init_db():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS watermark (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            last_sync_time TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            status INTEGER NOT NULL,
            punch INTEGER NOT NULL DEFAULT 0,
            fetched_at TEXT NOT NULL,
            sync_status TEXT NOT NULL DEFAULT 'pending',
            retry_count INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            UNIQUE(user_id, timestamp, status)
        );

        CREATE INDEX IF NOT EXISTS idx_queue_sync_status ON queue(sync_status);

        CREATE TABLE IF NOT EXISTS sync_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_type TEXT NOT NULL,
            message TEXT,
            created_at TEXT NOT NULL
        );
    """)

    row = conn.execute("SELECT last_sync_time FROM watermark WHERE id = 1").fetchone()
    if row is None:
        conn.execute("INSERT INTO watermark (id, last_sync_time) VALUES (1, ?)",
                     (INITIAL_SYNC_DATE.isoformat(),))

    conn.commit()
    conn.close()


def get_watermark():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    row = conn.execute("SELECT last_sync_time FROM watermark WHERE id = 1").fetchone()
    conn.close()
    if row and row[0]:
        return datetime.datetime.fromisoformat(row[0])
    return INITIAL_SYNC_DATE


def set_watermark(dt):
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.execute("UPDATE watermark SET last_sync_time = ? WHERE id = 1", (dt.isoformat(),))
    conn.commit()
    conn.close()


def add_to_queue(records):
    conn = sqlite3.connect(DB_PATH, timeout=10)
    now_str = datetime.datetime.now().isoformat()
    before = conn.total_changes
    for r in records:
        try:
            conn.execute("""
                INSERT OR IGNORE INTO queue (user_id, timestamp, status, punch, fetched_at, sync_status)
                VALUES (?, ?, ?, ?, ?, 'pending')
            """, (r['user_id'], r['timestamp'], r['status'], r.get('punch', 0), now_str))
        except Exception:
            pass
    conn.commit()
    inserted = conn.total_changes - before
    conn.close()
    return inserted


def flush_queue():
    conn = sqlite3.connect(DB_PATH, timeout=10)

    rows = conn.execute("""
        SELECT id, user_id, timestamp, status, punch
        FROM queue
        WHERE sync_status IN ('pending', 'failed') AND retry_count < 10
        ORDER BY timestamp ASC
        LIMIT ?
    """, (MAX_BATCH_SIZE,)).fetchall()

    if not rows:
        conn.close()
        return 0, 0, None

    payload = []
    ids = []
    max_ts = None
    for row in rows:
        payload.append({
            'user_id': row[1],
            'timestamp': row[2],
            'status': row[3],
            'punch': row[4]
        })
        ids.append(row[0])
        ts = datetime.datetime.fromisoformat(row[2])
        if max_ts is None or ts > max_ts:
            max_ts = ts

    try:
        resp = requests.post(WEBHOOK_URL, json=payload, timeout=30)
        if resp.status_code == 200:
            conn.executemany("UPDATE queue SET sync_status = 'sent' WHERE id = ?",
                           [(i,) for i in ids])
            conn.commit()
            conn.close()
            return len(ids), 0, max_ts
        else:
            error_msg = f"HTTP {resp.status_code}: {resp.text[:200]}"
            conn.executemany("""
                UPDATE queue SET sync_status = 'failed', retry_count = retry_count + 1, last_error = ?
                WHERE id = ?
            """, [(error_msg, i) for i in ids])
            conn.commit()
            conn.close()
            return 0, len(ids), None
    except requests.exceptions.RequestException as e:
        error_msg = str(e)
        conn.executemany("""
            UPDATE queue SET sync_status = 'failed', retry_count = retry_count + 1, last_error = ?
            WHERE id = ?
        """, [(error_msg, i) for i in ids])
        conn.commit()
        conn.close()
        return 0, len(ids), None


def get_queue_stats():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    pending = conn.execute("SELECT COUNT(*) FROM queue WHERE sync_status = 'pending'").fetchone()[0]
    failed = conn.execute("SELECT COUNT(*) FROM queue WHERE sync_status = 'failed'").fetchone()[0]
    sent = conn.execute("SELECT COUNT(*) FROM queue WHERE sync_status = 'sent'").fetchone()[0]
    conn.close()
    return pending, failed, sent


def log_event(event_type, message):
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.execute("INSERT INTO sync_log (event_type, message, created_at) VALUES (?, ?, ?)",
                (event_type, message, datetime.datetime.now().isoformat()))
    conn.commit()
    conn.close()


def cleanup_logs(retention_days=7):
    conn = sqlite3.connect(DB_PATH, timeout=10)
    cutoff = (datetime.datetime.now() - datetime.timedelta(days=retention_days)).isoformat()
    conn.execute("DELETE FROM sync_log WHERE created_at < ?", (cutoff,))
    conn.commit()
    conn.close()


def get_connection():
    zk = ZK(DEVICE_IP, port=DEVICE_PORT, timeout=10, password=COMM_KEY, force_udp=True)
    conn = zk.connect()
    conn.disable_device()
    return conn


def sync_attendance():
    global consecutive_failures, last_sync_time

    zk = ZK(DEVICE_IP, port=DEVICE_PORT, timeout=10, password=COMM_KEY, force_udp=True)
    conn = None
    try:
        print(f"[{datetime.datetime.now()}] Connecting to ZK device...")
        for attempt in range(3):
            try:
                conn = zk.connect()
                break
            except Exception as e:
                print(f"[{datetime.datetime.now()}] Connection attempt {attempt+1} failed: {e}")
                time.sleep(5)

        if not conn:
            print("Failed to connect after 3 attempts.")
            with state_lock:
                consecutive_failures += 1
            return

        conn.disable_device()

        watermark = get_watermark()
        fetch_start = watermark - datetime.timedelta(seconds=OVERLAP_SECONDS)

        print(f"[{datetime.datetime.now()}] Watermark: {watermark.isoformat()}, "
              f"Fetching records since {fetch_start.isoformat()}")

        attendance = conn.get_attendance()
        print(f"[{datetime.datetime.now()}] Device returned {len(attendance)} total records")

        new_records = []
        for log in attendance:
            if log.timestamp > fetch_start:
                new_records.append({
                    'user_id': str(log.user_id),
                    'timestamp': log.timestamp.isoformat(),
                    'status': log.status,
                    'punch': log.punch
                })

        if new_records:
            inserted = add_to_queue(new_records)
            print(f"[{datetime.datetime.now()}] Queued {inserted} new records "
                  f"({len(new_records) - inserted} duplicates skipped)")
        else:
            print(f"[{datetime.datetime.now()}] No new records to queue")

        total_sent = 0
        total_failed = 0
        max_sent_ts = None

        while True:
            sent, failed, batch_max_ts = flush_queue()
            total_sent += sent
            total_failed += failed

            if batch_max_ts and (max_sent_ts is None or batch_max_ts > max_sent_ts):
                max_sent_ts = batch_max_ts

            if sent == 0 and failed == 0:
                break
            if failed > 0:
                break

        if max_sent_ts:
            set_watermark(max_sent_ts)
            print(f"[{datetime.datetime.now()}] Watermark updated to {max_sent_ts.isoformat()}")
            with state_lock:
                last_sync_time = datetime.datetime.now()
                consecutive_failures = 0

        conn.enable_device()
        log_event("sync_completed", f"sent={total_sent}, failed={total_failed}, queued={len(new_records)}")

    except Exception as e:
        print(f"[{datetime.datetime.now()}] Error syncing device: {e}")
        log_event("sync_error", str(e))
        with state_lock:
            consecutive_failures += 1
    finally:
        if conn:
            conn.disconnect()


# =========================
# FLASK ROUTES
# =========================

@app.route('/create-user', methods=['POST'])
def create_user():
    data = request.json
    try:
        conn = get_connection()
        uid = int(data['employee_id'])
        name = data['name']
        users = conn.get_users()
        for u in users:
            if str(u.user_id) == str(uid):
                conn.enable_device()
                conn.disconnect()
                return jsonify({"message": "User already exists"}), 200
        conn.set_user(
            uid=uid, name=name, privilege=0,
            password='', group_id='', card=0
        )
        conn.enable_device()
        conn.disconnect()
        return jsonify({"message": "User created on device"}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/sync-users', methods=['GET'])
def sync_users():
    try:
        conn = get_connection()
        users = conn.get_users()
        payload = [{'user_id': str(u.user_id), 'name': u.name} for u in users]
        conn.enable_device()
        conn.disconnect()
        requests.post(WEBHOOK_URL_USER, json=payload)
        return jsonify({"users": len(payload)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/health', methods=['GET'])
def health():
    pending, failed, sent = get_queue_stats()
    with state_lock:
        failures = consecutive_failures
        last = last_sync_time

    status = 'healthy'
    if failures >= 5:
        status = 'down'
    elif failures >= 3:
        status = 'degraded'

    uptime = str(datetime.datetime.now() - start_time).split('.')[0]

    return jsonify({
        'status': status,
        'last_sync_time': last.isoformat() if last else None,
        'watermark': get_watermark().isoformat(),
        'queue': {
            'pending': pending,
            'failed': failed,
            'sent': sent,
            'total': pending + failed + sent
        },
        'consecutive_failures': failures,
        'uptime': uptime,
        'device_ip': DEVICE_IP,
        'sync_interval_sec': SYNC_INTERVAL_SEC
    })


@app.route('/queue/retry', methods=['POST'])
def retry_failed():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.execute("""
        UPDATE queue
        SET sync_status = 'pending', retry_count = 0, last_error = NULL
        WHERE sync_status = 'failed'
    """)
    affected = conn.total_changes
    conn.commit()
    conn.close()
    return jsonify({'reset': affected})


@app.route('/queue/stats', methods=['GET'])
def queue_stats():
    pending, failed, sent = get_queue_stats()
    return jsonify({
        'pending': pending,
        'failed': failed,
        'sent': sent,
        'total': pending + failed + sent
    })


# =========================
# BACKGROUND SYNC LOOP
# =========================

def background_loop():
    while True:
        try:
            flush_queue()
        except Exception as e:
            print(f"[{datetime.datetime.now()}] Pre-fetch flush error: {e}")

        sync_attendance()

        cleanup_logs()

        for _ in range(SYNC_INTERVAL_SEC // 30):
            time.sleep(30)
            try:
                flush_queue()
            except Exception as e:
                print(f"[{datetime.datetime.now()}] Mid-cycle flush error: {e}")


if __name__ == '__main__':
    print("=" * 60)
    print("ZKTeco Biometric Sync Service (Robust Mode)")
    print(f"Device: {DEVICE_IP}:{DEVICE_PORT}")
    print(f"Webhook: {WEBHOOK_URL}")
    print(f"Initial Sync: {INITIAL_SYNC_DATE.isoformat()}")
    print(f"Interval: {SYNC_INTERVAL_SEC}s | Overlap: {OVERLAP_SECONDS}s")
    print("=" * 60)

    init_db()

    t = threading.Thread(target=background_loop, daemon=True)
    t.start()

    log_event("service_started", f"watermark={get_watermark().isoformat()}")

    app.run(host='0.0.0.0', port=8000, threaded=True)
