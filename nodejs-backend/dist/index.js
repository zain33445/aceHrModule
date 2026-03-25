"use strict";
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
const app = (0, express_1.default)();
const PORT = process.env.PORT || 5000;
app.use((0, cors_1.default)());
app.use(express_1.default.json({ limit: '50mb' }));
app.use(express_1.default.urlencoded({ limit: '50mb', extended: true }));
// Main REST Routes
app.use('/api/auth', auth_routes_1.default);
app.use('/api/employees', employee_routes_1.default);
app.use('/api/attendance', attendance_routes_1.default);
app.use('/api/salaries', salary_routes_1.default);
app.use('/api/commissions', commission_routes_1.default);
app.use('/api/disputes', dispute_routes_1.default);
app.use('/api/absences', absence_routes_1.default);
app.use('/api/webhooks', webhook_routes_1.default);
app.get('/', (req, res) => {
    res.send('Node.js Attendance API is running.');
});
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
