import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.findMany({
    where: { username: null }
  });
  
  let count = 0;
  for (const user of users) {
    if (user.name) {
      let username = user.name.toLowerCase().replace(/\s+/g, '');
      try {
        await prisma.user.update({
          where: { id: user.id },
          data: { username }
        });
        count++;
        console.log(`Updated user ${user.id} (${user.name}) -> username: ${username}`);
      } catch (e) {
        if (e.code === 'P2002') {
          // Unique constraint failed, append ID
          username = `${username}${user.id}`;
          await prisma.user.update({
            where: { id: user.id },
            data: { username }
          });
          count++;
          console.log(`Updated user ${user.id} (${user.name}) -> username: ${username} (duplicate resolved)`);
        } else {
          console.error(`Failed to update ${user.id}`, e);
        }
      }
    }
  }
  
  console.log(`Successfully backfilled ${count} users.`);
}

main()
  .catch(e => console.error(e))
  .finally(() => process.exit(0));
