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
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const absence_service_1 = require("../services/absence.service");
const router = (0, express_1.Router)();
// Get all attendance records
router.get('/', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const { startDate, endDate } = req.query;
        const start = startDate ? new Date(startDate) : undefined;
        const end = endDate ? new Date(endDate) : undefined;
        const records = yield absence_service_1.AbsenceService.getAllAttendances(start, end);
        res.json(records);
    }
    catch (error) {
        res.status(500).json({ error: "Failed to fetch attendance records" });
    }
}));
// Get attendance records for a specific user
router.get('/user/:userId', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { userId } = req.params;
    const { startDate, endDate } = req.query;
    try {
        const start = startDate ? new Date(startDate) : undefined;
        const end = endDate ? new Date(endDate) : undefined;
        const records = yield absence_service_1.AbsenceService.getUserAttendances(userId, start, end);
        res.json(records);
    }
    catch (error) {
        res.status(500).json({ error: "Failed to fetch user attendance records" });
    }
}));
// Get attendance statistics for a user
router.get('/user/:userId/stats', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { userId } = req.params;
    const { startDate, endDate } = req.query;
    try {
        const start = startDate ? new Date(startDate) : undefined;
        const end = endDate ? new Date(endDate) : undefined;
        const stats = yield absence_service_1.AbsenceService.getUserAttendanceStats(userId, start, end);
        res.json(stats);
    }
    catch (error) {
        res.status(500).json({ error: "Failed to fetch attendance statistics" });
    }
}));
// Process attendance for yesterday (daily cron job endpoint)
router.post('/process-daily', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const result = yield absence_service_1.AbsenceService.processDailyAbsences();
        res.json(result);
    }
    catch (error) {
        res.status(500).json({ error: "Failed to process daily attendance" });
    }
}));
// Manually process attendance for a specific date (admin function)
router.post('/process/:date', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const date = req.params.date;
    try {
        const checkDate = date ? new Date(date) : undefined;
        const result = yield absence_service_1.AbsenceService.processDailyAbsences(checkDate);
        res.json(result);
    }
    catch (error) {
        res.status(500).json({ error: "Failed to process attendance" });
    }
}));
// LEAVE BANK MANAGEMENT ROUTES
// Get all leave bank records
router.get('/leave-bank', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const leaveBanks = yield absence_service_1.AbsenceService.getAllLeaveBanks();
        res.json(leaveBanks);
    }
    catch (error) {
        res.status(500).json({ error: "Failed to fetch leave bank records" });
    }
}));
// Get leave bank record for a specific user
router.get('/leave-bank/user/:userId', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { userId } = req.params;
    try {
        const leaveBank = yield absence_service_1.AbsenceService.getUserLeaveBank(userId);
        res.json(leaveBank);
    }
    catch (error) {
        res.status(500).json({ error: "Failed to fetch user leave bank" });
    }
}));
// Update leave bank for a user (admin function)
router.put('/leave-bank/user/:userId', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { userId } = req.params;
    const { leaves_remaining } = req.body;
    try {
        const leaveBank = yield absence_service_1.AbsenceService.updateLeaveBank(userId, parseInt(leaves_remaining));
        res.json({ message: "Leave bank updated", leaveBank });
    }
    catch (error) {
        res.status(500).json({ error: "Failed to update leave bank" });
    }
}));
// Reset leave bank to user's total allowed leaves
router.post('/leave-bank/user/:userId/reset', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { userId } = req.params;
    try {
        const leaveBank = yield absence_service_1.AbsenceService.resetLeaveBank(userId);
        res.json({ message: "Leave bank reset to total allowed leaves", leaveBank });
    }
    catch (error) {
        res.status(500).json({ error: "Failed to reset leave bank" });
    }
}));
exports.default = router;
