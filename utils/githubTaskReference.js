function extractTaskKeys(text) {
  const matches = String(text || "").match(/TASK-(\d+)(?![A-Za-z0-9])/gi) || [];
  return [...new Set(matches.map((value) => value.toUpperCase()))];
}

module.exports = { extractTaskKeys };
