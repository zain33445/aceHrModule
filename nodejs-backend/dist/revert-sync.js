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
const prisma_1 = __importDefault(require("./prisma"));
const absence_service_1 = require("./services/absence.service");
function revertAndReprocess() {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            console.log('\n🔄 Undoing previous data and re-generating with exact local dates...\n');
            const start = new Date('2026-02-27T00:00:00Z');
            const end = new Date('2026-05-01T23:59:59Z');
            const deleted = yield prisma_1.default.attendanceRecord.deleteMany({
                where: { date: { gte: start, lte: end } }
            });
            console.log(`🗑️ Deleted ${deleted.count} misaligned records.\n`);
            // We want to process every single day from March 1st to April 16th.
            // The target date in AbsenceService subtracts 1 day. 
            // And it runs in the local timezone (PDT).
            // So to process March 1st, we need to give it March 2nd Local Noon.
            // Build local dates manually
            const datesToProcess = [];
            // March 1 to March 31
            for (let i = 1; i <= 31; i++) {
                // e.g. process March 1st: we pass March 2nd 12:00 Local Time
                const nextDay = new Date(2026, 2, i + 1, 12, 0, 0); // Month is 0-indexed (2 = March)
                datesToProcess.push(nextDay);
            }
            // April 1 to April 16
            for (let i = 1; i <= 16; i++) {
                const nextDay = new Date(2026, 3, i + 1, 12, 0, 0); // 3 = April
                datesToProcess.push(nextDay);
            }
            console.log(`📅 Re-processing ${datesToProcess.length} correct days using local timezone calculations...\n`);
            for (const processDate of datesToProcess) {
                yield absence_service_1.AbsenceService.processDailyAbsences(processDate);
                // Let's log the actual calendar date that was processed (which is processDate - 1 day)
                const processed = new Date(processDate);
                processed.setDate(processed.getDate() - 1);
                console.log(`✅ correctly processed: ${processed.toDateString()}`);
            }
            console.log('\n📋 Re-processing complete! Run your apply_fixes script to restore weekend/fallback statuses.\n');
        }
        catch (error) {
            console.error('❌ Error:', error);
        }
        finally {
            yield prisma_1.default.$disconnect();
        }
    });
}
revertAndReprocess();
