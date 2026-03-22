const env = require("./env");

function validateEnv() {
  const errors = [];

  if (!Number.isInteger(env.port) || env.port <= 0 || env.port > 65535) {
    errors.push("PORT harus angka valid pada rentang 1-65535.");
  }

  if (!Number.isInteger(env.dbPort) || env.dbPort <= 0 || env.dbPort > 65535) {
    errors.push("DB_PORT harus angka valid pada rentang 1-65535.");
  }

  if (!env.databaseUrl) {
    const requiredFields = [
      ["DB_HOST", env.dbHost],
      ["DB_NAME", env.dbName],
      ["DB_USER", env.dbUser]
    ];

    requiredFields.forEach(([key, value]) => {
      if (!value || String(value).trim() === "") {
        errors.push(`${key} wajib diisi jika DATABASE_URL tidak digunakan.`);
      }
    });
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

module.exports = validateEnv;
