import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const context = browser.contexts()[0];
const page = context?.pages().find((candidate) => candidate.url().includes('/web/geek/job'));

if (!page) throw new Error('BOSS search page not found. Run browser:search first.');

await page.waitForLoadState('domcontentloaded').catch(() => {});
await page.waitForTimeout(2500);

const jobs = await page.locator('.job-card-wrapper, .job-card-box').evaluateAll((cards) => cards.map((card) => {
  const text = (selector) => card.querySelector(selector)?.textContent?.trim() ?? '';
  const allText = (selector) => Array.from(card.querySelectorAll(selector))
    .map((node) => node.textContent?.trim())
    .filter(Boolean);
  const anchor = card.querySelector('a[href*="/job_detail/"]');
  const href = anchor?.getAttribute('href') ?? '';

  return {
    title: text('.job-name'),
    company: text('.company-name'),
    area: text('.job-area'),
    salary: text('.salary'),
    tags: allText('.tag-list li, .job-card-footer li'),
    url: href ? new URL(href, location.origin).href : ''
  };
}).filter((job) => job.title || job.company));

const output = {
  source: page.url(),
  extractedAt: new Date().toISOString(),
  count: jobs.length,
  jobs
};

writeFileSync('data/boss-jobs.json', JSON.stringify(output, null, 2), 'utf8');
console.log(`Extracted ${jobs.length} jobs to data/boss-jobs.json`);
process.exit(0);
