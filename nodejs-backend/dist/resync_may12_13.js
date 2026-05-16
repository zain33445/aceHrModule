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
 * Proper resync for May 12 and 13 using the EXACT same logic as processDailyAbsences.
 *
 * The service uses setHours(6,0,0,0) which is SERVER LOCAL TIME (PDT = UTC-7).
 * So the 6AM PDT window = 13:00 UTC.
 *
 * May 12 window: May 12 06:00 PDT (13:00 UTC) → May 13 06:00 PDT (13:00 UTC)
 * May 13 window: May 13 06:00 PDT (13:00 UTC) → May 14 06:00 PDT (13:00 UTC)
 *
 * Run: npx ts-node src/resync_may12_13.ts
 */
const prisma_1 = __importDefault(require("./prisma"));
const absence_service_1 = require("./services/absence.service");
function main() {
    return __awaiter(this, void 0, void 0, function* () {
        var _a;
        console.log('=== PROPER RESYNC for May 12 & 13 ===\n');
        console.log('Server timezone offset:', new Date().getTimezoneOffset(), 'minutes (should be 420 for PDT)');
        // Step 1: Delete existing records for May 12 and May 13 (noon UTC canonical dates)
        const may12 = new Date('2026-05-12T12:00:00.000Z');
        const may13 = new Date('2026-05-13T12:00:00.000Z');
        const del12 = yield prisma_1.default.attendanceRecord.deleteMany({
            where: { date: may12 }
        });
        console.log(`Deleted ${del12.count} existing records for May 12`);
        const del13 = yield prisma_1.default.attendanceRecord.deleteMany({
            where: { date: may13 }
        });
        console.log(`Deleted ${del13.count} existing records for May 13`);
        // Step 2: Use processDateRange which calls processDailyAbsences internally
        // processDateRange(May 12, May 13) → calls processDailyAbsences(May 13) and processDailyAbsences(May 14)
        // processDailyAbsences(d) does: targetDate = d - 1 day, then window = targetDate 6AM → next day 6AM (server local)
        console.log('\nRebuilding records using service logic...');
        const results = yield absence_service_1.AbsenceService.processDateRange(new Date('2026-05-12T00:00:00'), // start: May 12 local midnight
        new Date('2026-05-13T00:00:00') // end:   May 13 local midnight
        );
        console.log('\nResults:');
        for (const r of results) {
            console.log(' -', r.message);
        }
        // Step 3: Print verification
        console.log('\n=== VERIFICATION ===');
        const records = yield prisma_1.default.attendanceRecord.findMany({
            where: {
                date: { in: [may12, may13] }
            },
            include: { user: { select: { name: true } } },
            orderBy: [{ date: 'asc' }, { user_id: 'asc' }]
        });
        for (const r of records) {
            const dayLabel = r.date.toISOString().startsWith('2026-05-12') ? 'May 12' : 'May 13';
            console.log(`  ${dayLabel} | ${(((_a = r.user) === null || _a === void 0 ? void 0 : _a.name) || r.user_id).padEnd(15)} | ${r.status.padEnd(8)} | in: ${(r.check_in_time || 'NULL').padEnd(5)} | out: ${r.check_out_time || 'NULL'}`);
        }
        yield prisma_1.default.$disconnect();
        console.log('\n=== DONE ===');
    });
}
main().catch(e => { console.error(e); process.exit(1); });
