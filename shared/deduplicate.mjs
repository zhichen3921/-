import { normalizeJob } from './job-schema.mjs';

const TRACKING_PARAMETERS = new Set([
  'fbclid',
  'gclid',
  'spm',
  'from',
  'ref',
  'referrer',
  'source',
  'tracking'
]);

function canonicalText(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function canonicalUrl(value) {
  if (!value) return '';
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    return '';
  }
  if (!['http:', 'https:'].includes(url.protocol)) return '';

  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith('utm_') || TRACKING_PARAMETERS.has(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  url.pathname = url.pathname === '/'
    ? '/'
    : url.pathname.replace(/\/+$/, '');
  return url.href.replace(/\?$/, '').replace(/\/$/, (match) => url.pathname === '/' ? match : '');
}

export function jobIdentityKeys(job) {
  if (!job || typeof job !== 'object') return [];
  const keys = [];
  const url = canonicalUrl(job.url);
  if (url) keys.push(`url:${url}`);

  const company = canonicalText(job.company);
  const title = canonicalText(job.title);
  const location = canonicalText(job.location);
  if (company && title && location) {
    keys.push(`company-title-location:${company}::${title}::${location}`);
  }

  return [...new Set(keys)];
}

function hasIncomingValue(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * Merge a refreshed copy of a job while treating user-controlled fields as
 * authoritative. In particular, communication status and any existing
 * greeting survive update-batch reimports.
 */
export function mergeJob(existing, incoming) {
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    throw new TypeError('已有岗位数据必须是对象');
  }
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    throw new TypeError('新岗位数据必须是对象');
  }

  const combined = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (hasIncomingValue(value)) combined[key] = value;
  }

  const protectedFields = [
    'id',
    'createdAt',
    'status',
    'notes',
    'manualNotes',
    'viewedAt',
    'lastViewedAt',
    'manualTags',
    'manualFields'
  ];
  for (const field of protectedFields) {
    if (existing[field] !== undefined) combined[field] = existing[field];
  }

  const forbiddenManualFields = new Set(['__proto__', 'prototype', 'constructor']);
  const manualFields = Array.isArray(existing.manualFields)
    ? existing.manualFields.filter((field) => (
      typeof field === 'string'
      && !forbiddenManualFields.has(field)
      && Object.hasOwn(existing, field)
    ))
    : [];
  for (const field of manualFields) {
    combined[field] = existing[field];
  }

  if (String(existing.greeting || '').trim()) {
    combined.greeting = existing.greeting;
  }
  combined.greetingEdited = Boolean(existing.greetingEdited || incoming.greetingEdited);

  return normalizeJob(combined);
}
