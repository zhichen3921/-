import { access, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

import { jobIdentityKeys, mergeJob } from '../shared/deduplicate.mjs';
import { JOB_STATUSES, normalizeJob } from '../shared/job-schema.mjs';
import { scoreJob } from '../shared/matcher.mjs';
import {
  createPublicUpdateManager
} from '../updates/run-status.mjs';
import {
  extensionCorsHeaders,
  HttpError,
  isExtensionOrigin,
  isSameOrigin,
  nullOriginMigrationCorsHeaders,
  readJsonBody,
  resolveStaticPath,
  tokenMatches,
  validateExtensionPreflight,
  validateNullOriginMigrationPreflight
} from './security.mjs';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const EXTENSION_INTAKE_PATHS = new Set(['/api/jobs', '/api/jobs/preview']);
const LEGACY_MIGRATION_PATH = '/api/migrations/legacy';
const MANUAL_JOB_FIELDS = Object.freeze([
  'title',
  'company',
  'location',
  'url',
  'description'
]);
const CONTENT_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.webp': 'image/webp'
});

function sendJson(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...headers
  });
  response.end(body);
}

function sendEmpty(response, status, headers = {}) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': '0',
    ...headers
  });
  response.end();
}

function sendError(response, error, headers = {}) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const code = typeof error?.code === 'string'
    ? error.code
    : 'INTERNAL_ERROR';
  const message = status >= 500 && code === 'INTERNAL_ERROR'
    ? 'The local application service encountered an unexpected error'
    : String(error?.message || 'Request failed');
  sendJson(response, status, { error: { code, message } }, headers);
}

function methodNotAllowed(allowed) {
  const error = new HttpError(405, 'METHOD_NOT_ALLOWED', 'HTTP method is not allowed for this route');
  error.allowed = allowed;
  return error;
}

function requireObject(value, label = 'Request body') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'INVALID_BODY', `${label} must be a JSON object`);
  }
  return value;
}

function requireToken(request, runtimeToken) {
  if (!isSameOrigin(request.headers.origin, request)) {
    throw new HttpError(403, 'ORIGIN_FORBIDDEN', 'Write request origin is not allowed');
  }
  if (!tokenMatches(request.headers['x-desk-token'], runtimeToken)) {
    throw new HttpError(403, 'INVALID_TOKEN', 'A valid runtime token is required');
  }
}

function isExtensionIntake(request, pathname) {
  return (
    request.method === 'POST' &&
    EXTENSION_INTAKE_PATHS.has(pathname) &&
    isExtensionOrigin(request.headers.origin)
  );
}

function authorizeWrite(request, pathname, runtimeToken, extensionToken) {
  if (!WRITE_METHODS.has(request.method)) return {};
  if (isExtensionIntake(request, pathname)) {
    if (!tokenMatches(request.headers['x-desk-extension-token'], extensionToken)) {
      throw new HttpError(
        403,
        'INVALID_EXTENSION_TOKEN',
        'A valid paired extension token is required'
      );
    }
    return;
  }
  if (pathname === LEGACY_MIGRATION_PATH && request.headers.origin === 'null') {
    if (!tokenMatches(request.headers['x-desk-token'], runtimeToken)) {
      throw new HttpError(403, 'INVALID_TOKEN', 'A valid runtime token is required');
    }
    return;
  }
  requireToken(request, runtimeToken);
}

function withMatch(job, preferences) {
  const match = scoreJob(job, preferences);
  return {
    ...job,
    score: match.score,
    route: match.route,
    recommendation: match.recommendation,
    match
  };
}

function findDuplicate(jobs, candidate) {
  if (candidate.id) {
    const byId = jobs.find((job) => job.id === candidate.id);
    if (byId) return byId;
  }
  const candidateKeys = new Set(jobIdentityKeys(candidate));
  if (candidateKeys.size === 0) return null;
  return jobs.find((job) => (
    jobIdentityKeys(job).some((key) => candidateKeys.has(key))
  )) || null;
}

function duplicateSummary(job) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    title: job.title
  };
}

function normalizeAndScore(input, preferences) {
  try {
    assertValidStatus(input);
    const normalizedJob = normalizeJob(input);
    return {
      normalizedJob,
      match: scoreJob(normalizedJob, preferences)
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'INVALID_JOB', error.message, { cause: error });
  }
}

function assertValidStatus(input) {
  if (
    Object.hasOwn(input, 'status') &&
    !JOB_STATUSES.includes(input.status)
  ) {
    throw new HttpError(
      400,
      'INVALID_STATUS',
      `Job status must be one of: ${JOB_STATUSES.join(', ')}`
    );
  }
}

function userUpdatedJob(existing, patch) {
  assertValidStatus(patch);
  const changedManualFields = MANUAL_JOB_FIELDS.filter((field) => (
    Object.hasOwn(patch, field) &&
    patch[field] !== existing[field]
  ));
  const preferredExisting = {
    ...existing,
    status: patch.status ?? existing.status,
    notes: patch.notes ?? existing.notes,
    greeting: patch.greeting ?? existing.greeting,
    greetingEdited: patch.greeting !== undefined
      ? true
      : existing.greetingEdited,
    manualFields: [
      ...new Set([
        ...(Array.isArray(existing.manualFields) ? existing.manualFields : []),
        ...changedManualFields
      ])
    ]
  };
  try {
    return normalizeJob(
      {
        ...existing,
        ...patch,
        manualFields: preferredExisting.manualFields
      },
      preferredExisting
    );
  } catch (error) {
    throw new HttpError(400, 'INVALID_JOB', error.message, { cause: error });
  }
}

async function previewJob(store, input) {
  const state = await store.read();
  const { forceSave: _forceSave, ...jobInput } = requireObject(input);
  const { normalizedJob, match } = normalizeAndScore(jobInput, state.preferences);
  const duplicate = findDuplicate(state.jobs, normalizedJob);
  return {
    normalizedJob,
    match,
    duplicate: duplicateSummary(duplicate)
  };
}

async function saveJob(store, input) {
  const body = requireObject(input);
  const { forceSave = false, ...jobInput } = body;
  let savedJob;
  let duplicate = null;

  await store.update((state) => {
    const result = normalizeAndScore(jobInput, state.preferences);
    const candidate = withMatch(result.normalizedJob, state.preferences);
    const existing = findDuplicate(state.jobs, candidate);
    duplicate = duplicateSummary(existing);

    if (candidate.route === 'excluded' && forceSave !== true && !existing) {
      throw new HttpError(
        422,
        'JOB_EXCLUDED_REQUIRES_FORCE',
        'Excluded jobs require forceSave: true'
      );
    }

    if (existing) {
      const index = state.jobs.findIndex((job) => job.id === existing.id);
      savedJob = withMatch(mergeJob(existing, candidate), state.preferences);
      state.jobs[index] = savedJob;
    } else {
      savedJob = candidate;
      state.jobs.push(savedJob);
    }
  });

  return { job: savedJob, duplicate };
}

async function updatePreferences(store, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(
      400,
      'INVALID_PREFERENCES',
      'Preferences must be a JSON object'
    );
  }
  let preferences;
  try {
    await store.update((state) => {
      preferences = { ...state.preferences, ...input };
      state.preferences = preferences;
      state.jobs = state.jobs.map((job) => (
        job.status === 'todo' ? withMatch(job, preferences) : job
      ));
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      400,
      'INVALID_PREFERENCES',
      error.message,
      { cause: error }
    );
  }
  return preferences;
}

async function updateJob(store, id, patch) {
  requireObject(patch);
  let savedJob;
  await store.update((state) => {
    const index = state.jobs.findIndex((job) => job.id === id);
    if (index === -1) {
      throw new HttpError(404, 'JOB_NOT_FOUND', 'Job was not found');
    }
    const normalized = userUpdatedJob(state.jobs[index], patch);
    savedJob = normalized.status === 'todo'
      ? withMatch(normalized, state.preferences)
      : {
          ...normalized,
          score: state.jobs[index].score,
          route: state.jobs[index].route,
          recommendation: state.jobs[index].recommendation,
          match: state.jobs[index].match
        };
    state.jobs[index] = savedJob;
  });
  return savedJob;
}

async function deleteJob(store, id) {
  let removed;
  await store.update((state) => {
    const index = state.jobs.findIndex((job) => job.id === id);
    if (index === -1) {
      throw new HttpError(404, 'JOB_NOT_FOUND', 'Job was not found');
    }
    [removed] = state.jobs.splice(index, 1);
    state.deletedKeys = [
      ...new Set([...state.deletedKeys, `id:${removed.id}`, ...jobIdentityKeys(removed)])
    ];
  });
  return removed;
}

function emptyBatchSummary(batchId) {
  return {
    batchId,
    queued: 0,
    review: 0,
    excluded: 0,
    duplicates: 0,
    invalid: 0
  };
}

async function importBatchPlaceholder(store, input) {
  const batch = requireObject(input, 'Batch');
  const batchId = String(batch.id || batch.batchId || '').trim();
  if (!batchId || !Array.isArray(batch.jobs)) {
    throw new HttpError(
      400,
      'INVALID_BATCH',
      'Batch requires a non-empty id and a jobs array'
    );
  }

  let summary = emptyBatchSummary(batchId);
  await store.update((state) => {
    if (state.importedBatchIds.includes(batchId)) {
      summary.duplicates = batch.jobs.length;
      return;
    }

    for (const inputJob of batch.jobs) {
      let candidate;
      try {
        const normalizedInput = {
          ...inputJob,
          curatedBatchId: inputJob?.curatedBatchId || batchId
        };
        assertValidStatus(normalizedInput);
        const normalized = normalizeJob(normalizedInput);
        candidate = withMatch(normalized, state.preferences);
      } catch {
        summary.invalid += 1;
        continue;
      }

      if (candidate.route === 'excluded') {
        summary.excluded += 1;
        continue;
      }

      const keys = jobIdentityKeys(candidate);
      if (
        state.deletedKeys.includes(`id:${candidate.id}`) ||
        keys.some((key) => state.deletedKeys.includes(key))
      ) {
        summary.duplicates += 1;
        continue;
      }

      const existing = findDuplicate(state.jobs, candidate);
      if (existing) {
        const index = state.jobs.findIndex((job) => job.id === existing.id);
        state.jobs[index] = withMatch(mergeJob(existing, candidate), state.preferences);
        summary.duplicates += 1;
        continue;
      }

      state.jobs.push(candidate);
      const summaryField = candidate.route === 'queue' ? 'queued' : candidate.route;
      summary[summaryField] += 1;
    }
    state.importedBatchIds.push(batchId);
  });
  return summary;
}

function migrationBatchIds(curatedBatches) {
  if (!Array.isArray(curatedBatches)) {
    throw new TypeError('curatedBatches must be an array');
  }
  return curatedBatches.map((entry) => {
    const id = typeof entry === 'string'
      ? entry.trim()
      : String(entry?.id || entry?.batchId || '').trim();
    if (!id) throw new TypeError('Each curated batch must have an id');
    return id;
  });
}

function validateLegacyManualFields(job) {
  if (!Object.hasOwn(job, 'manualFields')) return [];
  if (
    !Array.isArray(job.manualFields) ||
    job.manualFields.some((field) => !MANUAL_JOB_FIELDS.includes(field))
  ) {
    throw new TypeError('manualFields contains an unsupported field');
  }
  return [...new Set(job.manualFields)];
}

function normalizeLegacyJob(input, preferences) {
  requireObject(input, 'Legacy job');
  assertValidStatus(input);
  if (
    Object.hasOwn(input, 'greetingEdited') &&
    typeof input.greetingEdited !== 'boolean'
  ) {
    throw new TypeError('greetingEdited must be a boolean');
  }
  const manualFields = validateLegacyManualFields(input);
  const normalized = normalizeJob({ ...input, manualFields });
  return withMatch(normalized, preferences);
}

function mergeLegacyJob(existing, legacy, rawLegacy, preferences) {
  let merged = withMatch(mergeJob(existing, legacy), preferences);
  merged.id = existing.id;

  for (const field of [
    'status',
    'greeting',
    'greetingEdited',
    'createdAt',
    'notes',
    'manualFields'
  ]) {
    if (Object.hasOwn(rawLegacy, field)) {
      merged[field] = legacy[field];
    }
  }
  for (const field of legacy.manualFields || []) {
    if (Object.hasOwn(rawLegacy, field)) {
      merged[field] = legacy[field];
    }
  }

  return withMatch(merged, preferences);
}

async function migrateLegacyState(store, input) {
  let result;
  try {
    await store.update((state) => {
      const body = requireObject(input, 'Legacy migration');
      const sourceKey = String(body.sourceKey || '').trim();
      if (!sourceKey) throw new TypeError('sourceKey must be a non-empty string');
      if (!Array.isArray(body.jobs)) throw new TypeError('jobs must be an array');
      if (
        !Array.isArray(body.deletedKeys) ||
        body.deletedKeys.some((key) => typeof key !== 'string' || !key.trim())
      ) {
        throw new TypeError('deletedKeys must be an array of non-empty strings');
      }
      const batchIds = migrationBatchIds(body.curatedBatches);
      const processedSources = Array.isArray(state.updates.legacyMigrationSources)
        ? state.updates.legacyMigrationSources
        : [];

      if (processedSources.includes(sourceKey)) {
        result = {
          ok: true,
          imported: 0,
          merged: 0,
          alreadyPresent: body.jobs.length,
          total: body.jobs.length
        };
        return;
      }

      let imported = 0;
      let mergedCount = 0;
      for (const rawLegacy of body.jobs) {
        const legacy = normalizeLegacyJob(rawLegacy, state.preferences);
        const existing = findDuplicate(state.jobs, legacy);
        if (existing) {
          const index = state.jobs.findIndex((job) => job.id === existing.id);
          state.jobs[index] = mergeLegacyJob(
            existing,
            legacy,
            rawLegacy,
            state.preferences
          );
          mergedCount += 1;
        } else {
          state.jobs.push(legacy);
          imported += 1;
        }
      }

      state.importedBatchIds = [
        ...new Set([...state.importedBatchIds, ...batchIds])
      ];
      state.deletedKeys = [
        ...new Set([
          ...state.deletedKeys,
          ...body.deletedKeys.map((key) => key.trim())
        ])
      ];
      state.updates.legacyMigrationSources = [
        ...new Set([...processedSources, sourceKey])
      ];
      result = {
        ok: true,
        imported,
        merged: mergedCount,
        alreadyPresent: 0,
        total: body.jobs.length
      };
    });
  } catch (error) {
    throw new HttpError(
      400,
      'INVALID_MIGRATION',
      error.message,
      { cause: error }
    );
  }
  return result;
}

async function replaceClientStateJobs(store, input) {
  let savedJobs;
  try {
    await store.update((state) => {
      const body = requireObject(input, 'Client state');
      if (!Array.isArray(body.jobs)) {
        throw new TypeError('jobs must be an array');
      }
      savedJobs = body.jobs.map((inputJob) => {
        requireObject(inputJob, 'Client job');
        assertValidStatus(inputJob);
        return withMatch(normalizeJob(inputJob), state.preferences);
      });
      state.jobs = savedJobs;
    });
  } catch (error) {
    throw new HttpError(
      400,
      'INVALID_CLIENT_STATE',
      error.message,
      { cause: error }
    );
  }
  return savedJobs;
}

async function serveStatic(request, response, staticRoot, pathname) {
  if (!['GET', 'HEAD'].includes(request.method)) {
    throw methodNotAllowed(['GET', 'HEAD']);
  }
  const filePath = await resolveStaticPath(staticRoot, pathname);
  const body = await readFile(filePath);
  const contentType = CONTENT_TYPES[extname(filePath).toLowerCase()]
    || 'application/octet-stream';
  response.writeHead(200, {
    'cache-control': 'no-cache',
    'content-type': contentType,
    'content-length': body.length,
    'x-content-type-options': 'nosniff'
  });
  response.end(request.method === 'HEAD' ? undefined : body);
}

export function createRouter({
  store,
  runtimeToken,
  extensionToken,
  expectedAuthority,
  staticRoot,
  publicUpdateManager = null
}) {
  if (!store || typeof store.read !== 'function' || typeof store.update !== 'function') {
    throw new TypeError('createRouter requires a store');
  }
  if (typeof runtimeToken !== 'string' || !runtimeToken) {
    throw new TypeError('createRouter requires a runtimeToken');
  }
  if (typeof extensionToken !== 'string' || !extensionToken) {
    throw new TypeError('createRouter requires an extensionToken');
  }
  if (typeof expectedAuthority !== 'function') {
    throw new TypeError('createRouter requires expectedAuthority');
  }
  if (typeof staticRoot !== 'string' || !staticRoot) {
    throw new TypeError('createRouter requires a staticRoot');
  }
  if (
    publicUpdateManager !== null
    && typeof publicUpdateManager?.start !== 'function'
  ) {
    throw new TypeError('publicUpdateManager must provide start()');
  }

  const updateManager = publicUpdateManager || createPublicUpdateManager({
    projectRoot: staticRoot,
    store
  });
  const defaultRunnerScript = join(staticRoot, 'updates', 'run-public-update.ps1');

  return async function route(request, response) {
    let corsHeaders = {};
    try {
      const authority = expectedAuthority();
      if (
        typeof authority !== 'string' ||
        request.headers.host !== authority
      ) {
        throw new HttpError(
          421,
          'INVALID_HOST',
          'Host header must exactly match the loopback listener'
        );
      }

      const rawPathname = String(request.url || '/').split('?', 1)[0];
      const url = new URL(request.url, 'http://127.0.0.1');
      const pathname = url.pathname;

      if (request.method === 'OPTIONS') {
        if (
          pathname === LEGACY_MIGRATION_PATH &&
          request.headers.origin === 'null'
        ) {
          corsHeaders = validateNullOriginMigrationPreflight(request);
          sendEmpty(response, 204, corsHeaders);
          return;
        }
        if (!EXTENSION_INTAKE_PATHS.has(pathname)) {
          throw new HttpError(403, 'CORS_FORBIDDEN', 'CORS is not enabled for this route');
        }
        corsHeaders = validateExtensionPreflight(request);
        sendEmpty(response, 204, corsHeaders);
        return;
      }

      if (!pathname.startsWith('/api/')) {
        await serveStatic(request, response, staticRoot, rawPathname);
        return;
      }

      if (pathname === '/api/health') {
        if (request.method !== 'GET') throw methodNotAllowed(['GET']);
        sendJson(response, 200, { ok: true, host: '127.0.0.1' });
        return;
      }

      if (pathname === '/api/bootstrap') {
        if (request.method !== 'GET') throw methodNotAllowed(['GET']);
        if (!isSameOrigin(request.headers.origin, request)) {
          throw new HttpError(403, 'ORIGIN_FORBIDDEN', 'Bootstrap is same-origin only');
        }
        sendJson(response, 200, { token: runtimeToken });
        return;
      }

      if (isExtensionIntake(request, pathname)) {
        corsHeaders = extensionCorsHeaders(request.headers.origin);
      }
      authorizeWrite(request, pathname, runtimeToken, extensionToken);
      if (
        pathname === LEGACY_MIGRATION_PATH &&
        request.headers.origin === 'null'
      ) {
        corsHeaders = nullOriginMigrationCorsHeaders();
      }

      if (pathname === '/api/extension/pair') {
        if (request.method !== 'POST') throw methodNotAllowed(['POST']);
        await readJsonBody(request);
        sendJson(response, 200, { extensionToken });
        return;
      }

      if (pathname === '/api/state') {
        if (request.method === 'GET') {
          sendJson(response, 200, { state: await store.read() });
          return;
        }
        if (request.method === 'PUT') {
          const nextState = requireObject(await readJsonBody(request), 'Application state');
          try {
            sendJson(response, 200, { state: await store.replace(nextState) });
          } catch (error) {
            throw new HttpError(400, 'INVALID_STATE', error.message, { cause: error });
          }
          return;
        }
        throw methodNotAllowed(['GET', 'PUT']);
      }

      if (pathname === '/api/client-state') {
        if (request.method !== 'PUT') throw methodNotAllowed(['PUT']);
        const jobs = await replaceClientStateJobs(store, await readJsonBody(request));
        sendJson(response, 200, { ok: true, jobs });
        return;
      }

      if (pathname === LEGACY_MIGRATION_PATH) {
        if (request.method !== 'POST') throw methodNotAllowed(['POST']);
        const result = await migrateLegacyState(store, await readJsonBody(request));
        sendJson(response, 200, result, corsHeaders);
        return;
      }

      if (pathname === '/api/preferences') {
        if (request.method === 'GET') {
          const state = await store.read();
          sendJson(response, 200, { preferences: state.preferences });
          return;
        }
        if (request.method === 'PUT') {
          const preferences = await updatePreferences(store, await readJsonBody(request));
          sendJson(response, 200, { preferences });
          return;
        }
        throw methodNotAllowed(['GET', 'PUT']);
      }

      if (pathname === '/api/jobs/preview') {
        if (request.method !== 'POST') throw methodNotAllowed(['POST']);
        const result = await previewJob(store, await readJsonBody(request));
        sendJson(response, 200, result, corsHeaders);
        return;
      }

      if (pathname === '/api/jobs') {
        if (request.method === 'GET') {
          const state = await store.read();
          sendJson(response, 200, { jobs: state.jobs });
          return;
        }
        if (request.method === 'POST') {
          const result = await saveJob(store, await readJsonBody(request));
          sendJson(response, result.duplicate ? 200 : 201, result, corsHeaders);
          return;
        }
        throw methodNotAllowed(['GET', 'POST']);
      }

      const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
      if (jobMatch) {
        let id;
        try {
          id = decodeURIComponent(jobMatch[1]);
        } catch {
          throw new HttpError(400, 'INVALID_JOB_ID', 'Job id is not valid UTF-8');
        }
        if (request.method === 'GET') {
          const state = await store.read();
          const job = state.jobs.find((candidate) => candidate.id === id);
          if (!job) throw new HttpError(404, 'JOB_NOT_FOUND', 'Job was not found');
          sendJson(response, 200, { job });
          return;
        }
        if (request.method === 'PATCH' || request.method === 'PUT') {
          const job = await updateJob(store, id, await readJsonBody(request));
          sendJson(response, 200, { job });
          return;
        }
        if (request.method === 'DELETE') {
          const job = await deleteJob(store, id);
          sendJson(response, 200, { job });
          return;
        }
        throw methodNotAllowed(['GET', 'PATCH', 'PUT', 'DELETE']);
      }

      if (pathname === '/api/batches/import') {
        if (request.method !== 'POST') throw methodNotAllowed(['POST']);
        const summary = await importBatchPlaceholder(store, await readJsonBody(request));
        sendJson(response, 200, { summary });
        return;
      }

      if (pathname === '/api/updates/status') {
        if (request.method !== 'GET') throw methodNotAllowed(['GET']);
        const state = await store.read();
        sendJson(response, 200, { updates: state.updates });
        return;
      }

      if (pathname === '/api/updates/run') {
        if (request.method !== 'POST') throw methodNotAllowed(['POST']);
        requireObject(await readJsonBody(request));
        if (!publicUpdateManager) {
          try {
            await access(defaultRunnerScript);
          } catch {
            throw new HttpError(
              501,
              'UPDATE_RUNNER_NOT_IMPLEMENTED',
              'The public job update runner is not installed in this project'
            );
          }
        }
        const run = await updateManager.start();
        sendJson(response, 202, { run });
        return;
      }

      throw new HttpError(404, 'NOT_FOUND', 'API route was not found');
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error?.allowed) {
        response.setHeader('allow', error.allowed.join(', '));
      }
      sendError(response, error, corsHeaders);
    }
  };
}
