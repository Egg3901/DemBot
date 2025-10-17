const path = require('node:path');
const { launch } = require('./puppeteer-launch');
const { config, selectors, toAbsoluteUrl } = require('./ppusa-config');

class PPUSAAuthError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'PPUSAAuthError';
    this.details = details;
  }
}

const nowIso = () => new Date().toISOString();

const pushAction = (actions, step, success, data = {}) => {
  actions.push({ step, success, timestamp: nowIso(), ...data });
};

const captureInputSnapshot = async (page, limit = 10) => {
  try {
    return await page.evaluate((max) => {
      return Array.from(document.querySelectorAll('input'))
        .slice(0, max)
        .map((el) => ({
          type: el.getAttribute('type') || null,
          name: el.getAttribute('name') || null,
          id: el.id || null,
          placeholder: el.getAttribute('placeholder') || null,
          className: el.className || null,
          visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
        }));
    }, limit);
  } catch (_) {
    return [];
  }
};

const waitForFirst = async (page, list, timeout = 4000) => {
  try {
    return await Promise.any(
      list.map((sel) =>
        page.waitForSelector(sel, { timeout }).then(() => sel)
      )
    );
  } catch (_) {
    return null;
  }
};

const parseCookie = (cookieStr) => {
  if (!cookieStr || typeof cookieStr !== 'string') return null;
  const segments = cookieStr.split(';').map((s) => s.trim()).filter(Boolean);
  if (!segments.length) return null;
  const firstWithEquals = segments.find((seg) => seg.includes('='));
  if (!firstWithEquals) return null;
  const [name, ...rest] = firstWithEquals.split('=');
  const value = rest.join('=');
  if (!name || !value) return null;
  return { name: name.trim(), value: value.trim() };
};

async function tryCookieAuth(page, targetUrl, actions) {
  if (!config.cookie) return false;
  const cookieKV = parseCookie(config.cookie);
  if (!cookieKV) return false;
  const urlForCookie = new URL(config.baseUrl);
  pushAction(actions, 'cookie-apply', true, { name: cookieKV.name, domain: urlForCookie.hostname });
  await page.setCookie({
    name: cookieKV.name,
    value: cookieKV.value,
    domain: urlForCookie.hostname,
    path: '/',
    httpOnly: false,
  });
  await page.goto(targetUrl, { waitUntil: 'networkidle2' });
  const stillOnLogin = /\/login\b/i.test(page.url());
  pushAction(actions, 'cookie-check', !stillOnLogin, { finalUrl: page.url() });
  return !stillOnLogin;
}

async function authenticateAndNavigate({ url, waitUntil = 'networkidle2', debug = config.debug } = {}) {
  if (!config.email || !config.password) {
    throw new PPUSAAuthError('Missing PPUSA_EMAIL or PPUSA_PASSWORD', { email: !!config.email, password: !!config.password });
  }

  const actions = [];
  const targetUrl = toAbsoluteUrl(url || '/');
  pushAction(actions, 'start', true, { targetUrl });

  const browser = await launch();
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(config.navTimeout);
  pushAction(actions, 'browser-new', true, { navTimeout: config.navTimeout });

  if (typeof page.setUserAgent === 'function') {
    await page.setUserAgent(config.userAgent);
    pushAction(actions, 'ua-set', true, { userAgent: config.userAgent });
  }

  try {
    if (await tryCookieAuth(page, targetUrl, actions)) {
      const html = await page.content();
      return { browser, page, html, finalUrl: page.url(), status: 200, actions };
    }

    const loginUrl = toAbsoluteUrl(config.loginPage || '/login');
    await page.goto(loginUrl, { waitUntil: 'networkidle2' });
    pushAction(actions, 'login-goto', true, { loginUrl: page.url() });

    const emailSel = await waitForFirst(page, selectors.email, 4000);
    const passSel = await waitForFirst(page, selectors.password, 4000);
    if (!emailSel || !passSel) {
      const inputSnapshot = await captureInputSnapshot(page);
      throw new PPUSAAuthError('Login fields not found', {
        emailSel,
        passSel,
        triedSelectors: selectors,
        inputSnapshot,
        finalUrl: page.url(),
        actions,
      });
    }
    pushAction(actions, 'login-fields', true, { emailSel, passSel });

    await page.focus(emailSel);
    await page.keyboard.type(config.email, { delay: 15 });
    await page.focus(passSel);
    await page.keyboard.type(config.password, { delay: 15 });
    pushAction(actions, 'login-type', true, { emailLength: config.email.length });

    const submitSel = await waitForFirst(page, selectors.submit, 4000);
    pushAction(actions, 'login-submit-selector', !!submitSel, { submitSel });

    if (submitSel) {
      await Promise.all([
        page.waitForNavigation({ waitUntil, timeout: config.navTimeout }).catch(() => null),
        page.click(submitSel),
      ]);
    } else {
      await Promise.all([
        page.waitForNavigation({ waitUntil, timeout: config.navTimeout }).catch(() => null),
        page.keyboard.press('Enter'),
      ]);
    }
    pushAction(actions, 'login-submitted', true, { finalUrl: page.url() });

    if (/\/login\b/i.test(page.url())) {
      const err = new PPUSAAuthError('Auth rejected', { finalUrl: page.url(), actions });
      if (debug && typeof page.screenshot === 'function') {
        const fname = `ppusa_login_rejected_${Date.now()}.png`;
        const fpath = path.join(process.cwd(), fname);
        try {
          await page.screenshot({ path: fpath, fullPage: true });
          err.details.screenshot = fpath;
          pushAction(actions, 'login-screenshot', true, { screenshot: fpath });
        } catch (shotErr) {
          pushAction(actions, 'login-screenshot', false, { error: shotErr.message });
        }
      }
      err.details.actions = actions;
      throw err;
    }

    if (page.url() !== targetUrl) {
      await page.goto(targetUrl, { waitUntil });
      pushAction(actions, 'target-goto', true, { finalUrl: page.url() });
    } else {
      pushAction(actions, 'target-goto', true, { finalUrl: page.url(), skipped: true });
    }

    const response = await page.content();
    return { browser, page, html: response, finalUrl: page.url(), status: 200, actions };
  } catch (error) {
    pushAction(actions, 'error', false, { message: error.message });
    if (error instanceof PPUSAAuthError) {
      error.details.actions = actions;
    }
    try {
      await browser.close();
      pushAction(actions, 'browser-close', true, {});
    } catch (closeErr) {
      pushAction(actions, 'browser-close', false, { error: closeErr.message });
    }
    if (error instanceof PPUSAAuthError) throw error;
    throw new PPUSAAuthError(error.message, { actions });
  }
}

module.exports = {
  authenticateAndNavigate,
  PPUSAAuthError,
  selectors,
  config,
};
