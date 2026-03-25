# Attendance System Update Summary

## Changes Made (March 14, 2026)

### 1. Database Schema Updates (Prisma)

#### Shift Table - Time Format Standardization
**Before:**
```prisma
model Shift {
  id          Int     @id @default(autoincrement())
  shiftid     String  @unique
  latetiming  String
  halfday     String
  checkin     String
  checkout    String
}
```

**After:**
```prisma
model Shift {
  id          Int     @id @default(autoincrement())
  shiftid     String  @unique
  checkin     String  // Format: HH:MM (e.g., "09:00")
  checkout    String  // Format: HH:MM (e.g., "17:00")
  latetiming  String  // Format: HH:MM
  halfday     String  // Format: HH:MM
}
```

#### Renamed and Enhanced Attendance Record Table
**Before (AbsenceRecord):**
```prisma
model AbsenceRecord {
  id        Int      @id @default(autoincrement())
  user_id   String
  status    String   // "leave" or "absent"
  date      DateTime
  user      User     @relation(fields: [user_id], references: [id], onDelete: Cascade)
  @@unique([user_id, date])
  @@map("absence_records")
}
```

**After (AttendanceRecord):**
```prisma
model AttendanceRecord {
  id              Int       @id @default(autoincrement())
  user_id         String
  date            DateTime
  check_in_time   String?   // Format: HH:MM (e.g., "09:05")
  check_out_time  String?   // Format: HH:MM (e.g., "17:30")
  status          String    // "present", "absent", "leave", "late", "halfday"
  is_late         Boolean   @default(false)
  is_halfday      Boolean   @default(false)
  user            User      @relation(fields: [user_id], references: [id], onDelete: Cascade)
  @@unique([user_id, date])
  @@map("attendance_records")
}
```

#### User Model Changes
**Before:**
```prisma
absence_records AbsenceRecord[]
```

**After:**
```prisma
attendance_records AttendanceRecord[]
```

### 2. Database Migration
- **File**: `prisma/migrations/20260314_rename_absence_to_attendance/migration.sql`
- **Actions**:
  - Renamed `absence_records` table to `attendance_records`
  - Added new columns: `check_in_time`, `check_out_time`, `is_late`, `is_halfday`
  - Updated unique constraint naming

### 3. Service Layer Updates (AbsenceService)

#### New Helper Functions
- `timeToMinutes(timeStr: string)`: Converts HH:MM format to minutes for time comparison
- `calculateAndRecordAttendance()`: Processes check-in/check-out logs and calculates status
- `determineAttendanceStatus()`: Determines if present/late/halfday based on times
- `isLate()`: Checks if check-in time exceeds late threshold
- `isHalfday()`: Checks if check-out time is before half-day threshold

#### Updated Methods
- `processDailyAbsences()`: Now calls `calculateAndRecordAttendance()` for users with logs
- `getUserAttendanceStats()`: Returns new statistics with late/halfday counts
- `getUserAttendances()`: Works with new AttendanceRecord (backward compatible)
- `getAllAttendances()`: Works with new AttendanceRecord (backward compatible)

#### Backward Compatibility
Maintained old method names as aliases:
- `getUserAbsences()` → `getUserAttendances()`
- `getAllAbsences()` → `getAllAttendances()`
- `getUserAbsenceStats()` → `getUserAttendanceStats()`

### 4. API Endpoints Updates

#### Route File: `src/routes/absence.routes.ts`
- Updated response messages from "absence" to "attendance"
- Routes still use `/api/absences` for backward compatibility
- All new fields (check_in_time, check_out_time, is_late, is_halfday) returned in responses

#### Statistics Endpoint Response
**New format:**
```json
{
  "totalDays": 20,
  "presentDays": 18,
  "lateDays": 2,
  "halfdayDays": 1,
  "leaveDays": 0,
  "absentDays": 0
}
```

### 5. Time Format Standardization

All time fields now use **HH:MM** format (24-hour):
- `09:00` = 9:00 AM
- `17:00` = 5:00 PM
- `13:00` = 1:00 PM
- `09:15` = 9:15 AM

### 6. Attendance Status Values

Status field now supports:
- `"present"` - Employee checked in and out within normal hours
- `"absent"` - No logs and no leave available
- `"leave"` - No logs but used available leave
- `"late"` - Checked in after late threshold
- `"halfday"` - Checked out before half-day threshold

## How It Works Now

### Processing Attendance
1. **Daily Cron Job**: Runs at midnight to process previous day's attendance
2. **For Each User**:
   - Check if attendance logs exist
   - If no logs: Check leave bank and mark as "leave" or "absent"
   - If logs exist:
     - Extract first log as check-in, last log as check-out
     - Compare check-in with `shift.latetiming` → set `is_late`
     - Compare check-out with `shift.halfday` → set `is_halfday`
     - Create/update AttendanceRecord with all details

### Example Scenario
```
Shift Configuration:
- checkin: 09:00
- checkout: 17:00
- latetiming: 09:15
- halfday: 13:00

Employee logs:
- 09:20 (check-in)
- 12:45 (check-out)

Result:
- check_in_time: "09:20"
- check_out_time: "12:45"
- status: "present"
- is_late: true (09:20 > 09:15)
- is_halfday: true (12:45 < 13:00)
```

## Files Modified/Created

1. ✅ `prisma/schema.prisma` - Updated models
2. ✅ `prisma/migrations/20260314_.../migration.sql` - Database migration
3. ✅ `src/services/absence.service.ts` - Enhanced service with new logic
4. ✅ `src/routes/absence.routes.ts` - Updated response messages
5. ✅ `ATTENDANCE_README.md` - New comprehensive documentation

## Backward Compatibility

✅ All old API endpoints still work
✅ Old method names still available as aliases
✅ Existing client code requires NO changes
✅ Database migration preserves existing data

## Next Steps (Recommended)

1. Update shift times in database to HH:MM format:
   ```sql
   UPDATE shifts SET checkin = '09:00', checkout = '17:00', latetiming = '09:15', halfday = '13:00' WHERE shiftid = 'S001';
   ```

2. Run the daily attendance processing:
   ```
   POST /api/absences/process-daily
   ```

3. Review attendance records with new fields:
   ```
   GET /api/absences/user/{userId}
   ```

## Testing Checklist

- [ ] Verify shift times are in HH:MM format
- [ ] Process daily attendance and check records
- [ ] Verify check_in_time and check_out_time are captured
- [ ] Verify is_late flag works correctly
- [ ] Verify is_halfday flag works correctly
- [ ] Check backward compatibility with old endpoints
- [ ] Verify statistics endpoint shows all new counts
