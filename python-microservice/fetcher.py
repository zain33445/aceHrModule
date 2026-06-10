import time
import requests
import datetime
import os
from flask import Flask, request, jsonify
from zk import ZK

app = Flask(__name__)

DEVICE_IP = '192.168.18.101'
DEVICE_PORT = 4370
COMM_KEY = 11

WEBHOOK_URL = 'http://localhost:5000/api/webhooks/attendance'
WEBHOOK_URL_USER = 'http://localhost:5000/api/webhooks/users'

SYNC_FILE = 'last_sync_time.txt'


# =========================
# DEVICE CONNECTION HELPER
# =========================
def get_connection():
    zk = ZK(DEVICE_IP, port=DEVICE_PORT, timeout=10, password=COMM_KEY, force_udp=True)
    conn = zk.connect()
    conn.disable_device()
    return conn


# =========================
# SYNC TIME HANDLING
# =========================
def get_last_sync_time():
    if os.path.exists(SYNC_FILE):
        with open(SYNC_FILE, 'r') as f:
            t = f.read().strip()
            if t:
                return datetime.datetime.fromisoformat(t)

    now = datetime.datetime.now()
    set_last_sync_time(now)
    return now


def set_last_sync_time(t):
    with open(SYNC_FILE, 'w') as f:
        f.write(t.isoformat())


# =========================
# CREATE USER ON DEVICE
# =========================
@app.route('/create-user', methods=['POST'])
def create_user():
    data = request.json

    try:
        conn = get_connection()

        uid = int(data['employee_id'])
        name = data['name']

        # Check if user already exists
        users = conn.get_users()
        for u in users:
            if str(u.user_id) == str(uid):
                conn.enable_device()
                conn.disconnect()
                return jsonify({"message": "User already exists"}), 200

        conn.set_user(
            uid=uid,
            name=name,
            privilege=0,
            password='',
            group_id='',
            card=0
        )

        conn.enable_device()
        conn.disconnect()

        return jsonify({"message": "User created on device"}), 200

    except Exception as e:
        return jsonify({"error": str(e)}), 500


# =========================
# SYNC ATTENDANCE
# =========================
def sync_attendance():
    zk = ZK(DEVICE_IP, port=DEVICE_PORT, timeout=10, password=COMM_KEY, force_udp=True)
    conn = None
    try:
        print(f"[{datetime.datetime.now()}] Connecting to ZK device...")
        for attempt in range(3):
            try:
                conn = zk.connect()
                break # Connected successfully
            except Exception as e:
                print(f"[{datetime.datetime.now()}] Connection attempt {attempt+1} failed: {e}")
                time.sleep(5)
                
        if not conn:
            print("Failed to connect after 3 attempts.")
            return

        conn.disable_device()

        attendance = conn.get_attendance()
         
        # Prepare payload for Node.js
        logs_payload = []
        start_date = get_last_sync_time()
        present_time = datetime.datetime.now()
        
        for log in attendance:
            # The device clock is 6 days forward, deduct 6 days to get real time
            corrected_time = log.timestamp
            
            # Filter logs > start_date and <= present_time
            if start_date < corrected_time <= present_time:
                logs_payload.append({
                    "user_id": str(log.user_id),
                    "timestamp": corrected_time.isoformat(),
                    "status": log.punch,
                    'punch': log.punch  
                })

        if logs_payload:
            print(f"[{datetime.datetime.now()}] Formatting {len(logs_payload)} logs...")
            # Post to Node.js
            response = requests.post(WEBHOOK_URL, json=logs_payload)
            if response.status_code == 200:
                print(f"[{datetime.datetime.now()}] Successfully pushed {response.json().get('inserted')} new logs to Node.js")
                set_last_sync_time(present_time)
            else:
                print(f"[{datetime.datetime.now()}] Webhook failed: {response.status_code} - {response.text}")
        else:
            # No new logs, still update sync time
            set_last_sync_time(present_time)
    
        conn.enable_device()

    except Exception as e:
        print(f"[{datetime.datetime.now()}] Error syncing device: {e}")
    finally:
        if conn:
            conn.disconnect()

# =========================
# SYNC USERS (READ ONLY)
# =========================
@app.route('/sync-users', methods=['GET'])
def sync_users():
    try:
        conn = get_connection()

        users = conn.get_users()

        payload = []
        for u in users:
            payload.append({
                "user_id": str(u.user_id),
                "name": u.name
            })

        conn.enable_device()
        conn.disconnect()

        requests.post(WEBHOOK_URL_USER, json=payload)

        return jsonify({"users": len(payload)})

    except Exception as e:
        return jsonify({"error": str(e)}), 500


# =========================
# AUTO BACKGROUND SYNC
# =========================
def background_loop():
    while True:
        sync_attendance()
        time.sleep(300)  # 5 min


# =========================
# START SERVICE
# =========================
if __name__ == '__main__':
    import threading

    print("Starting ZKTeco Service...")

    t = threading.Thread(target=background_loop)
    t.daemon = True
    t.start()

    app.run(host='0.0.0.0', port=8000)