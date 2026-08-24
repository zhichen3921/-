import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import { chromium } from 'playwright';

const extractorPath = resolve('extension/extract-current-job.js');
const pageExtractorPath = resolve('extension/extract-current-page-jobs.js');
const fixturePath = resolve('tests/fixtures/boss-job-detail.html');
const splitLayoutFixturePath = resolve('tests/fixtures/boss-job-detail-split-layout.html');
const expandedSearchFixturePath = resolve('tests/fixtures/boss-search-expanded.html');
const hiddenPanelsFixturePath = resolve('tests/fixtures/boss-hidden-panels.html');

async function withPage(html, run) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html);
    await page.addScriptTag({ path: extractorPath });
    return await run(page);
  } finally {
    await browser.close();
  }
}

test('extracts the currently visible BOSS job and canonical URL', async () => {
  const html = await readFile(fixturePath, 'utf8');
  const result = await withPage(html, (page) => page.evaluate(() => (
    globalThis.BossJobCollectorExtract(document, {
      hostname: 'www.zhipin.com',
      href: 'https://www.zhipin.com/job_detail/fallback.html?seed=1'
    })
  )));

  assert.deepEqual(result, {
    title: 'AI Agent 实习生',
    company: '青屿智能',
    location: '深圳 · 南山区 · 科技园',
    salary: '200-300元/天',
    description: '参与 AI Agent 工作流设计与验证； 使用 Python、Prompt 和大模型 API 完成数据处理与自动化脚本。',
    url: 'https://www.zhipin.com/job_detail/fixture-ai-agent.html',
    missingFields: []
  });
});

test('extracts a direct detail page whose banner, description, and company are split', async () => {
  const html = await readFile(splitLayoutFixturePath, 'utf8');
  const result = await withPage(html, (page) => page.evaluate(() => (
    globalThis.BossJobCollectorExtract(document, {
      hostname: 'www.zhipin.com',
      href: 'https://www.zhipin.com/job_detail/ce02a7c301ca32571HJz396_FFdT.html?securityId=test'
    })
  )));

  assert.equal(result.title, 'AI大模型人工智能实习生');
  assert.equal(result.company, '马丁鱼科技有限公司');
  assert.equal(result.location, '深圳');
  assert.equal(result.salary, '100-150元/天');
  assert.match(result.description, /落地 AI 大模型人工智能相关项目/);
  assert.equal(
    result.url,
    'https://www.zhipin.com/job_detail/ce02a7c301ca32571HJz396_FFdT.html'
  );
  assert.deepEqual(result.missingFields, []);
});

test('uses JobPosting JSON-LD fallbacks and reports fields it cannot find', async () => {
  const html = `<!doctype html><html><head>
    <script type="application/ld+json">${JSON.stringify({
      '@type': 'JobPosting',
      title: '大模型应用实习生',
      hiringOrganization: { name: '折枝科技' },
      jobLocation: { address: { addressLocality: '深圳市' } },
      description: '<p>参与大模型 API 应用开发。</p>'
    })}</script>
  </head><body><div class="layout-vNext">新版结构</div></body></html>`;

  const result = await withPage(html, (page) => page.evaluate(() => (
    globalThis.BossJobCollectorExtract(document, {
      hostname: 'www.zhipin.com',
      href: 'https://www.zhipin.com/job_detail/layout-vnext.html?ka=search'
    })
  )));

  assert.equal(result.title, '大模型应用实习生');
  assert.equal(result.company, '折枝科技');
  assert.equal(result.location, '深圳市');
  assert.equal(result.description, '参与大模型 API 应用开发。');
  assert.equal(result.url, 'https://www.zhipin.com/job_detail/layout-vnext.html');
  assert.deepEqual(result.missingFields, ['salary']);
});

test('rejects pages outside zhipin.com without reading page content', async () => {
  const html = '<h1 class="job-title">伪造岗位</h1>';
  const error = await withPage(html, (page) => page.evaluate(() => {
    try {
      globalThis.BossJobCollectorExtract(document, {
        hostname: 'example.com',
        href: 'https://example.com/job_detail/fake.html'
      });
      return null;
    } catch (caught) {
      return { name: caught.name, code: caught.code, message: caught.message };
    }
  }));

  assert.equal(error?.name, 'BossCollectorError');
  assert.equal(error?.code, 'NOT_BOSS_PAGE');
});

async function captureError(html, location) {
  return withPage(html, (page) => page.evaluate((locationRef) => {
    try {
      globalThis.BossJobCollectorExtract(document, locationRef);
      return null;
    } catch (caught) {
      return { name: caught.name, code: caught.code, message: caught.message };
    }
  }, location));
}

for (const [pageName, href, body] of [
  ['chat', 'https://www.zhipin.com/web/geek/chat', '<main><h1 class="job-title">聊天中的岗位标题</h1><div class="job-sec-text">聊天记录</div></main>'],
  ['profile', 'https://www.zhipin.com/web/geek/recommend', '<main><h1>我的简历</h1><div class="company-name">个人中心</div></main>'],
  ['home', 'https://www.zhipin.com/', '<main><h1>找工作，上 BOSS 直聘</h1></main>'],
  ['list-only', 'https://www.zhipin.com/web/geek/job', '<main><a href="/job_detail/list-one.html">AI 实习生</a><a href="/job_detail/list-two.html">算法实习生</a></main>']
]) {
  test(`rejects ${pageName} pages without an active job detail`, async () => {
    const error = await captureError(`<!doctype html><html><body>${body}</body></html>`, {
      hostname: 'www.zhipin.com',
      href
    });

    assert.equal(error?.name, 'BossCollectorError');
    assert.equal(error?.code, 'NO_ACTIVE_JOB_DETAIL');
  });
}

test('extracts only the visible active detail and ignores hidden or inactive panels', async () => {
  const html = await readFile(hiddenPanelsFixturePath, 'utf8');
  const result = await withPage(html, (page) => page.evaluate(() => (
    globalThis.BossJobCollectorExtract(document, {
      hostname: 'www.zhipin.com',
      href: 'https://www.zhipin.com/web/geek/job?query=AI'
    })
  )));

  assert.equal(result.title, '可见 Agent 实习生');
  assert.equal(result.company, '可见科技');
  assert.equal(result.description, '这是当前活动岗位的描述。');
  assert.equal(result.url, 'https://www.zhipin.com/job_detail/visible-agent.html');
});

test('uses the active expanded detail link instead of the search page URL', async () => {
  const html = await readFile(expandedSearchFixturePath, 'utf8');
  const result = await withPage(html, (page) => page.evaluate(() => (
    globalThis.BossJobCollectorExtract(document, {
      hostname: 'www.zhipin.com',
      href: 'https://www.zhipin.com/web/geek/job?query=AI&city=101280600'
    })
  )));

  assert.equal(result.title, 'AI 工作流实习生');
  assert.equal(result.url, 'https://www.zhipin.com/job_detail/active-workflow.html');
});

test('extracts only visible job cards from the current search page for batch collection', async () => {
  const html = await readFile(expandedSearchFixturePath, 'utf8');
  const result = await withPage(html, async (page) => {
    await page.addScriptTag({ path: pageExtractorPath });
    return page.evaluate(() => globalThis.BossJobCollectorExtractPage(document, {
      hostname: 'www.zhipin.com',
      href: 'https://www.zhipin.com/web/geek/job?query=AI&city=101280600',
      pathname: '/web/geek/job'
    }));
  });

  assert.equal(result.totalVisible, 2);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.jobs.map((job) => job.title), [
    '算法实习生',
    'AI 工作流实习生'
  ]);
  assert.deepEqual(result.jobs.map((job) => job.url), [
    'https://www.zhipin.com/job_detail/inactive-algorithm.html',
    'https://www.zhipin.com/job_detail/active-workflow.html'
  ]);
});

test('batch extractor refuses a detail page and does not silently collect one job', async () => {
  const error = await withPage('<main><a href="/job_detail/only.html">唯一岗位</a></main>', async (page) => {
    await page.addScriptTag({ path: pageExtractorPath });
    return page.evaluate(() => {
      try {
        globalThis.BossJobCollectorExtractPage(document, {
          hostname: 'www.zhipin.com',
          href: 'https://www.zhipin.com/job_detail/only.html',
          pathname: '/job_detail/only.html'
        });
        return null;
      } catch (caught) {
        return { code: caught.code, message: caught.message };
      }
    });
  });

  assert.equal(error?.code, 'DETAIL_PAGE_NOT_BATCH');
});

test('batch extractor falls back to visible detail links when card class names change', async () => {
  const html = `<!doctype html><html><body>
    <main class="layout-vnext">
      <section><a href="/job_detail/vnext-agent.html">Agent 应用实习生</a></section>
      <section><a href="/job_detail/vnext-data.html">数据分析实习生</a></section>
    </main>
  </body></html>`;
  const result = await withPage(html, async (page) => {
    await page.addScriptTag({ path: pageExtractorPath });
    return page.evaluate(() => globalThis.BossJobCollectorExtractPage(document, {
      hostname: 'www.zhipin.com',
      href: 'https://www.zhipin.com/web/geek/job?query=AI',
      pathname: '/web/geek/job'
    }));
  });

  assert.deepEqual(result.jobs.map((job) => job.title), ['Agent 应用实习生', '数据分析实习生']);
  assert.deepEqual(result.jobs.map((job) => job.url), [
    'https://www.zhipin.com/job_detail/vnext-agent.html',
    'https://www.zhipin.com/job_detail/vnext-data.html'
  ]);
});

test('refuses an expanded detail when it has no unique job detail URL', async () => {
  const html = `<!doctype html><html><body>
    <section class="job-detail-container active">
      <h1 class="job-title">AI 实习生</h1>
      <div class="company-name">某科技</div>
      <div class="job-sec-text">岗位详情</div>
    </section>
  </body></html>`;
  const error = await captureError(html, {
    hostname: 'www.zhipin.com',
    href: 'https://www.zhipin.com/web/geek/job?query=AI'
  });

  assert.equal(error?.code, 'NO_UNIQUE_JOB_URL');
});

test('accepts a unique JobPosting JSON-LD fallback only with a unique detail URL', async () => {
  const jobPosting = JSON.stringify({
    '@type': 'JobPosting',
    title: '大模型应用实习生',
    url: 'https://www.zhipin.com/job_detail/jsonld-job.html?from=search',
    hiringOrganization: { name: '折枝科技' },
    description: '<p>参与大模型 API 应用开发。</p>'
  });
  const html = `<!doctype html><html><head><script type="application/ld+json">${jobPosting}</script></head><body></body></html>`;
  const result = await withPage(html, (page) => page.evaluate(() => (
    globalThis.BossJobCollectorExtract(document, {
      hostname: 'www.zhipin.com',
      href: 'https://www.zhipin.com/web/geek/job?query=LLM'
    })
  )));

  assert.equal(result.title, '大模型应用实习生');
  assert.equal(result.url, 'https://www.zhipin.com/job_detail/jsonld-job.html');
});

test('rejects malformed JobPosting JSON-LD instead of treating coerced fields as a job', async () => {
  const malformed = JSON.stringify({
    '@type': 'JobPosting',
    title: { text: '伪岗位' },
    url: 'https://www.zhipin.com/job_detail/malformed.html',
    description: '<p>不能用对象标题建立岗位身份。</p>'
  });
  const error = await captureError(
    `<!doctype html><html><head><script type="application/ld+json">${malformed}</script></head><body></body></html>`,
    { hostname: 'www.zhipin.com', href: 'https://www.zhipin.com/web/geek/job' }
  );

  assert.equal(error?.code, 'NO_ACTIVE_JOB_DETAIL');
});
