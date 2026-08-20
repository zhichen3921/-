import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApplicationServer } from '../server/server.mjs';
import { createStore } from '../server/store.mjs';

const EXTENSION_ORIGIN = `chrome-extension://${'a'.repeat(32)}`;

async function startTestServer() {
  const directory = await mkdtemp(join(tmpdir(), 'desk-api-'));
  const staticRoot = join(directory, 'public');
  await mkdir(staticRoot);
  await mkdir(join(staticRoot, 'client'));
  await writeFile(join(staticRoot, 'index.html'), '<h1>Application Desk</h1>', 'utf8');
  await writeFile(join(staticRoot, 'styles.css'), 'body{}', 'utf8');
  await writeFile(join(staticRoot, 'app.js'), 'window.APP = true;', 'utf8');
  await writeFile(join(staticRoot, 'curated-jobs.js'), 'window.JOBS = [];', 'utf8');
  await writeFile(join(staticRoot, 'client', 'api.js'), 'export const ok = true;', 'utf8');
  await writeFile(join(staticRoot, 'package.json'), '{"private":true}', 'utf8');
  await writeFile(join(staticRoot, 'notes.md'), 'private notes', 'utf8');
  await mkdir(join(staticRoot, 'docs'));
  await writeFile(join(staticRoot, 'docs', 'private.md'), 'private docs', 'utf8');

  const store = createStore({
    filePath: join(directory, 'state.json'),
    initialState: { version: 3, jobs: [] }
  });
  const app = createApplicationServer({
    store,
    host: '127.0.0.1',
    port: 0,
    staticRoot
  });
  await app.start();

  const address = app.address();
  const url = `http://127.0.0.1:${address.port}`;
  const bootstrapResponse = await fetch(`${url}/api/bootstrap`);
  const bootstrap = await bootstrapResponse.json();

  return {
    ...app,
    url,
    token: bootstrap.token,
    store
  };
}

async function json(response) {
  const body = await response.json();
  return { response, body };
}

function rawRequest(url, path, headers = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({
      host: target.hostname,
      port: target.port,
      method: 'GET',
      path,
      headers
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('health is local and state survives a token-authorized job write', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());

  const health = await fetch(`${app.url}/api/health`).then((response) => response.json());
  assert.equal(health.ok, true);
  assert.equal(health.host, '127.0.0.1');
  assert.equal(health.token, undefined);
  assert.equal(typeof app.token, 'string');
  assert.ok(app.token.length >= 32);

  const { response, body } = await json(await fetch(`${app.url}/api/jobs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-desk-token': app.token
    },
    body: JSON.stringify({
      title: 'AI Agent 实习生',
      company: '测试公司',
      location: '深圳',
      url: 'https://example.com/jobs/agent',
      description: '面向 2028 届，使用 Python 和大模型 API 开发 Agent 实习项目。'
    })
  }));

  assert.equal(response.status, 201);
  assert.equal(body.job.company, '测试公司');
  assert.equal(body.job.match.route, body.job.route);
  assert.equal((await app.store.read()).jobs[0].company, '测试公司');
});

test('same-origin writes require the runtime token and use the JSON error shape', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());

  const { response, body } = await json(await fetch(`${app.url}/api/preferences`, {
    method: 'PUT',
    headers: {
      origin: app.url,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ queueThreshold: 80 })
  }));

  assert.equal(response.status, 403);
  assert.deepEqual(Object.keys(body), ['error']);
  assert.equal(body.error.code, 'INVALID_TOKEN');
  assert.equal(typeof body.error.message, 'string');
});

test('rejects Host headers that do not exactly match loopback and the listening port', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());
  const actualAuthority = new URL(app.url).host;

  for (const { path, host, origin } of [
    { path: '/api/bootstrap', host: 'attacker.example', origin: 'http://attacker.example' },
    { path: '/api/health', host: '127.0.0.1:1' },
    { path: '/', host: `localhost:${new URL(app.url).port}` }
  ]) {
    const result = await rawRequest(app.url, path, {
      host,
      ...(origin ? { origin } : {})
    });
    assert.equal(result.status, 421, `${path} with Host ${host}`);
    assert.equal(JSON.parse(result.body).error.code, 'INVALID_HOST');
    assert.doesNotMatch(result.body, new RegExp(app.token));
  }

  const accepted = await rawRequest(app.url, '/api/health', { host: actualAuthority });
  assert.equal(accepted.status, 200);
});

test('preferences, individual jobs, state, and update status are backed by the store', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());
  const headers = {
    'content-type': 'application/json',
    'x-desk-token': app.token
  };

  const preferencesResult = await json(await fetch(`${app.url}/api/preferences`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ queueThreshold: 80, reviewThreshold: 65 })
  }));
  assert.equal(preferencesResult.response.status, 200);
  assert.equal(preferencesResult.body.preferences.queueThreshold, 80);

  const createResult = await json(await fetch(`${app.url}/api/jobs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: '机器学习实习生',
      company: '示例科技',
      location: '深圳',
      description: '面向 2028 届在校生，使用 Python 完成机器学习和数据分析工作。'
    })
  }));
  assert.equal(createResult.response.status, 201);
  const id = createResult.body.job.id;

  const updateResult = await json(await fetch(`${app.url}/api/jobs/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      title: '人工修正的机器学习实习生',
      company: '人工修正的示例科技',
      location: '深圳南山区',
      url: 'https://example.com/jobs/manually-corrected',
      description: '人工核对后的岗位描述',
      status: 'contacted',
      notes: '已发送话术',
      greeting: '人工编辑的话术',
      manualFields: []
    })
  }));
  assert.equal(updateResult.body.job.status, 'contacted');
  assert.equal(updateResult.body.job.notes, '已发送话术');
  assert.equal(updateResult.body.job.greetingEdited, true);
  assert.deepEqual(
    [...updateResult.body.job.manualFields].sort(),
    ['company', 'description', 'location', 'title', 'url'].sort()
  );

  const invalidStatus = await json(await fetch(`${app.url}/api/jobs/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ status: 'not-a-real-status' })
  }));
  assert.equal(invalidStatus.response.status, 400);
  assert.equal(invalidStatus.body.error.code, 'INVALID_STATUS');

  const fetchedJob = await fetch(`${app.url}/api/jobs/${encodeURIComponent(id)}`)
    .then((response) => response.json());
  assert.equal(fetchedJob.job.id, id);
  assert.equal(fetchedJob.job.status, 'contacted');

  const state = await fetch(`${app.url}/api/state`).then((response) => response.json());
  assert.equal(state.state.jobs.length, 1);
  assert.equal(state.state.preferences.reviewThreshold, 65);

});

test('invalid preferences return 400 INVALID_PREFERENCES without changing state', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());
  const before = await app.store.read();

  const result = await json(await fetch(`${app.url}/api/preferences`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'x-desk-token': app.token
    },
    body: JSON.stringify({ queueThreshold: 'high' })
  }));

  assert.equal(result.response.status, 400);
  assert.equal(result.body.error.code, 'INVALID_PREFERENCES');
  assert.deepEqual((await app.store.read()).preferences, before.preferences);
});

test('invalid job status is rejected rather than silently reset', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());

  const result = await json(await fetch(`${app.url}/api/jobs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-desk-token': app.token
    },
    body: JSON.stringify({
      title: 'AI 实习生',
      company: '状态测试公司',
      location: '深圳',
      status: 'invalid'
    })
  }));

  assert.equal(result.response.status, 400);
  assert.equal(result.body.error.code, 'INVALID_STATUS');
  assert.equal((await app.store.read()).jobs.length, 0);
});

test('extension preview and save require a paired token and use narrow CORS', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());

  const preflight = await fetch(`${app.url}/api/jobs/preview`, {
    method: 'OPTIONS',
    headers: {
      origin: EXTENSION_ORIGIN,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type, x-desk-extension-token'
    }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), EXTENSION_ORIGIN);
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
  assert.match(
    preflight.headers.get('access-control-allow-headers'),
    /x-desk-extension-token/
  );
  assert.equal(preflight.headers.get('access-control-allow-credentials'), null);

  const payload = {
    title: 'AI Agent 实习生',
    company: '扩展测试公司',
    location: '深圳',
    url: 'https://example.com/jobs/from-extension',
    description: '面向 2028 届，使用 Python、Prompt 与大模型 API 参与 Agent 实习。'
  };
  const unpaired = await json(await fetch(`${app.url}/api/jobs/preview`, {
    method: 'POST',
    headers: {
      origin: EXTENSION_ORIGIN,
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  }));
  assert.equal(unpaired.response.status, 403);
  assert.equal(unpaired.body.error.code, 'INVALID_EXTENSION_TOKEN');
  assert.equal(unpaired.response.headers.get('access-control-allow-origin'), EXTENSION_ORIGIN);

  const pairing = await json(await fetch(`${app.url}/api/extension/pair`, {
    method: 'POST',
    headers: {
      origin: app.url,
      'content-type': 'application/json',
      'x-desk-token': app.token
    },
    body: '{}'
  }));
  assert.equal(pairing.response.status, 200);
  assert.equal(typeof pairing.body.extensionToken, 'string');
  assert.ok(pairing.body.extensionToken.length >= 32);

  const preview = await json(await fetch(`${app.url}/api/jobs/preview`, {
    method: 'POST',
    headers: {
      origin: EXTENSION_ORIGIN,
      'content-type': 'application/json',
      'x-desk-extension-token': pairing.body.extensionToken
    },
    body: JSON.stringify(payload)
  }));
  assert.equal(preview.response.status, 200);
  assert.equal(preview.response.headers.get('access-control-allow-origin'), EXTENSION_ORIGIN);
  assert.equal(preview.body.normalizedJob.company, '扩展测试公司');
  assert.equal(preview.body.duplicate, null);
  assert.equal((await app.store.read()).jobs.length, 0);

  const saved = await json(await fetch(`${app.url}/api/jobs`, {
    method: 'POST',
    headers: {
      origin: EXTENSION_ORIGIN,
      'content-type': 'application/json',
      'x-desk-extension-token': pairing.body.extensionToken
    },
    body: JSON.stringify(payload)
  }));
  assert.equal(saved.response.status, 201);
  assert.equal(saved.response.headers.get('access-control-allow-origin'), EXTENSION_ORIGIN);

  const wrongExtensionToken = await json(await fetch(`${app.url}/api/jobs/preview`, {
    method: 'POST',
    headers: {
      origin: EXTENSION_ORIGIN,
      'content-type': 'application/json',
      'x-desk-extension-token': 'wrong-token'
    },
    body: JSON.stringify(payload)
  }));
  assert.equal(wrongExtensionToken.response.status, 403);
  assert.equal(wrongExtensionToken.body.error.code, 'INVALID_EXTENSION_TOKEN');

  const forbidden = await json(await fetch(`${app.url}/api/preferences`, {
    method: 'PUT',
    headers: {
      origin: EXTENSION_ORIGIN,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ queueThreshold: 10 })
  }));
  assert.equal(forbidden.response.status, 403);
  assert.equal(forbidden.body.error.code, 'ORIGIN_FORBIDDEN');

  const evilPreflight = await fetch(`${app.url}/api/jobs`, {
    method: 'OPTIONS',
    headers: {
      origin: 'https://evil.example',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type, x-desk-extension-token'
    }
  });
  assert.equal(evilPreflight.status, 403);
  assert.equal(evilPreflight.headers.get('access-control-allow-origin'), null);
});

test('legacy migration allows null origin only on its paired token-authenticated route', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());

  const preflight = await fetch(`${app.url}/api/migrations/legacy`, {
    method: 'OPTIONS',
    headers: {
      origin: 'null',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type, x-desk-token'
    }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'null');
  assert.equal(
    preflight.headers.get('access-control-allow-headers'),
    'content-type, x-desk-token'
  );

  const unauthorized = await json(await fetch(`${app.url}/api/migrations/legacy`, {
    method: 'POST',
    headers: {
      origin: 'null',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      sourceKey: 'applicationDesk.v2',
      jobs: [],
      curatedBatches: [],
      deletedKeys: []
    })
  }));
  assert.equal(unauthorized.response.status, 403);
  assert.equal(unauthorized.body.error.code, 'INVALID_TOKEN');
  assert.equal(unauthorized.response.headers.get('access-control-allow-origin'), null);

  const nullOriginOutsideMigration = await json(await fetch(`${app.url}/api/jobs`, {
    method: 'POST',
    headers: {
      origin: 'null',
      'content-type': 'application/json',
      'x-desk-token': app.token
    },
    body: JSON.stringify({ title: '不应保存的岗位' })
  }));
  assert.equal(nullOriginOutsideMigration.response.status, 403);
  assert.equal(nullOriginOutsideMigration.body.error.code, 'ORIGIN_FORBIDDEN');
  assert.equal(nullOriginOutsideMigration.response.headers.get('access-control-allow-origin'), null);
});

test('legacy migration atomically preserves user state, excluded jobs, and deletion decisions', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());
  const sameOriginHeaders = {
    'content-type': 'application/json',
    'x-desk-token': app.token
  };

  const serverJob = await fetch(`${app.url}/api/jobs`, {
    method: 'POST',
    headers: sameOriginHeaders,
    body: JSON.stringify({
      title: 'AI Agent 实习生',
      company: '迁移测试公司',
      location: '深圳',
      url: 'https://example.com/jobs/legacy-duplicate?utm_source=server',
      description: '面向 2028 届，使用 Python 和大模型 API 开发 Agent 实习项目。',
      greeting: '服务器自动话术'
    })
  }).then((response) => response.json());

  const legacyCreatedAt = '2026-01-02T03:04:05.000Z';
  const migrationBody = {
    sourceKey: 'applicationDesk.v2',
    curatedBatches: ['legacy-batch-1', { id: 'legacy-batch-2' }],
    deletedKeys: ['url:https://example.com/jobs/deleted'],
    jobs: [
      {
        title: '人工修正的 Agent 实习生',
        company: '迁移测试公司',
        location: '深圳',
        url: 'https://example.com/jobs/legacy-duplicate',
        description: '人工保存的岗位描述',
        status: 'contacted',
        greeting: '旧投递台人工话术',
        greetingEdited: true,
        createdAt: legacyCreatedAt,
        notes: '旧投递台备注',
        manualFields: ['title', 'description']
      },
      {
        title: '北京 AI Agent 实习生',
        company: '旧数据外地公司',
        location: '北京',
        url: 'https://example.com/jobs/legacy-excluded',
        description: '面向 2028 届，使用 Python 开发 Agent，不支持远程。',
        status: 'skipped',
        greeting: '旧岗位仍需保留'
      }
    ]
  };

  const migrated = await json(await fetch(`${app.url}/api/migrations/legacy`, {
    method: 'POST',
    headers: {
      origin: 'null',
      'content-type': 'application/json',
      'x-desk-token': app.token
    },
    body: JSON.stringify(migrationBody)
  }));
  assert.equal(migrated.response.status, 200);
  assert.equal(migrated.response.headers.get('access-control-allow-origin'), 'null');
  assert.deepEqual(migrated.body, {
    ok: true,
    imported: 1,
    merged: 1,
    alreadyPresent: 0,
    total: 2
  });

  const state = await app.store.read();
  assert.equal(state.jobs.length, 2);
  const merged = state.jobs.find((job) => job.id === serverJob.job.id);
  assert.equal(merged.title, '人工修正的 Agent 实习生');
  assert.equal(merged.description, '人工保存的岗位描述');
  assert.equal(merged.status, 'contacted');
  assert.equal(merged.greeting, '旧投递台人工话术');
  assert.equal(merged.greetingEdited, true);
  assert.equal(merged.createdAt, legacyCreatedAt);
  assert.equal(merged.notes, '旧投递台备注');
  assert.deepEqual(merged.manualFields, ['title', 'description']);

  const excluded = state.jobs.find((job) => job.url.includes('legacy-excluded'));
  assert.equal(excluded.route, 'excluded');
  assert.equal(excluded.status, 'skipped');
  assert.ok(state.importedBatchIds.includes('legacy-batch-1'));
  assert.ok(state.importedBatchIds.includes('legacy-batch-2'));
  assert.ok(state.deletedKeys.includes('url:https://example.com/jobs/deleted'));

  const repeated = await fetch(`${app.url}/api/migrations/legacy`, {
    method: 'POST',
    headers: {
      origin: 'null',
      'content-type': 'application/json',
      'x-desk-token': app.token
    },
    body: JSON.stringify(migrationBody)
  }).then((response) => response.json());
  assert.deepEqual(repeated, {
    ok: true,
    imported: 0,
    merged: 0,
    alreadyPresent: 2,
    total: 2
  });
  assert.equal((await app.store.read()).jobs.length, 2);
});

test('legacy migration validation failure writes nothing', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());
  const before = await app.store.read();

  const result = await json(await fetch(`${app.url}/api/migrations/legacy`, {
    method: 'POST',
    headers: {
      origin: 'null',
      'content-type': 'application/json',
      'x-desk-token': app.token
    },
    body: JSON.stringify({
      sourceKey: 'broken-legacy-state',
      curatedBatches: ['valid-batch'],
      deletedKeys: ['valid-key'],
      jobs: [
        { title: '有效岗位', location: '深圳' },
        { title: '无效岗位', status: 'not-valid' }
      ]
    })
  }));

  assert.equal(result.response.status, 400);
  assert.equal(result.body.error.code, 'INVALID_MIGRATION');
  assert.deepEqual(await app.store.read(), before);
});

test('legacy migration total counts only jobs in the current payload', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());
  const headers = {
    'content-type': 'application/json',
    'x-desk-token': app.token
  };

  await fetch(`${app.url}/api/jobs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: '与迁移无关的已有岗位',
      company: '已有公司',
      location: '深圳',
      url: 'https://example.com/jobs/unrelated-existing',
      description: '面向 2028 届，使用 Python 参与机器学习实习。'
    })
  });

  const result = await fetch(`${app.url}/api/migrations/legacy`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      sourceKey: 'single-job-legacy-payload',
      curatedBatches: [],
      deletedKeys: [],
      jobs: [{
        title: '本次迁移的岗位',
        company: '迁移公司',
        location: '深圳',
        url: 'https://example.com/jobs/current-migration',
        description: '面向 2028 届，使用 Python 和大模型 API 参与 Agent 实习。'
      }]
    })
  }).then((response) => response.json());

  assert.equal(result.total, 1);
  assert.equal(
    result.imported + result.merged + result.alreadyPresent,
    1
  );
  assert.equal((await app.store.read()).jobs.length, 2);
});

test('transitional client-state replacement changes only jobs', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());
  await app.store.update((state) => {
    state.preferences.queueThreshold = 82;
    state.importedBatchIds = ['existing-batch'];
    state.deletedKeys = ['url:https://example.com/deleted'];
    state.updates = {
      ...state.updates,
      status: 'success',
      lastSuccessAt: '2026-07-31T01:00:00.000Z',
      logs: [{ message: 'kept' }]
    };
  });
  const before = await app.store.read();

  const result = await json(await fetch(`${app.url}/api/client-state`, {
    method: 'PUT',
    headers: {
      origin: app.url,
      'content-type': 'application/json',
      'x-desk-token': app.token
    },
    body: JSON.stringify({
      jobs: [{
        title: '客户端同步的 AI 实习生',
        company: '客户端公司',
        location: '深圳',
        url: 'https://example.com/jobs/client-state',
        description: '面向 2028 届，使用 Python 和大模型 API 开发 Agent。',
        status: 'contacted',
        greeting: '客户端已有话术',
        greetingEdited: true
      }]
    })
  }));

  assert.equal(result.response.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.jobs.length, 1);
  assert.equal(result.body.jobs[0].status, 'contacted');
  assert.equal(typeof result.body.jobs[0].score, 'number');

  const after = await app.store.read();
  assert.deepEqual(after.preferences, before.preferences);
  assert.deepEqual(after.importedBatchIds, before.importedBatchIds);
  assert.deepEqual(after.deletedKeys, before.deletedKeys);
  assert.deepEqual(after.updates, before.updates);
  assert.equal(after.jobs.length, 1);
});

test('invalid client-state body returns 400 and writes nothing', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());
  const before = await app.store.read();

  for (const body of [
    { jobs: 'not-an-array' },
    {
      jobs: [
        { title: '有效岗位', location: '深圳' },
        { title: '无效岗位', url: 'file:///private/data' }
      ]
    }
  ]) {
    const result = await json(await fetch(`${app.url}/api/client-state`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-desk-token': app.token
      },
      body: JSON.stringify(body)
    }));
    assert.equal(result.response.status, 400);
    assert.equal(result.body.error.code, 'INVALID_CLIENT_STATE');
    assert.deepEqual(await app.store.read(), before);
  }
});

test('JSON bodies are limited to 1 MiB and invalid URLs are rejected', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());
  const headers = {
    'content-type': 'application/json',
    'x-desk-token': app.token
  };

  const oversized = await json(await fetch(`${app.url}/api/jobs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: 'AI 实习生',
      padding: 'x'.repeat(1024 * 1024)
    })
  }));
  assert.equal(oversized.response.status, 413);
  assert.equal(oversized.body.error.code, 'BODY_TOO_LARGE');

  const invalidUrl = await json(await fetch(`${app.url}/api/jobs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: 'AI 实习生',
      url: 'file:///etc/passwd'
    })
  }));
  assert.equal(invalidUrl.response.status, 400);
  assert.equal(invalidUrl.body.error.code, 'INVALID_JOB');
});

test('static serving uses an explicit public asset allowlist', async (t) => {
  const app = await startTestServer();
  t.after(() => app.close());

  const index = await fetch(`${app.url}/`).then((response) => response.text());
  assert.match(index, /Application Desk/);
  assert.equal((await fetch(`${app.url}/styles.css`)).status, 200);
  assert.equal((await fetch(`${app.url}/app.js`)).status, 200);
  assert.equal((await fetch(`${app.url}/curated-jobs.js`)).status, 200);
  assert.equal((await fetch(`${app.url}/client/api.js`)).status, 200);

  for (const pathname of [
    '/package.json',
    '/notes.md',
    '/docs/private.md',
    '/data/state.json',
    '/server/server.mjs',
    '/shared/matcher.mjs',
    '/tests/server-api.test.mjs'
  ]) {
    const result = await fetch(`${app.url}${pathname}`);
    assert.equal(result.status, 403, pathname);
  }

  const traversal = await rawRequest(app.url, '/%2e%2e/package.json');
  assert.equal(traversal.status, 403);

  const missingApi = await json(await fetch(`${app.url}/api/not-real`));
  assert.equal(missingApi.response.status, 404);
  assert.equal(missingApi.body.error.code, 'NOT_FOUND');
});

test('application server can restart after close', async () => {
  const app = await startTestServer();
  await app.close();
  assert.equal(app.server.listening, false);

  await app.start();
  const address = app.address();
  const restartedUrl = `http://127.0.0.1:${address.port}`;
  const health = await fetch(`${restartedUrl}/api/health`).then((response) => response.json());
  assert.equal(health.ok, true);
  await app.close();
});

test('server refuses non-loopback bind addresses', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'desk-api-bind-'));
  const store = createStore({
    filePath: join(directory, 'state.json'),
    initialState: { version: 3, jobs: [] }
  });

  assert.throws(
    () => createApplicationServer({
      store,
      host: '0.0.0.0',
      port: 43127,
      staticRoot: directory
    }),
    /127\.0\.0\.1/
  );
});
