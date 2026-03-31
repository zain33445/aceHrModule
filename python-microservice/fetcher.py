import time
import requests
import datetime
from zk import ZK, const

DEVICE_IP = '192.168.1.101'
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
         
        print(users)
        # Prepare payload for Node.js
        logs_payload = []
        start_date = datetime.datetime(2026, 1, 1)
        
        for log in attendance:
            # The device clock is 6 days forward, deduct 6 days to get real time
            corrected_time = log.timestamp - datetime.timedelta(days=6)
            
            # Filter logs from Jan 1, 2026 onwards
            if corrected_time >= start_date:
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
            else:
                print(f"[{datetime.datetime.now()}] Webhook failed: {response.status_code} - {response.text}")
        
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
