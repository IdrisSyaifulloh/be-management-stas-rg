const env = require("../config/env");

function getAuthCookieOptions() {
  const options = {
    httpOnly: true,
    secure: env.nodeEnv === "production",
    sameSite: env.cookieSameSite,
    path: "/"
  };

  if (env.cookieDomain) {
    options.domain = env.cookieDomain;
  }

  return options;
}

module.exports = {
  getAuthCookieOptions
};
