const d = new Date();
console.log("Original:", d.toISOString());
d.setHours(0, 0, 0, 0);
console.log("Zeroed:", d.toISOString());

const d2 = new Date();
const targetDate = d2;
targetDate.setDate(targetDate.getDate() - 1);
targetDate.setHours(0, 0, 0, 0);
console.log("Daily Absences:", targetDate.toISOString());

const d3 = new Date();
d3.setDate(d3.getDate() + 1);
const checkDate = d3;
const targetDate2 = checkDate || new Date();
targetDate2.setDate(targetDate2.getDate() - 1);
targetDate2.setHours(0, 0, 0, 0);
console.log("Sync Today Absences:", targetDate2.toISOString());
