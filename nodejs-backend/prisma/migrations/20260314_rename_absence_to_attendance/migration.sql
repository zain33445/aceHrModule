-- Step 1: Rename absence_records table to attendance_records
ALTER TABLE "absence_records"
RENAME TO "attendance_records";

-- Step 2: Update unique constraint name
ALTER TABLE "attendance_records"
DROP CONSTRAINT IF EXISTS "absence_records_user_id_date_key",
ADD CONSTRAINT "attendance_records_user_id_date_key" UNIQUE ("user_id", "date");

-- Step 3: Add new columns to attendance_records table
ALTER TABLE "attendance_records"
ADD COLUMN "check_in_time" VARCHAR(5),
ADD COLUMN "check_out_time" VARCHAR(5),
ADD COLUMN "is_late" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "is_halfday" BOOLEAN NOT NULL DEFAULT false;