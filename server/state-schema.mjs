const DEFAULT_PREFERENCES = Object.freeze({
  queueThreshold: 75,
  reviewThreshold: 60,
  primaryDirections: Object.freeze([
    'agent',
    'llm-workflow',
    'machine-learning',
    'data-analysis',
    'ai-product',
    'electronics-ai'
  ]),
  stretchDirections: Object.freeze([
    'llm-training',
    'computer-vision',
    'speech'
  ]),
  stretchEnabled: true,
  graduationYears: Object.freeze(['2028']),
  locations: Object.freeze(['深圳', '远程']),
  minimumMonths: 3,
  availableDaysPerWeek: 4
});

const DEFAULT_UPDATES = Object.freeze({
  lastSuccessAt: null,
  lastAttemptAt: null,
  status: 'idle',
  logs: Object.freeze([])
});

const UPDATE_STATUSES = new Set([
  'idle',
  'running',
  'success',
  'failed',
  'error'
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertRecord(value, field) {
  if (!isRecord(value)) {
    throw new TypeError(`${field} must be an object`);
  }
}

function assertIntegerInRange(value, field, minimum, maximum) {
  if (
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new TypeError(
      `${field} must be an integer between ${minimum} and ${maximum}`
    );
  }
}

function assertStringArray(value, field) {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || item.length === 0)
  ) {
    throw new TypeError(`${field} must be an array of non-empty strings`);
  }
}

function validatePreferences(preferences) {
  assertRecord(preferences, 'preferences');

  assertIntegerInRange(
    preferences.queueThreshold,
    'preferences.queueThreshold',
    0,
    100
  );
  assertIntegerInRange(
    preferences.reviewThreshold,
    'preferences.reviewThreshold',
    0,
    100
  );
  if (preferences.reviewThreshold > preferences.queueThreshold) {
    throw new TypeError(
      'preferences.reviewThreshold must not exceed preferences.queueThreshold'
    );
  }

  assertStringArray(
    preferences.primaryDirections,
    'preferences.primaryDirections'
  );
  assertStringArray(
    preferences.stretchDirections,
    'preferences.stretchDirections'
  );
  assertStringArray(
    preferences.graduationYears,
    'preferences.graduationYears'
  );
  assertStringArray(preferences.locations, 'preferences.locations');

  if (typeof preferences.stretchEnabled !== 'boolean') {
    throw new TypeError('preferences.stretchEnabled must be a boolean');
  }
  assertIntegerInRange(
    preferences.minimumMonths,
    'preferences.minimumMonths',
    0,
    120
  );
  assertIntegerInRange(
    preferences.availableDaysPerWeek,
    'preferences.availableDaysPerWeek',
    0,
    7
  );
}

function validateUpdates(updates) {
  assertRecord(updates, 'updates');

  if (
    typeof updates.status !== 'string' ||
    !UPDATE_STATUSES.has(updates.status)
  ) {
    throw new TypeError(
      `updates.status must be one of: ${[...UPDATE_STATUSES].join(', ')}`
    );
  }
  if (!Array.isArray(updates.logs)) {
    throw new TypeError('updates.logs must be an array');
  }

  for (const field of ['lastSuccessAt', 'lastAttemptAt']) {
    if (updates[field] !== null && typeof updates[field] !== 'string') {
      throw new TypeError(`updates.${field} must be a string or null`);
    }
  }
}

export function defaultState() {
  return {
    version: 3,
    jobs: [],
    preferences: {
      ...DEFAULT_PREFERENCES,
      primaryDirections: [...DEFAULT_PREFERENCES.primaryDirections],
      stretchDirections: [...DEFAULT_PREFERENCES.stretchDirections],
      graduationYears: [...DEFAULT_PREFERENCES.graduationYears],
      locations: [...DEFAULT_PREFERENCES.locations]
    },
    deletedKeys: [],
    importedBatchIds: [],
    updates: {
      ...DEFAULT_UPDATES,
      logs: []
    }
  };
}

export function normalizeState(input = {}) {
  assertRecord(input, 'Application state');

  if ('jobs' in input && !Array.isArray(input.jobs)) {
    throw new TypeError('Application state jobs must be an array');
  }
  if (
    'version' in input &&
    (!Number.isInteger(input.version) || input.version < 1)
  ) {
    throw new TypeError('Application state version must be a positive integer');
  }
  if ('preferences' in input) {
    assertRecord(input.preferences, 'preferences');
  }
  if ('deletedKeys' in input) {
    assertStringArray(input.deletedKeys, 'deletedKeys');
  }
  if ('importedBatchIds' in input) {
    assertStringArray(input.importedBatchIds, 'importedBatchIds');
  }
  if ('updates' in input) {
    assertRecord(input.updates, 'updates');
  }

  const defaults = defaultState();
  const preferences = input.preferences ?? {};
  const updates = input.updates ?? {};
  const mergedPreferences = {
    ...defaults.preferences,
    ...preferences
  };
  const mergedUpdates = {
    ...defaults.updates,
    ...updates
  };

  validatePreferences(mergedPreferences);
  validateUpdates(mergedUpdates);

  const normalized = {
    ...defaults,
    ...input,
    jobs: input.jobs ? [...input.jobs] : defaults.jobs,
    preferences: {
      ...mergedPreferences,
      primaryDirections: [...mergedPreferences.primaryDirections],
      stretchDirections: [...mergedPreferences.stretchDirections],
      graduationYears: [...mergedPreferences.graduationYears],
      locations: [...mergedPreferences.locations]
    },
    deletedKeys: Array.isArray(input.deletedKeys)
      ? [...input.deletedKeys]
      : defaults.deletedKeys,
    importedBatchIds: Array.isArray(input.importedBatchIds)
      ? [...input.importedBatchIds]
      : defaults.importedBatchIds,
    updates: {
      ...mergedUpdates,
      logs: [...mergedUpdates.logs]
    }
  };

  return normalized;
}
