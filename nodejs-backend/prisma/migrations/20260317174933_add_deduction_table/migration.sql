/*
  Warnings:

  - Made the column `category` on table `disputes` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "attendance_records" RENAME CONSTRAINT "absence_records_pkey" TO "attendance_records_pkey";

-- AlterTable
ALTER TABLE "disputes" ALTER COLUMN "category" SET NOT NULL,
ALTER COLUMN "category" DROP DEFAULT;

-- AlterTable
ALTER TABLE "salaries" ALTER COLUMN "paid_salary" SET DEFAULT 0.0;

-- CreateTable
CREATE TABLE "deductions" (
    "id" SERIAL NOT NULL,
    "user_id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "type" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "dispute_id" INTEGER,

    CONSTRAINT "deductions_pkey" PRIMARY KEY ("id")
);

-- RenameForeignKey
ALTER TABLE "attendance_records" RENAME CONSTRAINT "absence_records_user_id_fkey" TO "attendance_records_user_id_fkey";

-- AddForeignKey
ALTER TABLE "deductions" ADD CONSTRAINT "deductions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deductions" ADD CONSTRAINT "deductions_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "disputes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
