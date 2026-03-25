import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';

import authRoutes from './routes/auth.routes';
import employeeRoutes from './routes/employee.routes';
import attendanceRoutes from './routes/attendance.routes';
import webhookRoutes from './routes/webhook.routes';
import salaryRoutes from './routes/salary.routes';
import commissionRoutes from './routes/commission.routes';
import disputeRoutes from './routes/dispute.routes';
import absenceRoutes from './routes/absence.routes';
import deductionRoutes from './routes/deduction.routes';
import notificationRoutes from './routes/notification.routes';
import departmentRoutes from './routes/department.routes';
import holidayRoutes from './routes/holiday.routes';
import leaveRequestRoutes from './routes/leave-request.routes';
import auditRoutes from './routes/audit.routes';
import exportRoutes from './routes/export.routes';

import prisma from './prisma';
import { AbsenceService } from './services/absence.service';

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Audit Middleware
app.use(async (req, res, next) => {
  res.on('finish', async () => {
    if (['POST', 'PUT', 'DELETE'].includes(req.method) && res.statusCode >= 200 && res.statusCode < 300) {
      if (!req.path.includes('/auth/login') && !req.path.includes('/webhooks')) {
        try {
          await prisma.auditLog.create({
            data: {
              user_id: req.body?.user_id || req.body?.reviewed_by || req.body?.req_by || null,
              action: `${req.method} ${req.path}`,
              details: JSON.stringify(req.body || {}).substring(0, 1000)
            }
          });
        } catch (err) {
          console.error('Audit log failed', err);
        }
      }
    }
  });
  next();
});

// Main REST Routes

app.use('/api/auth', authRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/salaries', salaryRoutes);
app.use('/api/commissions', commissionRoutes);
app.use('/api/disputes', disputeRoutes);
app.use('/api/absences', absenceRoutes);
app.use('/api/deductions', deductionRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/departments', departmentRoutes);
app.use('/api/holidays', holidayRoutes);
app.use('/api/leave-requests', leaveRequestRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/export', exportRoutes);

app.get('/', (req, res) => {
  res.send('Node.js Attendance API is running.');
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  
  // 5-minute cron for live sync fallback
  setInterval(async () => {
    try {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      await AbsenceService.processDailyAbsences(tomorrow);
      console.log(`[Cron] 5-minute global sync for today completed`);
    } catch(err) {
      console.error(`[Cron] 5-minute sync failed`, err);
    }
  }, 5 * 60 * 1000);
});
