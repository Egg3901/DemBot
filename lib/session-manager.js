/**
 * Session Manager for DemBot
 * Manages persistent browser sessions and authentication to avoid repeated logins
 */

const { getBrowser, newPage, ensureHealthy } = require('./browser-manager');
const { authenticateAndNavigate, createAuthenticatedSession, isSessionHealthy, navigateWithSession, PPUSAAuthError } = require('./ppusa-auth-optimized');
const { config } = require('./ppusa-config');

class SessionManager {
  constructor() {
    this.sessions = new Map(); // sessionId -> { browser, page, lastUsed, authenticated }
    this.cleanupInterval = null;
    this.maxIdleTime = 5 * 60 * 1000; // 5 minutes
    this.maxSessions = 3;
  }

  async getSession(sessionId = 'default') {
    // Clean up expired sessions
    this.cleanupExpiredSessions();

    // Return existing session if available and healthy
    if (this.sessions.has(sessionId)) {
      const session = this.sessions.get(sessionId);
      if (await this.isSessionHealthy(session)) {
        session.lastUsed = Date.now();
        return session;
      } else {
        // Remove unhealthy session
        await this.closeSession(sessionId);
      }
    }

    // Create new session if under limit
    if (this.sessions.size >= this.maxSessions) {
      // Close oldest session
      const oldest = Array.from(this.sessions.entries())
        .sort(([,a], [,b]) => a.lastUsed - b.lastUsed)[0];
      await this.closeSession(oldest[0]);
    }

    return await this.createSession(sessionId);
  }

  async createSession(sessionId) {
    try {
      const browser = await getBrowser();
      const page = await newPage({ intercept: true });
      
      const session = {
        browser,
        page,
        lastUsed: Date.now(),
        authenticated: false,
        sessionId
      };

      this.sessions.set(sessionId, session);
      return session;
    } catch (error) {
      throw new Error(`Failed to create session ${sessionId}: ${error.message}`);
    }
  }

  async authenticateSession(sessionId = 'default', targetUrl) {
    const session = await this.getSession(sessionId);
    
    if (session.authenticated && await this.isSessionHealthy(session)) {
      return session;
    }

    try {
      // Use the existing page for authentication
      const result = await authenticateAndNavigate({ 
        url: targetUrl, 
        debug: config.debug,
        browser: session.browser,
        page: session.page
      });
      
      session.authenticated = true;
      session.lastUsed = Date.now();
      session.html = result.html;
      session.finalUrl = result.finalUrl;
      
      return session;
    } catch (error) {
      // If auth fails, close the session
      await this.closeSession(sessionId);
      throw error;
    }
  }

  async isSessionHealthy(session) {
    try {
      await session.browser.version();
      return true;
    } catch {
      return false;
    }
  }

  async closeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    try {
      await session.page?.close();
    } catch {}
    
    this.sessions.delete(sessionId);
  }

  cleanupExpiredSessions() {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions.entries()) {
      if (now - session.lastUsed > this.maxIdleTime) {
        this.closeSession(sessionId);
      }
    }
  }

  async closeAll() {
    for (const sessionId of this.sessions.keys()) {
      await this.closeSession(sessionId);
    }
  }

  // Start cleanup interval
  startCleanup() {
    if (this.cleanupInterval) return;
    
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredSessions();
    }, 60000); // Check every minute
  }

  stopCleanup() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

// Singleton instance
const sessionManager = new SessionManager();
sessionManager.startCleanup();

// Graceful shutdown
process.on('SIGINT', async () => {
  await sessionManager.closeAll();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await sessionManager.closeAll();
  process.exit(0);
});

module.exports = {
  SessionManager,
  sessionManager
};
