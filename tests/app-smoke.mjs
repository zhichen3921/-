import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

await page.goto(pathToFileURL(resolve('index.html')).href, { waitUntil: 'domcontentloaded' });
assert.equal(await page.locator('.search-card').count(), 5);
assert.equal(await page.locator('#radar-section.active-section').count(), 1);
assert.equal(await page.locator('[data-section="updates"]').count(), 0);
await page.locator('[data-section="queue"]').click();
assert.equal(await page.locator('[data-section="queue"]').getAttribute('aria-current'), 'page');
assert.equal(await page.locator('#queue-section[role="tabpanel"].active-section').count(), 1);
assert.equal(await page.locator('#queue-section.active-section .job-card').count(), 8);
await page.locator('[data-filter="recommended"]').click();
assert.equal(await page.locator('#queue-section.active-section .job-card').count(), 5);
await page.locator('[data-filter="stretch"]').click();
assert.equal(await page.locator('#queue-section.active-section .job-card').count(), 3);
await page.locator('[data-filter="all"]').click();
await page.locator('.job-card', { hasText: 'AI工作流实习生' }).locator('[data-greet]').click();
assert.match(await page.locator('#match-summary').innerText(), /公开核验|职业发展中心/);
await page.locator('#greeting-modal [data-close]').click();
await page.locator('#add-job-btn').click();
await page.locator('#job-title').fill('大模型应用开发实习生');
await page.locator('#job-company').fill('测试科技');
await page.locator('#job-location').fill('深圳·南山');
await page.locator('#job-url').fill('https://www.zhipin.com/job_detail/example.html');
await page.locator('#job-description').fill('面向2028届硕士在校生，负责大模型 API 应用和 Python 数据处理，熟悉机器学习、XGBoost、SHAP者优先。');
await page.locator('#job-form button[type="submit"]').click();
assert.equal(await page.locator('#queue-section.active-section .job-card').count(), 9);
const testJob = page.locator('#queue-section.active-section .job-card', { hasText: '测试科技' });
assert.match(await testJob.innerText(), /优先沟通/);
await testJob.locator('[data-greet]').click();
assert.match(await page.locator('#greeting-text').inputValue(), /您好，我是/);
await page.locator('#greeting-modal [data-close]').click();
assert.equal(errors.length, 0, errors.join('\n'));

await page.locator('[data-section="preferences"]').click();
await page.locator('[name="queueThreshold"]').fill('78');
await page.locator('.preferences-form').evaluate((form) => form.requestSubmit());
assert.match(await page.locator('#toast').innerText(), /偏好已保存在浏览器/);

await page.locator('[data-section="extension"]').click();
assert.equal(await page.locator('#extension-section.active-section').count(), 1);
assert.match(await page.locator('#extension-center-root').innerText(), /浏览器扩展/);

await page.reload({ waitUntil: 'domcontentloaded' });
await page.locator('[data-section="queue"]').click();
assert.equal(await page.locator('#queue-section.active-section .job-card').count(), 9);
await page.locator('[data-section="preferences"]').click();
assert.equal(await page.locator('[name="queueThreshold"]').inputValue(), '78');

await page.setViewportSize({ width: 390, height: 844 });
await page.locator('[data-section="queue"]').click();
assert.equal(await page.locator('#queue-section.active-section .job-card').count(), 9);
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);

console.log('Application desk smoke test passed');
await browser.close();
