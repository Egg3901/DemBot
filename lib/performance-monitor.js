/**
 * Performance Monitoring for DemBot
 * Tracks command execution times, cache hit rates, and system metrics
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('os');

class PerformanceMonitor {
  constructor() {
    this.metrics = {
      commands: new Map(), // commandName -> { count, totalTime, avgTime, minTime, maxTime }
      cache: { hits: 0, misses: 0, hitRate: 0 },
      sessions: { created: 0, reused: 0, closed: 0 },
      errors: new Map(), // errorType -> count
      memory: { peak: 0, current: 0 },
      startTime: Date.now()
    };
    
    this.startMemoryTracking();
  }

  /**
   * Track command execution
   * @param {string} commandName - Name of the command
   * @param {number} executionTime - Execution time in milliseconds
   * @param {boolean} success - Whether the command succeeded
   */
  trackCommand(commandName, executionTime, success = true) {
    if (!this.metrics.commands.has(commandName)) {
      this.metrics.commands.set(commandName, {
        count: 0,
        totalTime: 0,
        avgTime: 0,
        minTime: Infinity,
        maxTime: 0,
        successCount: 0,
        errorCount: 0
      });
    }

    const cmd = this.metrics.commands.get(commandName);
    cmd.count++;
    cmd.totalTime += executionTime;
    cmd.avgTime = cmd.totalTime / cmd.count;
    cmd.minTime = Math.min(cmd.minTime, executionTime);
    cmd.maxTime = Math.max(cmd.maxTime, executionTime);
    
    if (success) {
      cmd.successCount++;
    } else {
      cmd.errorCount++;
    }
  }

  /**
   * Track cache hit/miss
   * @param {boolean} hit - Whether it was a cache hit
   */
  trackCache(hit) {
    if (hit) {
      this.metrics.cache.hits++;
    } else {
      this.metrics.cache.misses++;
    }
    
    const total = this.metrics.cache.hits + this.metrics.cache.misses;
    this.metrics.cache.hitRate = total > 0 ? (this.metrics.cache.hits / total) * 100 : 0;
  }

  /**
   * Track session events
   * @param {string} event - 'created', 'reused', or 'closed'
   */
  trackSession(event) {
    if (this.metrics.sessions.hasOwnProperty(event)) {
      this.metrics.sessions[event]++;
    }
  }

  /**
   * Track errors
   * @param {string} errorType - Type of error
   */
  trackError(errorType) {
    if (!this.metrics.errors.has(errorType)) {
      this.metrics.errors.set(errorType, 0);
    }
    this.metrics.errors.set(errorType, this.metrics.errors.get(errorType) + 1);
  }

  /**
   * Start memory tracking
   */
  startMemoryTracking() {
    setInterval(() => {
      const memUsage = process.memoryUsage();
      this.metrics.memory.current = memUsage.heapUsed;
      this.metrics.memory.peak = Math.max(this.metrics.memory.peak, memUsage.heapUsed);
    }, 5000); // Check every 5 seconds
  }

  /**
   * Get performance summary
   * @returns {Object} Performance summary
   */
  getSummary() {
    const uptime = Date.now() - this.metrics.startTime;
    const totalCommands = Array.from(this.metrics.commands.values())
      .reduce((sum, cmd) => sum + cmd.count, 0);
    
    const avgCommandTime = totalCommands > 0 
      ? Array.from(this.metrics.commands.values())
          .reduce((sum, cmd) => sum + cmd.totalTime, 0) / totalCommands
      : 0;

    return {
      uptime: Math.round(uptime / 1000), // seconds
      totalCommands,
      avgCommandTime: Math.round(avgCommandTime),
      cache: this.metrics.cache,
      sessions: this.metrics.sessions,
      memory: {
        current: Math.round(this.metrics.memory.current / 1024 / 1024), // MB
        peak: Math.round(this.metrics.memory.peak / 1024 / 1024), // MB
        system: Math.round(os.totalmem() / 1024 / 1024), // MB
        free: Math.round(os.freemem() / 1024 / 1024) // MB
      },
      commands: Object.fromEntries(
        Array.from(this.metrics.commands.entries()).map(([name, data]) => [
          name,
          {
            count: data.count,
            avgTime: Math.round(data.avgTime),
            minTime: data.minTime === Infinity ? 0 : Math.round(data.minTime),
            maxTime: Math.round(data.maxTime),
            successRate: data.count > 0 ? Math.round((data.successCount / data.count) * 100) : 0
          }
        ])
      ),
      errors: Object.fromEntries(this.metrics.errors)
    };
  }

  /**
   * Get detailed metrics for a specific command
   * @param {string} commandName - Command name
   * @returns {Object|null} Command metrics
   */
  getCommandMetrics(commandName) {
    return this.metrics.commands.get(commandName) || null;
  }

  /**
   * Reset all metrics
   */
  reset() {
    this.metrics = {
      commands: new Map(),
      cache: { hits: 0, misses: 0, hitRate: 0 },
      sessions: { created: 0, reused: 0, closed: 0 },
      errors: new Map(),
      memory: { peak: 0, current: 0 },
      startTime: Date.now()
    };
  }

  /**
   * Save metrics to file
   * @param {string} filePath - Path to save metrics
   */
  saveMetrics(filePath) {
    try {
      const data = {
        timestamp: new Date().toISOString(),
        summary: this.getSummary(),
        raw: {
          commands: Object.fromEntries(this.metrics.commands),
          cache: this.metrics.cache,
          sessions: this.metrics.sessions,
          errors: Object.fromEntries(this.metrics.errors),
          memory: this.metrics.memory
        }
      };
      
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('Failed to save metrics:', error.message);
    }
  }

  /**
   * Load metrics from file
   * @param {string} filePath - Path to load metrics from
   */
  loadMetrics(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (data.raw) {
          this.metrics.commands = new Map(Object.entries(data.raw.commands || {}));
          this.metrics.cache = data.raw.cache || { hits: 0, misses: 0, hitRate: 0 };
          this.metrics.sessions = data.raw.sessions || { created: 0, reused: 0, closed: 0 };
          this.metrics.errors = new Map(Object.entries(data.raw.errors || {}));
          this.metrics.memory = data.raw.memory || { peak: 0, current: 0 };
        }
      }
    } catch (error) {
      console.error('Failed to load metrics:', error.message);
    }
  }
}

// Singleton instance
const performanceMonitor = new PerformanceMonitor();

// Auto-save metrics every 5 minutes
setInterval(() => {
  const metricsPath = path.join(process.cwd(), 'data', 'performance-metrics.json');
  performanceMonitor.saveMetrics(metricsPath);
}, 5 * 60 * 1000);

// Load existing metrics on startup
const metricsPath = path.join(process.cwd(), 'data', 'performance-metrics.json');
performanceMonitor.loadMetrics(metricsPath);

module.exports = {
  PerformanceMonitor,
  performanceMonitor
};
