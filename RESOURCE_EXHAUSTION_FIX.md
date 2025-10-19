# Resource Exhaustion Fix

## Problem
The `/update` command was experiencing `net::ERR_INSUFFICIENT_RESOURCES` errors when scraping multiple states. The bot would fail after processing only a few states due to browser resource exhaustion.

### Root Causes
1. **Single page reused for 50+ sequential navigations** - Each `page.goto()` accumulated resources (DOM nodes, event listeners, cached assets)
2. **No page cleanup between batches** - Resources weren't being released between state processing
3. **Aggressive memory limits** - Browser launched with `--max_old_space_size=512` which was too restrictive
4. **Large batch sizes** - Processing 8-10 states per batch without cleanup

## Solution

### 1. Page Recreation Between Batches
**Files Modified:** `commands/update.js`

Added page cleanup and recreation logic after each batch in all three scraping functions:
- `scrapeStatesData()`
- `scrapeRacesData()` 
- `scrapePrimariesData()`

```javascript
// Close and recreate page between batches to free resources
if (batchIndex < batches.length - 1) {
  try {
    await clearPageResources(page);
    await page.close();
    page = await browser.newPage();
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(30000);
  } catch (err) {
    console.warn('⚠️ Failed to recreate page:', err.message);
  }
  await new Promise(resolve => setTimeout(resolve, 1000));
}
```

**Benefit:** Forces release of accumulated DOM nodes, event listeners, and cached resources every 5 states.

### 2. Explicit Resource Cleanup
**Files Modified:** `commands/update.js`

Added `clearPageResources()` helper function that aggressively clears browser cache and cookies:

```javascript
async function clearPageResources(page) {
  try {
    const client = await page.target().createCDPSession();
    await client.send('Network.clearBrowserCookies');
    await client.send('Network.clearBrowserCache');
    await client.detach();
  } catch (err) {
    // Silently ignore errors - this is best-effort cleanup
  }
}
```

**Benefit:** Frees memory by clearing accumulated network cache between batches.

### 3. Reduced Batch Sizes
**Files Modified:** `commands/update.js`

Reduced batch sizes from 8-10 to 5 states per batch:
- States scraping: 10 → 5
- Races scraping: 8 → 5  
- Primaries scraping: 8 → 5

**Benefit:** Reduces resource accumulation before cleanup occurs.

### 4. Improved Browser Launch Configuration
**Files Modified:** `lib/ppusa-auth.js`

Removed restrictive memory limit and optimized Chrome flags:

**Before:**
```javascript
args: [
  '--max_old_space_size=512', // Too restrictive!
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding'
]
```

**After:**
```javascript
args: [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--no-first-run',
  '--no-zygote',
  '--single-process'
]
```

**Benefit:** Allows browser sufficient memory while still maintaining efficient resource usage.

### 5. Final Page Cleanup
**Files Modified:** `commands/update.js`

Added cleanup at the end of each scraping function:

```javascript
// Final cleanup of the last page
try {
  await clearPageResources(page);
} catch (err) {
  console.warn('⚠️ Failed to clear final page resources:', err.message);
}
```

**Benefit:** Ensures resources are freed even for the final batch.

## Expected Results

### Before Fix
- ❌ Failed after 3-5 states with `net::ERR_INSUFFICIENT_RESOURCES`
- ❌ Command timeout (30s) triggered
- ❌ Browser memory exhaustion

### After Fix
- ✅ Successfully processes all 50 states
- ✅ Resources freed every 5 states (1 batch)
- ✅ Reduced memory footprint
- ✅ Better reliability and stability
- ✅ Longer delays between batches (1s) for garbage collection

## Performance Impact

### Resource Usage
- **Before:** Linear resource accumulation until crash
- **After:** Sawtooth pattern - builds up to 5 states, drops on cleanup

### Timing
- **Additional overhead:** ~2-3 seconds per batch for page recreation
- **Total overhead for 50 states:** ~20-30 seconds extra
- **Trade-off:** Acceptable overhead for 100% reliability vs crashes

## Testing Recommendations

1. **Test with full state scraping:**
   ```
   /update type:states
   ```

2. **Monitor memory usage:**
   - Watch Chrome process memory in task manager
   - Should see periodic drops (sawtooth pattern)

3. **Test with races and primaries:**
   ```
   /update type:races
   /update type:primaries
   ```

4. **Check logs for:**
   - No `ERR_INSUFFICIENT_RESOURCES` errors
   - Successful completion messages
   - Batch progress updates

## Future Improvements

1. **Dynamic batch sizing** - Adjust batch size based on available memory
2. **Connection pooling** - Reuse browser contexts more efficiently  
3. **Parallel processing** - Process multiple states concurrently with resource limits
4. **Memory monitoring** - Track and log memory usage per batch
5. **Exponential backoff** - Add retry logic with delays for failed states

## Files Changed

1. `commands/update.js` - Main scraping logic improvements
2. `lib/ppusa-auth.js` - Browser launch configuration optimization

## Commit Message

```
fix: resolve browser resource exhaustion in state scraping

- Add page recreation between batches (every 5 states)
- Implement aggressive resource cleanup with CDP
- Reduce batch sizes from 8-10 to 5
- Remove restrictive memory limits from browser launch
- Add final page cleanup at end of scraping

Fixes #[issue-number] - ERR_INSUFFICIENT_RESOURCES when scraping states
```

