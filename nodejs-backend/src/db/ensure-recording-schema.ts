/**
 * ensure-recording-schema.ts — applies the idempotent recording-v2 DDL at boot.
 * `prisma migrate deploy` / `db push` are not usable on this database (see AGENTS.md),
 * so the additive SQL is executed statement by statement here.
 */
import fs from 'fs';
import path from 'path';
import prisma from '../prisma';

// Works from src/ (ts-node) and dist/ (tsc): both sit one level below the package root's src|dist.
const SQL_FILE = path.resolve(__dirname, '../../prisma/migrations/20261110000000_recording_v2/migration.sql');

let ready = false;
/** True once the v2 schema has been applied; v2 routes answer 503 until then. */
export const isRecordingSchemaReady = () => ready;

export async function ensureRecordingSchema(): Promise<void> {
  const sql = fs.readFileSync(SQL_FILE, 'utf8');
  // Statements are separated by "-- statement" marker lines (DO $$ blocks contain semicolons).
  const statements = sql.split(/^-- statement\s*$/m).slice(1).map((s) => s.trim()).filter(Boolean);
  for (const st of statements) {
    try {
      await prisma.$executeRawUnsafe(st);
    } catch (err: any) {
      throw new Error(`recording schema statement failed: ${err.message}\n${st.slice(0, 200)}`);
    }
  }
  ready = true;
  console.log(`[Recording Schema] ensured v2 schema (${statements.length} statements)`);
}
