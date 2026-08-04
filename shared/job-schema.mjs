import { randomUUID } from 'node:crypto';

export const JOB_STATUSES = Object.freeze(['todo', 'contacted', 'replied', 'skipped']);
export const JOB_ROUTES = Object.freeze(['queue', 'review', 'excluded']);

const STRING_LIMITS = Object.freeze({
  title: 100,
  company: 100,
  location: 100,
  url: 1_000,
  description: 12_000,
  source: 200,
  sourceId: 200,
  publishedAt: 40,
  verifiedAt: 40,
  curationNote: 1_000,
  curatedBatchId: 200,
  greeting: 4_000,
  notes: 4_000
});

function cleanString(value, maximum) {
  return String(value ?? '').trim().slice(0, maximum);
}

function cleanStringArray(value, maximumItems = 50) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .slice(0, maximumItems)
    .map((item) => cleanString(item, 100))
    .filter(Boolean))];
}

function cleanOptionalNumber(value, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(maximum, Math.max(minimum, number));
}

function assertHttpUrl(value) {
  if (!value) return '';
  if (value.length > STRING_LIMITS.url) {
    throw new TypeError(`岗位链接过长，最多允许 ${STRING_LIMITS.url} 个字符`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('岗位链接必须是有效的 http 或 https URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new TypeError('岗位链接只允许使用 http 或 https 协议');
  }
  return parsed.href;
}

/**
 * Normalize untrusted job input into the durable job shape.
 *
 * Existing state is accepted separately so callers can update a job without
 * losing its identity, creation time, status, or edited greeting.
 */
export function normalizeJob(input, existing = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('岗位数据必须是对象');
  }
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    throw new TypeError('已有岗位数据必须是对象');
  }

  const combined = { ...existing, ...input };
  const title = cleanString(input.title ?? existing.title, STRING_LIMITS.title);
  if (!title) throw new TypeError('岗位名称不能为空');

  const existingStatus = JOB_STATUSES.includes(existing.status) ? existing.status : null;
  const requestedStatus = JOB_STATUSES.includes(input.status) ? input.status : null;
  const existingGreeting = cleanString(existing.greeting, STRING_LIMITS.greeting);
  const requestedGreeting = cleanString(input.greeting, STRING_LIMITS.greeting);
  const rawUrl = String(input.url ?? existing.url ?? '').trim();
  const now = new Date().toISOString();

  return {
    ...combined,
    id: cleanString(existing.id || input.id, 200) || randomUUID(),
    title,
    company: cleanString(input.company ?? existing.company, STRING_LIMITS.company),
    location: cleanString(input.location ?? existing.location, STRING_LIMITS.location),
    url: assertHttpUrl(rawUrl),
    description: cleanString(input.description ?? existing.description, STRING_LIMITS.description),
    source: cleanString(input.source ?? existing.source, STRING_LIMITS.source),
    sourceId: cleanString(input.sourceId ?? existing.sourceId, STRING_LIMITS.sourceId),
    publishedAt: cleanString(input.publishedAt ?? existing.publishedAt, STRING_LIMITS.publishedAt),
    verifiedAt: cleanString(input.verifiedAt ?? existing.verifiedAt, STRING_LIMITS.verifiedAt),
    curationNote: cleanString(input.curationNote ?? existing.curationNote, STRING_LIMITS.curationNote),
    curatedBatchId: cleanString(input.curatedBatchId ?? existing.curatedBatchId, STRING_LIMITS.curatedBatchId),
    status: existingStatus || requestedStatus || 'todo',
    greeting: existingGreeting || requestedGreeting,
    greetingEdited: Boolean(existing.greetingEdited || input.greetingEdited),
    notes: cleanString(existing.notes || input.notes, STRING_LIMITS.notes),
    directions: cleanStringArray(input.directions ?? existing.directions),
    graduationYears: cleanStringArray(input.graduationYears ?? existing.graduationYears),
    durationMonths: cleanOptionalNumber(input.durationMonths ?? existing.durationMonths, { maximum: 120 }),
    daysPerWeek: cleanOptionalNumber(input.daysPerWeek ?? existing.daysPerWeek, { maximum: 7 }),
    active: typeof input.active === 'boolean'
      ? input.active
      : typeof existing.active === 'boolean' ? existing.active : true,
    createdAt: cleanString(existing.createdAt || input.createdAt, 40) || now,
    updatedAt: now
  };
}
