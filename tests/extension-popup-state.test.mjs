import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearInvalidExtensionToken,
  createDeskApi,
  DeskApiError,
  deriveConnectionStatus,
  derivePopupState,
  getSavePolicy,
  isAllowedBossUrl,
  makeJobPayload
} from '../extension/popup.js';

test('recognizes only zhipin.com pages as eligible current tabs', () => {
  assert.equal(isAllowedBossUrl('https://www.zhipin.com/job_detail/abc.html'), true);
  assert.equal(isAllowedBossUrl('https://m.zhipin.com/job_detail/abc.html'), true);
  assert.equal(isAllowedBossUrl('https://zhipin.com.evil.example/job_detail/abc.html'), false);
  assert.equal(isAllowedBossUrl('https://example.com/job_detail/abc.html'), false);
  assert.equal(isAllowedBossUrl('not a url'), false);
});

test('derives explicit popup states without treating errors as success', () => {
  assert.equal(derivePopupState({ loading: true }), 'loading');
  assert.equal(derivePopupState({ errorKind: 'service-offline' }), 'service-offline');
  assert.equal(derivePopupState({ errorKind: 'error' }), 'error');
  assert.equal(derivePopupState({ saved: true }), 'saved');
  assert.equal(derivePopupState({ preview: { duplicate: { id: 'job-1' } } }), 'duplicate');
  assert.equal(derivePopupState({ preview: { match: { score: 76 } } }), 'preview');
  assert.equal(derivePopupState({}), 'idle');
});

test('jobs below 60 require an explicit still-save confirmation', () => {
  assert.deepEqual(getSavePolicy({ match: { score: 59, route: 'excluded' } }, false), {
    requiresForce: true,
    canSave: false,
    forceSave: false
  });
  assert.deepEqual(getSavePolicy({ match: { score: 59, route: 'excluded' } }, true), {
    requiresForce: true,
    canSave: true,
    forceSave: true
  });
  assert.equal(getSavePolicy({ match: { score: 60, route: 'review' } }, false).canSave, true);
});

test('desk API sends only the paired extension token to preview and save endpoints', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: url.endsWith('/preview') ? 200 : 201,
      json: async () => url.endsWith('/preview')
        ? { normalizedJob: { title: 'AI 实习生' }, match: { score: 80, route: 'queue' }, duplicate: null }
        : { job: { id: 'job-1' }, duplicate: null }
    };
  };
  const api = createDeskApi({ fetchImpl, token: 'paired-token' });

  await api.preview({ title: 'AI 实习生' });
  await api.save({ title: 'AI 实习生', forceSave: false });

  assert.deepEqual(calls.map((call) => call.url), [
    'http://127.0.0.1:43127/api/jobs/preview',
    'http://127.0.0.1:43127/api/jobs'
  ]);
  for (const { options } of calls) {
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['x-desk-extension-token'], 'paired-token');
    assert.equal(options.headers['x-desk-token'], undefined);
  }
});

test('desk API sends batch preview and save as one request each', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    if (url.endsWith('/batch-preview')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [{
            index: 0,
            normalizedJob: { title: '批量 AI 实习生' },
            match: { score: 88, route: 'queue', reasons: [] },
            duplicate: null
          }]
        })
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        results: [{ job: { id: 'batch-job-1' }, duplicate: null }],
        created: 1,
        updated: 0
      })
    };
  };
  const api = createDeskApi({ fetchImpl, token: 'paired-token' });

  await api.batchPreview([{ title: '批量 AI 实习生' }]);
  await api.batchSave([{ title: '批量 AI 实习生' }], { forceSaveExcluded: true });

  assert.deepEqual(calls.map((call) => call.url), [
    'http://127.0.0.1:43127/api/jobs/batch-preview',
    'http://127.0.0.1:43127/api/jobs/batch'
  ]);
  assert.deepEqual(calls[0].body, { jobs: [{ title: '批量 AI 实习生' }] });
  assert.deepEqual(calls[1].body, {
    jobs: [{ title: '批量 AI 实习生' }],
    forceSaveExcluded: true
  });
  for (const { options } of calls) {
    assert.equal(options.headers['x-desk-extension-token'], 'paired-token');
    assert.equal(options.headers['x-desk-token'], undefined);
  }
});

test('editable preview fields become the saved payload without invented values', () => {
  const payload = makeJobPayload({
    title: ' Agent 实习生 ',
    company: '',
    location: '深圳',
    salary: '',
    url: 'https://www.zhipin.com/job_detail/abc.html',
    description: ' 使用 Python '
  }, { forceSave: true, now: '2026-08-01T09:00:00.000Z' });

  assert.deepEqual(payload, {
    title: 'Agent 实习生',
    company: '',
    location: '深圳',
    salary: '',
    url: 'https://www.zhipin.com/job_detail/abc.html',
    description: '使用 Python',
    source: 'BOSS直聘（当前页手动采集）',
    verifiedAt: '2026-08-01T09:00:00.000Z',
    forceSave: true
  });
});

test('distinguishes unconfigured, configured, and verified connections', () => {
  assert.equal(deriveConnectionStatus({ token: '', verified: false }), 'unconfigured');
  assert.equal(deriveConnectionStatus({ token: 'paired-token', verified: false }), 'configured');
  assert.equal(deriveConnectionStatus({ token: 'paired-token', verified: true }), 'verified');
});

test('rejects invalid JSON even when the desk returns 2xx', async () => {
  const api = createDeskApi({
    token: 'paired-token',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token'); }
    })
  });

  await assert.rejects(
    api.preview({ title: 'AI 实习生' }),
    (error) => error?.code === 'INVALID_DESK_RESPONSE' && error?.offline === false
  );
});

test('preview response requires normalizedJob, a finite score, and a valid route', async () => {
  for (const body of [
    { match: { score: 80, route: 'queue' } },
    { normalizedJob: {}, match: { score: Number.NaN, route: 'queue' } },
    { normalizedJob: {}, match: { score: 80, route: 'mystery' } }
  ]) {
    const api = createDeskApi({
      token: 'paired-token',
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => body })
    });
    await assert.rejects(api.preview({}), (error) => error?.code === 'INVALID_PREVIEW_RESPONSE');
  }
});

test('save response requires a persisted job id', async () => {
  for (const body of [{}, { job: {} }, { job: { id: '' } }]) {
    const api = createDeskApi({
      token: 'paired-token',
      fetchImpl: async () => ({ ok: true, status: 201, json: async () => body })
    });
    await assert.rejects(api.save({}), (error) => error?.code === 'INVALID_SAVE_RESPONSE');
  }
});

test('INVALID_EXTENSION_TOKEN clears the persisted extension token', async () => {
  const removed = [];
  const storageArea = {
    remove(keys, callback) {
      removed.push(keys);
      callback();
    }
  };

  const cleared = await clearInvalidExtensionToken(
    new DeskApiError('expired', { status: 403, code: 'INVALID_EXTENSION_TOKEN' }),
    storageArea
  );

  assert.equal(cleared, true);
  assert.deepEqual(removed, [['extensionToken']]);
});
