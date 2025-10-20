# DemBot

Discord bot for Power Play USA game automation and player tracking.

## Quick Start

1. **Install dependencies:**
   ```bash
   npm install
   npm run bootstrap:chrome  # Install Chromium dependencies
   ```

2. **Configure environment:** Create `.env` file with required variables (see Configuration below)

3. **Run the bot:**
   ```bash
   npm start                 # Native
   # OR
   npm run docker:build && npm run docker:run  # Docker
   ```

## Configuration

### Required Environment Variables

```bash
# Discord
DISCORD_TOKEN=your_bot_token_here
DISCORD_CLIENT_ID=your_client_id_here

# PPUSA Authentication (either email/password OR cookie)
PPUSA_EMAIL=your_email@example.com
PPUSA_PASSWORD=your_password
# OR
PPUSA_COOKIE=ppusa_session=abc123...
```

### Optional Environment Variables

```bash
# Command timeout (default: 10 minutes)
COMMAND_TIMEOUT_MS=600000

# Discord configuration
DISCORD_GUILD_ID=your_guild_id       # For guild-specific deployment
REGISTER_GLOBAL=false                # true to register commands globally
ALLOWED_DM_USER=user_id              # User allowed to DM bot

# Dashboard/Status server
DASHBOARD_PORT=3000
DASHBOARD_HOST=0.0.0.0

# PPUSA configuration
PPUSA_BASE_URL=https://powerplayusa.net
PPUSA_MAX_USER_ID=5000              # Max user ID to scrape (0 = unlimited)
PPUSA_START_USER_ID=1000            # Starting user ID for new profiles
```

## Refreshing PPUSA Cookies (Cloudflare Workaround)

If you see "Cloudflare Turnstile challenge detected":

1. **Update cookie:**
   ```bash
   npm run cookie:update
   ```

2. **Paste fresh session:** When prompted, paste your `ppusa_session` (and `cf_clearance` if shown) from a browser using the **same IP** as the bot
   - For EC2: Either proxy your browser through the instance, or log in from the server itself

3. **Restart bot:** So it loads the updated `.env`

## Commands

- `/help` - Show available commands
- `/profile <user>` - View player profile
- `/primary <state> <race>` - View primary election candidates
- `/update [type]` - Update cached data (states, races, primaries, profiles)
- `/leaderboard` - Show player rankings
- `/treasury` - View party treasury information
- And more...

## Troubleshooting

### Command Timeouts
If commands timeout, increase the timeout limit:
```bash
# .env
COMMAND_TIMEOUT_MS=900000  # 15 minutes (max safe)
```

See `TIMEOUT_FIX.md` for details.

### Browser Resource Issues
If you see `ERR_INSUFFICIENT_RESOURCES` errors:
- The bot automatically manages resources by recreating pages every 5 states
- Monitor memory usage if issues persist

See `RESOURCE_EXHAUSTION_FIX.md` for details.

### Cloudflare Challenges
If authentication fails:
1. Update `PPUSA_COOKIE` as described above
2. Ensure cookie is from same IP as bot
3. Cookie expires after ~24 hours typically

## Documentation

- `TIMEOUT_FIX.md` - Command timeout configuration and troubleshooting
- `RESOURCE_EXHAUSTION_FIX.md` - Browser resource management fixes
- `CRASH_PREVENTION_GUIDE.md` - Error handling and crash prevention

## Development

```bash
npm start          # Start bot
npm test           # Run tests (if available)
npm run lint       # Check code style
```

## Architecture

- **Commands:** `/commands/*.js` - Discord slash commands
- **Libraries:** `/lib/*.js` - Shared utilities (auth, scraping, caching)
- **Data:** `/data/*.json` - Cached player/state/race data
- **Main:** `index.js` - Discord client and command handler
