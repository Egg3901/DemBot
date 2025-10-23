// lib/cron-service.js
// Version: 1.0
const cron = require('node-cron');
const { loginAndGet, parseProfile, BASE } = require('./ppusa');
const { parseStateData, getAllStatesList } = require('./state-scraper');
const { resolveStateIdFromIndex } = require('./state-utils');
const { ensureDbShape, mergeProfileRecord } = require('./profile-cache');
const cheerio = require('cheerio');
const fs = require('node:fs');
const path = require('node:path');

// Configuration
const LOG_CHANNEL_ID = '1430939330406383688';
const MAX_CONSECUTIVE_MISSES = 20;
const DEFAULT_MAX_ID = Number(process.env.PPUSA_MAX_USER_ID || '0');
const DEFAULT_START_ID = Number(process.env.PPUSA_START_USER_ID || '1000');
const MAX_UPDATE_TIME = 20 * 60 * 1000; // 20 minutes max per update cycle (increased for sequential processing)

class CronService {
  constructor(client) {
    this.client = client;
    this.isRunning = false;
    this.lastRun = null;
    this.job = null;
  }

  async logToChannel(message, error = false) {
    try {
      // Check if client is ready
      if (!this.client || !this.client.isReady()) {
        console.log('Discord client not ready, skipping channel log');
        return;
      }

      const channel = await this.client.channels.fetch(LOG_CHANNEL_ID);
      const timestamp = new Date().toISOString();
      const prefix = error ? '❌' : '✅';
      const content = `${prefix} **Automated Update** [${timestamp}]\n${message}`;

      // Split long messages if needed
      if (content.length > 2000) {
        const chunks = content.match(/.{1,1900}/g) || [];
        for (const chunk of chunks) {
          await channel.send(chunk);
        }
      } else {
        await channel.send(content);
      }
    } catch (err) {
      console.error('Failed to log to Discord channel:', err);
    }
  }

  async updateProfiles() {
    const startTime = Date.now();
    try {
      console.log('🔄 Starting profile update...');
      await this.logToChannel('Starting automated profile update...');
      
      const dataDir = path.join(process.cwd(), 'data');
      const jsonPath = path.join(dataDir, 'profiles.json');
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

      let db = { updatedAt: new Date().toISOString(), profiles: {}, byDiscord: {} };
      if (fs.existsSync(jsonPath)) {
        try {
          db = ensureDbShape(JSON.parse(fs.readFileSync(jsonPath, 'utf8')));
        } catch {
          db = { updatedAt: new Date().toISOString(), profiles: {}, byDiscord: {} };
        }
      }
      db = ensureDbShape(db);

      const profilesList = Object.values(db.profiles || {});
      const allIdsSet = new Set();
      const allIds = [];
      const demIdsSet = new Set();
      const gopIdsSet = new Set();

      for (const profile of profilesList) {
        const idNum = Number(profile.id);
        if (!Number.isFinite(idNum)) continue;
        if (!allIdsSet.has(idNum)) {
          allIdsSet.add(idNum);
          allIds.push(idNum);
        }
        if (/democratic/i.test(String(profile.party))) demIdsSet.add(idNum);
        if (/republican/i.test(String(profile.party))) gopIdsSet.add(idNum);
      }

      allIds.sort((a, b) => a - b);
      const demIds = Array.from(demIdsSet).sort((a, b) => a - b);
      const gopIds = Array.from(gopIdsSet).sort((a, b) => a - b);

      const maxKnownIdAll = allIds.length ? allIds[allIds.length - 1] : 0;
      const baseStartId = DEFAULT_START_ID > 0 ? DEFAULT_START_ID : 1;
      const newStartId = Math.max(maxKnownIdAll + 1, baseStartId);
      const effectiveNewStartId = DEFAULT_MAX_ID > 0 ? Math.min(newStartId, DEFAULT_MAX_ID) : newStartId;

      const start = Date.now();
      let found = 0;
      let checked = 0;

      // Use existing IDs and scan for new ones
      const existingTargetIds = [...allIds];
      
      let browser, page;
      try {
        const loginSeed = existingTargetIds.length ? existingTargetIds[0] : baseStartId;
        const loginId = Number.isFinite(loginSeed) && loginSeed > 0 ? loginSeed : baseStartId;
        const sess = await loginAndGet(`${BASE}/users/${loginId}`);
        browser = sess.browser;
        page = sess.page;

        const scrapeId = async (id) => {
          checked++;
          let resp = null;
          try {
            resp = await page.goto(`${BASE}/users/${id}`, { waitUntil: 'networkidle2', timeout: 30000 });
          } catch (_) {}
          const status = resp?.status?.() ?? 200;
          const finalUrl = page.url();
          const html = await page.content();
          const info = parseProfile(html);
          const isUserUrl = /\/users\//i.test(finalUrl);
          const isMiss = (status >= 400) || !isUserUrl || !info?.name;
          if (isMiss) return { ok: false };

          mergeProfileRecord(db, id, info);
          found++;
          return { ok: true, info };
        };

        // Update existing profiles in parallel for better performance
        if (existingTargetIds.length) {
          // Process existing profiles in batches for better performance
          const BATCH_SIZE = 15;
          const CONCURRENCY = 10;

          for (let i = 0; i < existingTargetIds.length; i += BATCH_SIZE) {
            const batch = existingTargetIds.slice(i, i + BATCH_SIZE);
            const batchPromises = batch.map(async (id) => {
              try {
                return await scrapeId(id);
              } catch (error) {
                console.error(`Error scraping profile ${id}:`, error.message);
                return { ok: false };
              }
            });

            // Process batch with concurrency control
            await Promise.all(batchPromises.slice(0, CONCURRENCY));
          }
        }

        // Look for new profiles with parallel processing
        let consecutiveMisses = 0;
        if (effectiveNewStartId > 0) {
          let id = effectiveNewStartId;
          let newProfilesFound = 0;
          const maxNewProfiles = 50; // Reduced from 100 to 50 for faster completion
          const profileStartTime = Date.now();
          const NEW_PROFILE_BATCH_SIZE = 20;
          const NEW_PROFILE_CONCURRENCY = 8;

          while (true) {
            // Safety check: don't run for more than 5 minutes on profile discovery (reduced from 8)
            if (Date.now() - profileStartTime > 5 * 60 * 1000) {
              console.log('⏰ Profile discovery timeout reached, stopping search');
              await this.logToChannel(`Profile discovery stopped after 5 minutes. Found ${newProfilesFound} new profiles.`);
              break;
            }

            if (DEFAULT_MAX_ID > 0 && id > DEFAULT_MAX_ID) break;
            if (newProfilesFound >= maxNewProfiles) {
              console.log(`📊 Found ${maxNewProfiles} new profiles, stopping search`);
              await this.logToChannel(`Profile discovery stopped after finding ${maxNewProfiles} new profiles.`);
              break;
            }

            // Check a batch of new IDs in parallel
            const batchEnd = Math.min(id + NEW_PROFILE_BATCH_SIZE, DEFAULT_MAX_ID > 0 ? DEFAULT_MAX_ID + 1 : id + NEW_PROFILE_BATCH_SIZE);
            const batchIds = [];
            for (let batchId = id; batchId < batchEnd; batchId++) {
              batchIds.push(batchId);
            }

            const batchPromises = batchIds.map(async (batchId) => {
              try {
                return await scrapeId(batchId);
              } catch (error) {
                console.error(`Error scraping profile ${batchId}:`, error.message);
                return { ok: false };
              }
            });

            // Process batch with concurrency control
            const batchResults = await Promise.all(batchPromises.slice(0, NEW_PROFILE_CONCURRENCY));

            // Process results
            let batchFound = 0;
            for (const result of batchResults) {
              if (result.ok) {
                consecutiveMisses = 0;
                newProfilesFound++;
                batchFound++;
              } else {
                consecutiveMisses++;
                if (DEFAULT_MAX_ID === 0 && consecutiveMisses >= MAX_CONSECUTIVE_MISSES) break;
              }
            }

            // Update ID counter
            id = batchEnd;

            // If no profiles found in this batch and we have consecutive misses, break
            if (batchFound === 0 && consecutiveMisses >= MAX_CONSECUTIVE_MISSES) break;
          }
        }

        // Save the updated database
        const payload = { ...ensureDbShape(db), updatedAt: new Date().toISOString() };
        fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
        
        // Save a timestamped backup
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = path.join(dataDir, `profiles.${stamp}.json`);
        try { fs.writeFileSync(backupPath, JSON.stringify(db, null, 2)); } catch {}
        
        const secs = Math.round((Date.now() - start) / 1000);
        const totalTime = Math.round((Date.now() - startTime) / 1000);
        await this.logToChannel(`Profile update complete. Checked ${checked}, found ${found} new profiles. Time: ${totalTime}s.`);

      } finally {
        try { await page?.close(); } catch {}
      }

    } catch (err) {
      const totalTime = Math.round((Date.now() - startTime) / 1000);
      await this.logToChannel(`Profile update failed after ${totalTime}s: ${err?.message || String(err)}`, true);
      console.error('Profile update error:', err);
    }
  }

  async updateStates() {
    const startTime = Date.now();
    try {
      console.log('🏛️ Starting state update...');
      await this.logToChannel('Starting automated state data update...');
      
      const dataDir = path.join(process.cwd(), 'data');
      const statesJsonPath = path.join(dataDir, 'states.json');
      let statesDb = { states: {}, updatedAt: null };
      
      if (fs.existsSync(statesJsonPath)) {
        try {
          statesDb = JSON.parse(fs.readFileSync(statesJsonPath, 'utf8'));
          if (!statesDb.states) statesDb.states = {};
        } catch {
          statesDb = { states: {}, updatedAt: null };
        }
      }

      let browser, page;
      try {
        const statesList = getAllStatesList();
        const sess = await loginAndGet(`${BASE}/national/states`);
        browser = sess.browser;
        page = sess.page;
        
        // Get states index page for ID resolution
        const statesIndexHtml = await page.content();
        
        let scraped = 0;
        let skipped = 0;
        // Keep a copy of previous data for change detection
        const prevStatesDb = JSON.parse(JSON.stringify(statesDb));

        for (const state of statesList) {
          try {
            // Resolve state ID from the index
            const stateId = resolveStateIdFromIndex(statesIndexHtml, state.name);
            
            if (!stateId) {
              console.warn(`Could not resolve state ID for ${state.name}`);
              skipped++;
              continue;
            }

            // Navigate to state page with optimized settings
            const stateUrl = `${BASE}/states/${stateId}`;
            await page.goto(stateUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            const stateHtml = await page.content();
            
            // Parse state data
            const stateData = parseStateData(stateHtml, stateId);
            
            if (stateData) {
              statesDb.states[stateId] = stateData;
              scraped++;
            } else {
              console.warn(`Failed to parse state data for ${state.name} (ID ${stateId})`);
              skipped++;
            }
          } catch (err) {
            console.error(`Error scraping ${state.name}:`, err.message);
            skipped++;
          }
        }

        // Save states JSON
        statesDb.updatedAt = new Date().toISOString();
        fs.writeFileSync(statesJsonPath, JSON.stringify(statesDb, null, 2));

        // Compute and report changes (EVs and positions)
        const changes = [];
        let evChanges = 0, govChanges = 0, senChanges = 0, legChanges = 0;
        const getName = (o) => {
          if (!o || o.vacant) return 'Vacant';
          const party = o.party ? ` (${o.party})` : '';
          return `${o.name || 'Unknown'}${party}`;
        };
        const senList = (arr) => {
          const list = Array.isArray(arr) ? arr : [];
          const a = [getName(list[0] || { vacant: true }), getName(list[1] || { vacant: true })];
          return a.join(', ');
        };

        for (const [sid, cur] of Object.entries(statesDb.states || {})) {
          const prev = (prevStatesDb.states || {})[sid];
          if (!cur) continue;
          const label = cur.name || `State ${sid}`;
          const deltas = [];
          if (prev) {
            if (Number(prev.electoralVotes) !== Number(cur.electoralVotes) && cur.electoralVotes != null) {
              deltas.push(`EV ${prev.electoralVotes ?? '—'} → ${cur.electoralVotes}`);
              evChanges++;
            }
            const prevGov = getName(prev.governor);
            const curGov = getName(cur.governor);
            if (prevGov !== curGov) { deltas.push(`Gov ${prevGov} → ${curGov}`); govChanges++; }

            const prevSens = senList(prev.senators);
            const curSens = senList(cur.senators);
            if (prevSens !== curSens) { deltas.push(`Sen ${prevSens} → ${curSens}`); senChanges++; }

            const pLeg = prev.legislatureSeats || { democratic: 0, republican: 0 };
            const cLeg = cur.legislatureSeats || { democratic: 0, republican: 0 };
            if ((pLeg.democratic ?? 0) !== (cLeg.democratic ?? 0) || (pLeg.republican ?? 0) !== (cLeg.republican ?? 0)) {
              deltas.push(`Leg Dem ${pLeg.democratic ?? 0}→${cLeg.democratic ?? 0}, GOP ${pLeg.republican ?? 0}→${cLeg.republican ?? 0}`);
              legChanges++;
            }
          } else {
            // New state data entry
            if (cur.electoralVotes != null) deltas.push(`EV → ${cur.electoralVotes}`);
            if (cur.governor) deltas.push(`Gov → ${getName(cur.governor)}`);
            if (Array.isArray(cur.senators) && cur.senators.length) deltas.push(`Sen → ${senList(cur.senators)}`);
          }
          if (deltas.length) changes.push(`- ${label}: ${deltas.join('; ')}`);
        }
        
        // Save backup
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = path.join(dataDir, `states.${stamp}.json`);
        try { fs.writeFileSync(backupPath, JSON.stringify(statesDb, null, 2)); } catch {}

        let message = `State data update complete. Scraped ${scraped} states, skipped ${skipped}.`;
        if (changes.length) {
          const summaryBits = [];
          if (evChanges) summaryBits.push(`EV: ${evChanges}`);
          if (govChanges) summaryBits.push(`Governor: ${govChanges}`);
          if (senChanges) summaryBits.push(`Senate: ${senChanges}`);
          if (legChanges) summaryBits.push(`Legislature: ${legChanges}`);
          const summary = summaryBits.length ? ` Changes (${summaryBits.join(', ')}):` : ' Changes:';
          const maxLines = 20;
          const shown = changes.slice(0, maxLines).join('\n');
          const more = changes.length > maxLines ? `\n… and ${changes.length - maxLines} more.` : '';
          message += `${summary}\n\`\`\`\n${shown}\n${more}\n\`\`\``;
        }
        
        const totalTime = Math.round((Date.now() - startTime) / 1000);
        await this.logToChannel(`${message} Time: ${totalTime}s.`);

      } finally {
        try { await page?.close(); } catch {}
      }

    } catch (err) {
      const totalTime = Math.round((Date.now() - startTime) / 1000);
      await this.logToChannel(`State update failed after ${totalTime}s: ${err?.message || String(err)}`, true);
      console.error('State update error:', err);
    }
  }

  async updatePrimaries() {
    const startTime = Date.now();
    try {
      console.log('🗳️ Starting primaries update...');
      await this.logToChannel('Starting automated primaries update...');
      
      const dataDir = path.join(process.cwd(), 'data');
      const primariesJsonPath = path.join(dataDir, 'primaries.json');

      let browser, page;
      try {
        const statesList = getAllStatesList();
        const sess = await loginAndGet(`${BASE}/national/states`);
        browser = sess.browser;
        page = sess.page;
        try { page.setDefaultNavigationTimeout?.(15000); page.setDefaultTimeout?.(15000); } catch (_) {}

        const statesIndexHtml = await page.content();

        // Helper functions (simplified versions from update.js)
        const extractRacePrimariesFromStatePage = (html, raceLabel) => {
          const $ = cheerio.load(html || '');
          const raceName = String(raceLabel || '').trim().toLowerCase();
          let header = null;
          $('h4').each((_, el) => {
            const t = ($(el).text() || '').trim().toLowerCase();
            if (t === raceName) { header = $(el); return false; }
          });
          if (!header) return null;
          const container = header.closest('.container, .container-fluid, .bg-white').length
            ? header.closest('.container, .container-fluid, .bg-white')
            : header.parent();
          const table = container.find('table').first();
          if (!table.length) return null;
          const result = { dem: null, gop: null };
          table.find('tbody tr').each((_, tr) => {
            const row = $(tr);
            const a = row.find('a[href*="/primaries/"]').first();
            if (!a.length) return;
            const href = a.attr('href') || '';
            const url = href.startsWith('http') ? href : new URL(href, BASE).toString();
            const tds = row.find('td');
            const partyText = (a.text() || '').toLowerCase();
            const deadlineText = (tds.eq(1).text() || '').replace(/\s+/g, ' ').trim() || null;
            const countText = (tds.eq(2).text() || '').trim();
            const count = countText && /\d+/.test(countText) ? Number((countText.match(/\d+/) || [])[0]) : null;
            const obj = { url, deadline: deadlineText, count };
            if (partyText.includes('democrat')) result.dem = obj;
            if (partyText.includes('republican')) result.gop = obj;
          });
          if (!result.dem && !result.gop) return null;
          return result;
        };

        const extractPrimaryCandidates = (html) => {
          const $ = cheerio.load(html || '');
          const hideMetrics = (txt) => {
            const out = {};
            const re = /\b(ES|CO|NR|AR|CR)\s*[:\-]\s*([0-9]+(?:\.[0-9]+)?)\b/gi;
            let m;
            while ((m = re.exec(String(txt || '')))) {
              out[m[1].toUpperCase()] = Number(m[2]);
            }
            return out;
          };

          let scope = $('#electionresult');
          if (!scope.length) scope = $('body');
          const items = [];
          scope.find('.progress-wrapper').each((_, pw) => {
            const wrap = $(pw);
            const label = wrap.find('.progress-label a, .progress-label').first();
            const nameFull = (label.text() || '').replace(/\s+/g, ' ').trim();
            if (!nameFull) return;
            const link = wrap.find('a[href^="/users/"]').first();
            const href = link.attr('href') || '';
            const idMatch = href.match(/\/users\/(\d+)/);
            let name = nameFull;
            let metrics = hideMetrics(nameFull);
            const paren = nameFull.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
            if (paren) {
              name = paren[1].trim();
              metrics = { ...metrics, ...hideMetrics(paren[2]) };
            }
            let percent = null;
            const pctText = (wrap.find('.progress-percentage .text-primary').first().text() || '').trim();
            const mp = pctText.match(/([0-9]+(?:\.[0-9]+)?)/);
            if (mp) percent = Number(mp[1]);
            if (percent == null) {
              const w = wrap.find('.progress-bar').attr('style') || '';
              const mw = w.match(/width:\s*([0-9.]+)%/i);
              if (mw) percent = Number(mw[1]);
            }
            items.push({ userId: idMatch ? Number(idMatch[1]) : null, name, metrics, percent });
          });

          if (items.length) return { items, active: true };

          const regHeader = $('h3').filter((_, el) => /primary\s+registration/i.test($(el).text())).first();
          const regBlock = regHeader.length
            ? regHeader.closest('.container-fluid, .bg-white, .rounded, .ppusa_background, .row, .col-sm-6')
            : $();
          const regTable = regBlock.find('table tbody');
          if (regTable.length) {
            regTable.find('tr').each((_, tr) => {
              const row = $(tr);
              const link = row.find('a[href^="/users/"]').first();
              const href = link.attr('href') || '';
              const idMatch = href.match(/\/users\/(\d+)/);
              const name = row.find('a[href^="/users/"] h5').first().text().trim() || link.text().trim();
              if (!name) return;
              const rowText = row.text().replace(/\s+/g, ' ');
              const metrics = hideMetrics(rowText);
              items.push({ userId: idMatch ? Number(idMatch[1]) : null, name, metrics, percent: null });
            });
            return { items, active: false };
          }

          return { items, active: false };
        };

        const races = [
          { key: 's1', label: 'senate class 1' },
          { key: 's2', label: 'senate class 2' },
          { key: 's3', label: 'senate class 3' },
          { key: 'gov', label: 'governor' },
          { key: 'rep', label: 'house of representatives' },
        ];

        const primariesDb = { updatedAt: null, primaries: [], candidatesIndex: {} };
        let scrapedStates = 0;
        let racePages = 0;

        for (const state of statesList) {
          try {
            const stateId = resolveStateIdFromIndex(statesIndexHtml, state.name);
            if (!stateId) continue;
            await page.goto(`${BASE}/states/${stateId}/primaries`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            const primHtml = await page.content();

            for (const race of races) {
              const meta = extractRacePrimariesFromStatePage(primHtml, race.label);
              if (!meta) continue;
              const entry = {
                stateId: Number(stateId),
                stateName: state.name,
                race: race.key,
                raceLabel: race.label,
                parties: { dem: null, gop: null }
              };

              for (const p of ['dem', 'gop']) {
                const m = meta[p];
                if (!m || !m.url) { entry.parties[p] = null; continue; }
                await page.goto(m.url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                const partyHtml = await page.content();
                const parsed = extractPrimaryCandidates(partyHtml);
                racePages++;
                const candidates = parsed.items || [];

                const avg = (key) => {
                  const vals = candidates.map(c => c.metrics?.[key]).filter(v => typeof v === 'number');
                  if (!vals.length) return null;
                  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
                };

                entry.parties[p] = {
                  url: m.url,
                  deadline: m.deadline || null,
                  count: typeof m.count === 'number' ? m.count : (candidates?.length || null),
                  status: parsed.active ? 'active' : 'upcoming',
                  candidates,
                  avgMetrics: parsed.active ? {
                    ES: avg('ES'), CO: avg('CO'), NR: avg('NR'), AR: avg('AR'), CR: avg('CR')
                  } : null,
                };

                // index candidates for role syncing
                for (const cand of candidates) {
                  if (typeof cand.userId !== 'number' || !cand.userId) continue;
                  const key = String(cand.userId);
                  if (!primariesDb.candidatesIndex[key]) primariesDb.candidatesIndex[key] = [];
                  primariesDb.candidatesIndex[key].push({ stateId: Number(stateId), race: race.key, party: p, status: entry.parties[p].status });
                }
              }

              primariesDb.primaries.push(entry);
            }

            scrapedStates++;
          } catch (_) {
            // continue
          }
        }

        primariesDb.updatedAt = new Date().toISOString();
        fs.writeFileSync(primariesJsonPath, JSON.stringify(primariesDb, null, 2));
        try {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          fs.writeFileSync(path.join(dataDir, `primaries.${stamp}.json`), JSON.stringify(primariesDb, null, 2));
        } catch (_) {}

        const totalTime = Math.round((Date.now() - startTime) / 1000);
        await this.logToChannel(`Primaries update complete. States: ${scrapedStates}/${statesList.length}. Race pages fetched: ${racePages}. Time: ${totalTime}s.`);

      } finally {
        try { await page?.close(); } catch {}
      }

    } catch (err) {
      const totalTime = Math.round((Date.now() - startTime) / 1000);
      await this.logToChannel(`Primaries update failed after ${totalTime}s: ${err?.message || String(err)}`, true);
      console.error('Primaries update error:', err);
    }
  }

  async updateRaces() {
    const startTime = Date.now();
    try {
      console.log('🏁 Starting races update...');
      await this.logToChannel('Starting automated races update...');
      
      const dataDir = path.join(process.cwd(), 'data');
      const racesJsonPath = path.join(dataDir, 'races.json');

      let browser, page;
      try {
        const statesList = getAllStatesList();
        const sess = await loginAndGet(`${BASE}/national/states`);
        browser = sess.browser;
        page = sess.page;
        try { page.setDefaultNavigationTimeout?.(15000); page.setDefaultTimeout?.(15000); } catch (_) {}

        const statesIndexHtml = await page.content();

        // Helper functions (simplified versions from update.js)
        const findRaceFromElections = (html, raceLabel) => {
          const $ = cheerio.load(html || '');
          const target = String(raceLabel || '').trim().toLowerCase();
          let match = null;
          $('h4').each((_, heading) => {
            const headingText = ($(heading).text() || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (headingText !== target) return;
            const section = $(heading).closest('.container-fluid, .bg-white, .container, .rounded');
            const rows = section.find('table tbody tr');
            let raceUrl = null;
            rows.each((__, tr) => {
              const anchor = $(tr).find('a[href]').first();
              if (anchor.length && !raceUrl) {
                let href = anchor.attr('href');
                if (href && !/^https?:/i.test(href)) href = new URL(href, BASE).toString();
                raceUrl = href;
              }
              if (raceUrl) return false;
            });
            if (!raceUrl) {
              const anchor = section.find('a[href*="/elections/"]').first();
              if (anchor.length) {
                let href = anchor.attr('href');
                if (href && !/^https?:/i.test(href)) href = new URL(href, BASE).toString();
                raceUrl = href;
              }
            }
            match = { url: raceUrl || null };
            return false;
          });
          return match;
        };

        const extractRaceCandidates = (html) => {
          const $ = cheerio.load(html || '');
          const items = [];
          const wrappers = $('.progress-wrapper');
          wrappers.each((_, el) => {
            const wrap = $(el);
            const aUser = wrap.find('a[href^="/users/"]').first();
            const href = aUser.attr('href') || '';
            const idMatch = href.match(/\/users\/(\d+)/);
            
            const name = wrap.find('.progress-label a .text-primary').first().text().trim();
            if (!name) return;
            
            let party = null;
            const partySpan = wrap.find('.progress-label span').filter((__, node) => {
              const text = $(node).text().toLowerCase();
              return text.includes('democratic') || text.includes('republican');
            }).first();
            const partyText = (partySpan.text() || '').toLowerCase();
            if (/democratic/.test(partyText)) party = 'dem';
            else if (/republican/.test(partyText)) party = 'gop';
            
            let percent = null;
            const pctText = wrap.find('.progress-percentage .text-primary').last().text().trim();
            const mp = pctText.match(/([0-9]+(?:\.[0-9]+)?)/);
            if (mp) percent = Number(mp[1]);
            
            items.push({ userId: idMatch ? Number(idMatch[1]) : null, name, party, percent });
          });

          const hasWrappers = items.length > 0;
          const hasFinalHeader = $('h4').filter((_, el) => /final\s*results/i.test($(el).text())).length > 0;
          const active = hasWrappers && !hasFinalHeader;
          return { items, active };
        };

        const races = [
          { key: 's1', label: 'senate class 1' },
          { key: 's2', label: 'senate class 2' },
          { key: 's3', label: 'senate class 3' },
          { key: 'gov', label: 'governor' },
          { key: 'rep', label: 'house of representatives' },
        ];

        const racesDb = { updatedAt: null, races: [], candidatesIndex: {} };
        let scrapedStates = 0;
        let racePages = 0;

        for (const state of statesList) {
          try {
            const stateId = resolveStateIdFromIndex(statesIndexHtml, state.name);
            if (!stateId) continue;
            await page.goto(`${BASE}/states/${stateId}/elections`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            const electionsHtml = await page.content();

            for (const race of races) {
              const meta = findRaceFromElections(electionsHtml, race.label);
              if (!meta?.url) continue;
              await page.goto(meta.url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
              const raceHtml = await page.content();
              racePages++;
              const parsed = extractRaceCandidates(raceHtml);
              const candidates = parsed.items || [];
              const entry = {
                stateId: Number(stateId),
                stateName: state.name,
                race: race.key,
                raceLabel: race.label,
                status: parsed.active ? 'active' : 'finished',
                candidates,
              };
              racesDb.races.push(entry);

              for (const cand of candidates) {
                if (typeof cand.userId !== 'number' || !cand.userId) continue;
                const key = String(cand.userId);
                if (!racesDb.candidatesIndex[key]) racesDb.candidatesIndex[key] = [];
                const party = cand.party || null;
                racesDb.candidatesIndex[key].push({ stateId: Number(stateId), race: race.key, party, status: entry.status });
              }
            }

            scrapedStates++;
          } catch (_) {
            // continue
          }
        }

        racesDb.updatedAt = new Date().toISOString();
        fs.writeFileSync(racesJsonPath, JSON.stringify(racesDb, null, 2));
        try {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          fs.writeFileSync(path.join(dataDir, `races.${stamp}.json`), JSON.stringify(racesDb, null, 2));
        } catch (_) {}

        const totalTime = Math.round((Date.now() - startTime) / 1000);
        await this.logToChannel(`Races update complete. States: ${scrapedStates}/${statesList.length}. Race pages fetched: ${racePages}. Time: ${totalTime}s.`);

      } finally {
        try { await page?.close(); } catch {}
      }

    } catch (err) {
      const totalTime = Math.round((Date.now() - startTime) / 1000);
      await this.logToChannel(`Races update failed after ${totalTime}s: ${err?.message || String(err)}`, true);
      console.error('Races update error:', err);
    }
  }

  async runHourlyUpdate() {
    console.log('🔄 runHourlyUpdate called - checking if already running...');
    if (this.isRunning) {
      console.log('⚠️ Previous update still running, skipping this hour');
      await this.logToChannel('Previous update still running, skipping this hour.', true);
      return;
    }

    console.log('🚀 Starting hourly update process');
    this.isRunning = true;
    this.lastRun = new Date();
    const startTime = Date.now();

    // Set a timeout to prevent infinite running
    const timeoutHandle = setTimeout(async () => {
      if (this.isRunning) {
        console.error('🚨 CRON UPDATE TIMEOUT - Force stopping after 20 minutes');
        this.isRunning = false;
        await this.logToChannel('🚨 UPDATE TIMEOUT: Process exceeded 20 minutes, force stopped', true);
      }
    }, MAX_UPDATE_TIME);

    try {
      await this.logToChannel('🔄 Starting hourly automated updates (SEQUENTIAL)...');

      // Run updates SEQUENTIALLY to prevent browser conflicts and timeouts
      console.log('🔄 Running profile update...');
      await this.updateProfiles().catch(err => {
        console.error('Profile update failed:', err);
        this.logToChannel(`❌ Profile update failed: ${err?.message || String(err)}`, true);
      });

      console.log('🔄 Running state update...');
      await this.updateStates().catch(err => {
        console.error('State update failed:', err);
        this.logToChannel(`❌ State update failed: ${err?.message || String(err)}`, true);
      });

      console.log('🔄 Running primaries update...');
      await this.updatePrimaries().catch(err => {
        console.error('Primary update failed:', err);
        this.logToChannel(`❌ Primary update failed: ${err?.message || String(err)}`, true);
      });

      console.log('🔄 Running races update...');
      await this.updateRaces().catch(err => {
        console.error('Race update failed:', err);
        this.logToChannel(`❌ Race update failed: ${err?.message || String(err)}`, true);
      });

      const duration = Math.round((Date.now() - startTime) / 1000);
      await this.logToChannel(`✅ All hourly updates completed successfully! (${duration}s)`);
      console.log(`✅ Hourly update completed successfully in ${duration}s`);

    } catch (err) {
      const duration = Math.round((Date.now() - startTime) / 1000);
      await this.logToChannel(`❌ Hourly update failed after ${duration}s: ${err?.message || String(err)}`, true);
      console.error('Hourly update error:', err);
    } finally {
      // Clear the timeout since we're done
      clearTimeout(timeoutHandle);
      this.isRunning = false;
      console.log('🏁 Hourly update finished - isRunning set to false');
    }
  }

  start() {
    if (this.job) {
      console.log('Cron job already started');
      return;
    }

    // Run every hour at minute 0
    this.job = cron.schedule('0 * * * *', async () => {
      console.log('🕐 Cron job triggered - starting hourly update');
      try {
        await this.runHourlyUpdate();
      } catch (error) {
        console.error('❌ Cron job execution failed:', error);
        await this.logToChannel(`Cron job failed: ${error?.message || String(error)}`, true);
      }
    });

    console.log('✅ Cron job scheduled - will run every hour');
    console.log('📅 Next run:', this.job.nextDate ? this.job.nextDate().toString() : 'Unknown');
  }

  stop() {
    if (this.job) {
      this.job.stop();
      this.job = null;
      console.log('⏹️ Cron job stopped');
    }
    // Also force stop any running updates
    if (this.isRunning) {
      console.log('🛑 Force stopping running update');
      this.isRunning = false;
    }
  }

  forceStop() {
    console.log('🚨 FORCE STOP: Terminating all cron operations');
    this.isRunning = false;
    if (this.job) {
      this.job.stop();
      this.job = null;
    }
    console.log('⏹️ Cron service force stopped');
  }

  restart() {
    console.log('🔄 Restarting cron service...');
    this.stop();
    setTimeout(() => {
      this.start();
    }, 1000);
  }

  getStatus() {
    const jobScheduled = this.job ? true : false;
    const nextRun = jobScheduled && this.job.nextDate ? this.job.nextDate().toString() : null;

    // Check if we've been running for too long (more than 15 minutes)
    const runningTooLong = this.isRunning && this.lastRun &&
      (Date.now() - new Date(this.lastRun).getTime()) > 15 * 60 * 1000;

    return {
      isRunning: this.isRunning,
      lastRun: this.lastRun,
      scheduled: jobScheduled,
      nextRun: nextRun,
      jobActive: this.job ? true : false,
      runningTooLong: runningTooLong
    };
  }
}

module.exports = CronService;
