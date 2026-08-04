import test from 'node:test';
import assert from 'node:assert/strict';

await import('../client/filters.js');
await import('../client/update-center.js');
const { createApiClient } = await import('../client/api.js');

const {
  availableFilterOptions,
  createEmptyFilters,
  filterJobs,
  hasActiveFilters
} = globalThis.ApplicationDeskFilters;

const {
  normalizeUpdates,
  statusForLog
} = globalThis.ApplicationDeskUpdateCenter;

function fixtureJobs() {
  return [
    {
      id: 'agent-2028-todo',
      title: 'AI Agent 实习生',
      company: '青柠智能',
      location: '深圳·南山',
      description: '面向 2028 届，负责 Agent 与大模型工作流。',
      source: 'BOSS直聘',
      route: 'queue',
      directions: ['agent', 'llm-workflow'],
      graduationYears: ['2028'],
      durationMonths: 3,
      daysPerWeek: 4,
      status: 'todo',
      active: true,
      publishedAt: '2026-07-28',
      viewedAt: ''
    },
    {
      id: 'ml-review-viewed',
      title: '机器学习实习生',
      company: '林下数据',
      location: '深圳市福田区',
      description: '参与机器学习建模和数据分析。',
      source: '公司官网',
      route: 'review',
      directions: ['machine-learning', 'data-analysis'],
      graduationYears: [],
      durationMonths: 6,
      daysPerWeek: 5,
      status: 'todo',
      active: true,
      publishedAt: '2026-06-01',
      viewedAt: '2026-07-30T08:00:00.000Z'
    },
    {
      id: 'agent-beijing-contacted',
      title: '智能体开发实习生',
      company: '青柠智能',
      location: '北京·海淀',
      description: 'Agent 开发，接受 2028 届。',
      source: 'BOSS直聘',
      route: 'queue',
      directions: ['agent'],
      graduationYears: ['2028'],
      durationMonths: 3,
      daysPerWeek: 4,
      status: 'contacted',
      active: true,
      publishedAt: '2026-07-29',
      viewedAt: '2026-07-30T08:00:00.000Z'
    },
    {
      id: 'product-inactive',
      title: 'AI 产品实习生',
      company: '纸上科技',
      location: '深圳·宝安',
      description: 'AI 产品岗位，面向 2027 届。',
      source: '学校就业网',
      route: 'review',
      directions: ['ai-product'],
      graduationYears: ['2027'],
      durationMonths: 4,
      daysPerWeek: 3,
      status: 'skipped',
      active: false,
      publishedAt: '2026-07-15',
      viewedAt: ''
    }
  ];
}

test('filters by route, direction, graduation year and status together', () => {
  const result = filterJobs(fixtureJobs(), {
    routes: ['queue'],
    directions: ['agent'],
    graduationYears: ['2028'],
    statuses: ['todo']
  });

  assert.deepEqual(result.map((job) => job.id), ['agent-2028-todo']);
});

test('uses OR within one filter and AND between filter groups', () => {
  const result = filterJobs(fixtureJobs(), {
    companies: ['青柠智能', '林下数据'],
    districts: ['南山', '福田'],
    statuses: ['todo']
  });

  assert.deepEqual(
    result.map((job) => job.id),
    ['agent-2028-todo', 'ml-review-viewed']
  );
});

test('filters explicit 2028 acceptance and recent publication without treating unknown as accepted', () => {
  const result = filterJobs(fixtureJobs(), {
    accepts2028: true,
    publishedWithinDays: 7,
    now: '2026-07-31T00:00:00.000Z'
  });

  assert.deepEqual(
    result.map((job) => job.id),
    ['agent-2028-todo', 'agent-beijing-contacted']
  );
});

test('2028 acceptance rejects negated and other-year-only wording', () => {
  const jobs = [
    {
      id: 'positive-text',
      title: 'AI 实习生',
      description: '明确接受 2028 届在校生投递。'
    },
    {
      id: 'positive-field',
      title: '数据实习生',
      graduationYears: ['2028'],
      description: '面向在校生。'
    },
    {
      id: 'negative-accept',
      title: '算法实习生',
      graduationYears: ['2028'],
      description: '不接受 2028 届，本岗位仅面向 2027 届。'
    },
    {
      id: 'negative-recruit',
      title: 'Agent 实习生',
      description: '不招2028届毕业生。'
    },
    {
      id: 'other-years-only',
      title: 'AI 产品实习生',
      description: '仅限 2026、2027 届投递。'
    },
    {
      id: 'incidental-year',
      title: '机器学习实习生',
      description: '团队已有 2028 届同学，现面向各年级招聘。'
    }
  ];

  assert.deepEqual(
    filterJobs(jobs, { accepts2028: true }).map((job) => job.id),
    ['positive-text', 'positive-field']
  );
});

test('recommendation levels distinguish priority, suggested and review jobs', () => {
  const jobs = [
    { id: 'priority', route: 'queue', recommendation: '优先沟通' },
    { id: 'suggested', route: 'queue', recommendation: '建议沟通' },
    { id: 'review', route: 'review', recommendation: '冲刺复核' }
  ];

  assert.deepEqual(
    filterJobs(jobs, { recommendationLevels: ['priority'] }).map((job) => job.id),
    ['priority']
  );
  assert.deepEqual(
    filterJobs(jobs, { recommendationLevels: ['suggested'] }).map((job) => job.id),
    ['suggested']
  );
  assert.deepEqual(
    filterJobs(jobs, { recommendationLevels: ['review'] }).map((job) => job.id),
    ['review']
  );
});

test('filters viewed, active, duration and weekly attendance together', () => {
  const result = filterJobs(fixtureJobs(), {
    viewedStates: ['viewed'],
    activeStates: ['active'],
    durationMonths: [6],
    daysPerWeek: [5]
  });

  assert.deepEqual(result.map((job) => job.id), ['ml-review-viewed']);
});

test('falls back from legacy verdicts and infers directions when durable fields are absent', () => {
  const legacyJobs = [{
    id: 'legacy',
    title: '大模型 Agent 实习生',
    company: '旧版公司',
    location: '深圳南山',
    description: '负责 Prompt 工作流',
    verdict: 'unknown',
    status: 'todo'
  }];

  assert.deepEqual(
    filterJobs(legacyJobs, {
      routes: ['review'],
      directions: ['agent', 'llm-workflow']
    }).map((job) => job.id),
    ['legacy']
  );
});

test('available options are deduplicated, normalized and deterministically ordered', () => {
  const options = availableFilterOptions(fixtureJobs());

  assert.deepEqual(options.routes, ['queue', 'review']);
  assert.deepEqual(options.companies, ['林下数据', '青柠智能', '纸上科技']);
  assert.deepEqual(options.sources, ['公司官网', '学校就业网', 'BOSS直聘']);
  assert.deepEqual(options.districts, ['宝安', '福田', '海淀', '南山']);
  assert.deepEqual(options.durationMonths, [3, 4, 6]);
  assert.deepEqual(options.daysPerWeek, [3, 4, 5]);
});

test('clear-filter state is fresh and reports no active filters', () => {
  const first = createEmptyFilters();
  first.routes.push('queue');
  const second = createEmptyFilters();

  assert.deepEqual(second.routes, []);
  assert.equal(hasActiveFilters(second), false);
  assert.equal(hasActiveFilters({ ...second, accepts2028: true }), true);
});

test('update model preserves truthful schedule, discovery, failures and extension state', () => {
  const updates = normalizeUpdates({
    status: 'running',
    nextRunAt: '2026-08-02T01:00:00.000Z',
    todayDiscovered: 17,
    failedSources: ['某公司招聘页'],
    extension: {
      paired: true,
      lastHeartbeatAt: '2026-08-01T03:00:00.000Z'
    },
    logs: [{ source: '未知来源', message: '等待确认' }]
  });

  assert.equal(updates.nextRunAt, '2026-08-02T01:00:00.000Z');
  assert.equal(updates.todayDiscovered, 17);
  assert.deepEqual(updates.failedSources, ['某公司招聘页']);
  assert.equal(updates.extension.status, 'connected');
  assert.equal(statusForLog(updates.logs[0]), 'unknown');
});

test('API client uses granular job writes and user-triggered extension pairing', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, ...options });
    if (url.endsWith('/api/bootstrap')) {
      return new Response(JSON.stringify({ token: 'runtime-token' }), { status: 200 });
    }
    return new Response(JSON.stringify(
      url.endsWith('/api/extension/pair')
        ? { extensionToken: 'extension-secret' }
        : { job: { id: 'job-1' } }
    ), { status: 200 });
  };
  const client = createApiClient({ baseUrl: 'http://127.0.0.1:43127', fetchImpl });

  await client.createJob({ title: 'AI 实习生' });
  await client.patchJob('job-1', { status: 'contacted' });
  await client.deleteJob('job-1');
  const pairing = await client.pairExtension();

  assert.equal(pairing.extensionToken, 'extension-secret');
  assert.deepEqual(
    calls.filter((call) => !call.url.endsWith('/api/bootstrap')).map((call) => [call.method, call.url]),
    [
      ['POST', 'http://127.0.0.1:43127/api/jobs'],
      ['PATCH', 'http://127.0.0.1:43127/api/jobs/job-1'],
      ['DELETE', 'http://127.0.0.1:43127/api/jobs/job-1'],
      ['POST', 'http://127.0.0.1:43127/api/extension/pair']
    ]
  );
  assert.ok(calls.slice(1).every((call) => call.headers['x-desk-token'] === 'runtime-token'));
});
