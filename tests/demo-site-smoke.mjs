import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { chromium } from 'playwright';

const siteRoot = resolve('_site');
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

const server = createServer(async (request, response) => {
  try {
    const requestPath = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    const relativePath = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
    const filePath = normalize(join(siteRoot, relativePath));
    if (!filePath.startsWith(siteRoot)) throw new Error('invalid path');
    const body = await readFile(filePath);
    response.writeHead(200, { 'content-type': contentTypes[extname(filePath)] || 'application/octet-stream' });
    response.end(body);
  } catch (_) {
    response.writeHead(404);
    response.end('Not found');
  }
});

await new Promise((resolveServer) => server.listen(0, '127.0.0.1', resolveServer));
const address = server.address();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/?demo=1`, { waitUntil: 'domcontentloaded' });
  await page.click('#nav-profile');
  await page.setInputFiles('#resume-file', {
    name: 'resume.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('姓名：李四\n学校：深圳大学\n学历：硕士研究生\n2027届\n项目经历：机器学习推荐系统\nPython、PyTorch、SQL')
  });
  await page.locator('#resume-upload-status').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('[data-profile-name]')?.textContent === '李四');
  assert.equal(await page.locator('[data-profile-name]').first().textContent(), '李四');
  assert.match(await page.locator('#resume-upload-status').textContent(), /已载入/);
  console.log('Static demo upload smoke test passed');
} finally {
  await browser.close();
  server.close();
}
