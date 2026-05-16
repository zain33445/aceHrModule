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
 * Backfill missing checkouts by reprocessing each day's window
 * using the (now fixed) processDateRange which handles prev-day checkouts.
 *
 * Run:  npx ts-node src/backfill_checkouts.ts
 */
const prisma_1 = __importDefault(require("./prisma"));
const absence_service_1 = require("./services/absence.service");
function backfill() {
    return __awaiter(this, void 0, void 0, function* () {
        console.log('\n🔧 Backfilling missing checkouts from Apr 20 to today...\n');
        const startDate = new Date('2026-04-20');
        const endDate = new Date();
        // Reprocess each day — this will now also pick up overnight checkouts
        // because calculateAndRecordAttendance updates existing records
        yield absence_service_1.AbsenceService.processDateRange(startDate, endDate);
        // Verify
        console.log('\n📊 Verification — records with overnight workers:\n');
        const records = yield prisma_1.default.attendanceRecord.findMany({
            where: {
                date: { gte: new Date('2026-04-20T00:00:00.000Z') },
                check_in_time: { not: null }
            },
            include: { user: { select: { name: true } } },
            orderBy: [{ date: 'asc' }, { user_id: 'asc' }]
        });
        for (const r of records) {
            const flag = (r.check_out_time === null) ? ' ⚠️' : ' ✅';
            console.log(`  ${r.date.toISOString().split('T')[0]} | ${r.user.name.padEnd(12)} | ${r.status.padEnd(8)} | in=${(r.check_in_time || '').padEnd(5)} | out=${(r.check_out_time || 'NULL').padEnd(5)}${flag}`);
        }
        console.log('\n✅ Backfill complete!\n');
        yield prisma_1.default.$disconnect();
    });
}
backfill().catch(e => { console.error('❌ Error:', e); process.exit(1); });
