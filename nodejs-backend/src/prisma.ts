import { PrismaClient } from '@prisma/client';
import 'dotenv/config';

const prisma = new PrismaClient();

const RETRY_DELAY_MS = 5000;

async function connectWithRetry(): Promise<void> {
  try {
    await prisma.$connect();
    console.log('[Prisma] Connected to database');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Prisma] Database unavailable (${message}). Retrying in ${RETRY_DELAY_MS / 1000}s...`);
    setTimeout(connectWithRetry, RETRY_DELAY_MS);
  }
}

connectWithRetry();

export default prisma;
