CREATE TABLE "device_software_packages" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "silent_args" TEXT NOT NULL DEFAULT '',
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_software_packages_pkey" PRIMARY KEY ("id")
);
