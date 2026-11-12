/** Idempotent additive DDL for chat (db push / migrate are not usable here, see AGENTS.md). */
import prisma from '../prisma';

export async function ensureChatSchema(): Promise<void> {
  await prisma.$executeRawUnsafe('ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS title TEXT');
}
