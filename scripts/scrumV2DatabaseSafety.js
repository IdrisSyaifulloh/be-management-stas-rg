const SAFE_DATABASE_MARKERS = ["test", "testing", "uat", "staging", "stage", "disposable", "scrum_v2"];
const PRODUCTION_MARKERS = ["production", "prod", "live"];

function databaseIdentity(databaseUrl) {
  if (databaseUrl) {
    const parsed = new URL(databaseUrl);
    if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
      throw new Error("Database URL must use PostgreSQL.");
    }
    return {
      host: String(parsed.hostname || "").toLowerCase(),
      database: String(parsed.pathname || "").replace(/^\//, "").toLowerCase()
    };
  }
  return {
    host: String(process.env.DB_HOST || "localhost").toLowerCase(),
    database: String(process.env.DB_NAME || "").toLowerCase()
  };
}

function assertStagingEquivalentTarget(databaseUrl, { allowLocal = true } = {}) {
  if (String(process.env.NODE_ENV || "").toLowerCase() === "production") {
    throw new Error("Refusing database operation while NODE_ENV=production.");
  }
  const identity = databaseIdentity(databaseUrl);
  const combined = `${identity.host}/${identity.database}`;
  if (PRODUCTION_MARKERS.some((marker) => combined.includes(marker))) {
    throw new Error("Refusing an obviously production-looking database target.");
  }
  const isLocal = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(identity.host);
  const hasSafeMarker = SAFE_DATABASE_MARKERS.some((marker) => combined.includes(marker));
  if (!(hasSafeMarker || (allowLocal && isLocal && SAFE_DATABASE_MARKERS.some((marker) => identity.database.includes(marker))))) {
    throw new Error("Database target is ambiguous; use a database name or host containing test, uat, staging, disposable, or scrum_v2.");
  }
  return identity;
}

module.exports = { assertStagingEquivalentTarget, databaseIdentity };
