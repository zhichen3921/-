import test from 'node:test';
import assert from 'node:assert/strict';
import * as realFs from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  UpdateRunError,
  createPublicUpdateManager
} from '../updates/run-status.mjs';
import { createStore } from '../server/store.mjs';
import { createRouter } from '../server/router.mjs';

function validCandidate(overrides = {}) {
  return {
    id: '2026-08-01-shenzhen-ai-v1',
    generatedAt: '2026-08-01T09:00:00+08:00',
    verifiedAt: '2026-08-01',
    sources: [{
      name: '示例高校就业网',
      kind: 'university-career',
      url: 'https://career.example.edu.cn/jobs'
    }],
    jobs: [{
      title: 'AI 工作流实习生',
      company: '示例科技',
      location: '深圳',
      url: 'https://career.example.edu.cn/jobs/100',
      source: '示例高校就业网',
      publishedAt: '2026-07-31',
      verifiedAt: '2026-08-01',
      description: '面向 2028 届，使用 Python、大模型 API 和 Prompt 构建 Agent 工作流。'
    }],
    ...overrides
  };
}

async function fixture(options = {}) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'public-update-'));
  await mkdir(join(projectRoot, 'updates'), { recursive: true });
  await writeFile(join(projectRoot, 'updates', 'update-prompt.md'), '# prompt', 'utf8');
  const store = createStore({
    filePath: join(projectRoot, 'data', 'state.json'),
    initialState: { version: 3, jobs: options.jobs || [] }
  });
  const manager = createPublicUpdateManager({
    projectRoot,
    store,
    pid: 4242,
    now: () => new Date('2026-08-01T01:00:00.000Z'),
    processExists: options.processExists || (async () => false),
    runner: options.runner,
    importer: options.importer,
    fs: options.fs,
    fetchPage: options.fetchPage || (async ({ url }) => ({
      ok: true,
      status: 200,
      finalUrl: url,
      title: '示例科技 AI 工作流实习生',
      text: '示例科技公开招聘 AI 工作流实习生，地点深圳。'
    }))
  });
  return { manager, projectRoot, store };
}

test('rejects a second concurrent run with an update-specific conflict', async () => {
  let release;
  let markRunnerStarted;
  let runnerCalls = 0;
  const blocked = new Promise((resolve) => { release = resolve; });
  const runnerStarted = new Promise((resolve) => { markRunnerStarted = resolve; });
  const { manager } = await fixture({
    runner: async ({ candidatePath }) => {
      runnerCalls += 1;
      markRunnerStarted();
      await blocked;
      await writeFile(candidatePath, JSON.stringify(validCandidate()), 'utf8');
    }
  });

  const first = await manager.start();
  await runnerStarted;
  await assert.rejects(
    manager.start(),
    (error) => error instanceof UpdateRunError
      && error.code === 'UPDATE_ALREADY_RUNNING'
      && error.status === 409
  );
  assert.equal(first.status, 'running');
  assert.equal(runnerCalls, 1);

  release();
  const completed = await manager.waitForIdle(first.runId);
  assert.equal(completed.status, 'success');
});

test('clears a stale lock only after confirming its PID is absent', async () => {
  const checkedPids = [];
  const { manager, projectRoot, store } = await fixture({
    processExists: async (pid) => {
      checkedPids.push(pid);
      return false;
    },
    runner: async ({ candidatePath }) => {
      await writeFile(candidatePath, JSON.stringify(validCandidate()), 'utf8');
    }
  });
  const dataDirectory = join(projectRoot, 'data');
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(join(dataDirectory, 'update-running.lock'), JSON.stringify({
    pid: 9999,
    startedAt: '2026-07-31T01:00:00.000Z',
    runId: 'old-run'
  }), 'utf8');

  const run = await manager.start();
  const completed = await manager.waitForIdle(run.runId);

  assert.deepEqual(checkedPids, [9999]);
  assert.equal(completed.status, 'success');
  assert.equal((await store.read()).jobs.length, 1);
  await assert.rejects(stat(join(dataDirectory, 'update-running.lock')), /ENOENT/);
});

test('does not remove a lock while its recorded PID is alive', async () => {
  let runnerCalls = 0;
  const { manager, projectRoot, store } = await fixture({
    processExists: async () => true,
    runner: async () => { runnerCalls += 1; }
  });
  const lockPath = join(projectRoot, 'data', 'update-running.lock');
  await mkdir(join(projectRoot, 'data'), { recursive: true });
  const lock = {
    pid: 8888,
    startedAt: '2026-08-01T00:59:00.000Z',
    runId: 'live-run'
  };
  await writeFile(lockPath, JSON.stringify(lock), 'utf8');

  await assert.rejects(
    manager.start(),
    (error) => error.code === 'UPDATE_ALREADY_RUNNING'
  );
  assert.equal(runnerCalls, 0);
  assert.deepEqual(JSON.parse(await readFile(lockPath, 'utf8')), lock);
});

test('rejects an invalid candidate before import and retains existing jobs', async () => {
  const existing = {
    id: 'existing-job',
    title: '已有岗位',
    company: '已有公司',
    location: '深圳',
    status: 'contacted'
  };
  const { manager, projectRoot, store } = await fixture({
    jobs: [existing],
    runner: async ({ candidatePath }) => {
      const invalid = validCandidate({
        jobs: [{ ...validCandidate().jobs[0], url: 'https://www.zhipin.com/job/forbidden' }]
      });
      await writeFile(candidatePath, JSON.stringify(invalid), 'utf8');
    }
  });

  const run = await manager.start();
  const completed = await manager.waitForIdle(run.runId);
  const state = await store.read();

  assert.equal(completed.status, 'failed');
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].id, 'existing-job');
  assert.equal(state.jobs[0].status, 'contacted');
  const rejected = join(
    projectRoot,
    'data',
    'update-batches',
    'rejected',
    `${run.runId}.json`
  );
  assert.equal(typeof JSON.parse(await readFile(rejected, 'utf8')), 'object');
  assert.equal(state.updates.status, 'failed');
  assert.ok(state.updates.logs.some((entry) => entry.level === 'error'));
  assert.equal(typeof await readFile(
    join(projectRoot, 'data', 'update-logs', `${run.runId}.jsonl`),
    'utf8'
  ), 'string');
});

test('POST /api/updates/run starts only on an explicit request and maps concurrency to 409', async (t) => {
  let release;
  let markRunnerStarted;
  let runnerCalls = 0;
  const blocked = new Promise((resolve) => { release = resolve; });
  const runnerStarted = new Promise((resolve) => { markRunnerStarted = resolve; });
  const { manager, projectRoot, store } = await fixture({
    runner: async ({ candidatePath }) => {
      runnerCalls += 1;
      markRunnerStarted();
      await blocked;
      await writeFile(candidatePath, JSON.stringify(validCandidate()), 'utf8');
    }
  });
  let server;
  const expectedAuthority = () => {
    const address = server?.address();
    return address && typeof address !== 'string'
      ? `127.0.0.1:${address.port}`
      : '';
  };
  const router = createRouter({
    store,
    runtimeToken: 'runtime-test-token',
    extensionToken: 'extension-test-token',
    expectedAuthority,
    staticRoot: projectRoot,
    publicUpdateManager: manager
  });
  server = createServer((request, response) => router(request, response));
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  const baseUrl = `http://${expectedAuthority()}`;
  const headers = {
    'content-type': 'application/json',
    'x-desk-token': 'runtime-test-token'
  };
  assert.equal(runnerCalls, 0);

  const first = await fetch(`${baseUrl}/api/updates/run`, {
    method: 'POST',
    headers,
    body: '{}'
  });
  assert.equal(first.status, 202);
  const firstBody = await first.json();
  assert.equal(firstBody.run.status, 'running');
  await runnerStarted;

  const second = await fetch(`${baseUrl}/api/updates/run`, {
    method: 'POST',
    headers,
    body: '{}'
  });
  assert.equal(second.status, 409);
  const secondBody = await second.json();
  assert.equal(secondBody.error.code, 'UPDATE_ALREADY_RUNNING');
  assert.equal(runnerCalls, 1);

  release();
  assert.equal((await manager.waitForIdle(firstBody.run.runId)).status, 'success');
});

test('source verification failure preserves a manual-review artifact and imports nothing', async () => {
  const { manager, projectRoot, store } = await fixture({
    runner: async ({ candidatePath }) => {
      await writeFile(candidatePath, JSON.stringify(validCandidate()), 'utf8');
    },
    fetchPage: async () => ({
      ok: true,
      status: 200,
      finalUrl: 'https://www.zhipin.com/job_detail/redirected.html',
      title: '示例科技 AI 工作流实习生',
      text: '示例科技 AI 工作流实习生'
    })
  });

  const run = await manager.start();
  const completed = await manager.waitForIdle(run.runId);

  assert.equal(completed.status, 'failed');
  assert.equal((await store.read()).jobs.length, 0);
  const rejectedPath = join(
    projectRoot,
    'data',
    'update-batches',
    'rejected',
    `${run.runId}.json`
  );
  const rejected = JSON.parse(await readFile(rejectedPath, 'utf8'));
  assert.equal(rejected.manualReview[0].reason, 'UNSAFE_FINAL_URL');
});

test('an import failure leaves no accepted batch file', async () => {
  const { manager, projectRoot } = await fixture({
    runner: async ({ candidatePath }) => {
      await writeFile(candidatePath, JSON.stringify(validCandidate()), 'utf8');
    },
    importer: async () => { throw new Error('import exploded'); }
  });

  const run = await manager.start();
  const completed = await manager.waitForIdle(run.runId);

  assert.equal(completed.status, 'failed');
  await assert.rejects(
    stat(join(projectRoot, 'data', 'update-batches', `${validCandidate().id}.json`)),
    /ENOENT/
  );
});

test('archive failure after committed import is a warning, not a failed update', async () => {
  const batchFile = `${validCandidate().id}.json`;
  const fs = {
    ...realFs,
    async open(filePath, flags, ...args) {
      if (String(filePath).endsWith(batchFile) && flags === 'wx') {
        const error = new Error('archive unavailable');
        error.code = 'EACCES';
        throw error;
      }
      return realFs.open(filePath, flags, ...args);
    }
  };
  const { manager, store } = await fixture({
    fs,
    runner: async ({ candidatePath }) => {
      await writeFile(candidatePath, JSON.stringify(validCandidate()), 'utf8');
    }
  });

  const run = await manager.start();
  const completed = await manager.waitForIdle(run.runId);
  const state = await store.read();

  assert.equal(completed.status, 'success');
  assert.equal(state.jobs.length, 1);
  assert.equal(state.updates.status, 'success');
  assert.ok(completed.warnings.some((warning) => warning.code === 'ARCHIVE_FAILED'));
});

test('post-commit log failure is reported as a warning without rolling back import', async () => {
  let appendCalls = 0;
  const fs = {
    ...realFs,
    async appendFile(...args) {
      appendCalls += 1;
      if (appendCalls >= 2) throw new Error('log unavailable');
      return realFs.appendFile(...args);
    }
  };
  const { manager, store } = await fixture({
    fs,
    runner: async ({ candidatePath }) => {
      await writeFile(candidatePath, JSON.stringify(validCandidate()), 'utf8');
    }
  });

  const run = await manager.start();
  const completed = await manager.waitForIdle(run.runId);

  assert.equal(completed.status, 'success');
  assert.equal((await store.read()).jobs.length, 1);
  assert.ok(completed.warnings.some((warning) => warning.code === 'LOG_FAILED'));
});

test('PowerShell wrapper uses a read-only Codex sandbox and relative path boundaries', async () => {
  const script = await readFile(
    join(process.cwd(), 'updates', 'run-public-update.ps1'),
    'utf8'
  );

  assert.match(script, /GetRelativePath/);
  assert.doesNotMatch(script, /\.StartsWith\(/);
  assert.match(script, /'--sandbox',\s*'read-only'/);
  assert.doesNotMatch(script, /workspace-write/);
});

test('PowerShell 5.1 path boundary rejects a same-prefix or outside path before Codex starts', () => {
  const scriptPath = join(process.cwd(), 'updates', 'run-public-update.ps1');
  const outputPath = join(process.cwd(), 'data', 'boundary-test-output.json');
  const result = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    '-ProjectPath',
    process.cwd(),
    '-PromptPath',
    process.execPath,
    '-OutputPath',
    outputPath
  ], { encoding: 'utf8', windowsHide: true });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;

  assert.notEqual(result.status, 0);
  assert.match(output, /PromptPath must be inside ProjectPath/);
  assert.doesNotMatch(output, /does not contain a method named|GetRelativePath.*method/i);
});
