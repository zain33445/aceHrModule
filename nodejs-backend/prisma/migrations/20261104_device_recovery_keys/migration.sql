CREATE TABLE "device_recovery_keys" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "protector_id" TEXT NOT NULL,
    "encrypted_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_recovery_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "device_recovery_keys_device_id_protector_id_key" ON "device_recovery_keys"("device_id", "protector_id");

ALTER TABLE "device_recovery_keys" ADD CONSTRAINT "device_recovery_keys_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
