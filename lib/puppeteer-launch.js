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

// Prefer Puppeteer's managed Chromium by default. Allow opting into the
// `chromium` package binary only if explicitly requested via env.
const useChromiumPackage = String(process.env.PUPPETEER_USE_CHROMIUM_PACKAGE || 'false').toLowerCase() === 'true';
let chromiumPackagePath = null;
if (useChromiumPackage) {
  try {
    const chromium = require('chromium');
    if (chromium?.path && fs.existsSync(chromium.path)) chromiumPackagePath = chromium.path;
  } catch (_) {
    chromiumPackagePath = null;
  }
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

  // Only use the chromium package path if explicitly opted-in.
  if (useChromiumPackage && chromiumPackagePath) return chromiumPackagePath;

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
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-field-trial-config',
    '--disable-back-forward-cache',
    '--disable-hang-monitor',
    '--disable-ipc-flooding-protection',
    '--disable-popup-blocking',
    '--disable-prompt-on-repost',
    '--disable-domain-reliability',
    '--disable-component-extensions-with-background-pages',
    '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    '--window-size=1920,1080',
    '--lang=en-US,en',
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
  // Default to classic headless=true for maximum stability on servers
  const headless = headlessEnv ? (headlessEnv === 'true' ? true : headlessEnv) : true;

  const merged = {
    headless,
    args: baseArgs(),
    ignoreDefaultArgs: ['--enable-automation'],
    ignoreHTTPSErrors: true,
    protocolTimeout: 300000, // 5 minutes timeout for protocol operations
    ...opts,
    ...(executablePath ? { executablePath } : {}),
    ...(opts.args ? { args: [...baseArgs(), ...opts.args] } : {}),
  };
  try {
    const ep = merged.executablePath || '(puppeteer-managed)';
    // Helpful for diagnosing binary mismatches on servers like EC2
    console.log('[puppeteer-launch] Using executable:', ep, 'headless:', merged.headless);
  } catch (_) {}
  return puppeteer.launch(merged);
}

module.exports = { launch };
