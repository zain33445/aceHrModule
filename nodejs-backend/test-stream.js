const http = require('http');
const fs = require('fs');

const adminId = 1;
// Replace with the ID from the screenshot: 6ab9edbe-c0c1-4b14-8d4d-773a97184a3c
const url = 'http://localhost:5000/api/recording/sessions/6ab9edbe-c0c1-4b14-8d4d-773a97184a3c/stream?adminId=1';

http.get(url, (res) => {
  console.log('Status:', res.statusCode);
  console.log('Headers:', res.headers);
  
  res.on('data', (chunk) => {
    console.log('Received chunk:', chunk.length, 'bytes');
  });
  
  res.on('end', () => {
    console.log('Stream ended');
  });
}).on('error', (err) => {
  console.error('Error:', err.message);
});
