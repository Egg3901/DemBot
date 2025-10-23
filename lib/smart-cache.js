/**
 * Smart Cache for DemBot
 * Provides intelligent caching with TTL, incremental updates, and memory management
 */

const fs = require('node:fs');
const path = require('node:path');

class SmartCache {
  constructor(options = {}) {
    this.cache = new Map();
    this.ttl = options.ttl || 5 * 60 * 1000; // 5 minutes default
    this.maxSize = options.maxSize || 1000; // Max cached items
    this.cleanupInterval = options.cleanupInterval || 60000; // 1 minute
    this.persistent = options.persistent !== false;
    this.cacheFile = options.cacheFile || path.join(process.cwd(), 'data', 'smart-cache.json');
    
    this.startCleanup();
    this.loadFromDisk();
  }

  /**
   * Get item from cache
   * @param {string} key - Cache key
   * @returns {any|null} - Cached value or null if not found/expired
   */
  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;

    // Check if expired
    if (Date.now() - item.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }

    // Update access time for LRU
    item.lastAccessed = Date.now();
    return item.value;
  }

  /**
   * Set item in cache
   * @param {string} key - Cache key
   * @param {any} value - Value to cache
   * @param {number} customTtl - Custom TTL for this item
   */
  set(key, value, customTtl = null) {
    // Remove oldest items if at capacity
    if (this.cache.size >= this.maxSize) {
      this.evictOldest();
    }

    this.cache.set(key, {
      value,
      timestamp: Date.now(),
      lastAccessed: Date.now(),
      ttl: customTtl || this.ttl
    });

    // Persist to disk if enabled
    if (this.persistent) {
      this.saveToDisk();
    }
  }

  /**
   * Check if key exists and is not expired
   * @param {string} key - Cache key
   * @returns {boolean}
   */
  has(key) {
    const item = this.cache.get(key);
    if (!item) return false;

    if (Date.now() - item.timestamp > item.ttl) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Delete item from cache
   * @param {string} key - Cache key
   */
  delete(key) {
    this.cache.delete(key);
    if (this.persistent) {
      this.saveToDisk();
    }
  }

  /**
   * Clear all cache
   */
  clear() {
    this.cache.clear();
    if (this.persistent) {
      this.saveToDisk();
    }
  }

  /**
   * Get cache statistics
   * @returns {Object} - Cache stats
   */
  getStats() {
    const now = Date.now();
    let expired = 0;
    let active = 0;

    for (const item of this.cache.values()) {
      if (now - item.timestamp > item.ttl) {
        expired++;
      } else {
        active++;
      }
    }

    return {
      total: this.cache.size,
      active,
      expired,
      hitRate: this.hitRate || 0
    };
  }

  /**
   * Evict oldest items when at capacity
   */
  evictOldest() {
    const entries = Array.from(this.cache.entries());
    entries.sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);
    
    // Remove oldest 10% of items
    const toRemove = Math.ceil(entries.length * 0.1);
    for (let i = 0; i < toRemove; i++) {
      this.cache.delete(entries[i][0]);
    }
  }

  /**
   * Clean up expired items
   */
  cleanup() {
    const now = Date.now();
    for (const [key, item] of this.cache.entries()) {
      if (now - item.timestamp > item.ttl) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Start automatic cleanup
   */
  startCleanup() {
    if (this.cleanupTimer) return;
    
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.cleanupInterval);
  }

  /**
   * Stop automatic cleanup
   */
  stopCleanup() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Save cache to disk
   */
  saveToDisk() {
    try {
      const data = {
        cache: Array.from(this.cache.entries()),
        metadata: {
          version: '1.0',
          timestamp: Date.now()
        }
      };
      
      fs.writeFileSync(this.cacheFile, JSON.stringify(data, null, 2));
    } catch (error) {
      console.warn('Failed to save cache to disk:', error.message);
    }
  }

  /**
   * Load cache from disk
   */
  loadFromDisk() {
    if (!this.persistent || !fs.existsSync(this.cacheFile)) return;

    try {
      const data = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      if (data.cache && Array.isArray(data.cache)) {
        this.cache = new Map(data.cache);
        this.cleanup(); // Remove expired items on load
      }
    } catch (error) {
      console.warn('Failed to load cache from disk:', error.message);
    }
  }

  /**
   * Create a profile cache key
   * @param {string|number} profileId - Profile ID
   * @param {string} type - Cache type (profile, race, etc.)
   * @returns {string} - Cache key
   */
  static createProfileKey(profileId, type = 'profile') {
    return `${type}:${profileId}`;
  }

  /**
   * Create a race cache key
   * @param {string} state - State name
   * @param {string} race - Race type
   * @returns {string} - Cache key
   */
  static createRaceKey(state, race) {
    return `race:${state.toLowerCase()}:${race.toLowerCase()}`;
  }
}

// Singleton instance
const smartCache = new SmartCache({
  ttl: 10 * 60 * 1000, // 10 minutes for profiles
  maxSize: 2000,
  persistent: true
});

// Graceful shutdown
process.on('SIGINT', () => {
  smartCache.stopCleanup();
  smartCache.saveToDisk();
  process.exit(0);
});

process.on('SIGTERM', () => {
  smartCache.stopCleanup();
  smartCache.saveToDisk();
  process.exit(0);
});

module.exports = {
  SmartCache,
  smartCache
};
