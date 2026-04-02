const bcrypt = require('bcrypt');

const plainPassword = process.argv[2];

if (!plainPassword) {
  console.error('Usage: node hashPassword.js <password>');
  process.exit(1);
}

bcrypt.hash(plainPassword, 10).then(hash => {
  console.log('Hashed password:', hash);
  console.log('\nCopy this hash to your seed.sql or database!');
});
