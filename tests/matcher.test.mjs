import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeJob } from '../shared/job-schema.mjs';
import { routeMatch, scoreJob } from '../shared/matcher.mjs';

const preferences = {
  queueThreshold: 75,
  reviewThreshold: 60,
  primaryDirections: [
    'agent',
    'llm-workflow',
    'machine-learning',
    'data-analysis',
    'ai-product',
    'electronics-ai'
  ],
  stretchDirections: ['llm-training', 'computer-vision', 'speech'],
  stretchEnabled: true,
  graduationYears: ['2028'],
  locations: ['深圳', '远程']
};

test('routes scores at the exact configured boundaries', () => {
  assert.equal(routeMatch(75, preferences), 'queue');
  assert.equal(routeMatch(74, preferences), 'review');
  assert.equal(routeMatch(60, preferences), 'review');
  assert.equal(routeMatch(59, preferences), 'excluded');
});

test('scores a well-evidenced Shenzhen Agent internship into the main queue', () => {
  const job = normalizeJob({
    title: 'AI Agent 应用开发实习生',
    company: '示例科技',
    location: '深圳市南山区',
    url: 'https://example.com/jobs/agent-intern',
    description: [
      '面向 2028 届在校硕士招聘实习生。',
      '使用 Python、Prompt 和大模型 API 开发 Agent 工作流，',
      '参与数据处理、机器学习建模与效果分析。'
    ].join('')
  });

  const result = scoreJob(job, preferences);

  assert.equal(result.route, 'queue');
  assert.ok(result.score >= 75);
  assert.equal(result.hardMismatch, false);
  assert.ok(result.matchedSkills.includes('Python'));
  assert.ok(result.matchedSkills.includes('大模型 API'));
});

test('routes a relevant job with insufficient requirements to review', () => {
  const result = scoreJob(normalizeJob({
    title: 'AI Agent 实习生',
    company: '示例科技',
    location: '深圳',
    description: '负责 Agent 相关工作'
  }), preferences);

  assert.equal(result.route, 'review');
  assert.ok(result.gaps.includes('岗位要求信息不足'));
});

test('excludes an explicit non-2028 graduation restriction', () => {
  const result = scoreJob(normalizeJob({
    title: '机器学习实习生',
    company: '示例科技',
    location: '深圳',
    description: '仅面向 2026 届或 2027 届学生，使用 Python 完成机器学习建模与数据分析。'
  }), preferences);

  assert.equal(result.route, 'excluded');
  assert.equal(result.hardMismatch, true);
  assert.ok(result.gaps.some((gap) => gap.includes('毕业年份')));
});

test('excludes a mandatory credential absent from the approved resume facts', () => {
  const result = scoreJob(normalizeJob({
    title: 'AI 产品实习生',
    company: '示例科技',
    location: '深圳',
    description: '参与 AI 产品需求与数据分析，要求英语六级（CET-6）证书，必须提供成绩证明。'
  }), preferences);

  assert.equal(result.route, 'excluded');
  assert.equal(result.hardMismatch, true);
  assert.ok(result.gaps.some((gap) => gap.includes('英语六级')));
});

test('does not treat optional, preferred, bonus, or negated credentials as mandatory', () => {
  const descriptions = [
    '参与 AI 产品数据分析，英语六级优先。',
    '参与 AI 产品数据分析，持有 CET-6 可以加分。',
    '参与 AI 产品数据分析，无需英语六级。',
    '参与 AI 产品数据分析，不要求 CET-6 证书。',
    '参与 AI 产品数据分析，不需要提供英语六级证书。'
  ];

  for (const description of descriptions) {
    const result = scoreJob(normalizeJob({
      title: 'AI 产品实习生',
      company: '示例科技',
      location: '深圳',
      description: `${description} 面向 2028 届实习生，使用 Python 处理业务数据。`
    }), preferences);
    assert.equal(result.hardMismatch, false, description);
    assert.ok(!result.gaps.some((gap) => gap.includes('英语六级')), description);
  }
});

test('excludes a location outside configured choices without remote support', () => {
  const result = scoreJob(normalizeJob({
    title: 'AI Agent 实习生',
    company: '示例科技',
    location: '北京市海淀区',
    description: '使用 Python 和大模型 API 参与 Agent 应用开发，面向 2028 届在校生招聘。'
  }), preferences);

  assert.equal(result.route, 'excluded');
  assert.equal(result.hardMismatch, true);
  assert.ok(result.gaps.some((gap) => gap.includes('工作地点')));
});

test('does not mistake negated remote wording for remote support', () => {
  for (const phrase of ['不支持远程', '不接受 remote 工作']) {
    const result = scoreJob(normalizeJob({
      title: 'AI Agent 实习生',
      company: '示例科技',
      location: '北京',
      description: `面向 2028 届实习生，使用 Python 和大模型 API 开发 Agent；本岗位${phrase}。`
    }), preferences);

    assert.equal(result.route, 'excluded', phrase);
    assert.equal(result.hardMismatch, true, phrase);
    assert.ok(result.gaps.some((gap) => gap.includes('工作地点')), phrase);
  }
});

test('routes ambiguous locations to information review instead of hard mismatch', () => {
  for (const location of ['全国', '多地', '待定', '未定', '线上线下']) {
    const result = scoreJob(normalizeJob({
      title: 'AI Agent 实习生',
      company: '示例科技',
      location,
      description: '面向 2028 届实习生，使用 Python、Prompt 和大模型 API 开发 Agent 工作流。'
    }), preferences);
    assert.equal(result.route, 'review', location);
    assert.equal(result.hardMismatch, false, location);
    assert.ok(result.gaps.some((gap) => gap.includes('工作地点')), location);
  }
});

test('ignores incidental graduation-year references outside restriction context', () => {
  const descriptions = [
    '团队曾在 2027 届校招中获奖，目前招募在校实习生，使用 Python 完成机器学习和数据分析。',
    '团队曾招聘 2027 届毕业生，目前岗位面向不限年级的在校实习生，使用 Python 完成机器学习和数据分析。'
  ];
  for (const description of descriptions) {
    const result = scoreJob(normalizeJob({
      title: '机器学习实习生',
      company: '示例科技',
      location: '深圳',
      description
    }), preferences);

    assert.equal(result.hardMismatch, false, description);
    assert.notEqual(result.route, 'excluded', description);
    assert.ok(!result.gaps.some((gap) => gap.includes('毕业年份限制')), description);
  }
});

test('uses explicit job.graduationYears as a graduation restriction', () => {
  const result = scoreJob(normalizeJob({
    title: '机器学习实习生',
    company: '示例科技',
    location: '深圳',
    graduationYears: ['2027'],
    description: '招聘在校实习生，使用 Python 完成机器学习建模和数据分析。'
  }), preferences);

  assert.equal(result.route, 'excluded');
  assert.equal(result.hardMismatch, true);
  assert.ok(result.gaps.some((gap) => gap.includes('毕业年份限制')));
});

test('does not promote a short unrelated listing merely because details are missing', () => {
  const result = scoreJob(normalizeJob({
    title: '行政助理',
    company: '示例科技',
    location: '深圳',
    description: '协助日常行政工作'
  }), preferences);

  assert.equal(result.route, 'excluded');
  assert.ok(result.gaps.includes('岗位要求信息不足'));
});

test('raises a relevant AI internship with missing location and description to review threshold', () => {
  const result = scoreJob(normalizeJob({
    title: 'AI Agent 实习生',
    company: '示例科技',
    location: '',
    description: '负责 Agent 相关工作'
  }), preferences);

  assert.equal(result.score, 60);
  assert.equal(result.route, 'review');
  assert.equal(result.hardMismatch, false);
  assert.ok(result.gaps.includes('岗位要求信息不足'));
  assert.ok(result.gaps.includes('工作地点信息不足'));
});

test('normalization rejects non-http job links', () => {
  assert.throws(
    () => normalizeJob({ title: 'AI 实习生', url: 'javascript:alert(1)' }),
    /http|https/i
  );
});

test('normalization rejects URLs over 1000 characters instead of truncating them', () => {
  const longUrl = `https://example.com/${'a'.repeat(1_001)}`;
  assert.ok(longUrl.length > 1_000);
  assert.throws(
    () => normalizeJob({ title: 'AI 实习生', url: longUrl }),
    /1000|过长/
  );
});
