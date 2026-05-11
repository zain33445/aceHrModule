import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  try {
    const leads = await prisma.department.findMany({
      where: { NOT: { lead_id: null } },
      include: { lead: true }
    });
    console.log('Departments with leads:', JSON.stringify(leads, null, 2));

    const disputes = await prisma.dispute.findMany({
      include: {
        requester: { select: { name: true, department_id: true } }
      }
    });
    console.log('All disputes:', JSON.stringify(disputes, null, 2));

    const users = await prisma.user.findMany({
        take: 5,
        include: { led_departments: true }
    });
    console.log('Sample users:', JSON.stringify(users, null, 2));

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

main();
