-- Add dispute_id foreign key to salaries table
ALTER TABLE "salaries"
ADD COLUMN "dispute_id" INTEGER;

-- Add foreign key constraint
ALTER TABLE "salaries" ADD CONSTRAINT "salaries_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "disputes" ("id") ON DELETE SET NULL ON UPDATE CASCADE;