/**
 * Browser pool for reusing Puppeteer browser instances across command executions.
 * Reduces overhead by maintaining a pool of authenticated browsers.
 */
const { launch } = require('./puppeteer-launch');
const { config } = require('./ppusa-config');

class BrowserPool {
  constructor(maxBrowsers = 3, maxIdleTime = 300000) { // 5 minutes
    this.maxBrowsers = maxBrowsers;
    this.maxIdleTime = maxIdleTime;
    this.pool = [];
    this.activeBrowsers = new Set();
    this.lastActivity = new Map();
  }

  async getBrowser() {
    // Clean up expired browsers first
    await this.cleanupExpiredBrowsers();

    // Try to get an available browser from the pool
    if (this.pool.length > 0) {
      const browserData = this.pool.pop();
      this.activeBrowsers.add(browserData.browser);
      this.lastActivity.set(browserData.browser, Date.now());

      // Test if browser is still healthy and connected
      try {
        const pages = await browserData.browser.pages();
        if (pages.length > 0) {
          // Test basic connectivity
          const testPage = pages[0];
          await testPage.evaluate(() => true).catch(() => false);
          // Browser is healthy, return it
          return browserData;
        }
      } catch (error) {
        console.warn('Browser from pool is unhealthy or disconnected, creating new one:', error.message);
      }

      // Browser is unhealthy or disconnected, close it and create new one
      try {
        await browserData.browser.close();
      } catch (closeError) {
        console.warn('Error closing unhealthy browser:', closeError.message);
      }
      this.activeBrowsers.delete(browserData.browser);
    }

    // No available browsers, create a new one
    const browser = await this.createBrowser();
    this.activeBrowsers.add(browser);
    this.lastActivity.set(browser, Date.now());

    return { browser, page: null, authenticated: false };
  }

  async createBrowser() {
    console.log('🏊 Creating new browser instance for pool');
    const browser = await launch({
      timeout: 35000, // Increased timeout for browser creation
      args: [
        '--max_old_space_size=512',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-web-security', // Sometimes helps with navigation issues
        '--disable-features=VizDisplayCompositor' // Reduces resource usage
      ]
    });

    // Set up better error handling for the browser
    browser.on('disconnected', () => {
      console.warn('🔌 Browser disconnected unexpectedly');
      this.activeBrowsers.delete(browser);
      this.lastActivity.delete(browser);
    });

    return browser;
  }

  async returnBrowser(browserData) {
    if (!browserData || !browserData.browser) return;

    const { browser } = browserData;
    this.activeBrowsers.delete(browser);
    this.lastActivity.set(browser, Date.now());

    // Check if browser is still connected before returning to pool
    try {
      // Test if browser is still responsive
      const pages = await browser.pages();
      if (pages.length > 0) {
        await pages[0].evaluate(() => true).catch(() => false);
      }

      // Only return to pool if we haven't exceeded max browsers
      if (this.pool.length < this.maxBrowsers) {
        this.pool.push(browserData);
        console.log(`🏊 Returned browser to pool (pool size: ${this.pool.length})`);
      } else {
        // Pool is full, close this browser
        await browser.close();
        console.log('🏊 Closed browser (pool at max capacity)');
      }
    } catch (error) {
      // Browser is disconnected or unresponsive, close it
      console.warn('🏊 Browser disconnected during return, closing:', error.message);
      try {
        await browser.close();
      } catch (closeError) {
        console.warn('Error closing disconnected browser:', closeError.message);
      }
    }
  }

  async cleanupExpiredBrowsers() {
    const now = Date.now();
    const toRemove = [];

    for (let i = this.pool.length - 1; i >= 0; i--) {
      const browserData = this.pool[i];
      const lastActive = this.lastActivity.get(browserData.browser) || 0;

      if (now - lastActive > this.maxIdleTime) {
        toRemove.push(i);
        try {
          await browserData.browser.close();
          console.log('🏊 Closed expired browser from pool');
        } catch (error) {
          console.warn('Error closing expired browser:', error.message);
        }
      }
    }

    // Remove expired browsers from pool
    for (const index of toRemove.reverse()) {
      this.pool.splice(index, 1);
    }
  }

  async closeAllBrowsers() {
    console.log('🏊 Closing all browsers in pool');

    // Close pooled browsers
    for (const browserData of this.pool) {
      try {
        await browserData.browser.close();
      } catch (error) {
        console.warn('Error closing pooled browser:', error.message);
      }
    }
    this.pool = [];

    // Close active browsers
    for (const browser of this.activeBrowsers) {
      try {
        await browser.close();
      } catch (error) {
        console.warn('Error closing active browser:', error.message);
      }
    }
    this.activeBrowsers.clear();
    this.lastActivity.clear();
  }

  getStats() {
    return {
      poolSize: this.pool.length,
      activeBrowsers: this.activeBrowsers.size,
      maxBrowsers: this.maxBrowsers
    };
  }
}

// Global browser pool instance
const browserPool = new BrowserPool();

module.exports = { BrowserPool, browserPool };
