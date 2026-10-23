/**
 * db-baseline.ts — Mark existing migrations as applied.
 *
 * Why this is needed
 * ------------------
 * The databases in this project were created with `prisma db push`, not with
 * `prisma migrate deploy`. The tables therefore exist, but the
 * `_prisma_migrations` table only records a couple of the migration
 * directories. As a result `prisma migrate deploy` (which the Dockerfile runs
 * on start-up) tries to replay the whole chain and fails, because those
 * migrations try to create tables that already exist.
 *
 * The migration chain itself also cannot be replayed onto an *empty*
 * database: `20260317174933_add_deduction_table` alters `disputes.category`,
 * but the column is only created later by `add_dispute_fields` (migrations
 * are applied in name order, and "2026…" sorts before "add…").
 *
 * Prisma's supported way out of this is to *baseline* the database: tell
 * Prisma that the migrations which describe the schema that is already in
 * place have been applied. After that, `migrate deploy` only applies
 * migrations that come after the baseline — which is exactly what a new
 * deployment needs.
 *
 * This script is safe to run more than once and only ever *records*
 * migrations; it never changes the schema.
 *
 * Run with: npm run db:baseline
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import prisma from './prisma';

const MIGRATIONS_DIR = path.join(__dirname, '..', 'prisma', 'migrations');

async function main() {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.error(`[db:baseline] migrations directory not found: ${MIGRATIONS_DIR}`);
    process.exit(1);
  }

  const migrations = fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  if (migrations.length === 0) {
    console.log('[db:baseline] no migrations found — nothing to do.');
    return;
  }

  const applied = new Set<string>();
  try {
    const rows = await prisma.$queryRaw<{ migration_name: string }[]>`
      SELECT migration_name FROM _prisma_migrations
    `;
    for (const row of rows) applied.add(row.migration_name);
  } catch (err: any) {
    console.error('[db:baseline] could not read _prisma_migrations:', err?.message);
    console.error('   Is the database reachable and initialised?');
    process.exit(1);
  }

  const pending = migrations.filter((name) => !applied.has(name));

  console.log(`[db:baseline] ${migrations.length} migration(s) in the chain`);
  console.log(`[db:baseline] ${applied.size} already recorded, ${pending.length} to baseline`);

  for (const name of pending) {
    process.stdout.write(`[db:baseline]   marking "${name}" as applied… `);
    try {
      // Call the Prisma CLI through node directly — spawning `npx`/`npx.cmd`
      // as a child process is not reliable on Windows.
      const prismaCli = path.join(__dirname, '..', 'node_modules', 'prisma', 'build', 'index.js');
      if (!fs.existsSync(prismaCli)) {
        throw new Error(`Prisma CLI not found at ${prismaCli}`);
      }
      execFileSync(
        process.execPath,
        [prismaCli, 'migrate', 'resolve', '--applied', name],
        { stdio: 'ignore', cwd: path.join(__dirname, '..') }
      );
      console.log('done');
    } catch (err: any) {
      console.log('FAILED');
      console.error(`[db:baseline] could not mark "${name}": ${err?.message}`);
      console.error('   Mark it by hand with:');
      console.error(`     npx prisma migrate resolve --applied ${name}`);
      process.exit(1);
    }
  }

  console.log('[db:baseline] done — `prisma migrate deploy` will now only apply new migrations.');
}

main()
  .catch((err) => {
    console.error('[db:baseline] failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
