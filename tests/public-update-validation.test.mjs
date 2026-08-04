import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validatePublicBatch,
  verifyPublicBatch
} from '../updates/validate-public-results.mjs';

function candidate(overrides = {}) {
  return {
    id: '2026-08-01-shenzhen-ai-v1',
    generatedAt: '2026-08-01T09:00:00+08:00',
    verifiedAt: '2026-08-01',
    sources: [{
      name: '示例公司招聘官网',
      kind: 'company-career',
      url: 'https://careers.example.com/jobs'
    }],
    jobs: [{
      title: 'AI Agent 实习生',
      company: '示例科技',
      location: '深圳',
      url: 'https://careers.example.com/jobs/agent-intern',
      source: '示例公司招聘官网',
      publishedAt: '2026-07-31',
      verifiedAt: '2026-08-01',
      description: '公开招聘页显示的岗位职责与要求。'
    }],
    ...overrides
  };
}

test('accepts a strictly sourced public batch and converts it for the importer', () => {
  const input = candidate();
  const result = validatePublicBatch(input);

  assert.deepEqual(result.errors, []);
  assert.equal(result.batch.id, input.id);
  assert.deepEqual(result.batch.sources, ['示例公司招聘官网']);
  assert.equal(result.batch.jobs[0].source, '示例公司招聘官网');
  assert.equal(result.batch.jobs[0].verifiedAt, '2026-08-01');
  assert.notEqual(result.batch, input);
});

test('rejects missing or non-public job URLs', () => {
  const missing = candidate({ jobs: [{ ...candidate().jobs[0], url: '' }] });
  const privateUrl = candidate({
    jobs: [{ ...candidate().jobs[0], url: 'http://127.0.0.1/private-job' }]
  });

  assert.match(validatePublicBatch(missing).errors.join('\n'), /jobs\[0\]\.url/);
  assert.match(validatePublicBatch(privateUrl).errors.join('\n'), /public HTTP\(S\)/);
});

test('rejects invalid envelope and job dates', () => {
  const result = validatePublicBatch(candidate({
    id: 'batch-without-version',
    verifiedAt: '2026-02-30',
    jobs: [{ ...candidate().jobs[0], publishedAt: 'yesterday', verifiedAt: '01-08-2026' }]
  }));

  assert.equal(result.batch, null);
  assert.match(result.errors.join('\n'), /batch\.id/);
  assert.match(result.errors.join('\n'), /batch\.verifiedAt/);
  assert.match(result.errors.join('\n'), /jobs\[0\]\.publishedAt/);
  assert.match(result.errors.join('\n'), /jobs\[0\]\.verifiedAt/);
});

test('rejects duplicate job links after URL normalization', () => {
  const first = candidate().jobs[0];
  const result = validatePublicBatch(candidate({
    jobs: [
      first,
      { ...first, title: '重复岗位', url: `${first.url}#details` }
    ]
  }));

  assert.match(result.errors.join('\n'), /duplicate job URL/);
});

test('rejects unsupported source kinds and every BOSS public-update source', () => {
  const unsupported = validatePublicBatch(candidate({
    sources: [{
      name: '社交媒体转载',
      kind: 'social-media',
      url: 'https://social.example/jobs'
    }],
    jobs: [{ ...candidate().jobs[0], source: '社交媒体转载' }]
  }));
  const boss = validatePublicBatch(candidate({
    sources: [{
      name: 'BOSS直聘',
      kind: 'public-aggregator',
      url: 'https://www.zhipin.com/job_detail/example.html'
    }],
    jobs: [{
      ...candidate().jobs[0],
      source: 'BOSS直聘',
      url: 'https://www.zhipin.com/job_detail/example.html'
    }]
  }));

  assert.match(unsupported.errors.join('\n'), /unsupported source kind/);
  assert.match(boss.errors.join('\n'), /BOSS/i);
});

test('requires every job to name a declared source and its own verification date', () => {
  const result = validatePublicBatch(candidate({
    jobs: [{
      ...candidate().jobs[0],
      source: '未声明来源',
      verifiedAt: ''
    }]
  }));

  assert.match(result.errors.join('\n'), /declared source/);
  assert.match(result.errors.join('\n'), /jobs\[0\]\.verifiedAt/);
});

test('rejects spaced and case-insensitive BOSS aliases', () => {
  const result = validatePublicBatch(candidate({
    sources: [{
      name: 'B o S s 招 聘',
      kind: 'public-aggregator',
      url: 'https://jobs.example.com/list'
    }],
    jobs: [{ ...candidate().jobs[0], source: 'B o S s 招 聘' }]
  }));

  assert.match(result.errors.join('\n'), /cannot use BOSS/i);
});

test('rejects private IPv6 and IPv4-mapped IPv6 URLs', () => {
  for (const url of [
    'http://[::1]/job',
    'http://[fc00::1]/job',
    'http://[fe80::1]/job',
    'http://[::ffff:127.0.0.1]/job',
    'http://[::ffff:192.168.1.4]/job'
  ]) {
    const result = validatePublicBatch(candidate({
      jobs: [{ ...candidate().jobs[0], url }]
    }));
    assert.match(result.errors.join('\n'), /public HTTP\(S\)/, url);
  }
});

test('verifies final URL and records compact page evidence before import', async () => {
  const validated = validatePublicBatch(candidate());
  const result = await verifyPublicBatch(validated.batch, {
    now: () => new Date('2026-08-01T02:03:04.000Z'),
    fetchPage: async () => ({
      ok: true,
      status: 200,
      finalUrl: 'https://careers.example.com/jobs/agent-intern-final',
      title: '示例科技 AI Agent 实习生',
      text: '示例科技正在招聘 AI Agent 实习生，工作地点深圳。'
    })
  });

  assert.equal(result.rejected.length, 0);
  assert.equal(result.batch.jobs.length, 1);
  assert.equal(
    result.batch.jobs[0].url,
    'https://careers.example.com/jobs/agent-intern-final'
  );
  assert.equal(result.evidence[0].fetchedAt, '2026-08-01T02:03:04.000Z');
  assert.equal(result.evidence[0].finalUrl, result.batch.jobs[0].url);
  assert.match(result.evidence[0].summary, /company.+title/i);
  assert.match(result.batch.jobs[0].curationNote, /2026-08-01T02:03:04.000Z/);
  assert.doesNotMatch(result.batch.jobs[0].curationNote, /正在招聘/);
});

test('never auto-imports content that does not prove both company and title', async () => {
  const validated = validatePublicBatch(candidate());
  const result = await verifyPublicBatch(validated.batch, {
    fetchPage: async () => ({
      ok: true,
      status: 200,
      finalUrl: candidate().jobs[0].url,
      title: '通用招聘列表',
      text: '这里只有其他公司的数据分析岗位。'
    })
  });

  assert.equal(result.batch.jobs.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].reason, 'PAGE_EVIDENCE_MISMATCH');
});

test('network failures and unsafe redirect destinations never auto-import', async () => {
  const validated = validatePublicBatch(candidate());
  const networkFailure = await verifyPublicBatch(validated.batch, {
    fetchPage: async () => { throw new Error('offline'); }
  });
  const bossRedirect = await verifyPublicBatch(validated.batch, {
    fetchPage: async () => ({
      ok: true,
      status: 200,
      finalUrl: 'https://www.zhipin.com/job_detail/redirected.html',
      title: '示例科技 AI Agent 实习生',
      text: '示例科技 AI Agent 实习生'
    })
  });
  const privateRedirect = await verifyPublicBatch(validated.batch, {
    fetchPage: async () => ({
      ok: true,
      status: 200,
      finalUrl: 'http://[fd00::2]/job',
      title: '示例科技 AI Agent 实习生',
      text: '示例科技 AI Agent 实习生'
    })
  });

  assert.equal(networkFailure.batch.jobs.length, 0);
  assert.equal(networkFailure.rejected[0].reason, 'FETCH_FAILED');
  assert.equal(bossRedirect.batch.jobs.length, 0);
  assert.equal(bossRedirect.rejected[0].reason, 'UNSAFE_FINAL_URL');
  assert.equal(privateRedirect.batch.jobs.length, 0);
  assert.equal(privateRedirect.rejected[0].reason, 'UNSAFE_FINAL_URL');
});

test('hidden or scripted page text cannot satisfy visible evidence checks', async () => {
  const validated = validatePublicBatch(candidate());
  const result = await verifyPublicBatch(validated.batch, {
    fetch: async (url) => ({
      ok: true,
      status: 200,
      url,
      headers: { get: () => 'text/html; charset=utf-8' },
      async text() {
        return [
          '<html><head><title>普通招聘列表</title></head><body>',
          '<script>示例科技 AI Agent 实习生</script>',
          '<div hidden>示例科技 AI Agent 实习生</div>',
          '<p>页面暂未展示岗位详情</p>',
          '</body></html>'
        ].join('');
      }
    })
  });

  assert.equal(result.batch.jobs.length, 0);
  assert.equal(result.rejected[0].reason, 'PAGE_EVIDENCE_MISMATCH');
});
