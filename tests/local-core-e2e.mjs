import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { chromium } from 'playwright';

import { createApplicationServer } from '../server/server.mjs';
import { createStore } from '../server/store.mjs';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(testDirectory, '..');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'application-desk-e2e-'));
const store = createStore({
  filePath: join(temporaryRoot, 'data', 'state.json'),
  initialState: { version: 3, jobs: [] }
});
const application = createApplicationServer({
  store,
  host: '127.0.0.1',
  port: 0,
  staticRoot: projectRoot
});

let browser;
try {
  await application.start();
  const address = application.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const returnUrl = `${baseUrl}/`;
  const fileUrl = pathToFileURL(join(projectRoot, 'index.html')).href;
  const bootstrap = await fetch(`${baseUrl}/api/bootstrap`).then((response) => response.json());
  assert.equal(typeof bootstrap.token, 'string');
  assert.ok(bootstrap.token.length >= 32);

  const launcher = await readFile(join(projectRoot, '打开投递台.cmd'), 'utf8');
  const launcherScript = await readFile(
    join(projectRoot, 'scripts', 'open-application-desk.ps1'),
    'utf8'
  );
  assert.match(launcher, /open-application-desk\.ps1/);
  assert.match(launcherScript, /api\/health/);
  assert.match(launcherScript, /WindowStyle Hidden/);
  assert.match(launcherScript, /server\\server\.mjs/);
  assert.match(launcherScript, /legacyBridge=1&migration-bridge=1/);
  assert.match(launcherScript, /migrationBridge=1/);
  assert.match(launcherScript, /token=/);
  assert.match(launcherScript, /\.boss-edge-profile/);
  assert.doesNotMatch(`${launcher}\n${launcherScript}`, /(?:set\s+"?|\$env:)(?:HOME|CODEX_HOME)\s*=/i);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());

  await page.goto(fileUrl, { waitUntil: 'domcontentloaded' });
  const legacy = await page.evaluate(() => {
    const key = 'applicationDesk.v2';
    const value = JSON.parse(localStorage.getItem(key));
    if (!value || value.jobs.length !== 8) throw new Error('Expected eight curated legacy jobs');
    value.jobs[0].status = 'contacted';
    value.jobs[0].greeting = '这是端到端测试保留的人工话术';
    value.jobs[0].greetingEdited = true;
    localStorage.setItem(key, JSON.stringify(value));
    return value;
  });
  assert.equal(legacy.jobs.length, 8);
  assert.deepEqual(legacy.curatedBatches, ['2026-07-31-shenzhen-ai-v1']);

  await page.locator('[data-section="queue"]').click();
  assert.equal(await page.locator('#queue-section.active-section .job-card').count(), 8);
  await page.locator('[data-filter="recommended"]').click();
  assert.equal(await page.locator('#queue-section.active-section .job-card').count(), 5);
  await page.locator('[data-filter="stretch"]').click();
  assert.equal(await page.locator('#queue-section.active-section .job-card').count(), 3);

  const bridgeFragment = new URLSearchParams({
    migrationBridge: '1',
    token: bootstrap.token,
    baseUrl,
    returnUrl
  }).toString();
  const bridgeUrl = `${fileUrl}?legacyBridge=1&migration-bridge=1#${bridgeFragment}`;

  async function migrateThroughFileBridge() {
    await page.goto(bridgeUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForURL((url) => url.href === returnUrl, { timeout: 10_000 });
    await page.locator('[data-section="queue"]').click();
    await page.locator('#queue-section.active-section .job-card').first().waitFor();
  }

  await migrateThroughFileBridge();
  assert.equal(await page.locator('#queue-section.active-section .job-card').count(), 8);

  const firstState = await fetch(`${baseUrl}/api/state`).then((response) => response.json());
  assert.equal(firstState.state.jobs.length, 8);
  assert.ok(firstState.state.importedBatchIds.includes('2026-07-31-shenzhen-ai-v1'));
  assert.deepEqual(firstState.state.updates.legacyMigrationSources, ['applicationDesk.v2']);
  const migratedJob = firstState.state.jobs.find((job) => job.url === legacy.jobs[0].url);
  assert.equal(migratedJob.status, 'contacted');
  assert.equal(migratedJob.greeting, '这是端到端测试保留的人工话术');

  const keyword = page.locator('#compound-filter-panel [name="keyword"]');
  await keyword.fill('锐圳');
  await page.waitForTimeout(180);
  assert.equal(await page.locator('#queue-section.active-section .job-card').count(), 1);
  assert.match(await page.locator('#queue-section.active-section .job-card').innerText(), /深圳锐圳科技/);
  await keyword.fill('');
  await page.waitForTimeout(180);
  assert.equal(await page.locator('#queue-section.active-section .job-card').count(), 8);

  await page.locator('[data-section="preferences"]').click();
  await page.locator('[name="queueThreshold"]').fill('78');
  await page.locator('.preferences-form').evaluate((form) => form.requestSubmit());
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('偏好已保存'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('[data-section="preferences"]').click();
  assert.equal(await page.locator('[name="queueThreshold"]').inputValue(), '78');

  const updateBatch = JSON.parse(await readFile(
    join(projectRoot, 'data', 'update-batches', '2026-07-31-shenzhen-ai-v1.json'),
    'utf8'
  ));
  const reimportResponse = await fetch(`${baseUrl}/api/batches/import`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-desk-token': bootstrap.token
    },
    body: JSON.stringify({
      ...updateBatch,
      id: 'e2e-curated-reimport-v2'
    })
  });
  assert.equal(reimportResponse.status, 200);

  const afterBatch = await fetch(`${baseUrl}/api/state`).then((response) => response.json());
  assert.equal(afterBatch.state.jobs.length, 8);
  const preservedJob = afterBatch.state.jobs.find((job) => job.url === legacy.jobs[0].url);
  assert.equal(preservedJob.status, 'contacted');
  assert.equal(preservedJob.greeting, '这是端到端测试保留的人工话术');
  assert.equal(preservedJob.greetingEdited, true);

  await migrateThroughFileBridge();
  const repeatedState = await fetch(`${baseUrl}/api/state`).then((response) => response.json());
  assert.equal(repeatedState.state.jobs.length, 8);
  assert.equal(
    repeatedState.state.jobs.filter((job) => job.url === legacy.jobs[0].url).length,
    1
  );
  assert.equal(repeatedState.state.jobs.find((job) => job.url === legacy.jobs[0].url).status, 'contacted');
  assert.equal(pageErrors.length, 0, pageErrors.join('\n'));

  console.log('Local core end-to-end test passed');
} finally {
  if (browser) await browser.close();
  await application.close();
  await rm(temporaryRoot, { recursive: true, force: true });
}
