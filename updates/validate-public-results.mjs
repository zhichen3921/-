import { sanitizeBatchJob, validateBatch } from './batch-schema.mjs';

const SOURCE_KINDS = new Set([
  'company-career',
  'university-career',
  'public-aggregator'
]);
const SOURCE_FIELDS = new Set(['name', 'kind', 'url']);
const JOB_FIELDS = new Set([
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
const REVIEW_FIELDS = new Set([
  'score',
  'verdict',
  'recommendation',
  'reasons',
  'matchedSkills'
]);
const REVIEW_VERDICTS = new Set(['good', 'unknown', 'bad']);
const BOSS_HOST_PATTERN = /(^|\.)zhipin\.com$/i;
const BOSS_NAME_PATTERN = /b[\s._-]*o[\s._-]*s[\s._-]*s(?:[\s._-]*(?:直\s*聘|招\s*聘))?|zhipin/i;
const MAX_FETCHED_PAGE_CHARS = 1_000_000;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf())
    && parsed.toISOString().slice(0, 10) === value;
}

function isDateTime(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

function isPrivateIpv4(normalized) {
  const octets = normalized.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => (
    !Number.isInteger(part) || part < 0 || part > 255
  ))) {
    return false;
  }
  return octets[0] === 10
    || octets[0] === 127
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
    || octets[0] === 0;
}

function ipv6Words(address) {
  const normalized = address.toLowerCase().split('%')[0];
  if (!normalized.includes(':')) return null;
  const halves = normalized.split('::');
  if (halves.length > 2) return null;

  function parseHalf(value) {
    if (!value) return [];
    const words = [];
    for (const piece of value.split(':')) {
      if (piece.includes('.')) {
        const octets = piece.split('.').map(Number);
        if (
          octets.length !== 4
          || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
        ) return null;
        words.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      } else if (!/^[0-9a-f]{1,4}$/.test(piece)) {
        return null;
      } else {
        words.push(Number.parseInt(piece, 16));
      }
    }
    return words;
  }

  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] || '');
  if (!left || !right) return null;
  const omitted = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (omitted < 0 || (halves.length === 1 && left.length !== 8)) return null;
  const words = [...left, ...Array(omitted).fill(0), ...right];
  return words.length === 8 ? words : null;
}

function isPrivateIpv6(normalized) {
  const words = ipv6Words(normalized);
  if (!words) return false;
  const allZeroPrefix = words.slice(0, 7).every((word) => word === 0);
  if (allZeroPrefix && (words[7] === 0 || words[7] === 1)) return true;
  if ((words[0] & 0xfe00) === 0xfc00) return true;
  if ((words[0] & 0xffc0) === 0xfe80) return true;
  if ((words[0] & 0xffc0) === 0xfec0) return true;

  const mappedIpv4 = words.slice(0, 5).every((word) => word === 0)
    && words[5] === 0xffff;
  if (mappedIpv4) {
    const ipv4 = [
      words[6] >> 8,
      words[6] & 0xff,
      words[7] >> 8,
      words[7] & 0xff
    ].join('.');
    return isPrivateIpv4(ipv4);
  }
  return false;
}

function isPrivateHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    normalized === 'localhost'
    || normalized === '::1'
    || normalized.endsWith('.localhost')
    || normalized.endsWith('.local')
  ) {
    return true;
  }

  return isPrivateIpv4(normalized) || isPrivateIpv6(normalized);
}

function parsePublicUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) {
    return null;
  }
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    if (parsed.username || parsed.password || isPrivateHostname(parsed.hostname)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function normalizedUrl(parsed) {
  const copy = new URL(parsed.href);
  copy.hash = '';
  copy.hostname = copy.hostname.toLowerCase();
  if (
    (copy.protocol === 'https:' && copy.port === '443')
    || (copy.protocol === 'http:' && copy.port === '80')
  ) {
    copy.port = '';
  }
  return copy.href;
}

function isBossUrl(parsed) {
  return BOSS_HOST_PATTERN.test(parsed.hostname);
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function pageTitleFromHtml(html) {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ''));
  return match ? decodeHtmlEntities(match[1]).replace(/\s+/g, ' ').trim() : '';
}

function visibleTextFromHtml(html) {
  return decodeHtmlEntities(String(html || '')
    .replace(/<(script|style|noscript|template|svg|head)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(
      /<([a-z][\w:-]*)\b(?=[^>]*(?:\bhidden(?:\s|=|>)|aria-hidden\s*=\s*["']?true|style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden)))[^>]*>[\s\S]*?<\/\1>/gi,
      ' '
    )
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeEvidenceText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '');
}

function evidenceTerms(value, kind) {
  const compact = normalizeEvidenceText(value);
  const terms = [compact];
  if (kind === 'company') {
    terms.push(compact.replace(/(?:股份)?有限公司$|有限责任公司$|集团$/u, ''));
  } else {
    terms.push(compact.replace(/(?:日常)?实习生?$|招聘$/u, ''));
  }
  return [...new Set(terms)].filter((term) => {
    if (/^[a-z0-9]+$/i.test(term)) return term.length >= 3;
    return term.length >= 2;
  });
}

function findEvidenceToken(haystack, value, kind) {
  return evidenceTerms(value, kind).find((term) => haystack.includes(term)) || null;
}

async function defaultFetchPage({ url, fetch: fetchImplementation }) {
  if (typeof fetchImplementation !== 'function') {
    throw new TypeError('No fetch implementation is available');
  }
  const response = await fetchImplementation(url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      accept: 'text/html,application/xhtml+xml,text/plain;q=0.8',
      'user-agent': 'ApplicationDeskSourceVerifier/1.0'
    }
  });
  const contentLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_FETCHED_PAGE_CHARS * 4) {
    throw new Error('source page is too large to verify safely');
  }
  const html = String(await response.text()).slice(0, MAX_FETCHED_PAGE_CHARS);
  return {
    ok: response.ok,
    status: response.status,
    finalUrl: response.url || url,
    title: pageTitleFromHtml(html),
    text: visibleTextFromHtml(html)
  };
}

function validateReview(review, path, errors) {
  if (review === undefined) return;
  if (!isRecord(review)) {
    errors.push(`${path} must be an object`);
    return;
  }
  for (const field of Object.keys(review)) {
    if (!REVIEW_FIELDS.has(field)) errors.push(`${path}.${field} is not supported`);
  }
  if (
    Object.hasOwn(review, 'score')
    && (!Number.isFinite(review.score) || review.score < 0 || review.score > 100)
  ) {
    errors.push(`${path}.score must be a number from 0 to 100`);
  }
  if (
    Object.hasOwn(review, 'verdict')
    && !REVIEW_VERDICTS.has(review.verdict)
  ) {
    errors.push(`${path}.verdict must be good, unknown, or bad`);
  }
  if (
    Object.hasOwn(review, 'recommendation')
    && typeof review.recommendation !== 'string'
  ) {
    errors.push(`${path}.recommendation must be a string`);
  }
  for (const field of ['reasons', 'matchedSkills']) {
    if (
      Object.hasOwn(review, field)
      && (!Array.isArray(review[field]) || review[field].some((item) => typeof item !== 'string'))
    ) {
      errors.push(`${path}.${field} must be an array of strings`);
    }
  }
}

/**
 * Strictly validates an untrusted candidate produced by the public-search
 * runner. A valid result is converted to the existing import-batch shape.
 * Invalid candidates are never partially accepted.
 */
export function validatePublicBatch(candidate) {
  const errors = [];
  if (!isRecord(candidate)) {
    return { batch: null, errors: ['batch must be a JSON object'] };
  }

  const allowedEnvelope = new Set(['id', 'generatedAt', 'verifiedAt', 'sources', 'jobs']);
  for (const field of Object.keys(candidate)) {
    if (!allowedEnvelope.has(field)) errors.push(`batch.${field} is not supported`);
  }

  if (
    typeof candidate.id !== 'string'
    || !/^\d{4}-\d{2}-\d{2}-shenzhen-ai-v[1-9]\d*$/.test(candidate.id)
  ) {
    errors.push('batch.id must use YYYY-MM-DD-shenzhen-ai-vN');
  }
  if (!isDateTime(candidate.generatedAt)) {
    errors.push('batch.generatedAt must be a valid ISO date-time with timezone');
  }
  if (!isDateOnly(candidate.verifiedAt)) {
    errors.push('batch.verifiedAt must use a valid YYYY-MM-DD date');
  }
  if (
    typeof candidate.id === 'string'
    && isDateOnly(candidate.verifiedAt)
    && candidate.id.slice(0, 10) !== candidate.verifiedAt
  ) {
    errors.push('batch.id date must match batch.verifiedAt');
  }

  const declaredSources = new Map();
  const sourceUrls = new Set();
  if (!Array.isArray(candidate.sources) || candidate.sources.length === 0) {
    errors.push('batch.sources must be a non-empty array');
  } else {
    candidate.sources.forEach((source, index) => {
      const path = `batch.sources[${index}]`;
      if (!isRecord(source)) {
        errors.push(`${path} must be an object`);
        return;
      }
      for (const field of Object.keys(source)) {
        if (!SOURCE_FIELDS.has(field)) errors.push(`${path}.${field} is not supported`);
      }
      const name = typeof source.name === 'string' ? source.name.trim() : '';
      if (!name) {
        errors.push(`${path}.name must be a non-empty string`);
      } else if (declaredSources.has(name)) {
        errors.push(`${path}.name duplicates a declared source`);
      }
      if (!SOURCE_KINDS.has(source.kind)) {
        errors.push(`${path}.kind is an unsupported source kind`);
      }
      const sourceUrl = parsePublicUrl(source.url);
      if (!sourceUrl) {
        errors.push(`${path}.url must be a public HTTP(S) URL`);
      } else {
        const identity = normalizedUrl(sourceUrl);
        if (sourceUrls.has(identity)) errors.push(`${path}.url duplicates a source URL`);
        sourceUrls.add(identity);
      }
      if (
        BOSS_NAME_PATTERN.test(name)
        || (sourceUrl && BOSS_HOST_PATTERN.test(sourceUrl.hostname))
      ) {
        errors.push(`${path} cannot use BOSS; logged-in BOSS is collected only by the user extension`);
      }
      if (name) declaredSources.set(name, source);
    });
  }

  const sanitizedJobs = [];
  const jobUrls = new Set();
  if (!Array.isArray(candidate.jobs)) {
    errors.push('batch.jobs must be an array');
  } else {
    candidate.jobs.forEach((job, index) => {
      const path = `batch.jobs[${index}]`;
      if (!isRecord(job)) {
        errors.push(`${path} must be an object`);
        return;
      }
      for (const field of Object.keys(job)) {
        if (!JOB_FIELDS.has(field)) errors.push(`${path}.${field} is not supported`);
      }

      const jobUrl = parsePublicUrl(job.url);
      if (!jobUrl) {
        errors.push(`${path}.url must be a public HTTP(S) URL`);
      } else {
        const identity = normalizedUrl(jobUrl);
        if (jobUrls.has(identity)) errors.push(`${path}.url is a duplicate job URL`);
        jobUrls.add(identity);
        if (BOSS_HOST_PATTERN.test(jobUrl.hostname)) {
          errors.push(`${path}.url cannot use BOSS in a public update`);
        }
      }

      const sourceName = typeof job.source === 'string' ? job.source.trim() : '';
      if (!sourceName || !declaredSources.has(sourceName)) {
        errors.push(`${path}.source must identify a declared source`);
      }
      if (!isDateOnly(job.verifiedAt)) {
        errors.push(`${path}.verifiedAt must use a valid YYYY-MM-DD date`);
      }
      if (Object.hasOwn(job, 'publishedAt') && !isDateOnly(job.publishedAt)) {
        errors.push(`${path}.publishedAt must use a valid YYYY-MM-DD date`);
      }
      validateReview(job.review, `${path}.review`, errors);

      try {
        sanitizedJobs.push(sanitizeBatchJob(job));
      } catch (error) {
        errors.push(`${path}: ${error.message}`);
      }
    });
  }

  if (errors.length > 0) return { batch: null, errors };

  const batch = {
    id: candidate.id,
    generatedAt: candidate.generatedAt,
    verifiedAt: candidate.verifiedAt,
    sources: [...declaredSources.keys()],
    jobs: sanitizedJobs
  };
  try {
    return { batch: validateBatch(batch), errors: [] };
  } catch (error) {
    return { batch: null, errors: [`batch: ${error.message}`] };
  }
}

/**
 * Fetch every validated job page and require deterministic evidence for both
 * the declared company and job title. Only verified jobs are returned in the
 * importable batch. Rejected records contain compact diagnostics, never page
 * bodies, cookies, or other response data.
 */
export async function verifyPublicBatch(batch, {
  fetchPage = defaultFetchPage,
  fetch: fetchImplementation = globalThis.fetch,
  now = () => new Date()
} = {}) {
  if (!isRecord(batch) || !Array.isArray(batch.jobs)) {
    throw new TypeError('verifyPublicBatch requires a validated batch');
  }
  if (typeof fetchPage !== 'function') {
    throw new TypeError('fetchPage must be a function');
  }

  const verifiedJobs = [];
  const rejected = [];
  const evidence = [];

  for (const originalJob of batch.jobs) {
    const job = structuredClone(originalJob);
    const fetchedAtValue = now();
    const fetchedAtDate = fetchedAtValue instanceof Date
      ? new Date(fetchedAtValue.valueOf())
      : new Date(fetchedAtValue);
    if (Number.isNaN(fetchedAtDate.valueOf())) {
      throw new TypeError('now() returned an invalid date');
    }
    const fetchedAt = fetchedAtDate.toISOString();
    const compactJob = {
      title: String(job.title || ''),
      company: String(job.company || ''),
      url: String(job.url || ''),
      source: String(job.source || '')
    };

    let page;
    try {
      page = await fetchPage({
        url: job.url,
        fetch: fetchImplementation,
        job: structuredClone(compactJob)
      });
    } catch (error) {
      rejected.push({
        job: compactJob,
        reason: 'FETCH_FAILED',
        message: error instanceof Error ? error.message : String(error),
        fetchedAt
      });
      continue;
    }

    const finalUrlValue = typeof page?.finalUrl === 'string'
      ? page.finalUrl
      : typeof page?.url === 'string'
        ? page.url
        : job.url;
    const finalUrl = parsePublicUrl(finalUrlValue);
    if (!finalUrl || isBossUrl(finalUrl)) {
      rejected.push({
        job: compactJob,
        reason: 'UNSAFE_FINAL_URL',
        message: 'Redirect destination is BOSS, private, or not public HTTP(S)',
        fetchedAt,
        finalUrl: String(finalUrlValue || '').slice(0, 2000)
      });
      continue;
    }
    const normalizedFinalUrl = normalizedUrl(finalUrl);

    if (page?.ok === false || (Number.isInteger(page?.status) && page.status >= 400)) {
      rejected.push({
        job: compactJob,
        reason: 'FETCH_HTTP_ERROR',
        message: `Source returned HTTP ${page?.status || 'error'}`,
        fetchedAt,
        finalUrl: normalizedFinalUrl
      });
      continue;
    }

    const visibleEvidence = normalizeEvidenceText(
      `${String(page?.title || '')} ${String(page?.text || '')}`.slice(
        0,
        MAX_FETCHED_PAGE_CHARS
      )
    );
    const companyToken = findEvidenceToken(visibleEvidence, job.company, 'company');
    const titleToken = findEvidenceToken(visibleEvidence, job.title, 'title');
    if (!companyToken || !titleToken) {
      rejected.push({
        job: compactJob,
        reason: 'PAGE_EVIDENCE_MISMATCH',
        message: 'Visible page title/text did not confirm both company and job title',
        fetchedAt,
        finalUrl: normalizedFinalUrl,
        evidence: {
          companyMatched: Boolean(companyToken),
          titleMatched: Boolean(titleToken)
        }
      });
      continue;
    }

    const summary = `company token "${companyToken}" and title token "${titleToken}" matched`;
    const verificationNote = [
      `来源核验 ${fetchedAt}`,
      `最终链接 ${normalizedFinalUrl.slice(0, 500)}`,
      summary
    ].join('；');
    job.url = normalizedFinalUrl;
    job.curationNote = [job.curationNote, verificationNote]
      .filter((part) => typeof part === 'string' && part.trim())
      .join('；');
    verifiedJobs.push(job);
    evidence.push({
      title: job.title,
      company: job.company,
      fetchedAt,
      finalUrl: normalizedFinalUrl,
      summary
    });
  }

  return {
    batch: {
      ...structuredClone(batch),
      jobs: verifiedJobs
    },
    evidence,
    rejected
  };
}
