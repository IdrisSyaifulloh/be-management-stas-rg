const { Client } = require('pg');
const client = new Client({ host: 'localhost', port: 6789, user: 'postgres', password: 'postgres', database: 'postgres' });
client.connect()
  .then(() => {
    console.log('connected');
    return client.end();
  })
  .catch((e) => {
    console.error('connect failed', e.message);
    return client.end().catch(()=>{});
  });
