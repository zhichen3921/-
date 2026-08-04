import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.mjs';

test('store persists an atomic update', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-store-'));
  const filePath = join(dir, 'state.json');
  const store = createStore({ filePath, initialState: { version: 3, jobs: [] } });

  await store.update((state) => ({
    ...state,
    jobs: [{ id: 'job-1' }]
  }));

  assert.deepEqual(
    JSON.parse(await readFile(filePath, 'utf8')).jobs,
    [{ id: 'job-1' }]
  );
  assert.deepEqual((await store.read()).jobs, [{ id: 'job-1' }]);
});

test('store fills missing application-state defaults', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-store-'));
  const store = createStore({
    filePath: join(dir, 'state.json'),
    initialState: { version: 3, jobs: [] }
  });

  const state = await store.read();

  assert.equal(state.preferences.queueThreshold, 75);
  assert.equal(state.preferences.reviewThreshold, 60);
  assert.deepEqual(state.preferences.locations, ['深圳', '远程']);
  assert.deepEqual(state.deletedKeys, []);
  assert.deepEqual(state.importedBatchIds, []);
  assert.deepEqual(state.updates, {
    lastSuccessAt: null,
    lastAttemptAt: null,
    status: 'idle',
    logs: []
  });
});

test('store serializes concurrent updates without losing changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-store-'));
  const store = createStore({
    filePath: join(dir, 'state.json'),
    initialState: { version: 3, jobs: [] }
  });

  await Promise.all([
    store.update((state) => {
      state.jobs.push({ id: 'job-1' });
    }),
    store.update((state) => {
      state.jobs.push({ id: 'job-2' });
    })
  ]);

  assert.deepEqual(
    (await store.read()).jobs.map((job) => job.id),
    ['job-1', 'job-2']
  );
});

test('store rejects invalid jobs and remains usable afterward', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-store-'));
  const store = createStore({
    filePath: join(dir, 'state.json'),
    initialState: { version: 3, jobs: [] }
  });

  await assert.rejects(
    store.replace({ version: 3, jobs: {} }),
    /jobs must be an array/
  );

  const saved = await store.update((state) => ({
    ...state,
    jobs: [{ id: 'job-after-error' }]
  }));

  assert.deepEqual(saved.jobs, [{ id: 'job-after-error' }]);
});

test('store isolates initialState immediately when it is created', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-store-'));
  const initialState = {
    version: 3,
    jobs: [{ id: 'original' }],
    preferences: { locations: ['深圳'] }
  };
  const store = createStore({
    filePath: join(dir, 'state.json'),
    initialState
  });

  initialState.jobs[0].id = 'mutated';
  initialState.preferences.locations.push('其他');

  const state = await store.read();
  assert.deepEqual(state.jobs, [{ id: 'original' }]);
  assert.deepEqual(state.preferences.locations, ['深圳']);
});

test('store rejects invalid preference values at creation and replacement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-store-'));
  const filePath = join(dir, 'state.json');

  assert.throws(
    () =>
      createStore({
        filePath,
        initialState: {
          version: 3,
          jobs: [],
          preferences: { queueThreshold: '75' }
        }
    }),
    /queueThreshold/
  );
  assert.throws(
    () =>
      createStore({
        filePath,
        initialState: { version: '3', jobs: [] }
      }),
    /version/
  );
  assert.throws(
    () =>
      createStore({
        filePath,
        initialState: {
          version: 3,
          jobs: [],
          preferences: { primaryDirections: [42] }
        }
      }),
    /primaryDirections/
  );
  assert.throws(
    () =>
      createStore({
        filePath,
        initialState: {
          version: 3,
          jobs: [],
          updates: { status: 42, logs: [] }
        }
      }),
    /updates\.status/
  );

  const store = createStore({
    filePath,
    initialState: { version: 3, jobs: [] }
  });

  await assert.rejects(
    store.replace({
      version: 3,
      jobs: [],
      preferences: {
        queueThreshold: 50,
        reviewThreshold: 60
      }
    }),
    /reviewThreshold/
  );
  await assert.rejects(
    store.replace({
      version: 3,
      jobs: [],
      preferences: { locations: '深圳' }
    }),
    /locations/
  );
  await assert.rejects(
    store.replace({
      version: 3,
      jobs: [],
      updates: { status: 'idle', logs: 'not-an-array' }
    }),
    /updates\.logs/
  );
});

test('store recovers after a mutator throws', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-store-'));
  const store = createStore({
    filePath: join(dir, 'state.json'),
    initialState: { version: 3, jobs: [] }
  });

  await assert.rejects(
    store.update(() => {
      throw new Error('mutator failed');
    }),
    /mutator failed/
  );

  await store.update((state) => {
    state.jobs.push({ id: 'recovered' });
  });

  assert.deepEqual((await store.read()).jobs, [{ id: 'recovered' }]);
});

test('store return values cannot mutate persisted state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-store-'));
  const store = createStore({
    filePath: join(dir, 'state.json'),
    initialState: { version: 3, jobs: [] }
  });

  const saved = await store.replace({
    version: 3,
    jobs: [{ id: 'persisted', metadata: { source: 'public' } }]
  });
  saved.jobs[0].id = 'changed-outside';
  saved.jobs[0].metadata.source = 'changed-outside';

  const firstRead = await store.read();
  firstRead.jobs.push({ id: 'not-persisted' });

  assert.deepEqual((await store.read()).jobs, [
    { id: 'persisted', metadata: { source: 'public' } }
  ]);
});

test('a temporary-file write failure leaves the old state intact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-store-'));
  const filePath = join(dir, 'state.json');
  const temporaryPath = `${filePath}.tmp`;
  const store = createStore({
    filePath,
    initialState: { version: 3, jobs: [{ id: 'old' }] }
  });

  await store.read();
  await mkdir(temporaryPath);

  await assert.rejects(
    store.replace({
      version: 3,
      jobs: [{ id: 'new' }]
    })
  );

  assert.deepEqual(
    JSON.parse(await readFile(filePath, 'utf8')).jobs,
    [{ id: 'old' }]
  );

  await rm(temporaryPath, { recursive: true, force: true });
  assert.deepEqual((await store.read()).jobs, [{ id: 'old' }]);
});
