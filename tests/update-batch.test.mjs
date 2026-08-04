import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

import { createStore } from '../server/store.mjs';
import { defaultState } from '../server/state-schema.mjs';
import { jobIdentityKeys } from '../shared/deduplicate.mjs';
import { normalizeJob } from '../shared/job-schema.mjs';
import { validateBatch } from '../updates/batch-schema.mjs';
import { importBatch } from '../updates/import-batch.mjs';

const projectRoot = new URL('../', import.meta.url);

function queueJob(overrides = {}) {
  return {
    id: 'queue-job',
    title: 'AI Agent 应用实习生',
    company: '示例科技',
    location: '深圳',
    url: 'https://example.com/jobs/agent-intern',
    source: '示例招聘',
    publishedAt: '2026-07-30',
    description: '面向 2028 届在校实习生，使用 Python、Prompt 和大模型 API 开发 Agent 工作流并处理数据。',
    review: {
      score: 88,
      verdict: 'good',
      recommendation: '优先沟通',
      reasons: ['Python 与 Agent 方向匹配'],
      matchedSkills: ['Python', '大模型 API']
    },
    ...overrides
  };
}

function fixtureBatch(overrides = {}) {
  return {
    id: '2026-07-31-test-v1',
    generatedAt: '2026-07-31T09:00:00+08:00',
    verifiedAt: '2026-07-31',
    sources: ['示例招聘'],
    jobs: [queueJob()],
    ...overrides
  };
}

async function makeStore(initialState = defaultState()) {
  const directory = await mkdtemp(join(tmpdir(), 'desk-update-batch-'));
  return createStore({
    filePath: join(directory, 'state.json'),
    initialState
  });
}

test('strictly validates the top-level batch without rejecting individual job contents', () => {
  assert.throws(
    () => validateBatch({ generatedAt: '2026-07-31T09:00:00+08:00', sources: [], jobs: [] }),
    /id/
  );
  assert.throws(
    () => validateBatch(fixtureBatch({ generatedAt: 'not-a-date' })),
    /generatedAt/
  );
  assert.throws(
    () => validateBatch(fixtureBatch({ generatedAt: '2026-02-30T09:00:00+08:00' })),
    /generatedAt/
  );
  assert.throws(
    () => validateBatch(fixtureBatch({ sources: '示例招聘' })),
    /sources/
  );
  assert.throws(
    () => validateBatch(fixtureBatch({ jobs: {} })),
    /jobs/
  );
  assert.throws(
    () => validateBatch({ ...fixtureBatch(), unexpected: true }),
    /unexpected/
  );

  const validated = validateBatch(fixtureBatch({ jobs: [null] }));
  assert.deepEqual(validated.jobs, [null]);
  assert.deepEqual(
    validateBatch(fixtureBatch({ jobs: [() => undefined] })).jobs,
    [null]
  );
});

test('the same batch imports only once and respects deleted keys', async () => {
  const deleted = queueJob({
    id: 'deleted-job',
    title: '机器学习数据实习生',
    url: 'https://example.com/jobs/deleted'
  });
  const deletedKey = jobIdentityKeys(deleted)[0];
  const store = await makeStore({
    ...defaultState(),
    deletedKeys: [deletedKey]
  });
  const batch = fixtureBatch({ jobs: [queueJob(), deleted] });

  const first = await importBatch({ store, batch });
  const second = await importBatch({ store, batch });

  assert.deepEqual(first, {
    batchId: batch.id,
    queued: 1,
    review: 0,
    excluded: 0,
    duplicates: 1,
    invalid: 0
  });
  assert.deepEqual(second, {
    batchId: batch.id,
    queued: 0,
    review: 0,
    excluded: 0,
    duplicates: 2,
    invalid: 0
  });
  const state = await store.read();
  assert.equal(state.jobs.length, 1);
  assert.deepEqual(state.importedBatchIds, [batch.id]);
});

test('counts invalid jobs and excluded jobs without persisting either', async () => {
  const store = await makeStore();
  const batch = fixtureBatch({
    id: 'mixed-results-v1',
    jobs: [
      queueJob(),
      queueJob({
        id: 'invalid-job',
        title: '无效链接岗位',
        url: 'javascript:alert(1)'
      }),
      queueJob({
        id: 'invalid-status-job',
        title: '无效状态岗位',
        url: 'https://example.com/jobs/invalid-status',
        status: 'sent-by-batch'
      }),
      {
        title: '缺少稳定身份的岗位',
        description: 'AI 实习岗位，但没有来源链接、公司地点或显式岗位 ID。'
      },
      queueJob({
        id: 'excluded-job',
        title: '低分冲刺岗位',
        url: 'https://example.com/jobs/excluded',
        review: {
          score: 59,
          verdict: 'unknown',
          recommendation: '低优先',
          reasons: ['技能证据不足'],
          matchedSkills: ['Python']
        }
      })
    ]
  });

  const summary = await importBatch({ store, batch });
  const state = await store.read();

  assert.deepEqual(summary, {
    batchId: batch.id,
    queued: 1,
    review: 0,
    excluded: 1,
    duplicates: 0,
    invalid: 3
  });
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].id, 'queue-job');
  assert.deepEqual(state.importedBatchIds, [batch.id]);
});

test('skips each malformed job field while importing valid siblings', async () => {
  const malformedJobs = [
    queueJob({ id: 'bad-title-type', title: {} }),
    queueJob({ id: 'blank-title', title: '   ' }),
    queueJob({ id: 'bad-company-type', company: 42 }),
    queueJob({ id: 'blank-company', company: '' }),
    queueJob({ id: 'bad-location-type', location: [] }),
    queueJob({ id: 'bad-url-type', url: 123 }),
    queueJob({ id: 'bad-description-type', description: {} }),
    queueJob({ id: 'bad-source-type', source: false }),
    queueJob({ id: 'bad-published-type', publishedAt: 20260731 }),
    queueJob({ id: 'bad-published-date', publishedAt: '2026-02-30' }),
    queueJob({ id: 'bad-verified-type', verifiedAt: {} }),
    queueJob({ id: 'bad-verified-date', verifiedAt: '31-07-2026' }),
    queueJob({ id: 'bad-curation-note-type', curationNote: [] }),
    queueJob({ id: 'bad-directions-type', directions: 'Agent' }),
    queueJob({ id: 'bad-directions-item', directions: ['Agent', 7] }),
    queueJob({ id: 'bad-graduation-years-type', graduationYears: '2028' }),
    queueJob({ id: 'bad-graduation-years-item', graduationYears: ['2028', 2029] }),
    queueJob({ id: 'bad-duration-type', durationMonths: '3' }),
    queueJob({ id: 'bad-duration-number', durationMonths: Number.NaN }),
    queueJob({ id: 'bad-days-type', daysPerWeek: '5' }),
    queueJob({ id: 'bad-days-number', daysPerWeek: Number.POSITIVE_INFINITY }),
    queueJob({ id: 'bad-active-type', active: 'yes' })
  ];
  const store = await makeStore();
  const batch = fixtureBatch({
    id: 'malformed-fields-v1',
    jobs: [queueJob(), ...malformedJobs]
  });

  const summary = await importBatch({ store, batch });
  const state = await store.read();

  assert.equal(summary.invalid, malformedJobs.length);
  assert.equal(summary.queued, 1);
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].id, 'queue-job');
  assert.deepEqual(state.importedBatchIds, [batch.id]);
});

test('strips user state from batch jobs and preserves an intentionally empty edited greeting', async () => {
  const existing = normalizeJob({
    ...queueJob(),
    greeting: '',
    greetingEdited: true,
    status: 'contacted',
    notes: 'keep my note'
  });
  const store = await makeStore({
    ...defaultState(),
    jobs: [existing]
  });
  const incoming = queueJob({
    status: 'replied',
    greeting: 'AUTO GENERATED GREETING',
    greetingEdited: false,
    notes: 'batch note must not persist',
    manualFields: ['company'],
    manualTags: ['injected'],
    manualNotes: 'injected manual note',
    viewedAt: '2026-07-31T10:00:00.000Z',
    lastViewedAt: '2026-07-31T11:00:00.000Z',
    createdAt: '2000-01-01T00:00:00.000Z',
    updatedAt: '2000-01-01T00:00:00.000Z'
  });

  const summary = await importBatch({
    store,
    batch: fixtureBatch({ id: 'strip-user-state-v1', jobs: [incoming] })
  });
  const [saved] = (await store.read()).jobs;

  assert.equal(summary.duplicates, 1);
  assert.equal(saved.status, 'contacted');
  assert.equal(saved.greeting, '');
  assert.equal(saved.greetingEdited, true);
  assert.equal(saved.notes, 'keep my note');
  assert.equal(saved.manualTags, undefined);
  assert.equal(saved.manualNotes, undefined);
  assert.equal(saved.viewedAt, undefined);
  assert.equal(saved.lastViewedAt, undefined);
  assert.notEqual(saved.createdAt, '2000-01-01T00:00:00.000Z');
});

test('does not persist user state supplied for a new batch job', async () => {
  const store = await makeStore();
  const incoming = queueJob({
    id: 'new-state-injection',
    url: 'https://example.com/jobs/new-state-injection',
    status: 'replied',
    greeting: 'batch greeting',
    greetingEdited: true,
    notes: 'batch note',
    manualFields: ['title'],
    manualTags: ['batch-tag'],
    viewedAt: '2026-07-31T10:00:00.000Z'
  });

  const summary = await importBatch({
    store,
    batch: fixtureBatch({ id: 'new-job-user-state-v1', jobs: [incoming] })
  });
  const [saved] = (await store.read()).jobs;

  assert.equal(summary.queued, 1);
  assert.equal(saved.status, 'todo');
  assert.equal(saved.greeting, '');
  assert.equal(saved.greetingEdited, false);
  assert.equal(saved.notes, '');
  assert.equal(saved.manualFields, undefined);
  assert.equal(saved.manualTags, undefined);
  assert.equal(saved.viewedAt, undefined);
});

test('duplicate refresh preserves manual fields, communication status, and greeting', async () => {
  const existing = normalizeJob({
    ...queueJob(),
    title: '人工修改的岗位名',
    description: '人工修改的岗位描述',
    status: 'contacted',
    greeting: '这是我手动编辑的话术',
    greetingEdited: true,
    manualFields: ['title', 'description']
  });
  const store = await makeStore({
    ...defaultState(),
    jobs: [existing]
  });
  const incoming = queueJob({
    title: '来源更新后的岗位名',
    description: '来源更新后的完整岗位描述，仍然要求使用 Python、Prompt 和大模型 API 构建 Agent。',
    review: {
      score: 91,
      verdict: 'good',
      recommendation: '优先沟通',
      reasons: ['来源已更新'],
      matchedSkills: ['Python', '大模型 API']
    }
  });

  const summary = await importBatch({
    store,
    batch: fixtureBatch({ id: 'duplicate-refresh-v1', jobs: [incoming] })
  });
  const [saved] = (await store.read()).jobs;

  assert.equal(summary.duplicates, 1);
  assert.equal(saved.title, '人工修改的岗位名');
  assert.equal(saved.description, '人工修改的岗位描述');
  assert.equal(saved.status, 'contacted');
  assert.equal(saved.greeting, '这是我手动编辑的话术');
  assert.equal(saved.greetingEdited, true);
  assert.deepEqual(saved.manualFields, ['title', 'description']);
  assert.equal(saved.review.score, 91);
});

test('records a batch id even when every valid job is already present', async () => {
  const existing = normalizeJob(queueJob());
  const store = await makeStore({
    ...defaultState(),
    jobs: [existing]
  });
  const batch = fixtureBatch({ id: 'all-duplicates-v1' });

  const summary = await importBatch({ store, batch });
  const state = await store.read();

  assert.equal(summary.duplicates, 1);
  assert.equal(state.jobs.length, 1);
  assert.ok(state.importedBatchIds.includes(batch.id));
});

test('converted JSON preserves all eight legacy curated jobs losslessly', async () => {
  const legacySource = await readFile(new URL('curated-jobs.js', projectRoot), 'utf8');
  const context = { window: {} };
  vm.runInNewContext(legacySource, context, { filename: 'curated-jobs.js' });
  const legacy = JSON.parse(JSON.stringify(context.window.CURATED_BATCH));
  const converted = JSON.parse(await readFile(
    new URL('data/update-batches/2026-07-31-shenzhen-ai-v1.json', projectRoot),
    'utf8'
  ));

  assert.equal(converted.id, legacy.id);
  assert.equal(converted.verifiedAt, legacy.verifiedAt);
  assert.equal(converted.jobs.length, 8);
  assert.deepEqual(converted.jobs, legacy.jobs);
  assert.deepEqual(
    [...converted.sources].sort(),
    [...new Set(legacy.jobs.map((job) => job.source))].sort()
  );
  assert.ok(Number.isFinite(Date.parse(converted.generatedAt)));
});

test('imports the converted curated batch as four queue, three review, and one excluded', async () => {
  const batch = JSON.parse(await readFile(
    new URL('data/update-batches/2026-07-31-shenzhen-ai-v1.json', projectRoot),
    'utf8'
  ));
  const store = await makeStore();

  const summary = await importBatch({ store, batch });
  const state = await store.read();

  assert.deepEqual(summary, {
    batchId: '2026-07-31-shenzhen-ai-v1',
    queued: 4,
    review: 3,
    excluded: 1,
    duplicates: 0,
    invalid: 0
  });
  assert.equal(state.jobs.length, 7);
  assert.deepEqual(
    state.jobs.map((job) => job.review.score),
    [94, 90, 82, 77, 74, 63, 60]
  );
});
