const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function deepClean() {
  console.log("Fetching all...");
  const records = await prisma.attendanceRecord.findMany({});
  
  // Group by "userId_YYYY-MM-DD" in local time
  const groups = {};
  for (const r of records) {
    const d = new Date(r.date);
    const key = `${r.user_id}_${d.getFullYear()}_${d.getMonth()}_${d.getDate()}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  }

  const idsToDelete = [];
  
  for (const key in groups) {
    let arr = groups[key];
    if (arr.length > 1) {
      // Find one that is perfectly aligned to 00:00 local time (which is 19:00 UTC) if possible
      arr.sort((a,b) => {
        const aT = new Date(a.date).toISOString().endsWith("T19:00:00.000Z") ? 1 : 0;
        const bT = new Date(b.date).toISOString().endsWith("T19:00:00.000Z") ? 1 : 0;
        return bT - aT; // properly aligned ones go to front (idx 0)
      });
      
      // keep arr[0], delete the rest
      for (let i = 1; i < arr.length; i++) {
        idsToDelete.push(arr[i].id);
      }
    }
  }

  console.log(`Found ${idsToDelete.length} duplicates to aggressively wipe.`);
  
  if (idsToDelete.length > 0) {
    // Delete in batches to avoid Prisma limitations
    const batchSize = 1000;
    for (let i = 0; i < idsToDelete.length; i += batchSize) {
      const batch = idsToDelete.slice(i, i + batchSize);
      await prisma.attendanceRecord.deleteMany({
        where: { id: { in: batch } }
      });
      console.log(`Deleted batch of ${batch.length}`);
    }
  }

  // Same deep clean for deductions
  const deductions = await prisma.deduction.findMany({});
  const dGroups = {};
  for (const d of deductions) {
    const date = new Date(d.date);
    const key = `${d.user_id}_${d.type}_${date.getFullYear()}_${date.getMonth()}_${date.getDate()}`;
    if (!dGroups[key]) dGroups[key] = [];
    dGroups[key].push(d);
  }

  const dIdsToDelete = [];
  for (const key in dGroups) {
    let arr = dGroups[key];
    if (arr.length > 1) {
      for (let i = 1; i < arr.length; i++) {
        dIdsToDelete.push(arr[i].id);
      }
    }
  }

  console.log(`Found ${dIdsToDelete.length} duplicate deductions.`);
  if (dIdsToDelete.length > 0) {
    const batchSize = 1000;
    for (let i = 0; i < dIdsToDelete.length; i += batchSize) {
      await prisma.deduction.deleteMany({
        where: { id: { in: dIdsToDelete.slice(i, i + batchSize) } }
      });
    }
    console.log(`Deleted deduplicated deductions.`);
  }

  console.log("Deep clean complete.");
}

deepClean().catch(console.error).finally(() => prisma.$disconnect());
