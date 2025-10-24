# DemBot

## Hardcoded Permissions
- **Server ID `1430928325890670623`**: All commands allowed without restrictions
- **User ID `1430928325890670623`**: Complete bypass of all permission checks
- **User ID `333052320252297216`**: Debug and admin permissions

## Refreshing PPUSA cookies (Cloudflare workaround)
- Run `npm run cookie:update`.
- Paste the fresh `ppusa_session` (and `cf_clearance` if shown) captured from a browser that used the same IP as the bot (for EC2, proxy your browser through the instance or log in from the server itself).
- Restart the bot so the updated `.env` is loaded.

When the bot reports `Cloudflare Turnstile challenge detected`, repeat the steps above with a new cookie.

## Running
- Native: `npm start` (ensure Chromium deps installed via `npm run bootstrap:chrome`).
- Docker: `npm run docker:build` then `npm run docker:run` (uses `.env`).

## Environment Variables

Place a `.env` in the project root (or set them in your process environment).

- DISCORD_TOKEN: Bot token
- DISCORD_GUILD_ID: Guild for command registration (optional if using global)
- REGISTER_GLOBAL: 'true' for global command registration
- STATUS_PORT / DASHBOARD_PORT: Dashboard port (default 3000)
- STATUS_HOST / DASHBOARD_HOST: Dashboard bind host (default 0.0.0.0)
- PPUSA_BASE_URL, PPUSA_EMAIL, PPUSA_PASSWORD, PPUSA_COOKIE: Auth details
- PPUSA_LOGIN_UA, PPUSA_COOKIE_UA, PPUSA_ACCEPT_LANGUAGE: Optional headers
- PPUSA_DEBUG: 'true' to enable more verbose auth/scrape logging

### Profile discovery controls
Used by both the cron service and `/update` to bound new user discovery. Defaults are sensible if unset.

- PPUSA_START_USER_ID: First user ID to consider when scanning (default 1)
- PPUSA_MAX_USER_ID: Optional ceiling for IDs; 0 disables (default 0)
- PPUSA_MAX_NEW_PROFILES: Max new profiles to discover per run (default 500)
- PPUSA_CONSECUTIVE_MISS_LIMIT: Stop after this many consecutive missing IDs (default 100)
- PPUSA_MAX_IDS_PER_RUN: Hard cap on total IDs attempted per run (default 1000)