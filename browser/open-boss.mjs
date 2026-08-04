import { appendFileSync } from 'node:fs';
import { chromium } from 'playwright';

const TARGET_URL = 'https://www.zhipin.com/';
const FALLBACK_URL = 'https://www.zhipin.com/web/geek/job';
const LOG_FILE = 'browser/open-boss.log';

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  appendFileSync(LOG_FILE, `${line}\n`, { encoding: 'utf8' });
}

log('Starting Playwright');

const context = await chromium.launchPersistentContext('.browser-profile', {
  headless: false,
  viewport: null,
  args: ['--start-maximized'],
  handleSIGINT: false,
  handleSIGTERM: false,
  handleSIGHUP: false
});

let mainPage = context.pages()[0] ?? await context.newPage();
let recovering = false;
let blankChecks = 0;

function observe(page) {
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) log(`Main navigation: ${frame.url()}`);
  });
  page.on('close', () => {
    if (page === mainPage) log('Main page closed; watchdog will recreate it');
  });
  page.on('crash', () => log('Main page crashed; watchdog will recover it'));
}

async function openBoss(reason) {
  if (recovering) return;
  recovering = true;
  try {
    if (!mainPage || mainPage.isClosed()) {
      mainPage = await context.newPage();
      observe(mainPage);
    }
    mainPage.setDefaultNavigationTimeout(45000);
    await mainPage.bringToFront();
    log(`Opening BOSS (${reason})`);
    await mainPage.goto(TARGET_URL, { waitUntil: 'commit' });
    await mainPage.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    log(`BOSS ready: ${mainPage.url()}`);
  } catch (error) {
    log(`Primary navigation failed: ${error.message}`);
    await mainPage.goto(FALLBACK_URL, { waitUntil: 'commit', timeout: 30000 }).catch((fallbackError) => {
      log(`Fallback navigation failed: ${fallbackError.message}`);
    });
  } finally {
    blankChecks = 0;
    recovering = false;
  }
}

observe(mainPage);
context.on('close', () => log('Browser context closed'));
context.on('page', (page) => {
  if (page !== mainPage) log(`New page opened: ${page.url()}`);
});

await openBoss('initial launch');

const watchdog = setInterval(async () => {
  if (!mainPage || mainPage.isClosed()) {
    await openBoss('main page was closed');
    return;
  }

  const url = mainPage.url();
  const isBlank = url === 'about:blank' || url.startsWith('chrome://newtab');
  blankChecks = isBlank ? blankChecks + 1 : 0;

  if (blankChecks >= 2) {
    log(`Blank page detected repeatedly: ${url}`);
    await openBoss('blank-page recovery');
  }
}, 2000);

async function shutdown(signal) {
  log(`Shutting down after ${signal}`);
  clearInterval(watchdog);
  await context.close().catch(() => {});
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP', () => shutdown('SIGHUP'));
process.on('uncaughtException', (error) => log(`Uncaught exception: ${error.stack ?? error.message}`));
process.on('unhandledRejection', (error) => log(`Unhandled rejection: ${error?.stack ?? error}`));

log('Watchdog active; browser process will stay alive');
await new Promise(() => {});
