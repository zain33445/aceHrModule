-- Ensure a default leave type exists
INSERT INTO leave_types (name, is_paid, created_at)
VALUES ('Annual', true, NOW())
ON CONFLICT (name) DO NOTHING;

-- Step 1: Add leave_type_id column as nullable
ALTER TABLE leave_bank ADD COLUMN leave_type_id INTEGER;

-- Step 2: Backfill existing rows with the default leave type (id=1)
UPDATE leave_bank SET leave_type_id = 1 WHERE leave_type_id IS NULL;

-- Step 3: Make leave_type_id NOT NULL
ALTER TABLE leave_bank ALTER COLUMN leave_type_id SET NOT NULL;

-- Step 4: Drop old unique constraint on user_id
ALTER TABLE leave_bank DROP CONSTRAINT IF EXISTS leave_bank_user_id_key;

-- Step 5: Add composite unique constraint on (user_id, leave_type_id)
ALTER TABLE leave_bank ADD CONSTRAINT leave_bank_user_id_leave_type_id_key UNIQUE (user_id, leave_type_id);

-- Step 6: Add foreign key
ALTER TABLE leave_bank ADD CONSTRAINT leave_bank_leave_type_id_fkey
  FOREIGN KEY (leave_type_id) REFERENCES leave_types(id) ON DELETE CASCADE;
