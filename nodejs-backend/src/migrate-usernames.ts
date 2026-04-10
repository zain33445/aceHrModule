import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Starting migration: Assigning IDs as usernames for users without a username...');
  
  const users = await prisma.user.findMany({
    where: {
      username: null
    }
  });

  console.log(`Found ${users.length} users needing update.`);

  for (const user of users) {
    await prisma.user.update({
      where: { id: user.id },
      data: { username: user.id }
    });
    console.log(`Updated user ${user.id} with username ${user.id}`);
  }

  console.log('Migration complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
