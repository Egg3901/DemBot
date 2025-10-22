const fs = require('node:fs');
const path = require('node:path');
const { launch } = require('./puppeteer-launch');
const { config, toAbsoluteUrl } = require('./ppusa-config');

let browserPromise = null;

function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch (_) {}
}

async function getBrowser() {
  if (browserPromise) return browserPromise;

  const userDataDir = process.env.PUPPETEER_USER_DATA_DIR
    ? path.resolve(process.cwd(), process.env.PUPPETEER_USER_DATA_DIR)
    : path.resolve(process.cwd(), '.cache', 'puppeteer');

  // Allow opting out of persistence
  const persist = String(process.env.PUPPETEER_PERSIST || 'true').toLowerCase() !== 'false';
  if (persist) ensureDir(userDataDir);

  const args = [];
  // Modest disk cache to speed up repeat navigations
  const cacheDir = path.join(userDataDir, 'http-cache');
  if (persist) {
    ensureDir(cacheDir);
    args.push(`--disk-cache-dir=${cacheDir}`);
    args.push('--disk-cache-size=268435456'); // 256MB
  }

  browserPromise = launch({
    ...(persist ? { userDataDir } : {}),
    args,
  });

  return browserPromise;
}

function isThirdParty(urlStr, firstPartyHost) {
  try {
    const u = new URL(urlStr);
    return u.hostname !== firstPartyHost;
  } catch (_) {
    return false;
  }
}

async function newPage({ intercept = true } = {}) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try { await page.setDefaultNavigationTimeout(Number(config.navTimeout) || 20000); } catch (_) {}

  // Standard headers/UA/timezone for consistency
  try { await page.setExtraHTTPHeaders({ 'Accept-Language': config.acceptLanguage }); } catch (_) {}
  try {
    if (config.timezone) await page.emulateTimezone(config.timezone);
  } catch (_) {}
  try {
    if (typeof page.setUserAgent === 'function') {
      await page.setUserAgent(config.cookie && config.cookieUserAgent ? config.cookieUserAgent : config.userAgent);
    }
  } catch (_) {}

  if (intercept) {
    const base = new URL(toAbsoluteUrl('/'));
    const firstPartyHost = base.hostname;
    const blockedTypes = new Set(
      (process.env.PPUSA_BLOCK_RESOURCE_TYPES || 'image,media,font,stylesheet,beacon,preload,prefetch,websocket')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    );

    try {
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const type = (req.resourceType() || '').toLowerCase();
        if (blockedTypes.has(type)) return req.abort();
        if (isThirdParty(req.url(), firstPartyHost)) {
          // Allow first-party scripts/XHR; block third-party noise for speed
          const allowList = ['document', 'xhr', 'fetch', 'script'];
          if (!allowList.includes(type)) return req.abort();
        }
        return req.continue();
      });
    } catch (_) {}
  }

  return page;
}

async function ensureHealthy() {
  try {
    const browser = await getBrowser();
    await browser.version();
    return true;
  } catch (_) {
    browserPromise = null; // force relaunch on next call
    return false;
  }
}

module.exports = {
  getBrowser,
  newPage,
  ensureHealthy,
};


