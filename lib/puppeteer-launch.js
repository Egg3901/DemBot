/**
 * Centralized Puppeteer launcher with sane defaults for servers/containers.
 * - Respects `PUPPETEER_EXECUTABLE_PATH` or `CHROME_PATH` if provided
 * - Adds flags for common headless environments (no-sandbox, shm fix)
 * - Forces use of the stealth plugin to reduce bot detection
 * - Allows callers to merge/override via an options argument
 */
const puppeteerExtra = require('puppeteer-extra');
const stealthPlugin = require('puppeteer-extra-plugin-stealth');

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
  return (
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    process.env.CHROME_PATH ||
    undefined
  );
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

