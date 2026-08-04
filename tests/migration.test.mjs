import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LEGACY_MIGRATED_KEY,
  buildMigrationPayload,
  migrateLegacyState,
  parseMigrationBridgeConfig,
  readLegacyState
} from '../client/migration.js';
import { createApiClient } from '../client/api.js';

function fakeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    }
  };
}

function legacyFixture() {
  return {
    jobs: [{
      id: 'legacy-1',
      title: 'AI Agent 实习生',
      company: '示例科技',
      status: 'contacted',
      greeting: '这是我手动修改的话术',
      createdAt: '2026-07-01T08:00:00.000Z',
      source: '公开招聘页',
      publishedAt: '2026-06-30',
      verifiedAt: '2026-07-01',
      curationNote: '接受 2028 届',
      curatedBatchId: 'shenzhen-ai-v1',
      review: {
        score: 82,
        verdict: 'good',
        reasons: ['方向匹配']
      },
      metadata: {
        collectedBy: 'legacy-curator'
      }
    }],
    curatedBatches: ['shenzhen-ai-v1'],
    deletedKeys: ['url:https://example.com/deleted-job']
  };
}

test('reads legacy state and builds a lossless migration payload', () => {
  const legacy = legacyFixture();
  const storage = fakeStorage({
    'applicationDesk.v2': JSON.stringify(legacy)
  });

  const read = readLegacyState(storage);
  const payload = buildMigrationPayload(read);

  assert.deepEqual(payload, {
    sourceKey: 'applicationDesk.v2',
    jobs: legacy.jobs,
    curatedBatches: ['shenzhen-ai-v1'],
    deletedKeys: ['url:https://example.com/deleted-job']
  });
  assert.equal(payload.jobs[0].status, 'contacted');
  assert.equal(payload.jobs[0].greeting, '这是我手动修改的话术');
  assert.equal(payload.jobs[0].createdAt, '2026-07-01T08:00:00.000Z');
  assert.deepEqual(payload.jobs[0].review, legacy.jobs[0].review);
  assert.deepEqual(payload.jobs[0].metadata, legacy.jobs[0].metadata);

  payload.jobs[0].metadata.collectedBy = 'changed';
  assert.equal(read.jobs[0].metadata.collectedBy, 'legacy-curator');
});

test('migration sends one atomic legacy-state request after preview and marks success afterwards', async () => {
  const original = JSON.stringify(legacyFixture());
  const storage = fakeStorage({ 'applicationDesk.v2': original });
  const events = [];
  let receivedPayload;
  let apiCalls = 0;

  const result = await migrateLegacyState({
    storage,
    confirmMigration: async (preview) => {
      events.push('preview');
      assert.deepEqual(preview, {
        total: 1,
        curated: 1,
        withGreeting: 1,
        statuses: {
          todo: 0,
          contacted: 1,
          replied: 0,
          skipped: 0,
          other: 0
        }
      });
      return true;
    },
    api: {
      async importLegacyState(payload) {
        apiCalls += 1;
        events.push('api');
        assert.equal(storage.getItem(LEGACY_MIGRATED_KEY), null);
        receivedPayload = payload;
        return {
          ok: true,
          imported: payload.jobs.length,
          merged: 0,
          alreadyPresent: 0,
          total: payload.jobs.length
        };
      }
    }
  });

  events.push('done');
  assert.deepEqual(events, ['preview', 'api', 'done']);
  assert.equal(apiCalls, 1);
  assert.equal(result.status, 'migrated');
  assert.equal(result.imported, 1);
  assert.equal(result.total, 1);
  assert.equal(receivedPayload.jobs[0].status, 'contacted');
  assert.equal(receivedPayload.jobs[0].greeting, '这是我手动修改的话术');
  assert.equal(receivedPayload.jobs[0].createdAt, '2026-07-01T08:00:00.000Z');
  assert.deepEqual(receivedPayload.curatedBatches, ['shenzhen-ai-v1']);
  assert.deepEqual(receivedPayload.deletedKeys, ['url:https://example.com/deleted-job']);
  assert.equal(storage.getItem('applicationDesk.v2'), original);
  assert.equal(storage.getItem(LEGACY_MIGRATED_KEY), 'true');
});

test('legacy payload preserves user-controlled fields and includes excluded jobs', async () => {
  const legacy = legacyFixture();
  Object.assign(legacy.jobs[0], {
    greetingEdited: true,
    notes: '用户备注',
    manualFields: ['description', 'manualScore'],
    description: '用户修正后的岗位说明',
    manualScore: 91
  });
  legacy.jobs.push({
    id: 'legacy-excluded',
    title: '不匹配但保留的岗位',
    company: '示例公司',
    route: 'excluded',
    status: 'skipped',
    greeting: '保留的话术',
    greetingEdited: true,
    createdAt: '2026-07-02T08:00:00.000Z',
    notes: '已确认不投',
    manualFields: ['route', 'notes']
  });
  const storage = fakeStorage({
    'applicationDesk.v2': JSON.stringify(legacy)
  });
  let receivedPayload;

  await migrateLegacyState({
    storage,
    confirmMigration: async () => true,
    api: {
      async importLegacyState(payload) {
        receivedPayload = payload;
        return {
          ok: true,
          imported: 2,
          merged: 0,
          alreadyPresent: 0,
          total: 2
        };
      }
    }
  });

  assert.equal(receivedPayload.jobs.length, 2);
  assert.deepEqual(receivedPayload.jobs[0], legacy.jobs[0]);
  assert.deepEqual(receivedPayload.jobs[1], legacy.jobs[1]);
  assert.equal(receivedPayload.jobs[1].route, 'excluded');
});

test('failed or incomplete API import leaves legacy data and migration marker unchanged', async () => {
  const original = JSON.stringify(legacyFixture());
  const responses = [
    new Error('server unavailable'),
    { ok: false, imported: 1, merged: 0, alreadyPresent: 0, total: 1 },
    { ok: true, imported: 0, merged: 0, alreadyPresent: 0, total: 1 },
    { ok: true, imported: 1, merged: 0, alreadyPresent: 0, total: 2 }
  ];

  for (const response of responses) {
    const storage = fakeStorage({ 'applicationDesk.v2': original });
    await assert.rejects(
      migrateLegacyState({
        storage,
        confirmMigration: async () => true,
        api: {
          async importLegacyState() {
            if (response instanceof Error) throw response;
            return response;
          }
        }
      }),
      /server unavailable|未确认|数量/
    );

    assert.equal(storage.getItem('applicationDesk.v2'), original);
    assert.equal(storage.getItem(LEGACY_MIGRATED_KEY), null);
  }
});

test('declined migration does not call the API or set a marker', async () => {
  const storage = fakeStorage({
    'applicationDesk.v2': JSON.stringify(legacyFixture())
  });
  let apiCalls = 0;

  const result = await migrateLegacyState({
    storage,
    confirmMigration: async () => false,
    api: {
      async importLegacyState() {
        apiCalls += 1;
      }
    }
  });

  assert.equal(result.status, 'cancelled');
  assert.equal(result.imported, 0);
  assert.equal(apiCalls, 0);
  assert.equal(storage.getItem(LEGACY_MIGRATED_KEY), null);
});

test('migration is idempotent after a confirmed success marker', async () => {
  const storage = fakeStorage({
    'applicationDesk.v2': JSON.stringify(legacyFixture())
  });
  let apiCalls = 0;
  let confirmationCalls = 0;
  const api = {
    async importLegacyState(payload) {
      apiCalls += 1;
      return {
        ok: true,
        imported: payload.jobs.length,
        merged: 0,
        alreadyPresent: 0,
        total: payload.jobs.length
      };
    }
  };
  const confirmMigration = async () => {
    confirmationCalls += 1;
    return true;
  };

  const first = await migrateLegacyState({ api, storage, confirmMigration });
  const second = await migrateLegacyState({ storage });

  assert.equal(first.status, 'migrated');
  assert.equal(second.status, 'already-migrated');
  assert.equal(apiCalls, 1);
  assert.equal(confirmationCalls, 1);
});

test('bridge-style migration can keep every localStorage key unchanged', async () => {
  const original = JSON.stringify(legacyFixture());
  const storage = fakeStorage({ 'applicationDesk.v2': original });

  const result = await migrateLegacyState({
    storage,
    markMigrated: false,
    confirmMigration: async () => true,
    api: {
      async importLegacyState(payload) {
        return {
          ok: true,
          imported: payload.jobs.length,
          merged: 0,
          alreadyPresent: 0,
          total: payload.jobs.length
        };
      }
    }
  });

  assert.equal(result.status, 'migrated');
  assert.equal(storage.getItem('applicationDesk.v2'), original);
  assert.equal(storage.getItem(LEGACY_MIGRATED_KEY), null);
});

test('missing or malformed legacy data is treated as empty without writing', async () => {
  for (const value of [undefined, '{bad json', JSON.stringify({ jobs: 'not-an-array' })]) {
    const storage = fakeStorage(value === undefined ? {} : {
      'applicationDesk.v2': value
    });
    let apiCalls = 0;
    const result = await migrateLegacyState({
      storage,
      confirmMigration: async () => true,
      api: {
        async importLegacyState() {
          apiCalls += 1;
        }
      }
    });

    assert.equal(result.status, 'no-legacy-data');
    assert.equal(apiCalls, 0);
    assert.equal(storage.getItem(LEGACY_MIGRATED_KEY), null);
  }
});

test('migration bridge is enabled only by explicit file launch parameters in the fragment', () => {
  const fragment = new URLSearchParams({
    migrationBridge: '1',
    baseUrl: 'http://127.0.0.1:43127',
    token: 'one-time-token',
    returnUrl: 'http://127.0.0.1:43127/'
  }).toString();

  assert.deepEqual(
    parseMigrationBridgeConfig(new URL(
      `file:///D:/desk/index.html?migration-bridge=1#${fragment}`
    )),
    {
      baseUrl: 'http://127.0.0.1:43127',
      token: 'one-time-token',
      returnUrl: 'http://127.0.0.1:43127/'
    }
  );
  assert.equal(
    parseMigrationBridgeConfig(new URL(`file:///D:/desk/index.html#${fragment}`)),
    null
  );
  assert.equal(
    parseMigrationBridgeConfig(new URL(
      'file:///D:/desk/index.html?migration-bridge=1#baseUrl=http%3A%2F%2F127.0.0.1%3A43127&returnUrl=http%3A%2F%2F127.0.0.1%3A43127%2F'
    )),
    null
  );
  assert.equal(
    parseMigrationBridgeConfig(new URL(
      'file:///D:/desk/index.html?migration-bridge=1#migrationBridge=1&baseUrl=https%3A%2F%2Fexample.com&token=x&returnUrl=https%3A%2F%2Fexample.com'
    )),
    null
  );
  assert.equal(
    parseMigrationBridgeConfig(new URL(
      `http://127.0.0.1:43127/?migration-bridge=1#${fragment}`
    )),
    null
  );
});

test('API client posts one bulk migration and saves client state with the provided token', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/api/migrations/legacy')) {
      return new Response(JSON.stringify({
        ok: true,
        imported: 1,
        merged: 0,
        alreadyPresent: 0,
        total: 1
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (url.endsWith('/api/client-state')) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (url.endsWith('/api/state')) {
      return new Response(JSON.stringify({ jobs: [{ id: 'server-job' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const api = createApiClient({
    baseUrl: 'http://127.0.0.1:43127/',
    token: 'provided-token',
    fetchImpl
  });
  const payload = buildMigrationPayload(legacyFixture());

  const migrationResult = await api.importLegacyState(payload);
  const saved = await api.putClientState({
    jobs: payload.jobs,
    curatedBatches: payload.curatedBatches,
    deletedKeys: payload.deletedKeys
  });
  const state = await api.getState();

  assert.equal(migrationResult.ok, true);
  assert.equal(saved.ok, true);
  assert.deepEqual(state.jobs, [{ id: 'server-job' }]);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'http://127.0.0.1:43127/api/migrations/legacy');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['x-desk-token'], 'provided-token');
  assert.deepEqual(JSON.parse(calls[0].options.body), payload);
  assert.equal(calls[1].url, 'http://127.0.0.1:43127/api/client-state');
  assert.equal(calls[1].options.method, 'PUT');
  assert.equal(calls[1].options.headers['x-desk-token'], 'provided-token');
});
