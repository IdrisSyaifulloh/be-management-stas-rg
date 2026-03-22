const validateEnv = require("../config/validateEnv");

const result = validateEnv();

if (!result.isValid) {
  console.error("Konfigurasi environment tidak valid:");
  result.errors.forEach((error) => {
    console.error(`- ${error}`);
  });
  process.exit(1);
}

console.log("Konfigurasi environment valid.");
