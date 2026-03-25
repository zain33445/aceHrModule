-- Add payable_salary and deduction columns to salaries table
ALTER TABLE "salaries"
ADD COLUMN "payable_salary" DOUBLE PRECISION NOT NULL DEFAULT 0.0;

ALTER TABLE "salaries"
ADD COLUMN "deduction" DOUBLE PRECISION NOT NULL DEFAULT 0.0;

ALTER TABLE "salaries"
ADD COLUMN "deduction_reason" TEXT DEFAULT 'absence';

-- Optionally populate payable_salary with paid_salary values for existing records
UPDATE "salaries"
SET
    "payable_salary" = "paid_salary"
WHERE
    "payable_salary" = 0.0;