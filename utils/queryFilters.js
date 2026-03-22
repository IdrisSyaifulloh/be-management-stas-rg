function buildWhereClause(filters) {
  const params = [];
  const predicates = [];

  filters.forEach(({ value, sql }) => {
    if (value === undefined || value === null || value === "") {
      return;
    }

    params.push(value);
    predicates.push(sql(params.length));
  });

  const whereClause = predicates.length > 0 ? `WHERE ${predicates.join(" AND ")}` : "";

  return {
    whereClause,
    params
  };
}

function clampLimit(rawLimit, defaultLimit = 50, maxLimit = 200) {
  const parsed = Number(rawLimit);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultLimit;
  }

  return Math.min(Math.floor(parsed), maxLimit);
}

module.exports = {
  buildWhereClause,
  clampLimit
};
