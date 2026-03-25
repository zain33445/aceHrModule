const { Client } = require('pg');

async function testConnection() {
  const client = new Client({
    connectionString: "postgresql://postgres:postgres@127.0.0.1:5432/postgres"
  });

  try {
    console.log('Connecting to postgres database...');
    await client.connect();
    console.log('Connected successfully!');
    
    const res = await client.query('SELECT datname FROM pg_database');
    console.log('Available databases:');
    res.rows.forEach(row => console.log(` - ${row.datname}`));
    
    await client.end();
  } catch (err) {
    console.error('Connection failed:');
    console.error(err.message);
    console.error(err.stack);
  }
}

testConnection();
