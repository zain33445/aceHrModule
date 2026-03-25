import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  try {
    console.log('Attempting to connect to the database...');
    await prisma.$connect();
    console.log('SUCCESS: Connected to the database.');
    
    console.log('Attempting to fetch users...');
    const users = await prisma.user.findMany();
    console.log(`SUCCESS: Fetched ${users.length} users.`);
    console.log(users);
  } catch (err) {
    console.error('ERROR: Database connection or query failed.');
    console.error(err);
  } finally {
    await prisma.$disconnect();
  }
}

main();
