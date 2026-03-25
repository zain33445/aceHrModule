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
const express_1 = require("express");
const prisma_1 = __importDefault(require("../prisma"));
const router = (0, express_1.Router)();
// Get all employees
router.get('/', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const users = yield prisma_1.default.user.findMany();
        res.json(users);
    }
    catch (error) {
        res.status(500).json({ error: "Failed to fetch employees" });
    }
}));
// Create an employee
router.post('/', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { user_id, name, monthly_salary, leave_bank, password } = req.body;
    try {
        const user = yield prisma_1.default.user.create({
            data: {
                id: String(user_id),
                name,
                monthly_salary: monthly_salary || 0.0,
                leave_bank: leave_bank || 5,
                password_hash: password || '1234',
                role: 'employee'
            }
        });
        // Create leave bank record with the same number of leaves as allowed
        yield prisma_1.default.leaveBank.create({
            data: {
                user_id: String(user_id),
                leaves_remaining: leave_bank || 5
            }
        });
        res.json({ message: "Employee created manually", user });
    }
    catch (error) {
        res.status(500).json({ error: "Failed to create employee" });
    }
}));
// Delete an employee
router.delete('/:id', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        yield prisma_1.default.user.delete({
            where: { id: String(req.params.id) }
        });
        res.json({ message: "Employee deleted successfully" });
    }
    catch (error) {
        res.status(500).json({ error: "Failed to delete employee" });
    }
}));
// Update employee salary
router.post('/update-employee', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { user_id, monthly_salary } = req.body;
    try {
        yield prisma_1.default.user.update({
            where: { id: String(user_id) },
            data: { monthly_salary: parseFloat(monthly_salary) }
        });
        res.json({ message: "Employee salary updated" });
    }
    catch (error) {
        res.status(500).json({ error: "Failed to update employee salary" });
    }
}));
// Update employee leaves
router.post('/update-leaves', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { user_id, leave_bank } = req.body;
    try {
        yield prisma_1.default.user.update({
            where: { id: String(user_id) },
            data: { leave_bank: parseInt(leave_bank) }
        });
        res.json({ message: "Leave bank updated" });
    }
    catch (error) {
        res.status(500).json({ error: "Failed to update leave bank" });
    }
}));
exports.default = router;
