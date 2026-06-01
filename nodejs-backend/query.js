const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const sessions = await prisma.recordingSession.findMany({
    take: 1,
    orderBy: { created_at: 'desc' },
    include: { chunks: true }
  });
  console.log(JSON.stringify(sessions, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
