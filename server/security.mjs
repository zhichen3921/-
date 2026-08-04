import { randomBytes, timingSafeEqual } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

export const MAX_JSON_BODY_BYTES = 1024 * 1024;

const EXTENSION_ORIGIN_PATTERN = /^chrome-extension:\/\/[a-p]{32}$/;
const PUBLIC_ROOT_ASSETS = new Set([
  'index.html',
  'styles.css',
  'app.js',
  'curated-jobs.js'
]);
const PUBLIC_CLIENT_MODULE = /^client\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.js$/;

export class HttpError extends Error {
  constructor(status, code, message, options = {}) {
    super(message, options);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export function createRuntimeToken() {
  return randomBytes(32).toString('base64url');
}

export function isExtensionOrigin(origin) {
  return typeof origin === 'string' && EXTENSION_ORIGIN_PATTERN.test(origin);
}

export function isSameOrigin(origin, request) {
  if (!origin) return true;
  const host = request.headers.host;
  return typeof host === 'string' && origin === `http://${host}`;
}

export function tokenMatches(received, expected) {
  if (typeof received !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function extensionCorsHeaders(origin) {
  if (!isExtensionOrigin(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-desk-extension-token',
    'access-control-max-age': '600',
    vary: 'Origin'
  };
}

export function nullOriginMigrationCorsHeaders() {
  return {
    'access-control-allow-origin': 'null',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-desk-token',
    'access-control-max-age': '600',
    vary: 'Origin'
  };
}

export function validateExtensionPreflight(request) {
  const origin = request.headers.origin;
  const method = request.headers['access-control-request-method'];
  const requestedHeaders = String(
    request.headers['access-control-request-headers'] || ''
  )
    .split(',')
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean);

  if (!isExtensionOrigin(origin) || String(method).toUpperCase() !== 'POST') {
    throw new HttpError(403, 'CORS_FORBIDDEN', 'Extension origin is not allowed');
  }
  const allowedHeaders = new Set(['content-type', 'x-desk-extension-token']);
  if (requestedHeaders.some((header) => !allowedHeaders.has(header))) {
    throw new HttpError(403, 'CORS_FORBIDDEN', 'Requested CORS headers are not allowed');
  }

  return extensionCorsHeaders(origin);
}

export function validateNullOriginMigrationPreflight(request) {
  const method = request.headers['access-control-request-method'];
  const requestedHeaders = String(
    request.headers['access-control-request-headers'] || ''
  )
    .split(',')
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean);
  const allowedHeaders = new Set(['content-type', 'x-desk-token']);

  if (
    request.headers.origin !== 'null' ||
    String(method).toUpperCase() !== 'POST' ||
    requestedHeaders.some((header) => !allowedHeaders.has(header))
  ) {
    throw new HttpError(403, 'CORS_FORBIDDEN', 'Null-origin migration preflight is not allowed');
  }
  return nullOriginMigrationCorsHeaders();
}

export function requireJsonContentType(request) {
  const contentType = String(request.headers['content-type'] || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== 'application/json') {
    throw new HttpError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'Request body must use application/json'
    );
  }
}

export async function readJsonBody(request, limit = MAX_JSON_BODY_BYTES) {
  requireJsonContentType(request);

  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    request.resume();
    throw new HttpError(
      413,
      'BODY_TOO_LARGE',
      `JSON request body must not exceed ${limit} bytes`
    );
  }

  const chunks = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      tooLarge = true;
      continue;
    }
    chunks.push(chunk);
  }

  if (tooLarge) {
    throw new HttpError(
      413,
      'BODY_TOO_LARGE',
      `JSON request body must not exceed ${limit} bytes`
    );
  }
  if (size === 0) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Request body is not valid JSON');
  }
}

function remainsWithin(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function assertPublicStaticPath(decodedPath) {
  const normalizedPath = decodedPath
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  const segments = normalizedPath.split('/').filter(Boolean);
  if (
    segments.some((segment) => segment === '..' || segment.includes('\0'))
  ) {
    throw new HttpError(403, 'STATIC_PATH_FORBIDDEN', 'Static path is not allowed');
  }

  const publicPath = normalizedPath || 'index.html';
  if (
    !PUBLIC_ROOT_ASSETS.has(publicPath) &&
    !PUBLIC_CLIENT_MODULE.test(publicPath)
  ) {
    throw new HttpError(
      403,
      'STATIC_PATH_FORBIDDEN',
      'Static file is not in the public asset allowlist'
    );
  }
}

export async function resolveStaticPath(staticRoot, encodedPathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(encodedPathname);
  } catch {
    throw new HttpError(400, 'INVALID_PATH', 'Static path is not valid UTF-8');
  }

  assertPublicStaticPath(decodedPath);
  const root = await realpath(staticRoot);
  const relativePath = decodedPath.replace(/^[/\\]+/, '') || 'index.html';
  let candidate = resolve(root, relativePath);
  if (!remainsWithin(root, candidate)) {
    throw new HttpError(403, 'STATIC_PATH_FORBIDDEN', 'Static path is outside the application root');
  }

  let candidateStat;
  try {
    candidateStat = await stat(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw new HttpError(404, 'STATIC_NOT_FOUND', 'Static file was not found');
    }
    throw error;
  }

  if (candidateStat.isDirectory()) {
    candidate = resolve(candidate, 'index.html');
  }

  let canonicalCandidate;
  try {
    canonicalCandidate = await realpath(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw new HttpError(404, 'STATIC_NOT_FOUND', 'Static file was not found');
    }
    throw error;
  }
  if (!remainsWithin(root, canonicalCandidate)) {
    throw new HttpError(403, 'STATIC_PATH_FORBIDDEN', 'Static symlink leaves the application root');
  }

  const finalStat = await stat(canonicalCandidate);
  if (!finalStat.isFile()) {
    throw new HttpError(404, 'STATIC_NOT_FOUND', 'Static file was not found');
  }
  return canonicalCandidate;
}
