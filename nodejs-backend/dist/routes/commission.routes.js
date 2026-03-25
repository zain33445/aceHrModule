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
// Get all commissions
router.get('/', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const commissions = yield prisma_1.default.commission.findMany({
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
        res.json(commissions);
    }
    catch (error) {
        res.status(500).json({ error: "Failed to fetch commissions" });
    }
}));
// Get commissions for a specific user
router.get('/user/:userId', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { userId } = req.params;
    try {
        const commissions = yield prisma_1.default.commission.findMany({
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
        res.json(commissions);
    }
    catch (error) {
        res.status(500).json({ error: "Failed to fetch user commissions" });
    }
}));
// Create a commission record
router.post('/', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { user_id, commission, date } = req.body;
    try {
        const commissionRecord = yield prisma_1.default.commission.create({
            data: {
                user_id,
                commission: parseFloat(commission),
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
        res.json({ message: "Commission record created", commission: commissionRecord });
    }
    catch (error) {
        res.status(500).json({ error: "Failed to create commission record" });
    }
}));
// Update a commission record
router.put('/:id', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { id } = req.params;
    const { commission, date } = req.body;
    try {
        const commissionRecord = yield prisma_1.default.commission.update({
            where: { id: parseInt(id) },
            data: {
                commission: commission ? parseFloat(commission) : undefined,
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
        res.json({ message: "Commission record updated", commission: commissionRecord });
    }
    catch (error) {
        res.status(500).json({ error: "Failed to update commission record" });
    }
}));
// Delete a commission record
router.delete('/:id', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { id } = req.params;
    try {
        yield prisma_1.default.commission.delete({
            where: { id: parseInt(id) }
        });
        res.json({ message: "Commission record deleted" });
    }
    catch (error) {
        res.status(500).json({ error: "Failed to delete commission record" });
    }
}));
exports.default = router;
