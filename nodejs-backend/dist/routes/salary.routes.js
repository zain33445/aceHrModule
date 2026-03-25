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
// Get all salaries
router.get('/', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const salaries = yield prisma_1.default.salary.findMany({
            include: {
                user: {
                    select: {
                        id: true,
                        name: true
                    }
                }
            },
            orderBy: {
                date: 'desc'
            }
        });
        res.json(salaries);
    }
    catch (error) {
        res.status(500).json({ error: "Failed to fetch salaries" });
    }
}));
// Get salaries for a specific user
router.get('/user/:userId', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { userId } = req.params;
    try {
        const salaries = yield prisma_1.default.salary.findMany({
            where: { user_id: userId },
            include: {
                user: {
                    select: {
                        id: true,
                        name: true
                    }
                }
            },
            orderBy: {
                date: 'desc'
            }
        });
        res.json(salaries);
    }
    catch (error) {
        res.status(500).json({ error: "Failed to fetch user salaries" });
    }
}));
// Create a salary record
router.post('/', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { user_id, paid_salary, date } = req.body;
    try {
        const salary = yield prisma_1.default.salary.create({
            data: {
                user_id,
                paid_salary: parseFloat(paid_salary),
                date: new Date(date)
            },
            include: {
                user: {
                    select: {
                        id: true,
                        name: true
                    }
                }
            }
        });
        res.json({ message: "Salary record created", salary });
    }
    catch (error) {
        res.status(500).json({ error: "Failed to create salary record" });
    }
}));
// Update a salary record
router.put('/:id', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { id } = req.params;
    const { paid_salary, date } = req.body;
    try {
        const salary = yield prisma_1.default.salary.update({
            where: { id: parseInt(id) },
            data: {
                paid_salary: paid_salary ? parseFloat(paid_salary) : undefined,
                date: date ? new Date(date) : undefined
            },
            include: {
                user: {
                    select: {
                        id: true,
                        name: true
                    }
                }
            }
        });
        res.json({ message: "Salary record updated", salary });
    }
    catch (error) {
        res.status(500).json({ error: "Failed to update salary record" });
    }
}));
// Delete a salary record
router.delete('/:id', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { id } = req.params;
    try {
        yield prisma_1.default.salary.delete({
            where: { id: parseInt(id) }
        });
        res.json({ message: "Salary record deleted" });
    }
    catch (error) {
        res.status(500).json({ error: "Failed to delete salary record" });
    }
}));
exports.default = router;
