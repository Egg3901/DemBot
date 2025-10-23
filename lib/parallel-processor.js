/**
 * Parallel Processing Utilities for DemBot
 * Provides batching and concurrency control for web scraping operations
 */

class ParallelProcessor {
  constructor(options = {}) {
    this.maxConcurrency = options.maxConcurrency || 5;
    this.batchSize = options.batchSize || 10;
    this.delayBetweenBatches = options.delayBetweenBatches || 1000; // 1 second
    this.retryAttempts = options.retryAttempts || 2;
    this.retryDelay = options.retryDelay || 2000; // 2 seconds
  }

  /**
   * Process items in parallel with concurrency control
   * @param {Array} items - Items to process
   * @param {Function} processor - Async function to process each item
   * @param {Object} options - Processing options
   */
  async processInParallel(items, processor, options = {}) {
    const {
      maxConcurrency = this.maxConcurrency,
      batchSize = this.batchSize,
      delayBetweenBatches = this.delayBetweenBatches,
      retryAttempts = this.retryAttempts,
      onProgress = null,
      onError = null
    } = options;

    const results = [];
    const errors = [];
    
    // Process in batches
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      
      // Process batch with concurrency control
      const batchPromises = batch.map(async (item, index) => {
        const globalIndex = i + index;
        
        for (let attempt = 0; attempt <= retryAttempts; attempt++) {
          try {
            const result = await processor(item, globalIndex);
            results[globalIndex] = result;
            
            if (onProgress) {
              onProgress(globalIndex + 1, items.length, result);
            }
            
            return result;
          } catch (error) {
            if (attempt === retryAttempts) {
              errors.push({ item, index: globalIndex, error });
              if (onError) {
                onError(error, item, globalIndex);
              }
              return null;
            }
            
            // Wait before retry
            await this.delay(this.retryDelay * (attempt + 1));
          }
        }
      });

      // Wait for batch to complete with concurrency control
      await this.limitConcurrency(batchPromises, maxConcurrency);
      
      // Delay between batches to avoid overwhelming the server
      if (i + batchSize < items.length) {
        await this.delay(delayBetweenBatches);
      }
    }

    return { results, errors };
  }

  /**
   * Process items with a custom concurrency limiter
   * @param {Array} promises - Array of promises
   * @param {number} maxConcurrency - Maximum concurrent executions
   */
  async limitConcurrency(promises, maxConcurrency) {
    const executing = [];
    const results = [];

    for (const promise of promises) {
      const p = promise.then(result => {
        executing.splice(executing.indexOf(p), 1);
        return result;
      });
      
      results.push(p);
      executing.push(p);

      if (executing.length >= maxConcurrency) {
        await Promise.race(executing);
      }
    }

    return Promise.all(results);
  }

  /**
   * Process profiles in parallel with intelligent batching
   * @param {Array} profileIds - Profile IDs to process
   * @param {Function} profileProcessor - Function to process each profile
   * @param {Object} options - Processing options
   */
  async processProfiles(profileIds, profileProcessor, options = {}) {
    const {
      onProgress = null,
      onError = null,
      maxConcurrency = 3, // Conservative for profile scraping
      batchSize = 5
    } = options;

    return this.processInParallel(profileIds, profileProcessor, {
      maxConcurrency,
      batchSize,
      delayBetweenBatches: 2000, // 2 seconds between batches
      onProgress,
      onError
    });
  }

  /**
   * Process race data in parallel
   * @param {Array} raceData - Race data to process
   * @param {Function} raceProcessor - Function to process each race
   * @param {Object} options - Processing options
   */
  async processRaces(raceData, raceProcessor, options = {}) {
    const {
      onProgress = null,
      onError = null,
      maxConcurrency = 4,
      batchSize = 8
    } = options;

    return this.processInParallel(raceData, raceProcessor, {
      maxConcurrency,
      batchSize,
      delayBetweenBatches: 1500, // 1.5 seconds between batches
      onProgress,
      onError
    });
  }

  /**
   * Utility delay function
   * @param {number} ms - Milliseconds to delay
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Create a progress tracker
   * @param {number} total - Total items to process
   * @param {Function} onUpdate - Callback for progress updates
   */
  createProgressTracker(total, onUpdate) {
    let processed = 0;
    const startTime = Date.now();

    return (current, totalItems, result) => {
      processed = current;
      const elapsed = Date.now() - startTime;
      const rate = processed / (elapsed / 1000); // items per second
      const eta = totalItems > processed ? (totalItems - processed) / rate : 0;

      if (onUpdate) {
        onUpdate({
          processed,
          total: totalItems,
          percentage: Math.round((processed / totalItems) * 100),
          rate: Math.round(rate * 10) / 10,
          eta: Math.round(eta),
          elapsed: Math.round(elapsed / 1000)
        });
      }
    };
  }
}

module.exports = {
  ParallelProcessor
};
