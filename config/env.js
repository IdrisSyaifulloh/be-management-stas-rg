const path = require("path");
const dotenv = require("dotenv");

const envRoot = path.join(__dirname, "..");
const runtimeEnv = process.env.NODE_ENV || "development";

// 1) Load base .env (local/shared defaults)
dotenv.config({ path: path.join(envRoot, ".env") });

// 2) In production, allow dedicated override from .env.production
if (runtimeEnv === "production") {
  dotenv.config({ path: path.join(envRoot, ".env.production"), override: true });
}

const env = {
  nodeEnv: runtimeEnv,
  port: Number(process.env.PORT || 3000),
  corsOrigin: process.env.CORS_ORIGIN || "http://localhost:5173",
  databaseUrl: process.env.DATABASE_URL || null,
  dbHost: process.env.DB_HOST || "localhost",
  dbPort: Number(process.env.DB_PORT || 5432),
  dbName: process.env.DB_NAME || "stasrg",
  dbUser: process.env.DB_USER || "postgres",
  dbPassword: process.env.DB_PASSWORD || "postgres",
  jwtSecret: process.env.JWT_SECRET || null
};

module.exports = env;
