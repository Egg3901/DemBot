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

const parseCookies = (cookieStr) => {
  if (!cookieStr || typeof cookieStr !== 'string') return [];
  const parts = cookieStr.split(';').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return [];

  const cookies = [];
  for (const seg of parts) {
    if (!seg.includes('=')) {
      cookies.push({ name: 'ppusa_session', value: seg });
      continue;
    }
    const [rawName, ...rest] = seg.split('=');
    let name = (rawName || '').trim();
    let value = rest.join('=').trim();
    if (/^ppusa_session=/i.test(value)) value = value.replace(/^ppusa_session=/i, '');
    cookies.push({ name, value });
  }
  return cookies;
};

async function tryCookieAuth(page, targetUrl, actions) {
  if (!config.cookie) return false;
  const parsed = parseCookies(config.cookie);
  if (!parsed.length) return false;
  const urlForCookie = new URL(config.baseUrl);
  pushAction(actions, 'cookie-apply', true, { names: parsed.map((c) => c.name), domain: urlForCookie.hostname });
  for (const kv of parsed) {
    if (!kv.name || !kv.value) continue;
    await page.setCookie({
      name: kv.name,
      value: kv.value,
      domain: urlForCookie.hostname,
      path: '/',
      httpOnly: false,
    });
  }
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

  try {
    await page.setExtraHTTPHeaders({ 'Accept-Language': config.acceptLanguage });
  } catch (_) {}

  try {
    if (config.timezone) await page.emulateTimezone(config.timezone);
  } catch (_) {}

  if (typeof page.setUserAgent === 'function') {
    await page.setUserAgent(config.cookie && config.cookieUserAgent ? config.cookieUserAgent : config.userAgent);
    pushAction(actions, 'ua-set', true, { userAgent: config.userAgent });
  }

  try {
    if (await tryCookieAuth(page, targetUrl, actions)) {
      try {
        const expectedPath = new URL(targetUrl).pathname;
        const afterCookie = new URL(page.url()).pathname;
        const cookieReached = afterCookie === expectedPath;
        pushAction(actions, 'cookie-target-verify', cookieReached, {
          finalUrl: page.url(),
          expectedPath,
        });
        if (!cookieReached) {
          throw new PPUSAAuthError('Authenticated (cookie) but redirected away from target', {
            finalUrl: page.url(),
            expectedPath,
            actions,
            reason: 'redirect-away',
          });
        }
      } catch (verifyErr) {
        if (verifyErr instanceof PPUSAAuthError) throw verifyErr;
        // Fallback: non-PPUSA error in verification; log but continue
        console.warn('Cookie target verification error:', verifyErr?.message || verifyErr);
      }

      console.log('[ppusa-auth] login ok via cookie:', page.url());
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
      const turnstilePresent = inputSnapshot.some(
        (input) =>
          /turnstile/i.test(input.name || '') ||
          /turnstile/i.test(input.id || '') ||
          /cf-/i.test(input.name || '')
      );
      const message = turnstilePresent
        ? 'Cloudflare Turnstile challenge detected (login form hidden)'
        : 'Login fields not found';
      throw new PPUSAAuthError(message, {
        emailSel,
        passSel,
        triedSelectors: selectors,
        inputSnapshot,
        finalUrl: page.url(),
        actions,
        challenge: turnstilePresent ? 'cloudflare-turnstile' : null,
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

    try {
      const expectedPath = new URL(targetUrl).pathname;
      const currentPath = new URL(page.url()).pathname;
      const onTarget = currentPath === expectedPath;
      pushAction(actions, 'target-verify', onTarget, {
        finalUrl: page.url(),
        expectedPath,
      });
      if (!onTarget) {
        throw new PPUSAAuthError('Authenticated (form) but redirected away from target', {
          finalUrl: page.url(),
          expectedPath,
          actions,
          reason: 'redirect-away',
        });
      }
    } catch (verifyErr) {
      if (verifyErr instanceof PPUSAAuthError) throw verifyErr;
      console.warn('Form target verification error:', verifyErr?.message || verifyErr);
    }

    console.log('[ppusa-auth] login ok after form:', page.url());
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









