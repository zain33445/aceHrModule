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
function checkLogStatuses() {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            console.log('\n📊 Checking AttendanceLog Status Values:\n');
            const startOfMarch = new Date('2026-03-01');
            const endOfMarch = new Date('2026-03-31');
            endOfMarch.setHours(23, 59, 59, 999);
            // Get all unique statuses
            const logs = yield prisma_1.default.attendanceLog.findMany({
                where: {
                    timestamp: {
                        gte: startOfMarch,
                        lte: endOfMarch
                    }
                },
                select: {
                    status: true,
                    user_id: true,
                    timestamp: true
                },
                orderBy: { timestamp: 'asc' },
                take: 50
            });
            console.log(`Sample logs (first 50):\n`);
            logs.forEach((log, i) => {
                const date = log.timestamp.toISOString().split('T')[0];
                const time = log.timestamp.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
                console.log(`${i + 1}. User: ${log.user_id}, Status: ${log.status}, Date: ${date}, Time: ${time}`);
            });
            // Get unique statuses
            const statuses = yield prisma_1.default.attendanceLog.findMany({
                where: {
                    timestamp: {
                        gte: startOfMarch,
                        lte: endOfMarch
                    }
                },
                select: { status: true },
                distinct: ['status']
            });
            console.log(`\n\nUnique Status Values Found:`);
            statuses.forEach(s => {
                console.log(`  • ${s.status}`);
            });
            // Count by status
            const groupedByStatus = yield prisma_1.default.attendanceLog.groupBy({
                by: ['status'],
                where: {
                    timestamp: {
                        gte: startOfMarch,
                        lte: endOfMarch
                    }
                },
                _count: true
            });
            console.log(`\n\nCount by Status:`);
            groupedByStatus.forEach(g => {
                console.log(`  • Status ${g.status}: ${g._count} logs`);
            });
            // Count per user per day
            console.log(`\n\nLogs per User per Day Sample:\n`);
            const userId1Logs = yield prisma_1.default.attendanceLog.findMany({
                where: {
                    user_id: '1',
                    timestamp: {
                        gte: startOfMarch,
                        lte: endOfMarch
                    }
                },
                orderBy: { timestamp: 'asc' }
            });
            console.log(`User 1 logs (${userId1Logs.length} total):`);
            userId1Logs.forEach(log => {
                const date = log.timestamp.toISOString().split('T')[0];
                const time = log.timestamp.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
                console.log(`  • ${date} ${time} - Status: ${log.status}`);
            });
        }
        catch (error) {
            console.error('Error:', error);
        }
        finally {
            yield prisma_1.default.$disconnect();
        }
    });
}
checkLogStatuses();
