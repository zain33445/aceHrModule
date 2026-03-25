# Absence Management System

## Overview
The absence management system automatically tracks employee absences and manages leave allocations. At the end of each day, the system checks for employees who haven't logged any attendance and processes them according to their remaining leave balance.

## Database Tables

### `absence_records` Table
| Field    | Type      | Description                          |
|----------|-----------|--------------------------------------|
| id       | Integer   | Primary key, auto-increment         |
| user_id  | String    | Foreign key to users.id              |
| status   | String    | "leave" or "absent"                  |
| date     | DateTime  | Date of the absence                  |

**Unique Constraint**: (user_id, date) - prevents duplicate records for the same user on the same date.

### `leave_bank` Table
| Field            | Type      | Description                          |
|------------------|-----------|--------------------------------------|
| id               | Integer   | Primary key, auto-increment         |
| user_id          | String    | Foreign key to users.id (unique)     |
| leaves_remaining | Integer   | Current remaining leave balance      |

### User Table Changes
- `leave_bank` field: Represents **total allowed leaves** (static, don't update this)
- `leaveBank` relation: Links to the leave_bank table for remaining balance tracking

## Business Logic

### Daily Absence Processing
1. **Check Attendance**: For each employee, check if they have any attendance logs for the previous day
2. **Leave Bank Check**: If no attendance logs exist:
   - Check `leave_bank.leaves_remaining` for the user
   - If `leaves_remaining > 0`: Deduct 1 and mark status as "leave"
   - If `leaves_remaining = 0`: Mark status as "absent"
3. **Record Creation**: Create an absence record with the appropriate status

### Leave Bank Management
- **Total Allowed**: `users.leave_bank` (static value, represents maximum allowed leaves)
- **Remaining Balance**: `leave_bank.leaves_remaining` (decrements when leaves are used)
- **Initialization**: New users get a leave_bank record with `leaves_remaining = users.leave_bank`
- **Reset**: Admins can reset leave balance to total allowed amount

## API Endpoints

### Absence Records
```
GET /api/absences
GET /api/absences?startDate=2024-01-01&endDate=2024-01-31
```
Returns all absence records, optionally filtered by date range.

```
GET /api/absences/user/{userId}
GET /api/absences/user/{userId}?startDate=2024-01-01&endDate=2024-01-31
```
Returns absence records for a specific user.

```
GET /api/absences/user/{userId}/stats
```
Returns absence statistics for a user.

### Absence Processing
```
POST /api/absences/process-daily
```
Process absences for yesterday.

```
POST /api/absences/process/{date}
```
Process absences for a specific date.

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
```
Returns statistics including:
- Total absence days
- Leave days used
- Absent days
- Percentages

### Process Absences (Admin)
```
POST /api/absences/process/{date}
```
Process absences for a specific date.

```
POST /api/absences/process-daily
```
Process absences for yesterday. This endpoint should be called daily (e.g., via cron job at 11:59 PM).

## Example Usage

### Automatic Daily Processing
Set up a cron job to call the daily processing endpoint:

```bash
# Run every day at 11:59 PM
59 23 * * * curl -X POST http://localhost:5000/api/absences/process-daily
```

### Manual Processing
```bash
# Process absences for a specific date
curl -X POST http://localhost:5000/api/absences/process/2024-01-15

# Process absences for yesterday
curl -X POST http://localhost:5000/api/absences/process-daily
```

### Get Absence Data
```bash
# Get all absences
curl http://localhost:5000/api/absences

# Get user absences
curl http://localhost:5000/api/absences/user/1

# Get user statistics
curl http://localhost:5000/api/absences/user/1/stats
```

## Response Examples

### Absence Record
```json
{
  "id": 1,
  "user_id": "1",
  "status": "leave",
  "date": "2024-01-15T00:00:00.000Z",
  "user": {
    "id": "1",
    "name": "John Doe"
  }
}
```

### Statistics Response
```json
{
  "totalDays": 5,
  "leaveDays": 3,
  "absentDays": 2,
  "leavePercentage": 60,
  "absentPercentage": 40
}
```

### Processing Response
```json
{
  "message": "Processed absences for 2 users on Mon Jan 15 2024",
  "processedCount": 2,
  "checkDate": "2024-01-15T00:00:00.000Z"
}
```

## Integration Notes

- The absence processing should run after attendance data for the day is complete
- Consider running the daily process at midnight (00:00) to ensure all attendance data is captured
- The system prevents duplicate absence records for the same user/date combination
- Leave bank is automatically updated when leaves are used
- The system integrates with the existing attendance logging system

## Testing

Run the test script to verify the absence processing functionality:

```bash
npm run test-absence
```

This will process absences and display results for testing purposes.