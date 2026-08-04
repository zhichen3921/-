import test from 'node:test';
import assert from 'node:assert/strict';

import { jobIdentityKeys, mergeJob } from '../shared/deduplicate.mjs';

test('identity keys normalize tracking parameters and title whitespace', () => {
  const first = jobIdentityKeys({
    title: 'AI Agent 实习生',
    company: '示例科技',
    location: '深圳 南山区',
    url: 'https://EXAMPLE.com/jobs/123/?utm_source=feed#details'
  });
  const second = jobIdentityKeys({
    title: ' ai agent  实习生 ',
    company: '示例科技',
    location: '深圳  南山区',
    url: 'https://example.com/jobs/123'
  });

  assert.ok(first.some((key) => second.includes(key)));
  assert.ok(first.includes('url:https://example.com/jobs/123'));
  assert.ok(first.includes('company-title-location:示例科技::ai agent 实习生::深圳 南山区'));
});

test('merge preserves user state and edited greeting', () => {
  const existing = {
    id: '1',
    status: 'contacted',
    greeting: '我的话术',
    greetingEdited: true,
    title: 'Agent 实习生',
    company: '示例科技',
    description: '旧描述',
    createdAt: '2026-07-01T00:00:00.000Z'
  };

  const merged = mergeJob(existing, {
    title: 'Agent 工程实习生',
    company: '示例科技',
    description: '新的完整岗位描述',
    status: 'todo',
    greeting: '自动话术',
    greetingEdited: false
  });

  assert.equal(merged.id, '1');
  assert.equal(merged.status, 'contacted');
  assert.equal(merged.greeting, '我的话术');
  assert.equal(merged.greetingEdited, true);
  assert.equal(merged.createdAt, '2026-07-01T00:00:00.000Z');
  assert.equal(merged.description, '新的完整岗位描述');
});

test('merge does not erase existing details with blank incoming values', () => {
  const merged = mergeJob(
    {
      id: 'job-1',
      title: '机器学习实习生',
      company: '示例科技',
      location: '深圳',
      url: 'https://example.com/jobs/1',
      status: 'todo',
      greeting: '已有话术',
      notes: '人工备注'
    },
    {
      title: '机器学习实习生',
      company: '',
      location: '',
      url: '',
      description: '更新后的岗位要求'
    }
  );

  assert.equal(merged.company, '示例科技');
  assert.equal(merged.location, '深圳');
  assert.equal(merged.url, 'https://example.com/jobs/1');
  assert.equal(merged.greeting, '已有话术');
  assert.equal(merged.notes, '人工备注');
});

test('identity falls back to company, title, and location when no URL is available', () => {
  assert.deepEqual(
    jobIdentityKeys({ company: ' 示例 科技 ', title: 'AI 产品实习生', location: ' 深圳 ' }),
    ['company-title-location:示例 科技::ai 产品实习生::深圳']
  );
});

test('does not create a fallback identity when location is missing', () => {
  assert.deepEqual(
    jobIdentityKeys({ company: '示例科技', title: 'AI 产品实习生' }),
    []
  );
  assert.deepEqual(
    jobIdentityKeys({
      company: '示例科技',
      title: 'AI 产品实习生',
      url: 'https://example.com/jobs/ai-product'
    }),
    ['url:https://example.com/jobs/ai-product']
  );
});

test('merge preserves every field named in existing.manualFields', () => {
  const existing = {
    id: 'manual-job',
    title: '人工岗位名',
    company: '旧公司',
    location: '人工地点',
    url: 'https://example.com/manual-url',
    description: '人工修改的岗位描述',
    status: 'contacted',
    greeting: '人工话术',
    greetingEdited: true,
    manualFields: ['title', 'location', 'url', 'description']
  };

  const merged = mergeJob(existing, {
    title: '抓取岗位名',
    company: '新公司',
    location: '抓取地点',
    url: 'https://example.com/refreshed-url',
    description: '抓取描述',
    status: 'todo',
    greeting: '自动话术',
    manualFields: []
  });

  assert.equal(merged.title, '人工岗位名');
  assert.equal(merged.company, '新公司');
  assert.equal(merged.location, '人工地点');
  assert.equal(merged.url, 'https://example.com/manual-url');
  assert.equal(merged.description, '人工修改的岗位描述');
  assert.equal(merged.status, 'contacted');
  assert.equal(merged.greeting, '人工话术');
  assert.deepEqual(merged.manualFields, ['title', 'location', 'url', 'description']);
});
