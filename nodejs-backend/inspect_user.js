const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function inspect() {
  const user = await prisma.user.findUnique({
    where: { id: '6' },
    include: {
      department: {
        include: {
          shift: true
        }
      }
    }
  });

  console.log('--- User 6 Details ---');
  console.log(JSON.stringify(user, null, 2));
}

inspect().catch(console.error).finally(() => prisma.$disconnect());
