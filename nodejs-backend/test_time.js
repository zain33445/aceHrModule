// Test script for time parsing logic in AbsenceService

// Mock timeToMinutes since it's private (we can test it by calling public methods that use it or by making a temp public wrapper)
// For this test, I'll just create a small script that tests the logic I wrote.

function testTimeToMinutes(timeStr) {
    if (!timeStr) return 0;
    const normalized = timeStr.toLowerCase().replace(/\s+/g, '');
    const isPM = normalized.includes('pm');
    const isAM = normalized.includes('am');
    const timeOnly = normalized.replace(/[ap]m/g, '');
    const [hoursStr, minutesStr] = timeOnly.split(':');
    let hours = parseInt(hoursStr, 10);
    const minutes = parseInt(minutesStr, 10) || 0;
    if (isPM && hours < 12) hours += 12;
    if (isAM && hours === 12) hours = 0;
    return hours * 60 + minutes;
}

const testCases = [
    { input: "09:00", expected: 540 },
    { input: "9:00am", expected: 540 },
    { input: "9:15 am", expected: 555 },
    { input: "1:00pm", expected: 780 },
    { input: "13:00", expected: 780 },
    { input: "7:30pm", expected: 1170 },
    { input: "19:30", expected: 1170 },
    { input: "12:00am", expected: 0 },
    { input: "12:00pm", expected: 720 },
    { input: "18:00", expected: 1080 }
];

console.log("--- Testing Time Logic ---");
testCases.forEach(tc => {
    const result = testTimeToMinutes(tc.input);
    const passed = result === tc.expected;
    console.log(`Input: ${tc.input.padEnd(10)} | Expected: ${tc.expected} | Result: ${result} | ${passed ? 'PASSED' : 'FAILED'}`);
});
