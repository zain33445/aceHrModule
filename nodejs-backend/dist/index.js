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
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const auth_routes_1 = __importDefault(require("./routes/auth.routes"));
const employee_routes_1 = __importDefault(require("./routes/employee.routes"));
const attendance_routes_1 = __importDefault(require("./routes/attendance.routes"));
const webhook_routes_1 = __importDefault(require("./routes/webhook.routes"));
const salary_routes_1 = __importDefault(require("./routes/salary.routes"));
const commission_routes_1 = __importDefault(require("./routes/commission.routes"));
const dispute_routes_1 = __importDefault(require("./routes/dispute.routes"));
const absence_routes_1 = __importDefault(require("./routes/absence.routes"));
const deduction_routes_1 = __importDefault(require("./routes/deduction.routes"));
const notification_routes_1 = __importDefault(require("./routes/notification.routes"));
const department_routes_1 = __importDefault(require("./routes/department.routes"));
const holiday_routes_1 = __importDefault(require("./routes/holiday.routes"));
const leave_request_routes_1 = __importDefault(require("./routes/leave-request.routes"));
const audit_routes_1 = __importDefault(require("./routes/audit.routes"));
const export_routes_1 = __importDefault(require("./routes/export.routes"));
const monitoring_routes_1 = __importDefault(require("./routes/monitoring.routes"));
const prisma_1 = __importDefault(require("./prisma"));
const absence_service_1 = require("./services/absence.service");
const app = (0, express_1.default)();
const PORT = process.env.PORT || 5000;
app.use((0, cors_1.default)());
app.use(express_1.default.json({ limit: '50mb' }));
app.use(express_1.default.urlencoded({ limit: '50mb', extended: true }));
// Audit Middleware
app.use((req, res, next) => __awaiter(void 0, void 0, void 0, function* () {
    res.on('finish', () => __awaiter(void 0, void 0, void 0, function* () {
        var _a, _b, _c;
        if (['POST', 'PUT', 'DELETE'].includes(req.method) && res.statusCode >= 200 && res.statusCode < 300) {
            if (!req.path.includes('/auth/login') && !req.path.includes('/webhooks')) {
                try {
                    yield prisma_1.default.auditLog.create({
                        data: {
                            user_id: ((_a = req.body) === null || _a === void 0 ? void 0 : _a.user_id) || ((_b = req.body) === null || _b === void 0 ? void 0 : _b.reviewed_by) || ((_c = req.body) === null || _c === void 0 ? void 0 : _c.req_by) || null,
                            action: `${req.method} ${req.path}`,
                            details: JSON.stringify(req.body || {}).substring(0, 1000)
                        }
                    });
                }
                catch (err) {
                    console.error('Audit log failed', err);
                }
            }
        }
    }));
    next();
}));
// Main REST Routes
app.use('/api/auth', auth_routes_1.default);
app.use('/api/employees', employee_routes_1.default);
app.use('/api/attendance', attendance_routes_1.default);
app.use('/api/salaries', salary_routes_1.default);
app.use('/api/commissions', commission_routes_1.default);
app.use('/api/disputes', dispute_routes_1.default);
app.use('/api/absences', absence_routes_1.default);
app.use('/api/deductions', deduction_routes_1.default);
app.use('/api/notifications', notification_routes_1.default);
app.use('/api/webhooks', webhook_routes_1.default);
app.use('/api/departments', department_routes_1.default);
app.use('/api/holidays', holiday_routes_1.default);
app.use('/api/leave-requests', leave_request_routes_1.default);
app.use('/api/audit', audit_routes_1.default);
app.use('/api/export', export_routes_1.default);
app.use('/api/monitoring', monitoring_routes_1.default);
app.get('/', (req, res) => {
    res.send('Node.js Attendance API is running.');
});
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    // 5-minute cron for live sync fallback
    setInterval(() => __awaiter(void 0, void 0, void 0, function* () {
        try {
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            yield absence_service_1.AbsenceService.processDailyAbsences(tomorrow);
            console.log(`[Cron] 5-minute global sync for today completed`);
        }
        catch (err) {
            console.error(`[Cron] 5-minute sync failed`, err);
        }
    }), 5 * 60 * 1000);
});
