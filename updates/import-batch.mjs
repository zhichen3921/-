import { JOB_STATUSES, normalizeJob } from '../shared/job-schema.mjs';
import { jobIdentityKeys, mergeJob } from '../shared/deduplicate.mjs';
import { routeMatch, scoreJob } from '../shared/matcher.mjs';
import { sanitizeBatchJob, validateBatch } from './batch-schema.mjs';

const REVIEW_VERDICTS = new Set(['good', 'unknown', 'bad']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateReview(review) {
  if (review === undefined || review === null) return undefined;
  if (!isRecord(review)) {
    throw new TypeError('job.review must be an object');
  }
  if (
    Object.hasOwn(review, 'score')
    && (
      typeof review.score !== 'number'
      || !Number.isFinite(review.score)
      || review.score < 0
      || review.score > 100
    )
  ) {
    throw new TypeError('job.review.score must be a number between 0 and 100');
  }
  if (
    Object.hasOwn(review, 'verdict')
    && (
      typeof review.verdict !== 'string'
      || !REVIEW_VERDICTS.has(review.verdict)
    )
  ) {
    throw new TypeError('job.review.verdict must be good, unknown, or bad');
  }
  if (
    Object.hasOwn(review, 'recommendation')
    && typeof review.recommendation !== 'string'
  ) {
    throw new TypeError('job.review.recommendation must be a string');
  }
  for (const field of ['reasons', 'matchedSkills']) {
    if (
      Object.hasOwn(review, field)
      && (
        !Array.isArray(review[field])
        || review[field].some((item) => typeof item !== 'string')
      )
    ) {
      throw new TypeError(`job.review.${field} must be an array of strings`);
    }
  }

  return Object.fromEntries([
    'score',
    'verdict',
    'recommendation',
    'reasons',
    'matchedSkills'
  ].filter((field) => Object.hasOwn(review, field))
    .map((field) => [field, structuredClone(review[field])]));
}

function prepareJob(input, batch) {
  const sanitized = sanitizeBatchJob(input);
  if (
    Object.hasOwn(input, 'status')
    && (
      typeof input.status !== 'string'
      || !JOB_STATUSES.includes(input.status)
    )
  ) {
    throw new TypeError('job.status is invalid');
  }
  const review = validateReview(sanitized.review);
  return normalizeJob({
    ...sanitized,
    ...(review ? { review } : {}),
    verifiedAt: sanitized.verifiedAt
      || batch.verifiedAt
      || new Date(batch.generatedAt).toISOString().slice(0, 10),
    curatedBatchId: batch.id,
    batchGeneratedAt: batch.generatedAt
  });
}

function recommendationFor(route) {
  if (route === 'queue') return '优先沟通';
  if (route === 'review') return '待复核';
  return '不建议加入';
}

function withMatch(job, preferences) {
  const automatic = scoreJob(job, preferences);
  const reviewedScore = job.review?.score;
  const score = typeof reviewedScore === 'number' && Number.isFinite(reviewedScore)
    ? reviewedScore
    : automatic.score;
  const route = automatic.hardMismatch
    ? 'excluded'
    : routeMatch(score, preferences);
  const reviewedReasons = Array.isArray(job.review?.reasons)
    ? job.review.reasons
    : null;
  const reviewedSkills = Array.isArray(job.review?.matchedSkills)
    ? job.review.matchedSkills
    : null;
  const recommendation = route === 'excluded'
    ? recommendationFor(route)
    : String(job.review?.recommendation || automatic.recommendation || recommendationFor(route));
  const match = {
    ...automatic,
    score,
    route,
    recommendation,
    reasons: reviewedReasons || automatic.reasons,
    matchedSkills: reviewedSkills || automatic.matchedSkills,
    reviewed: typeof reviewedScore === 'number'
  };

  return {
    ...job,
    score,
    route,
    recommendation,
    match
  };
}

function findDuplicate(jobs, candidate) {
  if (candidate.id) {
    const byId = jobs.find((job) => job.id === candidate.id);
    if (byId) return byId;
  }
  const keys = new Set(jobIdentityKeys(candidate));
  if (keys.size === 0) return null;
  return jobs.find((job) => jobIdentityKeys(job).some((key) => keys.has(key))) || null;
}

function emptySummary(batchId) {
  return {
    batchId,
    queued: 0,
    review: 0,
    excluded: 0,
    duplicates: 0,
    invalid: 0
  };
}

export async function importBatch({ store, batch } = {}) {
  if (!store || typeof store.update !== 'function') {
    throw new TypeError('importBatch requires a store with update()');
  }
  const validated = validateBatch(batch);
  const summary = emptySummary(validated.id);

  await store.update((state) => {
    if (state.importedBatchIds.includes(validated.id)) {
      summary.duplicates = validated.jobs.length;
      return;
    }

    for (const input of validated.jobs) {
      let candidate;
      try {
        candidate = withMatch(prepareJob(input, validated), state.preferences);
      } catch {
        summary.invalid += 1;
        continue;
      }

      const keys = jobIdentityKeys(candidate);
      const hasExplicitId = typeof input?.id === 'string' && input.id.trim().length > 0;
      if (!hasExplicitId && keys.length === 0) {
        summary.invalid += 1;
        continue;
      }
      const deleted = state.deletedKeys.includes(`id:${candidate.id}`)
        || keys.some((key) => state.deletedKeys.includes(key));
      if (deleted) {
        summary.duplicates += 1;
        continue;
      }

      const existing = findDuplicate(state.jobs, candidate);
      if (candidate.route === 'excluded') {
        if (existing) {
          summary.duplicates += 1;
        } else {
          summary.excluded += 1;
        }
        continue;
      }

      if (existing) {
        const index = state.jobs.findIndex((job) => job.id === existing.id);
        const merged = mergeJob(existing, candidate);
        state.jobs[index] = withMatch(merged, state.preferences);
        summary.duplicates += 1;
        continue;
      }

      state.jobs.push(candidate);
      const summaryField = candidate.route === 'queue' ? 'queued' : candidate.route;
      summary[summaryField] += 1;
    }

    state.importedBatchIds.push(validated.id);
  });

  return summary;
}
