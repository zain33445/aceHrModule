import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      name: true,
      username: true,
      password_hash: true
    }
  });
  console.log("All users in DB:", JSON.stringify(users, null, 2));
}

main().finally(() => process.exit(0));
