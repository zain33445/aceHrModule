import time
import requests
import datetime
import os
from zk import ZK

SYNC_FILE = 'last_sync_time.txt'

def get_last_sync_time():
    if os.path.exists(SYNC_FILE):
        try:
            with open(SYNC_FILE, 'r') as f:
                time_str = f.read().strip()
                if time_str:
                    return datetime.datetime.fromisoformat(time_str)
        except Exception as e:
            print(f"Error reading sync file: {e}")
            
    # If file doesn't exist or is invalid, create with present time
    now = datetime.datetime.now()
    set_last_sync_time(now)
    return now

def set_last_sync_time(sync_time):
    try:
        with open(SYNC_FILE, 'w') as f:
            f.write(sync_time.isoformat())
    except Exception as e:
        print(f"Error writing sync file: {e}")

DEVICE_IP = '192.168.18.101'
DEVICE_PORT = 4370
COMM_KEY = 11
WEBHOOK_URL = 'http://localhost:5000/api/webhooks/attendance'
WEBHOOK_URL_USER = 'http://localhost:5000/api/webhooks/users'

def fetch_and_post_logs():
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
        users = conn.get_users()
         
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
            print(logs_payload[0])
        print(f"[{datetime.datetime.now()}] Formatting {len(logs_payload)} logs...")

        user_payload = []
        for user in users:
            user_payload.append({
                "user_id": str(user.user_id),
                "name": user.name,
            })
          
        if logs_payload:
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
        
        if user_payload:
            # Post to Node.js
            response = requests.post(WEBHOOK_URL_USER, json=user_payload)
            if response.status_code == 200:
                print(f"[{datetime.datetime.now()}] Successfully pushed {response.json().get('inserted')} new users to Node.js")
            else:
                print(f"[{datetime.datetime.now()}] Webhook failed: {response.status_code} - {response.text}")
                
        conn.enable_device()

    except Exception as e:
        print(f"[{datetime.datetime.now()}] Error syncing device: {e}")
    finally:
        if conn:
            conn.disconnect()

if __name__ == "__main__":
    print("Starting Biometric Fetcher Service...")
    while True:
        fetch_and_post_logs()
        time.sleep(300) # Sync every 5 minutes
