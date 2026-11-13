-- Recording v2: additive, idempotent. Executed by ensureRecordingSchema() at server start
-- (statements are separated by the "-- statement" marker lines) and safe to re-run.
-- Never apply with `prisma db push` (it would drop users.leave_bank).

-- statement
ALTER TABLE "recording_sessions"
  ADD COLUMN IF NOT EXISTS "recording_date" DATE,
  ADD COLUMN IF NOT EXISTS "dir_path" TEXT,
  ADD COLUMN IF NOT EXISTS "generation" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "duration_ms" INTEGER,
  ADD COLUMN IF NOT EXISTS "logged_out_ms" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "last_chunk_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "assembly_error" TEXT,
  ADD COLUMN IF NOT EXISTS "assembly_attempts" INTEGER NOT NULL DEFAULT 0;

-- statement
CREATE TABLE IF NOT EXISTS "recording_segments" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "device_id" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "last_seq" INTEGER,
    "lost_seqs" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "mime" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "state" TEXT NOT NULL DEFAULT 'open',
    "generation" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recording_segments_pkey" PRIMARY KEY ("id")
);

-- statement
ALTER TABLE "recording_chunks"
  ADD COLUMN IF NOT EXISTS "captured_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "duration_ms" INTEGER,
  ADD COLUMN IF NOT EXISTS "logged_out" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "purged_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "segment_id" TEXT,
  ADD COLUMN IF NOT EXISTS "seq" INTEGER,
  ADD COLUMN IF NOT EXISTS "sha256" TEXT;

-- statement
ALTER TABLE "recording_chunks" ALTER COLUMN "chunk_index" DROP NOT NULL;

-- statement
CREATE TABLE IF NOT EXISTS "app_settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

-- statement
CREATE INDEX IF NOT EXISTS "recording_segments_session_id_state_idx" ON "recording_segments"("session_id", "state");

-- statement
CREATE INDEX IF NOT EXISTS "recording_sessions_user_id_status_idx" ON "recording_sessions"("user_id", "status");

-- statement
CREATE UNIQUE INDEX IF NOT EXISTS "recording_sessions_user_id_recording_date_key" ON "recording_sessions"("user_id", "recording_date");

-- statement
CREATE UNIQUE INDEX IF NOT EXISTS "recording_chunks_segment_id_seq_key" ON "recording_chunks"("segment_id", "seq");

-- statement
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recording_segments_session_id_fkey') THEN
    ALTER TABLE "recording_segments" ADD CONSTRAINT "recording_segments_session_id_fkey"
      FOREIGN KEY ("session_id") REFERENCES "recording_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- statement
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recording_chunks_segment_id_fkey') THEN
    ALTER TABLE "recording_chunks" ADD CONSTRAINT "recording_chunks_segment_id_fkey"
      FOREIGN KEY ("segment_id") REFERENCES "recording_segments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- statement
-- Multi-monitor: which screen (1 = primary, 2..N left-to-right) a segment recorded.
ALTER TABLE "recording_segments" ADD COLUMN IF NOT EXISTS screen SMALLINT;
