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
exports.testAbsenceProcessing = testAbsenceProcessing;
const absence_service_1 = require("./services/absence.service");
// Example usage of the AbsenceService
function testAbsenceProcessing() {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            console.log('Testing absence processing...');
            // Process absences for yesterday
            const result = yield absence_service_1.AbsenceService.processDailyAbsences();
            console.log('Daily absence processing result:', result);
            // Get absence records for all users
            const allAbsences = yield absence_service_1.AbsenceService.getAllAbsences();
            console.log('All absence records:', allAbsences);
            // Get absence stats for a specific user (example user ID: '1')
            const userStats = yield absence_service_1.AbsenceService.getUserAbsenceStats('1');
            console.log('User absence stats:', userStats);
        }
        catch (error) {
            console.error('Error testing absence processing:', error);
        }
    });
}
// Run the test if this file is executed directly
if (require.main === module) {
    testAbsenceProcessing();
}
