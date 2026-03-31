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
// Basic login logic compatible with the old Python API
router.post('/login', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { password } = req.body;
    try {
        const user = yield prisma_1.default.user.findFirst({
            where: { password_hash: password }
        });
        if (!user) {
            return res.status(401).json({ detail: "Invalid password" });
        }
        res.json({
            user_id: user.id,
            name: user.name,
            role: user.role
        });
    }
    catch (error) {
        res.status(500).json({ msg: "Internal server error", error });
    }
}));
// Update password
router.post('/update-password', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { user_id, new_password } = req.body;
    try {
        yield prisma_1.default.user.update({
            where: { id: String(user_id) },
            data: { password_hash: new_password }
        });
        res.json({ message: "Password updated successfully" });
    }
    catch (error) {
        res.status(500).json({ error: "Failed to update password" });
    }
}));
// Change password (secure, requires current password verification)
router.post('/change-password', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    const { user_id, current_password, new_password } = req.body;
    try {
        const user = yield prisma_1.default.user.findFirst({
            where: { id: String(user_id), password_hash: current_password }
        });
        if (!user) {
            return res.status(401).json({ detail: "Incorrect current password" });
        }
        yield prisma_1.default.user.update({
            where: { id: String(user_id) },
            data: { password_hash: new_password }
        });
        res.json({ message: "Password changed successfully" });
    }
    catch (error) {
        res.status(500).json({ detail: "Failed to update password" });
    }
}));
exports.default = router;
