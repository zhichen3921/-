import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const contexts = browser.contexts();
const pages = contexts.flatMap((context) => context.pages());

console.log(`Connected to dedicated Edge. Pages: ${pages.length}`);
for (const page of pages) {
  console.log(`${await page.title().catch(() => '')} | ${page.url()}`);
}

// End this short-lived checker without sending Browser.close to the user's Edge.
process.exit(0);
