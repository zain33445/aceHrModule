"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Restore records from Apr 17+ using the ORIGINAL code logic
 * (reverting the PKT repair script's changes to the DB)
 */
const prisma_1 = __importDefault(require("./prisma"));
const absence_service_1 = require("./services/absence.service");
function restore() {
    return __awaiter(this, void 0, void 0, function* () {
        console.log('\n🔄 Restoring records from Apr 17 using original code logic...\n');
        // 1. Delete the PKT-rebuilt records
        const deleted = yield prisma_1.default.attendanceRecord.deleteMany({
            where: { date: { gte: new Date('2026-04-17T00:00:00.000Z') } }
        });
        console.log(`🗑️  Deleted ${deleted.count} records from Apr 17+`);
        const delDed = yield prisma_1.default.deduction.deleteMany({
            where: { date: { gte: new Date('2026-04-17T00:00:00.000Z') } }
        });
        console.log(`🗑️  Deleted ${delDed.count} deductions from Apr 17+`);
        // 2. Reprocess using the ORIGINAL code (processDateRange with the +1 day logic)
        const startDate = new Date('2026-04-17');
        const endDate = new Date('2026-04-22');
        console.log(`\n📅 Reprocessing Apr 17 to Apr 22...\n`);
        yield absence_service_1.AbsenceService.processDateRange(startDate, endDate);
        // 3. Verify
        console.log('\n📊 Verification:');
        const records = yield prisma_1.default.attendanceRecord.findMany({
            where: { date: { gte: new Date('2026-04-17T00:00:00.000Z') } },
            include: { user: { select: { name: true } } },
            orderBy: { date: 'desc' },
            take: 20
        });
        for (const r of records) {
            console.log(`  ${r.date.toISOString().split('T')[0]} | ${r.user.name.padEnd(12)} | ${r.status.padEnd(8)} | in=${r.check_in_time || 'NULL'} out=${r.check_out_time || 'NULL'}`);
        }
        console.log(`\nTotal rebuilt: ${yield prisma_1.default.attendanceRecord.count({ where: { date: { gte: new Date('2026-04-17T00:00:00.000Z') } } })}`);
        console.log('\n✅ Restore complete!\n');
        yield prisma_1.default.$disconnect();
    });
}
restore().catch(e => { console.error('❌ Error:', e); process.exit(1); });
