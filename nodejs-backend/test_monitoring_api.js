/**
 * test_monitoring_api.js
 * 
 * Automated test for the Monitoring -> Attendance backend sync.
 * Run this with: node test_monitoring_api.js
 */

const http = require('http');

const MOCK_USER_ID = '15'; // Rizwan
const API_URL = 'http://localhost:5000/api/monitoring/screenshot';

async function sendEvent(type, appName) {
    console.log(`Sending ${type} event for ${appName}...`);
    
    const payload = JSON.stringify({
        userId: MOCK_USER_ID,
        appName: appName,
        timestamp: new Date().toISOString(),
        type: type,
        screenshotBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' // 1x1 white pixel
    });

    return new Promise((resolve, reject) => {
        const req = http.request(API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                console.log(`Response (${res.statusCode}):`, data);
                resolve(JSON.parse(data));
            });
        });

        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

async function runTest() {
    console.log('--- STARTING MONITORING API TEST ---');
    
    try {
        // 1. Simulate Check-in
        await sendEvent('check-in', 'TestApp_Chrome');
        
        console.log('Waiting 2 seconds...');
        await new Promise(r => setTimeout(r, 2000));

        // 2. Simulate Hourly Screenshot
        await sendEvent('hourly', 'TestApp_Chrome');

        console.log('Waiting 2 seconds...');
        await new Promise(r => setTimeout(r, 2000));

        // 3. Simulate Check-out
        await sendEvent('check-out', 'TestApp_Chrome');

        console.log('\n--- TEST COMPLETED ---');
        console.log('Verify the results in Prisma Studio or monitoring.log at the backend.');
        console.log('Check-in and Check-out times should be visible in the AttendanceRecord for user 15.');

    } catch (err) {
        console.error('Test failed:', err.message);
    }
}

runTest();
