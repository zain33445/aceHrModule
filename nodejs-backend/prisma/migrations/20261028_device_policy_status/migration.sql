CREATE TABLE "device_policy_statuses" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "policy_id" TEXT,
    "policy_version" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "applied" BOOLEAN NOT NULL DEFAULT false,
    "checks" JSONB,
    "errors" JSONB,
    "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_policy_statuses_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "device_policy_statuses_device_id_policy_id_key" ON "device_policy_statuses"("device_id", "policy_id");

CREATE INDEX "device_policy_statuses_policy_id_checked_at_idx" ON "device_policy_statuses"("policy_id", "checked_at");

ALTER TABLE "device_policy_statuses" ADD CONSTRAINT "device_policy_statuses_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "device_policy_statuses" ADD CONSTRAINT "device_policy_statuses_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "device_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
