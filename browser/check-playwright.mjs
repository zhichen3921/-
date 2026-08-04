import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.setContent('<h1>Playwright ready</h1>');
console.log(await page.locator('h1').textContent());
await browser.close();
