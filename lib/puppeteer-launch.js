/**
 * Centralized Puppeteer launcher with sane defaults for servers/containers.
 * - Respects `PUPPETEER_EXECUTABLE_PATH` or `CHROME_PATH` if provided
 * - Adds flags for common headless environments (no-sandbox, shm fix)
 * - Forces use of the stealth plugin to reduce bot detection
 * - Allows callers to merge/override via an options argument
 */
const fs = require('node:fs');
const path = require('node:path');
const puppeteerExtra = require('puppeteer-extra');
const stealthPlugin = require('puppeteer-extra-plugin-stealth');
let bundledChromiumPath = null;

try {
  const chromium = require('chromium');
  if (chromium?.path) bundledChromiumPath = chromium.path;
} catch (_) {
  bundledChromiumPath = null;
}

// Always load the stealth plugin; bubble a helpful message on failure.
let puppeteer;
try {
  puppeteerExtra.use(stealthPlugin());
  puppeteer = puppeteerExtra;
} catch (err) {
  err.message = `Failed to initialize puppeteer-extra stealth plugin: ${err.message}`;
  throw err;
}

function resolveExecutablePath() {
  const explicit =
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    process.env.CHROME_PATH ||
    '';
  if (explicit) return explicit;

  if (bundledChromiumPath && fs.existsSync(bundledChromiumPath)) {
    return bundledChromiumPath;
  }

  return undefined;
}

function baseArgs() {
  const extra = (process.env.PUPPETEER_ARGS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-zygote',
    '--disable-blink-features=AutomationControlled',
    '--disable-web-security',
    '--disable-features=VizDisplayCompositor',
    '--disable-extensions',
    '--disable-plugins',
    '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ...extra,
  ];
}

/**
 * Launch Puppeteer with opinionated defaults.
 * @param {import('puppeteer').LaunchOptions & import('puppeteer').BrowserLaunchArgumentOptions & import('puppeteer').BrowserConnectOptions} [opts]
 */
async function launch(opts = {}) {
  const executablePath = resolveExecutablePath();
  const headlessEnv = process.env.PUPPETEER_HEADLESS;
  const headless = headlessEnv ? (headlessEnv === 'true' ? true : headlessEnv) : 'new';

  const merged = {
    headless,
    args: baseArgs(),
    ...opts,
    ...(executablePath ? { executablePath } : {}),
    ...(opts.args ? { args: [...baseArgs(), ...opts.args] } : {}),
  };
  return puppeteer.launch(merged);
}

module.exports = { launch };
