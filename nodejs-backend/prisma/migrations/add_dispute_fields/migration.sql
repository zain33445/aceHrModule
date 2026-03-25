-- Add category and dispute_date columns to disputes table
ALTER TABLE "disputes"
ADD COLUMN "category" TEXT DEFAULT 'other';

ALTER TABLE "disputes"
ADD COLUMN "dispute_date" TIMESTAMP(3);

-- Update existing records to have a default dispute_date if needed
UPDATE "disputes"
SET
    "dispute_date" = "date_of_req"
WHERE
    "dispute_date" IS NULL;

-- Make dispute_date NOT NULL after populating
ALTER TABLE "disputes"
ALTER COLUMN "dispute_date"
SET
    NOT NULL;