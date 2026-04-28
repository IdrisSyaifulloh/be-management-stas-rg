const http = require("http");
const app = require("../app");
const { pool } = require("../db/pool");

let server;
let baseUrl;

function assert(condition, message, details) {
  if (!condition) {
    const suffix = details ? ` | ${JSON.stringify(details)}` : "";
    throw new Error(`${message}${suffix}`);
  }
}

async function request(method, path, body, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...headers
    },
    body: body == null ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: response.status, body: json };
}

(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;

  const operatorHeaders = {
    "x-user-role": "operator",
    "x-user-id": "SECURITY-SMOKE-OPERATOR"
  };

  const loginInjection = await request("POST", "/auth/login", {
    identifier: "' OR '1'='1",
    password: "' OR '1'='1"
  });
  assert([400, 401].includes(loginInjection.status), "Login injection must not authenticate", loginInjection);
  assert(!loginInjection.body?.user, "Login injection must not return a user", loginInjection);

  const fullStudents = await request("GET", "/students?limit=20", null, operatorHeaders);
  assert(fullStudents.status === 200, "Baseline students query should succeed", fullStudents);

  const searchInjection = await request("GET", "/students?search=' OR 1=1 --&limit=20", null, operatorHeaders);
  assert(searchInjection.status === 200, "Student search injection should be treated as search text", searchInjection);
  assert(
    Array.isArray(searchInjection.body) && searchInjection.body.length < fullStudents.body.length,
    "Student search injection must not return all rows",
    { injectedRows: searchInjection.body?.length, baselineRows: fullStudents.body?.length }
  );

  const idInjection = await request("GET", "/students/abc' OR '1'='1", null, operatorHeaders);
  assert(idInjection.status === 400, "Injected ID must be rejected", idInjection);

  const sortInjection = await request("GET", "/students?sortBy=name; DROP TABLE students", null, operatorHeaders);
  assert(sortInjection.status === 400, "Injected sort field must be rejected", sortInjection);

  console.log(JSON.stringify({
    ok: true,
    checks: [
      "Login SQL injection payload failed",
      "Student search injection did not return all rows",
      "Injected ID was rejected",
      "Injected sort field was rejected"
    ]
  }, null, 2));
})().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
}).finally(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
  process.exit(process.exitCode || 0);
});
