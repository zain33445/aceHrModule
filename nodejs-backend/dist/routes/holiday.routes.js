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
// Get all holidays
router.get('/', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const holidays = yield prisma_1.default.holiday.findMany({
            orderBy: { date: 'asc' }
        });
        res.json(holidays);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch holidays' });
    }
}));
// Create holiday
router.post('/', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { name, date } = req.body;
    try {
        const holiday = yield prisma_1.default.holiday.create({
            data: { name, date: new Date(date) }
        });
        res.json(holiday);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to create holiday' });
    }
}));
// Delete holiday
router.delete('/:id', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        yield prisma_1.default.holiday.delete({ where: { id: parseInt(req.params.id) } });
        res.json({ message: 'Holiday deleted' });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to delete holiday' });
    }
}));
exports.default = router;
