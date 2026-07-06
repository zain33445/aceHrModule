import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import { createServer } from 'http';

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
import leaveLedgerRoutes from './routes/leave-ledger.routes';
import leavePolicyRoutes from './routes/leave-policy.routes';
import leaveTypeRoutes from './routes/leave-type.routes';
import auditRoutes from './routes/audit.routes';
import exportRoutes from './routes/export.routes';
import monitoringRoutes from './routes/monitoring.routes';
import recordingRoutes from './routes/recording.routes';
import tabAccessRoutes from './routes/tab-access.routes';
import overtimeRoutes from './routes/overtime.routes';
import { initGateway } from './gateways/recording.gateway';
import { processOutboxEvents, recoverStuckEvents } from './workers/outbox-worker';

import prisma from './prisma';
import { AbsenceService } from './services/absence.service';
import { HolidayService } from './services/holiday.service';

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
// Raw binary parser for video chunk uploads (agent uses Content-Type: application/octet-stream)
app.use('/api/recording/chunk', express.raw({ type: 'application/octet-stream', limit: '50mb' }));


// Audit Middleware
app.use(async (req, res, next) => {
  res.on('finish', async () => {
    if (['POST', 'PUT', 'DELETE'].includes(req.method) && res.statusCode >= 200 && res.statusCode < 300) {
      if (!req.path.includes('/auth/login') && !req.path.includes('/webhooks')) {
        try {
          await prisma.auditLog.create({
            data: {
              user_id: req.body?.user_id || req.body?.reviewed_by || req.body?.hr_id || req.body?.lead_id || req.body?.admin_id || req.body?.req_by || null,
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
app.use('/api/leave-ledger', leaveLedgerRoutes);
app.use('/api/leave-policies', leavePolicyRoutes);
app.use('/api/leave-types', leaveTypeRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/monitoring', monitoringRoutes);
app.use('/api/recording', recordingRoutes);
app.use('/api/tab-access', tabAccessRoutes);
app.use('/api/overtime', overtimeRoutes);


app.get('/', (req, res) => {
  res.send('Node.js Attendance API is running.');
});

const server = createServer(app);

// Initialize WebSocket gateway for recording control
const recordingGateway = initGateway(server);
console.log('[Server] Recording WebSocket gateway attached to HTTP server');

server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);

  // ── Startup: assemble any orphaned sessions ─────────────────────────────
  setTimeout(async () => {
    try {
      const { assembleSession } = await import('./services/recording.service');
      const orphaned = await prisma.recordingSession.findMany({
        where: { status: { in: ['stopped', 'recording'] } },
        include: { _count: { select: { chunks: true } } },
      });
      if (orphaned.length === 0) return;
      console.log(`[Startup] Found ${orphaned.length} orphaned session(s) — assembling...`);
      for (const session of orphaned) {
        if (session._count.chunks === 0) {
          // No chunks at all — just mark as stopped, nothing to assemble
          await prisma.recordingSession.update({
            where: { id: session.id },
            data: { status: 'stopped', ended_at: new Date() },
          });
          console.log(`[Startup] Session ${session.id} had 0 chunks — marked stopped.`);
          continue;
        }
        console.log(`[Startup] Assembling session ${session.id} (${session._count.chunks} chunks)...`);
        // Mark stopped first so assembly can proceed
        if (session.status === 'recording') {
          await prisma.recordingSession.update({
            where: { id: session.id },
            data: { status: 'stopped', ended_at: new Date() },
          });
        }
        assembleSession(session.id).catch((err) => {
          console.error(`[Startup] Assembly failed for ${session.id}: ${err.message}`);
        });
      }
    } catch (err) {
      console.error('[Startup] Orphan cleanup failed:', err);
    }
  }, 3000); // wait 3s for DB connections to settle

  // ── Startup: process any pending holidays created while server was down ──
  setTimeout(async () => {
    try {
      const result = await HolidayService.processHolidays();
      if (result.processed > 0) {
        console.log(`[HolidayCron] Startup processed ${result.processed} pending holiday(s), updated ${result.recordsUpdated} attendance records, refunded ${result.leavesRefunded} leaves, removed ${result.deductionsRemoved} deductions`);
      }
    } catch (err) {
      console.error('[HolidayCron] Startup run failed:', err);
    }
  }, 5000); // run 5s after server is up

  // ── 8-hour cron for holiday enforcement (runs 3× per day) ────────────────
  setInterval(async () => {
    try {
      const result = await HolidayService.processHolidays();
      if (result.processed > 0) {
        console.log(`[HolidayCron] Processed ${result.processed} holiday(s) | attendance: ${result.recordsUpdated} | leaves refunded: ${result.leavesRefunded} | deductions removed: ${result.deductionsRemoved}`);
      }
    } catch (err) {
      console.error('[HolidayCron] 8-hour run failed:', err);
    }
  }, 8 * 60 * 60 * 1000);

  
  // 5-minute cron for live sync fallback
  setInterval(async () => {
    try {
      // Extract the current DATE string in Karachi timezone (YYYY-MM-DD) — independent of Windows system clock
      const todayKarachi = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Karachi" });
      const yesterdayKarachi = new Date(Date.now() - 86400000).toLocaleDateString("en-CA", { timeZone: "Asia/Karachi" });

      // Build canonical UTC noon dates for processing
      const today = new Date(`${todayKarachi}T12:00:00.000Z`);
      const yesterday = new Date(`${yesterdayKarachi}T12:00:00.000Z`);

      // Process TODAY (Karachi Time)
      await AbsenceService.processDailyAbsences(today);
      
      // Also process YESTERDAY (Karachi Time)
      await AbsenceService.processDailyAbsences(yesterday);
      
      // Also cleanup any past pending records
      await AbsenceService.processMissedAbsences();
      
      console.log(`[Cron] 5-minute global sync and cleanup completed`);
    } catch(err) {
      console.error(`[Cron] 5-minute sync failed`, err);
    }
  }, 5 * 60 * 1000);

  // Hourly cron for 3-day MonitoringLog retention policy
  setInterval(async () => {
    try {
      const threeDaysAgo = new Date();
      threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
      
      const { count } = await prisma.monitoringLog.deleteMany({
        where: {
          timestamp: {
            lt: threeDaysAgo
          }
        }
      });
      if (count > 0) {
        console.log(`[Cron] Deleted ${count} old monitoring logs (older than 3 days)`);
      }
    } catch (err) {
      console.error(`[Cron] 3-day retention cleanup failed`, err);
    }
  }, 60 * 60 * 1000); // Run every hour

  // ── Background Workers ──────────────────────────────────────────────────
  // Process outbox events every 10 seconds
  setInterval(async () => {
    await processOutboxEvents();
  }, 10000);

  // Recover stuck outbox events every 5 minutes
  setInterval(async () => {
    await recoverStuckEvents();
  }, 5 * 60 * 1000);

  // ── Daily cron: Auto-transition probation employees to permanent ─────────
  setInterval(async () => {
    try {
      const now = new Date();
      const probationEmployees = await prisma.user.findMany({
        where: {
          type: 'probation',
          joining_date: { not: null },
          probation_duration: { not: null },
        },
      });

      let promoted = 0;
      for (const emp of probationEmployees) {
        const probationEnd = new Date(emp.joining_date!);
        probationEnd.setMonth(probationEnd.getMonth() + emp.probation_duration!);

        if (now >= probationEnd) {
          await prisma.user.update({
            where: { id: emp.id },
            data: { type: 'permanent' },
          });
          promoted++;
        }
      }

      if (promoted > 0) {
        console.log(`[ProbationCron] Promoted ${promoted} employee(s) from probation to permanent`);
      }
    } catch (err) {
      console.error('[ProbationCron] Daily check failed:', err);
    }
  }, 24 * 60 * 60 * 1000); // Run every 24 hours

});
