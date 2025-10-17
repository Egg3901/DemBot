/**
 * Centralized Puppeteer launcher with sane defaults for servers/containers.
 * - Respects `PUPPETEER_EXECUTABLE_PATH` or `CHROME_PATH` if provided
 * - Adds flags for common headless environments (no-sandbox, shm fix)
 * - Allows callers to merge/override via an options argument
 */
const puppeteer = require('puppeteer');

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

