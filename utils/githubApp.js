const crypto = require("crypto");

function config() {
  return {
    appId: String(process.env.GITHUB_APP_ID || "").trim(),
    privateKey: String(process.env.GITHUB_APP_PRIVATE_KEY || "").replace(/\\n/g, "\n").trim(),
    webhookSecret: String(process.env.GITHUB_WEBHOOK_SECRET || "").trim()
  };
}
function isGitHubConfigured() { const c = config(); return Boolean(c.appId && c.privateKey && c.webhookSecret); }
function createGitHubAppJwt() {
  const c = config();
  if (!c.appId || !c.privateKey) return null;
  const now = Math.floor(Date.now() / 1000);
  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const header = b64({ alg: "RS256", typ: "JWT" });
  const payload = b64({ iat: now - 30, exp: now + 540, iss: c.appId });
  const input = `${header}.${payload}`;
  const signature = crypto.createSign("RSA-SHA256").update(input).sign(c.privateKey, "base64url");
  return `${input}.${signature}`;
}
async function githubApiRequest(path, options = {}) {
  const token = options.token || createGitHubAppJwt();
  if (!token) throw Object.assign(new Error("GitHub belum dikonfigurasi."), { statusCode: 503, code: "SCRUM_GITHUB_NOT_CONFIGURED" });
  const response = await fetch(`https://api.github.com${path}`, { ...options, token: undefined, headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.message || "GitHub API error."), { statusCode: response.status });
  return body;
}
async function createInstallationAccessToken(installationId) {
  if (!/^\d+$/.test(String(installationId || ""))) throw Object.assign(new Error("githubInstallationId tidak valid."), { statusCode: 400 });
  const jwt = createGitHubAppJwt();
  if (!jwt) throw Object.assign(new Error("GitHub belum dikonfigurasi."), { statusCode: 503, code: "SCRUM_GITHUB_NOT_CONFIGURED" });
  return githubApiRequest(`/app/installations/${installationId}/access_tokens`, { method: "POST", token: jwt });
}
module.exports = { isGitHubConfigured, createGitHubAppJwt, createInstallationAccessToken, githubApiRequest };
