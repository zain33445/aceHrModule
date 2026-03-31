/**
 * test_upload.js (Frontend Simulator)
 * 
 * Simulate detection events directly from the frontend directory.
 * Run with: node test_upload.js
 */

import http from 'http';

// Configuration
const CONFIG = {
    userId: '15', // Rizwan
    apiUrl: 'http://localhost:5000/api/monitoring/screenshot',
    apps: ['chrome', 'Zoom', 'PlanSwift']
};

async function triggerEvent(type, appName) {
    const timestamp = new Date().toISOString();
    console.log(`[SIMULATOR] Triggering ${type} for ${appName} at ${timestamp}...`);

    const payload = JSON.stringify({
        userId: CONFIG.userId,
        appName: appName,
        timestamp: timestamp,
        type: type,
        screenshotBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    });

    return new Promise((resolve) => {
        const req = http.request(CONFIG.apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                console.log(`   Result: ${res.statusCode} ${data}`);
                resolve();
            });
        });

        req.on('error', (e) => {
            console.error(`   Error: ${e.message}`);
            resolve();
        });

        req.write(payload);
        req.end();
    });
}

async function startSimulation() {
    console.log('=== STARTING DESKTOP MONITORING SIMULATION ===');
    
    // Simulate App 1 starts
    await triggerEvent('check-in', CONFIG.apps[0]);
    
    console.log('--- Simulation running... (waiting 3s)');
    await new Promise(r => setTimeout(r, 3000));
    
    // Simulate App 2 starts
    await triggerEvent('check-in', CONFIG.apps[1]);
    
    console.log('--- Simulation running... (waiting 3s)');
    await new Promise(r => setTimeout(r, 3000));
    
    // Simulate App 1 closes
    await triggerEvent('check-out', CONFIG.apps[0]);
    
    console.log('--- Simulation running... (waiting 3s)');
    await new Promise(r => setTimeout(r, 3000));
    
    // Simulate App 2 closes
    await triggerEvent('check-out', CONFIG.apps[1]);

    console.log('\n=== SIMULATION COMPLETE ===');
    console.log('Check your backend database to see the attendance marks for user 15.');
}

startSimulation();
