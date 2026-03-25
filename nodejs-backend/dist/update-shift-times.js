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
function updateShiftTimes() {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            console.log('\n🔄 Updating shift times to HH:MM format (24-hour)...\n');
            // Day shift: 9:00 AM - 3:45 PM, late after 9:16 AM, half-day before 11:01 AM
            const dayShift = yield prisma_1.default.shift.update({
                where: { shiftid: 'day' },
                data: {
                    checkin: '09:00',
                    checkout: '15:45',
                    latetiming: '09:16',
                    halfday: '11:01'
                }
            });
            console.log('✅ Day shift updated:');
            console.log(`   Check-in: ${dayShift.checkin}`);
            console.log(`   Check-out: ${dayShift.checkout}`);
            console.log(`   Late after: ${dayShift.latetiming}`);
            console.log(`   Half-day before: ${dayShift.halfday}\n`);
            // Night shift: 7:30 PM - 2:45 AM, late after 7:41 PM, half-day before 11:01 PM
            const nightShift = yield prisma_1.default.shift.update({
                where: { shiftid: 'night' },
                data: {
                    checkin: '19:30',
                    checkout: '02:45',
                    latetiming: '19:41',
                    halfday: '23:01'
                }
            });
            console.log('✅ Night shift updated:');
            console.log(`   Check-in: ${nightShift.checkin}`);
            console.log(`   Check-out: ${nightShift.checkout}`);
            console.log(`   Late after: ${nightShift.latetiming}`);
            console.log(`   Half-day before: ${nightShift.halfday}\n`);
            console.log('✅ All shift times updated successfully!\n');
        }
        catch (error) {
            console.error('Error:', error);
        }
        finally {
            yield prisma_1.default.$disconnect();
        }
    });
}
updateShiftTimes();
