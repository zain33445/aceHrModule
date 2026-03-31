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
// Get all departments
router.get('/', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const departments = yield prisma_1.default.department.findMany({
            include: {
                shift: true,
                users: { select: { id: true, name: true, role: true } }
            }
        });
        res.json(departments);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch departments' });
    }
}));
// Create department
router.post('/', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { name, shift_id } = req.body;
    try {
        const department = yield prisma_1.default.department.create({
            data: { name, shift_id: shift_id ? parseInt(shift_id) : undefined }
        });
        res.json(department);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to create department' });
    }
}));
// Update department
router.put('/:id', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { name, shift_id } = req.body;
    try {
        const department = yield prisma_1.default.department.update({
            where: { id: parseInt(req.params.id) },
            data: { name, shift_id: shift_id ? parseInt(shift_id) : undefined }
        });
        res.json(department);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to update department' });
    }
}));
// Delete department
router.delete('/:id', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        yield prisma_1.default.department.delete({ where: { id: parseInt(req.params.id) } });
        res.json({ message: 'Department deleted' });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to delete department' });
    }
}));
exports.default = router;
