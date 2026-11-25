import prisma from '../prisma';

const TRIGGER_NAME = 'leave_ledger_apply_balance';
const MARKER_KEY = 'leave_ledger_trigger_v1';

const FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION leave_ledger_apply_balance() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO leave_bank (user_id, leave_type_id, leaves_remaining)
  VALUES (NEW.user_id, NEW.leave_type_id, NEW.amount::double precision)
  ON CONFLICT (user_id, leave_type_id)
  DO UPDATE SET leaves_remaining =
    round((leave_bank.leaves_remaining::numeric + NEW.amount), 2)::double precision;
  RETURN NEW;
END;
$$;
`;

async function triggerPresent(client: typeof prisma): Promise<boolean> {
  const rows = await client.$queryRawUnsafe<{ exists: boolean }[]>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_trigger
       WHERE tgname = '${TRIGGER_NAME}' AND NOT tgisinternal
     ) AS exists`
  );
  return rows[0]?.exists === true;
}

export async function ensureLeaveLedgerBalanceTrigger(): Promise<void> {
  if (await triggerPresent(prisma)) return;

  const result = await prisma.$transaction(
    async (tx) => {
      await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('leave_ledger_apply_balance'))::text AS locked`);

      if (await triggerPresent(tx as unknown as typeof prisma)) {
        return { reconciled: false, pendingRows: 0, newBanks: 0, openings: 0 };
      }

      const marker = await tx.$queryRawUnsafe<{ key: string }[]>(
        `SELECT key FROM app_settings WHERE key = '${MARKER_KEY}'`
      );

      let pendingRows = 0;
      let newBanks = 0;
      let openings = 0;

      if (marker.length === 0) {
        await tx.$executeRawUnsafe(`LOCK TABLE leave_ledger IN EXCLUSIVE MODE`);
        await tx.$executeRawUnsafe(`LOCK TABLE leave_bank IN EXCLUSIVE MODE`);
        await tx.$executeRawUnsafe(`LOCK TABLE leave_requests IN EXCLUSIVE MODE`);

        pendingRows = await tx.$executeRawUnsafe(`
          UPDATE leave_bank lb
          SET leaves_remaining = round((lb.leaves_remaining::numeric + p.pending_sum), 2)::double precision
          FROM (
            SELECT ll.user_id, ll.leave_type_id, SUM(ll.amount) AS pending_sum
            FROM leave_ledger ll
            JOIN leave_requests lr ON lr.id = ll.leave_request_id
            WHERE lr.status = 'PENDING'
            GROUP BY ll.user_id, ll.leave_type_id
            HAVING SUM(ll.amount) <> 0
          ) p
          WHERE lb.user_id = p.user_id AND lb.leave_type_id = p.leave_type_id
        `);

        newBanks = await tx.$executeRawUnsafe(`
          INSERT INTO leave_bank (user_id, leave_type_id, leaves_remaining)
          SELECT ll.user_id, ll.leave_type_id, round(SUM(ll.amount), 2)::double precision
          FROM leave_ledger ll
          LEFT JOIN leave_bank lb
            ON lb.user_id = ll.user_id AND lb.leave_type_id = ll.leave_type_id
          WHERE lb.id IS NULL
          GROUP BY ll.user_id, ll.leave_type_id
          ON CONFLICT (user_id, leave_type_id) DO NOTHING
        `);

        openings = await tx.$executeRawUnsafe(`
          INSERT INTO leave_ledger (user_id, leave_type_id, transaction_type, amount, idempotency_key, notes, created_by_type)
          SELECT lb.user_id, lb.leave_type_id, 'ADJUSTMENT'::"LeaveTransactionType",
                 round(lb.leaves_remaining::numeric - COALESCE(s.total, 0), 2),
                 'OPENING-BALANCE-' || lb.user_id || '-' || lb.leave_type_id,
                 'Opening balance: aligns leave_bank with leave_ledger before enabling the balance trigger',
                 'SYSTEM'
          FROM leave_bank lb
          LEFT JOIN (
            SELECT user_id, leave_type_id, SUM(amount) AS total
            FROM leave_ledger
            GROUP BY user_id, leave_type_id
          ) s ON s.user_id = lb.user_id AND s.leave_type_id = lb.leave_type_id
          WHERE round(lb.leaves_remaining::numeric - COALESCE(s.total, 0), 2) <> 0
          ON CONFLICT (idempotency_key) DO NOTHING
        `);

        const mismatches = await tx.$queryRawUnsafe<{ count: bigint }[]>(`
          SELECT count(*) AS count
          FROM leave_bank lb
          LEFT JOIN (
            SELECT user_id, leave_type_id, SUM(amount) AS total
            FROM leave_ledger
            GROUP BY user_id, leave_type_id
          ) s ON s.user_id = lb.user_id AND s.leave_type_id = lb.leave_type_id
          WHERE round(lb.leaves_remaining::numeric - COALESCE(s.total, 0), 2) <> 0
        `);

        if (Number(mismatches[0]?.count ?? 0) !== 0) {
          throw new Error('leave_bank still differs from leave_ledger after reconciliation');
        }
      }

      await tx.$executeRawUnsafe(FUNCTION_SQL);
      await tx.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${TRIGGER_NAME} ON leave_ledger`);
      await tx.$executeRawUnsafe(
        `CREATE TRIGGER ${TRIGGER_NAME} AFTER INSERT ON leave_ledger FOR EACH ROW EXECUTE FUNCTION leave_ledger_apply_balance()`
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ('${MARKER_KEY}', 'applied', now()) ON CONFLICT (key) DO NOTHING`
      );

      return { reconciled: marker.length === 0, pendingRows, newBanks, openings };
    },
    { timeout: 60_000 }
  );

  if (result.reconciled) {
    console.log(
      `[Leave Ledger] reconciled bank to ledger (pending holds: ${result.pendingRows}, new bank rows: ${result.newBanks}, opening entries: ${result.openings})`
    );
  }
  console.log('[Leave Ledger] balance trigger ready');
}
