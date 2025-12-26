const DEFAULT_TIMEZONE = process.env.REPORTS_TIMEZONE || "America/Los_Angeles";

function normalizeBucket(value) {
  const bucket = String(value || "day").toLowerCase();
  if (bucket === "hour" || bucket === "day" || bucket === "week") {
    return bucket;
  }
  return "day";
}

function normalizeTimezone(value) {
  const tz = String(value || DEFAULT_TIMEZONE).trim();
  if (!tz || !/^[A-Za-z/_]+$/.test(tz)) {
    return DEFAULT_TIMEZONE;
  }
  return tz;
}

function columnRef(column) {
  if (column.includes(".")) return column;
  return `"${column}"`;
}

function bucketExpression(column, bucket, timezone) {
  const safeBucket = normalizeBucket(bucket);
  const safeTz = normalizeTimezone(timezone);
  const col = columnRef(column);
  const local = `DATE_TRUNC('${safeBucket}', TIMEZONE('${safeTz}', ${col}))`;
  return `(${local} AT TIME ZONE '${safeTz}')`;
}

function bucketLabelExpression(column, bucket, timezone) {
  const safeBucket = normalizeBucket(bucket);
  const safeTz = normalizeTimezone(timezone);
  const col = columnRef(column);
  const local = `DATE_TRUNC('${safeBucket}', TIMEZONE('${safeTz}', ${col}))`;
  if (safeBucket === "hour") {
    return `TO_CHAR(${local}, 'YYYY-MM-DD\"T\"HH24:00:00')`;
  }
  if (safeBucket === "week") {
    return `TO_CHAR(${local}, 'IYYY-IW')`;
  }
  return `TO_CHAR(${local}, 'YYYY-MM-DD')`;
}

module.exports = {
  DEFAULT_TIMEZONE,
  normalizeBucket,
  normalizeTimezone,
  bucketExpression,
  bucketLabelExpression,
};
