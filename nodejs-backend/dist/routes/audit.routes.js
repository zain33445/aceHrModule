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
// Get audit logs
router.get('/', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { limit = 100, page = 1 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);
    try {
        const logs = yield prisma_1.default.auditLog.findMany({
            take: Number(limit),
            skip,
            include: {
                user: { select: { id: true, name: true, role: true } }
            },
            orderBy: { created_at: 'desc' }
        });
        const total = yield prisma_1.default.auditLog.count();
        res.json({
            logs,
            pagination: {
                total,
                page: Number(page),
                limit: Number(limit),
                totalPages: Math.ceil(total / Number(limit))
            }
        });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch audit logs' });
    }
}));
exports.default = router;
