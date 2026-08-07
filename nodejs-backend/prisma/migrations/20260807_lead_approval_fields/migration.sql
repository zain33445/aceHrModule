-- Add team-lead approval stage to leave and overtime requests
ALTER TABLE "leave_requests" ADD COLUMN     "lead_approved_at" TIMESTAMP(3),
ADD COLUMN     "lead_approved_by" TEXT,
ADD COLUMN     "lead_remarks" TEXT,
ADD COLUMN     "lead_status" TEXT NOT NULL DEFAULT 'pending';

ALTER TABLE "overtime_requests" ADD COLUMN     "lead_approved_at" TIMESTAMP(3),
ADD COLUMN     "lead_approved_by" TEXT,
ADD COLUMN     "lead_remarks" TEXT,
ADD COLUMN     "lead_status" TEXT NOT NULL DEFAULT 'pending';

ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_lead_approved_by_fkey" FOREIGN KEY ("lead_approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "overtime_requests" ADD CONSTRAINT "overtime_requests_lead_approved_by_fkey" FOREIGN KEY ("lead_approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
