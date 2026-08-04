const ALLOWED_TOP_LEVEL_FIELDS = new Set([
  'id',
  'generatedAt',
  'verifiedAt',
  'sources',
  'jobs'
]);

const BATCH_JOB_FIELDS = Object.freeze([
  'id',
  'title',
  'company',
  'location',
  'url',
  'description',
  'source',
  'sourceId',
  'publishedAt',
  'verifiedAt',
  'curationNote',
  'directions',
  'graduationYears',
  'durationMonths',
  'daysPerWeek',
  'active',
  'review'
]);

const STRING_JOB_FIELDS = Object.freeze([
  'id',
  'title',
  'company',
  'location',
  'url',
  'description',
  'source',
  'sourceId',
  'publishedAt',
  'verifiedAt',
  'curationNote'
]);

const ARRAY_JOB_FIELDS = Object.freeze(['directions', 'graduationYears']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertDateOnly(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError(`${field} must use YYYY-MM-DD format`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError(`${field} must be a valid calendar date`);
  }
}

function assertDateTime(value, field) {
  const match = typeof value === 'string'
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value)
    : null;
  if (!match || value.length > 50 || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${field} must be a valid ISO date-time with a timezone`);
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const daysInMonth = month >= 1 && month <= 12
    ? new Date(Date.UTC(year, month, 0)).getUTCDate()
    : 0;
  const invalidOffset = zone !== 'Z'
    && (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59);

  if (
    day < 1
    || day > daysInMonth
    || hour > 23
    || minute > 59
    || second > 59
    || invalidOffset
  ) {
    throw new TypeError(`${field} must be a valid ISO date-time with a timezone`);
  }
}

/**
 * Validate source-controlled job fields and return only fields that an update
 * batch is allowed to provide. User state (status, greeting, notes, view
 * history, manual markers, timestamps, and unknown fields) is intentionally
 * omitted from the returned object.
 */
export function sanitizeBatchJob(input) {
  if (!isRecord(input)) {
    throw new TypeError('batch job must be an object');
  }

  for (const field of STRING_JOB_FIELDS) {
    if (Object.hasOwn(input, field) && typeof input[field] !== 'string') {
      throw new TypeError(`job.${field} must be a string`);
    }
  }
  for (const field of ['title', 'company']) {
    if (typeof input[field] !== 'string' || input[field].trim().length === 0) {
      throw new TypeError(`job.${field} must be a non-empty string`);
    }
  }
  for (const field of ['publishedAt', 'verifiedAt']) {
    if (typeof input[field] === 'string' && input[field].length > 0) {
      assertDateOnly(input[field], `job.${field}`);
    }
  }
  for (const field of ARRAY_JOB_FIELDS) {
    if (
      Object.hasOwn(input, field)
      && (
        !Array.isArray(input[field])
        || input[field].some((item) => typeof item !== 'string')
      )
    ) {
      throw new TypeError(`job.${field} must be an array of strings`);
    }
  }
  for (const [field, maximum] of [['durationMonths', 120], ['daysPerWeek', 7]]) {
    if (
      Object.hasOwn(input, field)
      && (
        typeof input[field] !== 'number'
        || !Number.isFinite(input[field])
        || input[field] < 0
        || input[field] > maximum
      )
    ) {
      throw new TypeError(`job.${field} must be a finite number between 0 and ${maximum}`);
    }
  }
  if (Object.hasOwn(input, 'active') && typeof input.active !== 'boolean') {
    throw new TypeError('job.active must be a boolean');
  }

  return Object.fromEntries(BATCH_JOB_FIELDS
    .filter((field) => Object.hasOwn(input, field))
    .map((field) => [field, structuredClone(input[field])]));
}

/**
 * Validate only the batch envelope. Job entries are intentionally left for
 * importBatch to validate one by one so a single malformed listing does not
 * discard the rest of a fetched update.
 */
export function validateBatch(input) {
  if (!isRecord(input)) {
    throw new TypeError('batch must be an object');
  }

  for (const field of ['id', 'generatedAt', 'sources', 'jobs']) {
    if (!Object.hasOwn(input, field)) {
      throw new TypeError(`batch.${field} is required`);
    }
  }
  for (const field of Object.keys(input)) {
    if (!ALLOWED_TOP_LEVEL_FIELDS.has(field)) {
      throw new TypeError(`unexpected top-level batch field: ${field}`);
    }
  }

  if (
    typeof input.id !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(input.id)
  ) {
    throw new TypeError(
      'batch.id must be 1-200 characters using letters, numbers, dot, underscore, or hyphen'
    );
  }
  assertDateTime(input.generatedAt, 'batch.generatedAt');
  if (Object.hasOwn(input, 'verifiedAt')) {
    assertDateOnly(input.verifiedAt, 'batch.verifiedAt');
  }
  if (
    !Array.isArray(input.sources)
    || input.sources.length === 0
    || input.sources.length > 100
    || input.sources.some((source) => (
      typeof source !== 'string'
      || source.trim().length === 0
      || source.trim().length > 200
    ))
  ) {
    throw new TypeError(
      'batch.sources must be a non-empty array of source labels up to 200 characters'
    );
  }
  const normalizedSources = input.sources.map((source) => source.trim());
  if (new Set(normalizedSources).size !== normalizedSources.length) {
    throw new TypeError('batch.sources must not contain duplicate labels');
  }
  if (!Array.isArray(input.jobs)) {
    throw new TypeError('batch.jobs must be an array');
  }
  if (input.jobs.length > 10_000) {
    throw new TypeError('batch.jobs must contain at most 10000 entries');
  }

  return {
    id: input.id,
    generatedAt: input.generatedAt,
    ...(Object.hasOwn(input, 'verifiedAt') ? { verifiedAt: input.verifiedAt } : {}),
    sources: normalizedSources,
    jobs: input.jobs.map((job) => {
      try {
        return structuredClone(job);
      } catch {
        return null;
      }
    })
  };
}
