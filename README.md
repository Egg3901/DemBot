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
