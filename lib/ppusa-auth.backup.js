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












