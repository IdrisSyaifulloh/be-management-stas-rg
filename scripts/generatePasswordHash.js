// Script helper untuk generate bcrypt hash password
// Cara pakai: node scripts/generatePasswordHash.js <password>
// Contoh: node scripts/generatePasswordHash.js 12345678

const bcrypt = require('bcrypt');

const password = process.argv[2] || '12345678';
const saltRounds = 10;

console.log(`\n🔐 Generating bcrypt hash untuk password: "${password}"\n`);

bcrypt.hash(password, saltRounds).then(hash => {
  console.log('✅ Hash bcrypt:');
  console.log('─'.repeat(60));
  console.log(hash);
  console.log('─'.repeat(60));
  console.log('\n📋 Copy hash di atas ke file seed.sql atau database\n');
  console.log('💡 Untuk insert SQL:');
  console.log(`   INSERT INTO users (..., password_hash) VALUES (..., '${hash}');\n`);
}).catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
