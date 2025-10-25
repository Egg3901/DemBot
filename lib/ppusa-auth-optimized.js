/**
 * Optimized PPUSA Authentication
 * Wraps the original auth with session management support
 */

const { authenticateAndNavigate: originalAuth, PPUSAAuthError } = require('./ppusa-auth');
const { getBrowser, newPage } = require('./browser-manager');
const { config } = require('./ppusa-config');

/**
 * Optimized authentication that supports session reuse
 * @param {Object} options - Authentication options
 * @param {string} options.url - Target URL
 * @param {string} options.waitUntil - Wait condition
 * @param {boolean} options.debug - Debug mode
 * @param {Object} options.browser - Existing browser instance
 * @param {Object} options.page - Existing page instance
 * @returns {Promise<Object>} - Authentication result
 */
async function authenticateAndNavigate(options = {}) {
  const { browser = null, page = null, ...authOptions } = options;
  
  // If browser and page are provided, use them directly
  if (browser && page) {
    try {
      // Quick health check
      await browser.version();
      
      // Apply cookie if provided (so reused sessions get auth context)
      const targetUrl = authOptions.url || '/';
      if (config.cookie) {
        try {
          const cookieDomain = new URL(config.baseUrl).hostname;
          const raw = String(config.cookie);
          const parts = raw.split(';').map((s) => s.trim()).filter(Boolean);
          for (const seg of parts) {
            const eq = seg.indexOf('=');
            if (eq === -1) continue;
            const name = seg.slice(0, eq).trim();
            const value = seg.slice(eq + 1).trim();
            if (!name || !value) continue;
            await page.setCookie({ name, value, domain: cookieDomain, path: '/' });
          }
        } catch (_) {}
      }

      // Navigate to target URL
      await page.goto(targetUrl, { 
        waitUntil: authOptions.waitUntil || 'domcontentloaded',
        timeout: config.navTimeout 
      });
      
      const html = await page.content();
      const finalUrl = page.url();
      // If still on login after reuse (cookie not accepted), fall back to original auth
      if (/\/login\b/i.test(finalUrl)) {
        return originalAuth(authOptions);
      }
      return { 
        browser, 
        page, 
        html, 
        finalUrl, 
        status: 200, 
        actions: [{ step: 'reuse-session', success: true, timestamp: new Date().toISOString() }]
      };
    } catch (error) {
      // If reuse fails, fall back to original auth
      console.warn('[ppusa-auth-optimized] Session reuse failed, falling back to full auth:', error.message);
    }
  }
  
  // Fall back to original authentication
  return originalAuth(authOptions);
}

/**
 * Create a new authenticated session
 * @param {string} sessionId - Session identifier
 * @param {string} targetUrl - Initial target URL
 * @returns {Promise<Object>} - Session object
 */
async function createAuthenticatedSession(sessionId = 'default', targetUrl = '/') {
  try {
    const result = await authenticateAndNavigate({ url: targetUrl });
    return {
      browser: result.browser,
      page: result.page,
      sessionId,
      authenticated: true,
      lastUsed: Date.now(),
      html: result.html,
      finalUrl: result.finalUrl
    };
  } catch (error) {
    throw new PPUSAAuthError(`Failed to create authenticated session: ${error.message}`, {
      sessionId,
      targetUrl,
      cause: error
    });
  }
}

/**
 * Check if a session is still healthy
 * @param {Object} session - Session object
 * @returns {Promise<boolean>} - Session health status
 */
async function isSessionHealthy(session) {
  try {
    if (!session || !session.browser || !session.page) return false;
    await session.browser.version();
    return true;
  } catch {
    return false;
  }
}

/**
 * Navigate to a URL using an existing session
 * @param {Object} session - Session object
 * @param {string} url - Target URL
 * @param {string} waitUntil - Wait condition
 * @returns {Promise<Object>} - Navigation result
 */
async function navigateWithSession(session, url, waitUntil = 'domcontentloaded') {
  if (!isSessionHealthy(session)) {
    throw new PPUSAAuthError('Session is not healthy', { sessionId: session.sessionId });
  }
  
  try {
    await session.page.goto(url, { 
      waitUntil, 
      timeout: config.navTimeout 
    });
    
    const html = await session.page.content();
    session.lastUsed = Date.now();
    
    return {
      html,
      finalUrl: session.page.url(),
      status: 200
    };
  } catch (error) {
    throw new PPUSAAuthError(`Navigation failed: ${error.message}`, {
      url,
      sessionId: session.sessionId,
      cause: error
    });
  }
}

module.exports = {
  authenticateAndNavigate,
  createAuthenticatedSession,
  isSessionHealthy,
  navigateWithSession,
  PPUSAAuthError
};
