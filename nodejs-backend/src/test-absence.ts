import { AbsenceService } from './services/absence.service';

// Example usage of the AbsenceService
async function testAbsenceProcessing() {
  try {
    console.log('Testing absence processing...');

    // Process absences for yesterday
    const result = await AbsenceService.processDailyAbsences();
    console.log('Daily absence processing result:', result);

    // Get absence records for all users
    const allAbsences = await AbsenceService.getAllAbsences();
    console.log('All absence records:', allAbsences);

    // Get absence stats for a specific user (example user ID: '1')
    const userStats = await AbsenceService.getUserAbsenceStats('1');
    console.log('User absence stats:', userStats);

  } catch (error) {
    console.error('Error testing absence processing:', error);
  }
}

// Run the test if this file is executed directly
if (require.main === module) {
  testAbsenceProcessing();
}

export { testAbsenceProcessing };