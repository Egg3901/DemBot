const path = require('node:path');
const { launch } = require('./puppeteer-launch');
const { browserPool } = require('./browser-pool');
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

const pathOf = (u) => {
  try { return new URL(u).pathname; } catch (_) { return ''; }
};

async function enforceTarget(page, targetUrl, actions, waitUntil = 'domcontentloaded') {
  const expectedPath = pathOf(targetUrl);
  const timeout = page.getDefaultNavigationTimeout();

  // 1) Direct navigate to target
  try {
    await page.goto(targetUrl, { waitUntil, timeout });
    const ok = pathOf(page.url()) === expectedPath;
    pushAction(actions, 'target-goto', true, { finalUrl: page.url(), attempt: 'direct' });
    if (ok) return true;
  } catch (e) {
    pushAction(actions, 'target-goto', false, { error: e?.message || String(e), attempt: 'direct' });
  }

  // 2) Party page then target (some apps require establishing context)
  try {
    const m = expectedPath.match(/^\/parties\/(\d+)/);
    if (m && m[1]) {
      const partyHref = toAbsoluteUrl(`/parties/${m[1]}`);
      await page.goto(partyHref, { waitUntil, timeout });
      pushAction(actions, 'party-goto', true, { finalUrl: page.url(), partyId: m[1] });
      await page.goto(targetUrl, { waitUntil, timeout });
      const okParty = pathOf(page.url()) === expectedPath;
      pushAction(actions, 'target-goto', true, { finalUrl: page.url(), attempt: 'after-party' });
      if (okParty) return true;
    }
  } catch (e) {
    pushAction(actions, 'party-goto', false, { error: e?.message || String(e) });
  }

  // 2) Landing then target (some stacks set flags on landing)
  try {
    await page.goto(toAbsoluteUrl('/'), { waitUntil, timeout });
    pushAction(actions, 'landing-goto', true, { finalUrl: page.url() });
    await page.goto(targetUrl, { waitUntil, timeout });
    const ok2 = pathOf(page.url()) === expectedPath;
    pushAction(actions, 'target-goto', true, { finalUrl: page.url(), attempt: 'after-landing' });
    if (ok2) return true;
  } catch (e) {
    pushAction(actions, 'target-goto', false, { error: e?.message || String(e), attempt: 'after-landing' });
  }

  return false;
}

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
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: page.getDefaultNavigationTimeout() });
  const stillOnLogin = /\/login\b/i.test(page.url());
  pushAction(actions, 'cookie-check', !stillOnLogin, { finalUrl: page.url() });
  return !stillOnLogin;
}

async function authenticateAndNavigate({ url, waitUntil = 'domcontentloaded', debug = config.debug } = {}) {
  if (!config.email || !config.password) {
    throw new PPUSAAuthError('Missing PPUSA_EMAIL or PPUSA_PASSWORD', { email: !!config.email, password: !!config.password });
  }

  const actions = [];
  const targetUrl = toAbsoluteUrl(url || '/');
  pushAction(actions, 'start', true, { targetUrl });

  let browser = null;
  let page = null;
  let browserData = null;

  try {
    // Get browser from pool or create new one
    browserData = await browserPool.getBrowser();
    browser = browserData.browser;
    
    // Set up browser error handling
    browser.on('disconnected', () => {
      console.warn('🔌 Browser disconnected unexpectedly');
    });
    
    page = await browser.newPage();
    
    // Set up page error handling
    page.on('error', (err) => {
      console.warn('📄 Page error:', err.message);
    });
    
    page.on('pageerror', (err) => {
      console.warn('📄 Page JS error:', err.message);
    });
    
    // Set reasonable timeouts
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(config.navTimeout || 30000);
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

    // Always perform form login directly; skip cookie/landing logic
    const loginUrl = toAbsoluteUrl(config.loginPage || '/login');
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: config.navTimeout });
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

    // Try to reach target, but don't fail if redirected (some pages need navigation from safe pages)
    const reached = await enforceTarget(page, targetUrl, actions, waitUntil);
    const expectedPath = pathOf(targetUrl);
    const currentPath = pathOf(page.url());
    const onTarget = currentPath === expectedPath;
    pushAction(actions, 'target-verify', onTarget, { finalUrl: page.url(), expectedPath });
    
    // Allow certain redirects (like /account, /dashboard) as successful auth
    const safeRedirects = ['/account', '/dashboard', '/', '/national'];
    const onSafeRedirect = safeRedirects.some(safe => currentPath.startsWith(safe));
    
    if (!reached && !onSafeRedirect) {
      throw new PPUSAAuthError('Authenticated (form) but redirected away from target', {
        finalUrl: page.url(),
        expectedPath,
        actions,
        reason: 'redirect-away',
      });
    }

    console.log('[ppusa-auth] login ok after form:', page.url());
    const response = await page.content();
    return { browser, page, html: response, finalUrl: page.url(), status: 200, actions };
  } catch (error) {
    pushAction(actions, 'error', false, { message: error.message });
    if (error instanceof PPUSAAuthError) {
      error.details.actions = actions;
    }
    
    // Return browser to pool or close if error occurred
    if (browser) {
      try {
        // Close all pages first
        const pages = await browser.pages();
        await Promise.allSettled(pages.map(p => p.close().catch(() => {})));

        if (browserData) {
          // Return to pool for reuse
          await browserPool.returnBrowser(browserData);
          pushAction(actions, 'browser-return', true, {});
        } else {
          // No pool data, close browser
          await browser.close();
          pushAction(actions, 'browser-close', true, {});
        }
      } catch (closeErr) {
        console.warn('⚠️ Failed to return/close browser properly:', closeErr.message);
        pushAction(actions, 'browser-return', false, { error: closeErr.message });

        // Force kill if normal close fails
        try {
          if (browser.process && browser.process.pid) {
            process.kill(browser.process.pid, 'SIGKILL');
          }
        } catch (killErr) {
          console.warn('⚠️ Failed to force kill browser:', killErr.message);
        }
      }
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









