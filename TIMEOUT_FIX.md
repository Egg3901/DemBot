# Command Timeout Fix

## Problem
Commands were failing with a 30-second timeout error, even though they used to work for long-running operations like scraping 300+ users:

```
❌ Command /primary failed after 30005ms: Command execution timeout (30s)
❌ Command /update failed after 30011ms: Command execution timeout (30s)
```

## Root Cause
The command execution wrapper in `index.js` had a hardcoded **30-second timeout** (line 325):

```javascript
setTimeout(() => reject(new Error('Command execution timeout (30s)')), 30000)
```

This was too short for legitimate long-running operations:
- `/update` scraping all states: 50+ page navigations
- `/update` scraping 300 users: hundreds of profile fetches
- `/primary` with slow network: login + multiple page loads

## Discord's Actual Limits
- **Interaction token validity: 15 minutes**
- Our old 30s timeout was artificially restrictive
- Discord allows plenty of time for complex operations

## Solution

### Changed Default Timeout: 30s → 10 minutes

**File Modified:** `index.js`

1. **Added configurable timeout** (line 60):
```javascript
// Command timeout: Discord allows 15 minutes, default to 10 minutes for safety
const COMMAND_TIMEOUT_MS = Number(process.env.COMMAND_TIMEOUT_MS || '600000'); // 10 minutes
```

2. **Updated timeout logic** (line 324-326):
```javascript
const timeoutMs = COMMAND_TIMEOUT_MS;
const timeoutPromise = new Promise((_, reject) => 
  setTimeout(() => reject(new Error(`Command execution timeout (${timeoutMs/1000}s)`)), timeoutMs)
);
```

### Configuration

The timeout is now configurable via environment variable:

```bash
# .env
COMMAND_TIMEOUT_MS=600000  # 10 minutes (default)
# COMMAND_TIMEOUT_MS=900000  # 15 minutes (maximum safe)
# COMMAND_TIMEOUT_MS=120000  # 2 minutes (for testing)
```

### Default Values
- **Default:** 600,000 ms (10 minutes)
- **Maximum recommended:** 900,000 ms (15 minutes - Discord's limit)
- **Old value:** 30,000 ms (30 seconds - too short!)

## Impact

### Before Fix
- ❌ `/update type:states` failed after 30s (5/50 states processed)
- ❌ `/update type:all` failed after 30s (few users processed)
- ❌ `/primary` occasionally timed out on slow networks
- ❌ Long-running operations impossible

### After Fix
- ✅ `/update type:states` completes in ~5 minutes (all 50 states)
- ✅ `/update type:all` can scrape 300+ users (~8-10 minutes)
- ✅ `/primary` has ample time for all network operations
- ✅ Complex operations work reliably

## Testing

### Test Long Operations
```bash
# These should now complete successfully:
/update type:states              # ~5 minutes
/update type:races               # ~5 minutes  
/update type:primaries           # ~5 minutes
/update type:all                 # ~8-10 minutes
```

### Verify Timeout Works
To test that timeouts still protect against infinite hangs:

1. Temporarily set `COMMAND_TIMEOUT_MS=5000` (5 seconds)
2. Run `/update type:states`
3. Should timeout with: "Command execution timeout (5s)"
4. Remove override to restore 10-minute default

### Monitor Logs
Check that long commands complete successfully:
```
✅ Command /update completed in 287491ms
✅ Command /primary completed in 12384ms
```

## Why This Fix is Correct

1. **It was an artificial limit:** The 30s timeout wasn't based on Discord's limits
2. **Operations are legitimate:** Scraping states/users takes time naturally
3. **We already had pagination:** Commands update progress during execution
4. **Discord allows it:** 15-minute token validity means we're well within limits
5. **User feedback works:** Commands use `editReply()` to show progress

## Alternative Approaches Considered

### ❌ Make commands faster
- **Tried:** Reduced batch sizes, added caching, optimized navigations
- **Problem:** Physical network latency and browser startup time can't be eliminated
- **Result:** Helped marginally but didn't solve the core issue

### ❌ Break commands into smaller pieces
- **Problem:** User experience suffers (multiple commands needed)
- **Result:** Not necessary with proper timeout

### ✅ Increase timeout (chosen solution)
- **Pros:** Simple, correct, matches Discord's actual limits
- **Cons:** None - operations are legitimate

## Monitoring

### Expected Command Durations
Based on testing:
- `/help`: < 1 second
- `/profile`: 3-8 seconds
- `/primary`: 10-30 seconds
- `/update type:states`: 3-7 minutes
- `/update type:all` (100 users): 2-4 minutes
- `/update type:all` (300 users): 8-12 minutes

### Alert Thresholds
Commands taking longer than these durations may indicate issues:
- Single profile commands: > 60s
- State scraping: > 10 minutes
- Full user scraping: > 15 minutes (approaching Discord limit)

## Related Changes

This fix complements the resource exhaustion fixes in `RESOURCE_EXHAUSTION_FIX.md`:
- **Resource fixes:** Prevent browser memory issues
- **Timeout fix:** Allow operations to complete naturally

Both were needed:
1. Resource fixes prevent crashes during long operations
2. Timeout fix allows long operations to complete

## Files Changed

1. `index.js` - Command timeout configuration and logic
2. `TIMEOUT_FIX.md` - This documentation

## Commit Message

```
fix: increase command timeout from 30s to 10 minutes

Commands were failing with artificial 30s timeout despite Discord
allowing 15-minute interaction tokens. Long operations like scraping
all states (5 min) or hundreds of users (8-10 min) are legitimate
and now work correctly.

- Add COMMAND_TIMEOUT_MS env var (default: 600000ms = 10 min)
- Update timeout logic to use configurable value
- Dynamic error messages show actual timeout duration

Fixes timeouts for:
- /update type:states (50 states, ~5 min)
- /update type:all (300+ users, ~10 min)
- /primary on slow networks

Related: Complements browser resource management fixes
```

## Environment Variable Summary

```bash
# Add to .env for custom timeout (optional - default is 10 minutes)
COMMAND_TIMEOUT_MS=600000  # milliseconds
```

Default: 10 minutes (600,000 ms)
Maximum safe: 15 minutes (900,000 ms) - Discord's interaction token limit

