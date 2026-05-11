const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  try {
    const leads = await prisma.department.findMany({
      where: { NOT: { lead_id: null } },
      include: { lead: { select: { id: true, name: true } } }
    });
    console.log('Departments with leads:', JSON.stringify(leads, null, 2));

    const disputes = await prisma.dispute.findMany({
      take: 10,
      include: {
        requester: { select: { name: true, department_id: true } }
      }
    });
    console.log('Sample disputes:', JSON.stringify(disputes, null, 2));

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

main();
