export const LEGACY_STORAGE_KEY = 'applicationDesk.v2';
export const LEGACY_MIGRATED_KEY = 'applicationDesk.v2.migrated';

const VALID_STATUSES = Object.freeze([
  'todo',
  'contacted',
  'replied',
  'skipped'
]);
const migrationsInFlight = new WeakMap();

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function readLegacyState(storage) {
  if (!storage || typeof storage.getItem !== 'function') {
    throw new TypeError('readLegacyState requires a Storage-compatible object');
  }

  const serialized = storage.getItem(LEGACY_STORAGE_KEY);
  if (!serialized) return null;

  try {
    const parsed = JSON.parse(serialized);
    if (!isObject(parsed) || !Array.isArray(parsed.jobs)) return null;
    return cloneJson(parsed);
  } catch {
    return null;
  }
}

export function buildMigrationPayload(legacy) {
  if (!isObject(legacy) || !Array.isArray(legacy.jobs)) {
    throw new TypeError('Legacy state must contain a jobs array');
  }

  return {
    sourceKey: LEGACY_STORAGE_KEY,
    jobs: cloneJson(legacy.jobs),
    curatedBatches: Array.isArray(legacy.curatedBatches)
      ? cloneJson(legacy.curatedBatches)
      : [],
    deletedKeys: Array.isArray(legacy.deletedKeys)
      ? cloneJson(legacy.deletedKeys)
      : []
  };
}

function isLoopbackHttpUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      url.hostname === '127.0.0.1'
    );
  } catch {
    return false;
  }
}

export function parseMigrationBridgeConfig(locationLike) {
  let launchUrl;
  try {
    launchUrl = locationLike instanceof URL
      ? locationLike
      : new URL(locationLike?.href || String(locationLike));
  } catch {
    return null;
  }

  if (launchUrl.protocol !== 'file:') return null;
  if (launchUrl.searchParams.get('migration-bridge') !== '1') return null;

  const fragment = new URLSearchParams(launchUrl.hash.replace(/^#/, ''));
  if (fragment.get('migrationBridge') !== '1') return null;

  const baseUrl = fragment.get('baseUrl') || '';
  const token = fragment.get('token') || '';
  const returnUrl = fragment.get('returnUrl') || '';
  if (!baseUrl || !token || !returnUrl) return null;
  if (!isLoopbackHttpUrl(baseUrl) || !isLoopbackHttpUrl(returnUrl)) return null;

  const parsedBase = new URL(baseUrl);
  const parsedReturn = new URL(returnUrl);
  if (parsedBase.origin !== parsedReturn.origin) return null;

  return {
    baseUrl: parsedBase.href.replace(/\/$/, ''),
    token,
    returnUrl: parsedReturn.href
  };
}

export function buildMigrationPreview(legacy) {
  if (!isObject(legacy) || !Array.isArray(legacy.jobs)) {
    throw new TypeError('Legacy state must contain a jobs array');
  }

  const statuses = {
    todo: 0,
    contacted: 0,
    replied: 0,
    skipped: 0,
    other: 0
  };
  let curated = 0;
  let withGreeting = 0;

  for (const job of legacy.jobs) {
    const status = VALID_STATUSES.includes(job?.status) ? job.status : 'other';
    statuses[status] += 1;
    if (String(job?.greeting || '').trim()) withGreeting += 1;
    if (
      job?.curatedBatchId ||
      job?.source ||
      job?.verifiedAt ||
      job?.curationNote ||
      job?.review
    ) {
      curated += 1;
    }
  }

  return {
    total: legacy.jobs.length,
    curated,
    withGreeting,
    statuses
  };
}

async function runMigration({
  api,
  storage,
  confirmMigration,
  markMigrated = true
}) {
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
    throw new TypeError('migrateLegacyState requires a Storage-compatible object');
  }

  if (storage.getItem(LEGACY_MIGRATED_KEY) === 'true') {
    return {
      status: 'already-migrated',
      imported: 0,
      preview: null
    };
  }

  if (!api || typeof api.importLegacyState !== 'function') {
    throw new TypeError('migrateLegacyState requires api.importLegacyState');
  }
  if (typeof confirmMigration !== 'function') {
    throw new TypeError('migrateLegacyState requires confirmMigration');
  }

  const legacy = readLegacyState(storage);
  if (!legacy) {
    return {
      status: 'no-legacy-data',
      imported: 0,
      preview: null
    };
  }

  const preview = buildMigrationPreview(legacy);
  const confirmed = await confirmMigration(cloneJson(preview));
  if (!confirmed) {
    return {
      status: 'cancelled',
      imported: 0,
      preview
    };
  }

  const payload = buildMigrationPayload(legacy);
  const response = await api.importLegacyState(payload);
  if (!isObject(response) || response.ok !== true || response.error) {
    const message = response?.error?.message || '本地投递台未确认迁移成功';
    throw new Error(message);
  }

  const countFields = ['imported', 'merged', 'alreadyPresent', 'total'];
  const countsAreValid = countFields.every((field) => (
    Number.isInteger(response[field]) && response[field] >= 0
  ));
  const completed = countsAreValid
    && response.imported + response.merged + response.alreadyPresent === response.total
    && response.total === payload.jobs.length;
  if (!completed) {
    throw new Error('本地投递台返回的迁移数量不完整');
  }

  if (markMigrated) storage.setItem(LEGACY_MIGRATED_KEY, 'true');
  return {
    status: 'migrated',
    imported: response.imported,
    merged: response.merged,
    alreadyPresent: response.alreadyPresent,
    total: response.total,
    preview
  };
}

export function migrateLegacyState(options) {
  const storage = options?.storage;
  if (!storage || (typeof storage !== 'object' && typeof storage !== 'function')) {
    return runMigration(options);
  }

  const pending = migrationsInFlight.get(storage);
  if (pending) return pending;

  const migration = runMigration(options)
    .finally(() => migrationsInFlight.delete(storage));
  migrationsInFlight.set(storage, migration);
  return migration;
}
