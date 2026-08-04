import { chromium } from 'playwright';

const query = process.argv[2] ?? '半导体';
const cityCode = process.argv[3] ?? '101020100'; // Shanghai
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const context = browser.contexts()[0];

if (!context) throw new Error('No browser context found. Please reopen the dedicated BOSS browser.');

let page = context.pages().find((candidate) => candidate.url().includes('zhipin.com'));
if (!page) page = await context.newPage();

const searchUrl = new URL('https://www.zhipin.com/web/geek/job');
searchUrl.searchParams.set('query', query);
searchUrl.searchParams.set('city', cityCode);

await page.goto(searchUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.bringToFront();
console.log(`Opened BOSS search: ${query} | ${page.url()}`);

// Disconnect this helper process without closing the user's Edge.
process.exit(0);
