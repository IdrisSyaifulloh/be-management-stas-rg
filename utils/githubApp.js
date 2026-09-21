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
  let response;
  try {
    response = await fetch(`https://api.github.com${path}`, {
      ...options,
      token: undefined,
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "STAS-RG-Scrum-App",
        Authorization: `Bearer ${token}`,
        ...(options.headers || {})
      }
    });
  } catch (netErr) {
    throw Object.assign(new Error("GitHub API tidak dapat memvalidasi repository saat ini. Silakan coba kembali."), {
      statusCode: 502,
      code: "SCRUM_GITHUB_API_UNAVAILABLE"
    });
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.message || "GitHub API error."), { statusCode: response.status, body });
  return body;
}
async function createInstallationAccessToken(installationId) {
  if (!/^\d+$/.test(String(installationId || ""))) throw Object.assign(new Error("githubInstallationId tidak valid."), { statusCode: 400 });
  const jwt = createGitHubAppJwt();
  if (!jwt) throw Object.assign(new Error("GitHub belum dikonfigurasi."), { statusCode: 503, code: "SCRUM_GITHUB_NOT_CONFIGURED" });
  return githubApiRequest(`/app/installations/${installationId}/access_tokens`, { method: "POST", token: jwt });
}

async function validateGitHubRepository({ owner, repo, githubInstallationId } = {}) {
  if (!isGitHubConfigured()) {
    throw Object.assign(new Error("GitHub belum dikonfigurasi."), { statusCode: 503, code: "SCRUM_GITHUB_NOT_CONFIGURED" });
  }

  let installation;
  try {
    installation = await githubApiRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`);
  } catch (error) {
    if (error.code === "SCRUM_GITHUB_NOT_CONFIGURED") throw error;
    if (error.statusCode === 404 || error.statusCode === 403 || error.statusCode === 401) {
      throw Object.assign(
        new Error("Repository tidak ditemukan atau GitHub App STAS-RG Scrum belum memiliki akses ke repository tersebut."),
        { statusCode: 404, code: "SCRUM_GITHUB_REPOSITORY_NOT_ACCESSIBLE" }
      );
    }
    throw Object.assign(
      new Error("GitHub API tidak dapat memvalidasi repository saat ini. Silakan coba kembali."),
      { statusCode: 502, code: "SCRUM_GITHUB_API_UNAVAILABLE" }
    );
  }

  if (!installation || !installation.id) {
    throw Object.assign(
      new Error("Repository tidak ditemukan atau GitHub App STAS-RG Scrum belum memiliki akses ke repository tersebut."),
      { statusCode: 404, code: "SCRUM_GITHUB_REPOSITORY_NOT_ACCESSIBLE" }
    );
  }

  const expectedInstallationId = String(installation.id);
  if (githubInstallationId !== undefined && githubInstallationId !== null && String(githubInstallationId).trim() !== "") {
    if (String(githubInstallationId).trim() !== expectedInstallationId) {
      throw Object.assign(
        new Error("Installation ID tidak sesuai dengan GitHub App installation repository ini."),
        { statusCode: 409, code: "SCRUM_GITHUB_INSTALLATION_MISMATCH" }
      );
    }
  }

  let tokenData;
  try {
    tokenData = await createInstallationAccessToken(expectedInstallationId);
  } catch (error) {
    if (error.code === "SCRUM_GITHUB_NOT_CONFIGURED") throw error;
    throw Object.assign(
      new Error("GitHub API tidak dapat memvalidasi repository saat ini. Silakan coba kembali."),
      { statusCode: 502, code: "SCRUM_GITHUB_API_UNAVAILABLE" }
    );
  }

  if (!tokenData?.token) {
    throw Object.assign(
      new Error("GitHub API tidak dapat memvalidasi repository saat ini. Silakan coba kembali."),
      { statusCode: 502, code: "SCRUM_GITHUB_API_UNAVAILABLE" }
    );
  }

  let repoData;
  try {
    repoData = await githubApiRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
      token: tokenData.token
    });
  } catch (error) {
    if (error.statusCode === 404 || error.statusCode === 403 || error.statusCode === 401) {
      throw Object.assign(
        new Error("Repository tidak ditemukan atau GitHub App STAS-RG Scrum belum memiliki akses ke repository tersebut."),
        { statusCode: 404, code: "SCRUM_GITHUB_REPOSITORY_NOT_ACCESSIBLE" }
      );
    }
    throw Object.assign(
      new Error("GitHub API tidak dapat memvalidasi repository saat ini. Silakan coba kembali."),
      { statusCode: 502, code: "SCRUM_GITHUB_API_UNAVAILABLE" }
    );
  }

  if (!repoData || !repoData.id) {
    throw Object.assign(
      new Error("Repository tidak ditemukan atau GitHub App STAS-RG Scrum belum memiliki akses ke repository tersebut."),
      { statusCode: 404, code: "SCRUM_GITHUB_REPOSITORY_NOT_ACCESSIBLE" }
    );
  }

  return {
    owner: repoData.owner?.login || owner,
    repo: repoData.name || repo,
    fullName: repoData.full_name || `${owner}/${repo}`,
    githubRepositoryId: String(repoData.id),
    githubInstallationId: expectedInstallationId,
    defaultBranch: repoData.default_branch || "main",
    isPrivate: Boolean(repoData.private),
    htmlUrl: repoData.html_url || `https://github.com/${owner}/${repo}`
  };
}

module.exports = { isGitHubConfigured, createGitHubAppJwt, createInstallationAccessToken, githubApiRequest, validateGitHubRepository };
