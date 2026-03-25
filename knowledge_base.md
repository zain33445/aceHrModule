# BioAttendance Pro: Knowledge Base & Architecture

This guide explains how your system works, the technologies used, and a simplified breakdown of the Python logic.

## 🏗️ System Overview (Workflow)

The system operates in a 4-step loop:
1.  **Device (K50)**: Records thumbprints and store logs locally on the machine.
2.  **Sync Worker (Python)**: Every 5 minutes, it "asks" the device for new logs and saves them into a local **SQLite Database**.
3.  **API Server (FastAPI)**: Acts as a waiter. When the frontend asks for data, the API quickly grabs it from the local Database (not the device) to keep things fast.
4.  **Dashboard (React)**: Beautifully displays the data and allows you to change settings (like salaries).

## 📚 Libraries Used

### Backend (Python)
- **FastAPI**: The engine that handles web requests. Fast and modern.
- **ZK (zkpython)**: The "translator" that knows how to speak to ZKTeco hardware.
- **SQLite3**: A lightweight database that lives in a single file (`attendance_system.db`).
- **Pydantic**: Ensures that the data sent from the frontend is correctly formatted.

### Frontend (React)
- **Vite**: The build tool that makes the app run fast during development.
- **Axios**: The "messenger" that sends data to the Python backend.
- **Lucide-React**: The library providing the beautiful icons.

---

## 🐍 Understanding the Python Code (Beginner Friendly)

Since you are familiar with JavaScript, here is how to read our Python logic:

### 1. Variables and Functions
In JS, you use `function name() { ... }`. In Python, we use `def name():`.
- `database.py`: Think of this as your "Database Manager". It has functions like `get_employees()` which is basically `SELECT * FROM employees` in SQL.

### 2. The Loop (Sync Worker)
In `sync_worker.py`, we have a "While True" loop.
```python
while True:
    fetch_device_data()  # Get data from K50
    insert_logs()        # Save to DB
    await asyncio.sleep(300) # Wait 5 minutes (300 seconds)
```
*Wait*/`await` is the same as JS `await`. It prevents the app from freezing while waiting for a timer.

### 3. Salary Logic (Deduction Calculation)
In `salary_service.py`, we use a simple math formula:
```python
daily_rate = monthly_salary / 30
unpaid_absences = absent_days - available_leaves
deductions = unpaid_absences * daily_rate
total_salary = monthly_salary - deductions
```
This is exactly how a human accountant would calculate it!

---

## 🛠️ Maintenance Tips
- **Port Conflict**: If the app fails to start, it's usually because Port 8001 is "busy". We moved from 8000 to 8001 to avoid common conflicts.
- **Database**: If you want to see the raw data, you can open `attendance_system.db` with any SQLite viewer tool.
