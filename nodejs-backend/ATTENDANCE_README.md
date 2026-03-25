# Attendance Management System

## Overview
The attendance management system tracks employee check-ins, check-outs, and automatically determines attendance status based on shift timings. It manages leave allocations and records attendance details including late arrivals and half-days.

## Database Tables

### `shifts` Table
Stores shift configuration including working hours and timing thresholds.

| Field      | Type   | Description                              |
|------------|--------|------------------------------------------|
| id         | Int    | Primary key, auto-increment              |
| shiftid    | String | Unique shift identifier (e.g., "S001")   |
| checkin    | String | Expected check-in time (Format: HH:MM)   |
| checkout   | String | Expected check-out time (Format: HH:MM)  |
| latetiming | String | Late marking threshold (Format: HH:MM)   |
| halfday    | String | Half-day checkout limit (Format: HH:MM)  |

**Example Data:**
```
shiftid: "S001"
checkin: "09:00"
checkout: "17:00"
latetiming: "09:15"
halfday: "13:00"
```

### `attendance_records` Table (Formerly `absence_records`)
Records daily attendance status for employees with detailed timing information.

| Field           | Type     | Description                                  |
|-----------------|----------|----------------------------------------------|
| id              | Int      | Primary key, auto-increment                  |
| user_id         | String   | Foreign key to users.id                      |
| date            | DateTime | Date of attendance                           |
| check_in_time   | String?  | Actual check-in time (Format: HH:MM)         |
| check_out_time  | String?  | Actual check-out time (Format: HH:MM)        |
| status          | String   | Status: "present", "absent", "leave", "late", "halfday" |
| is_late         | Boolean  | Flag indicating if employee checked in late  |
| is_halfday      | Boolean  | Flag indicating if employee left early       |

**Unique Constraint**: (user_id, date) - prevents duplicate records for the same user on the same date.

### `leave_bank` Table
Tracks remaining leave balance for each employee.

| Field            | Type    | Description                               |
|------------------|---------|-------------------------------------------|
| id               | Int     | Primary key, auto-increment               |
| user_id          | String  | Foreign key to users.id (unique)          |
| leaves_remaining | Int     | Current remaining leave balance           |

### User Table Changes
- `leave_bank` field: Represents **total allowed leaves** (static, don't update this)
- `attendance_records` relation: Links to the attendance_records table

## Business Logic

### Attendance Status Determination
The system processes attendance logs and determines status based on:

1. **No Attendance Logs**: 
   - Check `leave_bank.leaves_remaining` for the user
   - If `leaves_remaining > 0`: Mark as "leave" and deduct 1
   - If `leaves_remaining = 0`: Mark as "absent"

2. **With Attendance Logs**:
   - Extract check-in time from first log and check-out time from last log
   - Compare with shift timings:
     - If check-in time > latetiming: `is_late = true`
     - If check-out time < halfday: `is_halfday = true`
     - Default status: "present"

### Shift Times Format
All times are stored in **HH:MM** format (24-hour):
- `09:00` = 9:00 AM
- `17:00` = 5:00 PM
- `13:00` = 1:00 PM

### Daily Attendance Processing
1. **Check Attendance Logs**: For each employee, check if they have any logs for the target date
2. **Calculate Check-in/Check-out**: Extract times from attendance logs
3. **Compare with Shift**: Determine if late or half-day based on shift configuration
4. **Create/Update Record**: Create or update the attendance record with all details

## API Endpoints

### Attendance Records
```
GET /api/absences
GET /api/absences?startDate=2024-01-01&endDate=2024-01-31
```
Returns all attendance records, optionally filtered by date range.

```
GET /api/absences/user/{userId}
GET /api/absences/user/{userId}?startDate=2024-01-01&endDate=2024-01-31
```
Returns attendance records for a specific user with full details (check-in time, check-out time, late/halfday flags).

```
GET /api/absences/user/{userId}/stats
```
Returns attendance statistics for a user:
- `totalDays`: Total records
- `presentDays`: Days marked as present
- `lateDays`: Days marked as late
- `halfdayDays`: Days marked as half-day
- `leaveDays`: Days marked as leave
- `absentDays`: Days marked as absent

### Attendance Processing
```
POST /api/absences/process-daily
```
Process attendance for yesterday.

```
POST /api/absences/process/{date}
```
Process attendance for a specific date (format: YYYY-MM-DD).

### Leave Bank Management
```
GET /api/absences/leave-bank
```
Get all leave bank records.

```
GET /api/absences/leave-bank/user/{userId}
```
Get leave bank record for a specific user.

```
PUT /api/absences/leave-bank/user/{userId}
```
Update leave bank balance for a user.

```json
{
  "leaves_remaining": 3
}
```

```
POST /api/absences/leave-bank/user/{userId}/reset
```
Reset leave bank to user's total allowed leaves.

## Time Format Examples

### Valid Shift Configuration
```json
{
  "shiftid": "MORNING",
  "checkin": "09:00",
  "checkout": "17:00",
  "latetiming": "09:15",
  "halfday": "13:00"
}
```

### Attendance Record Example
```json
{
  "id": 1,
  "user_id": "1",
  "date": "2024-03-14T00:00:00Z",
  "check_in_time": "09:05",
  "check_out_time": "17:30",
  "status": "present",
  "is_late": false,
  "is_halfday": false
}
```

```json
{
  "id": 2,
  "user_id": "2",
  "date": "2024-03-14T00:00:00Z",
  "check_in_time": "09:20",
  "check_out_time": "13:00",
  "status": "present",
  "is_late": true,
  "is_halfday": false
}
```

## Key Features

✓ Automatic late detection based on shift configuration
✓ Half-day tracking when employees leave early
✓ Leave deduction system with tracking
✓ Flexible attendance status system
✓ Detailed check-in/check-out time recording
✓ Backward compatible API (old method names still work)
✓ Comprehensive attendance statistics

## Migration Notes

- **Table Renamed**: `absence_records` → `attendance_records`
- **New Fields**: `check_in_time`, `check_out_time`, `is_late`, `is_halfday`
- **Shift Times**: Format changed to consistent HH:MM format
- **Status Values**: Extended from {"leave", "absent"} to {"present", "absent", "leave", "late", "halfday"}
- **Backward Compatibility**: Old API methods still supported
