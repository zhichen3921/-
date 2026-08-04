import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const pages = browser.contexts().flatMap((context) => context.pages());
console.log(`PAGES: ${pages.length}`);
for (const [index, candidate] of pages.entries()) {
  console.log(`PAGE_${index + 1}: ${await candidate.title().catch(() => '')} | ${candidate.url()}`);
}
const page = pages.find((candidate) => candidate.url().includes('zhipin.com'));

if (!page) throw new Error('BOSS page not found.');

console.log(`URL: ${page.url()}`);
console.log(`TITLE: ${await page.title().catch(() => '')}`);
console.log(`JOB_LINKS: ${await page.locator('a[href*="job_detail"]').count()}`);
console.log(`CARDS_A: ${await page.locator('.job-card-wrapper').count()}`);
console.log(`CARDS_B: ${await page.locator('.job-card-box').count()}`);
const bodyText = await page.locator('body').innerText().catch(() => '');
console.log(`BODY:\n${bodyText.slice(0, 1600)}`);
process.exit(0);
