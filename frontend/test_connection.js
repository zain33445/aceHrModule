import http from 'http';

const options = {
  hostname: '192.168.1.19',
  port: 5000,
  path: '/api',
  method: 'GET',
  timeout: 5000
};

console.log('Testing connection to http://192.168.1.19:5000/api...');

const req = http.request(options, (res) => {
  console.log(`STATUS: ${res.statusCode}`);
  res.on('data', (chunk) => {
    console.log(`BODY: ${chunk}`);
  });
  res.on('end', () => {
    console.log('No more data in response.');
    process.exit(0);
  });
});

req.on('error', (e) => {
  console.error(`Problem with request: ${e.message}`);
  process.exit(1);
});

req.on('timeout', () => {
  console.error('Request timed out!');
  req.destroy();
  process.exit(1);
});

req.end();
