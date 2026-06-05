ALTER TABLE salaries
RENAME COLUMN payable_salary TO base_salary;

ALTER TABLE deductions
ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE';
