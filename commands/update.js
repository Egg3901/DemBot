// commands/update.js
// Version: 2.0 - Enhanced with parallel processing and smart caching
const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');
const { parseProfile, BASE, loginAndGet } = require('../lib/ppusa');
const cheerio = require('cheerio');
const { canManageBot } = require('../lib/permissions');
const { ensureDbShape, mergeProfileRecord } = require('../lib/profile-cache');
const { resolveStateIdFromIndex } = require('../lib/state-utils');
const { parseStateData, getAllStatesList } = require('../lib/state-scraper');
const { sessionManager } = require('../lib/session-manager');
const { ParallelProcessor } = require('../lib/parallel-processor');
const { smartCache } = require('../lib/smart-cache');
const { performRoleSync } = require('../lib/role-sync');
const { navigateWithSession, authenticateAndNavigate: authWithReuse } = require('../lib/ppusa-auth-optimized');

// Inactive (offline) role and threshold (days)
const INACTIVE_ROLE_ID = '1427236595345522708';
const OFFLINE_THRESHOLD_DAYS = 4;
const WARNING_THRESHOLD_DAYS = 3;

const TYPE_CHOICES = new Set(['all', 'dems', 'gop', 'new', 'states', 'primaries', 'races']);
const TYPE_LABELS = {
  all: 'All Profiles',
  dems: 'Democratic Profiles',
  gop: 'Republican Profiles',
  new: 'New Accounts',
  states: 'State Data',
  primaries: 'Primaries',
  races: 'Races',
};

const isDemocratic = (party = '') => /democratic/i.test(String(party));
const isRepublican = (party = '') => /republican/i.test(String(party));

// Role sync is now imported from lib/role-sync.js

module.exports = {
  data: new SlashCommandBuilder()
    .setName('update')
    .setDescription('Crawl player profiles (id 1..max) and update profiles.json')
    .addStringOption((opt) =>
      opt
        .setName('type')
        .setDescription('Which profiles to refresh (all, dems, gop, or new)')
        .setRequired(false)
        .addChoices(
          { name: 'All profiles', value: 'all' },
          { name: 'Democrats', value: 'dems' },
          { name: 'Republicans', value: 'gop' },
          { name: 'New accounts only', value: 'new' },
          { name: 'State data (EV, positions)', value: 'states' },
          { name: 'Primaries (all states)', value: 'primaries' },
          { name: 'Races (all states)', value: 'races' },
        )
    )
    .addBooleanOption(opt =>
      opt
        .setName('roles')
        .setDescription('After update, apply needed roles to matching server members')
        .setRequired(false)
    )
    .addBooleanOption(opt =>
      opt
        .setName('clear')
        .setDescription('When used with roles, remove all managed office and region roles')
        .setRequired(false)
    )
    .addBooleanOption(opt =>
      opt
        .setName('debug')
        .setDescription('Enable deep logging for troubleshooting')
        .setRequired(false)
    ),

  /**
   * Execute the /update command with optimizations
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @returns {Promise<void>}
   */
  async execute(interaction) {
    await interaction.deferReply();

    const applyRoles = interaction.options.getBoolean('roles') || false;
    const clearRoles = interaction.options.getBoolean('clear') || false;
    const typeInputRaw = (interaction.options.getString('type') || 'all').toLowerCase();
    const updateType = TYPE_CHOICES.has(typeInputRaw) ? typeInputRaw : 'all';
    const typeLabel = TYPE_LABELS[updateType] || TYPE_LABELS.all;
    const inGuild = interaction.inGuild();
    const debug = interaction.options.getBoolean('debug') || false;

    const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logPath = path.join(process.cwd(), 'bot-health.log');
    const dlog = (msg) => {
      if (!debug) return;
      const line = `[${new Date().toISOString()}] [update:${updateType}] ${msg}\n`;
      try { fs.appendFileSync(logPath, line, 'utf8'); } catch (_) {}
      try { console.log('[update]', msg); } catch (_) {}
    };
    if (debug) {
      dlog(`--- START (stamp=${runStamp}) user=${interaction.user?.id || 'unknown'} guild=${interaction.guild?.id || 'DM'} ---`);
    }

    if (!(await canManageBot(interaction))) {
      return interaction.editReply('You do not have permission to use /update.');
    }

    if (!inGuild && applyRoles) {
      return interaction.editReply('Role syncing must be run from within the server.');
    }

    if (clearRoles && !applyRoles) {
      return interaction.editReply('Use the clear option alongside roles=true.');
    }

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
    if (!db.updatedAt) db.updatedAt = new Date().toISOString();

    // Ensure a file exists immediately so users can see it while crawling
    const writeDb = () => {
      const payload = { ...ensureDbShape(db), updatedAt: new Date().toISOString() };
      fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
    };
    if (!fs.existsSync(jsonPath)) writeDb();

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
      if (isDemocratic(profile.party)) demIdsSet.add(idNum);
      if (isRepublican(profile.party)) gopIdsSet.add(idNum);
    }

    allIds.sort((a, b) => a - b);
    const demIds = Array.from(demIdsSet).sort((a, b) => a - b);
    const gopIds = Array.from(gopIdsSet).sort((a, b) => a - b);

    const existingTargetIds =
      updateType === 'all' ? allIds :
      updateType === 'dems' ? demIds :
      updateType === 'gop' ? gopIds :
      [];

    const maxKnownIdAll = allIds.length ? allIds[allIds.length - 1] : 0;
    const baseStartId = 1000;
    const newStartId = Math.max(maxKnownIdAll + 1, baseStartId);
    const effectiveNewStartId = newStartId;
    const typeSummaryLabel = updateType === 'new' ? 'New accounts' : `${typeLabel} + new accounts`;

    const start = Date.now();
    let found = 0;
    let checked = 0;
    dlog(`dbCounts: totalProfiles=${profilesList.length} allIds=${allIds.length} demIds=${demIds.length} gopIds=${gopIds.length}`);
    dlog(`selection: type=${updateType} existingTargetIds=${existingTargetIds.length}`);
    dlog(`newScan: baseStartId=${baseStartId} maxKnownIdAll=${maxKnownIdAll} newStartId=${newStartId} effectiveNewStartId=${effectiveNewStartId} range=[${effectiveNewStartId}..${effectiveNewStartId + 99}]`);

    // Handle special update types (states, primaries, races)
    if (['states', 'primaries', 'races'].includes(updateType)) {
      try {
        const dataDir = path.join(process.cwd(), 'data');
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

        if (updateType === 'states') {
          // Reinstate working states scraper
          await interaction.editReply('Updating state data (EVs, positions)...');

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

            const statesIndexHtml = await page.content();

            let scraped = 0;
            let skipped = 0;

            for (const [idx, state] of statesList.entries()) {
              try {
                const stateId = resolveStateIdFromIndex(statesIndexHtml, state.name);
                if (!stateId) { skipped++; continue; }
                await page.goto(`${BASE}/states/${stateId}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                const stateHtml = await page.content();
                const stateData = parseStateData(stateHtml, stateId);
                if (stateData) { statesDb.states[stateId] = stateData; scraped++; }
                else { skipped++; }
              } catch (_) { skipped++; }

              if ((idx + 1) % 10 === 0) {
                try { await interaction.editReply(`Updating state data... ${idx + 1}/${statesList.length} processed`); } catch {}
              }
            }

            statesDb.updatedAt = new Date().toISOString();
            fs.writeFileSync(statesJsonPath, JSON.stringify(statesDb, null, 2));
            try {
              const stamp = new Date().toISOString().replace(/[:.]/g, '-');
              fs.writeFileSync(path.join(dataDir, `states.${stamp}.json`), JSON.stringify(statesDb, null, 2));
            } catch {}

            await interaction.editReply(`States updated. Scraped ${scraped}, skipped ${skipped}.`);
          } finally {
            try { await page?.close(); } catch {}
          }

          return;
        }

        if (updateType === 'primaries') {
          // Reinstate working primaries scraper
          await interaction.editReply('Updating primaries across all states...');

          const primariesJsonPath = path.join(dataDir, 'primaries.json');
          let browser, page;
          try {
            const statesList = getAllStatesList();
            const sess = await loginAndGet(`${BASE}/national/states`);
            browser = sess.browser;
            page = sess.page;
            try { page.setDefaultNavigationTimeout?.(15000); page.setDefaultTimeout?.(15000); } catch {}

            const statesIndexHtml = await page.content();

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
              const items = [];
              const pick = (txt) => {
                const out = {};
                const re = /\b(ES|CO|NR|AR|CR)\s*[:\-]\s*([0-9]+(?:\.[0-9]+)?)\b/gi;
                let m; while ((m = re.exec(String(txt || '')))) out[m[1].toUpperCase()] = Number(m[2]);
                return out;
              };
              let scope = $('#electionresult'); if (!scope.length) scope = $('body');
              scope.find('.progress-wrapper').each((_, pw) => {
                const wrap = $(pw);
                const label = wrap.find('.progress-label a, .progress-label').first();
                const nameFull = (label.text() || '').replace(/\s+/g, ' ').trim();
                if (!nameFull) return;
                const link = wrap.find('a[href^="/users/"]').first();
                const href = link.attr('href') || '';
                const idMatch = href.match(/\/users\/(\d+)/);
                let name = nameFull;
                let metrics = pick(nameFull);
                const paren = nameFull.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
                if (paren) { name = paren[1].trim(); metrics = { ...metrics, ...pick(paren[2]) }; }
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
              const regBlock = regHeader.length ? regHeader.closest('.container-fluid, .bg-white, .rounded, .ppusa_background, .row, .col-sm-6') : $();
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
                  const metrics = pick(rowText);
                  items.push({ userId: idMatch ? Number(idMatch[1]) : null, name, metrics, percent: null });
                });
                return { items, active: false };
              }
              return { items, active: false };
            };

            for (const [idx, state] of statesList.entries()) {
              try {
                const stateId = resolveStateIdFromIndex(statesIndexHtml, state.name);
                if (!stateId) continue;
                await page.goto(`${BASE}/states/${stateId}/primaries`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                const primHtml = await page.content();
                for (const race of races) {
                  const meta = extractRacePrimariesFromStatePage(primHtml, race.label);
                  if (!meta) continue;
                  const entry = { stateId: Number(stateId), stateName: state.name, race: race.key, raceLabel: race.label, parties: { dem: null, gop: null } };
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
                      avgMetrics: parsed.active ? { ES: avg('ES'), CO: avg('CO'), NR: avg('NR'), AR: avg('AR'), CR: avg('CR') } : null,
                    };
                    for (const cand of candidates) {
                      if (typeof cand.userId !== 'number' || !cand.userId) continue;
                      const key = String(cand.userId);
                      if (!primariesDb.candidatesIndex[key]) primariesDb.candidatesIndex[key] = [];
                      primariesDb.candidatesIndex[key].push({ stateId: Number(stateId), race: race.key, party: p, status: entry.parties[p].status });
                    }
                  }
                  primariesDb.primaries.push(entry);
                }
              } catch (_) { /* continue */ }

              if ((idx + 1) % 5 === 0) {
                try { await interaction.editReply(`Updating primaries... processed ${idx + 1}/${statesList.length} states`); } catch {}
              }
              scrapedStates++;
            }

            primariesDb.updatedAt = new Date().toISOString();
            fs.writeFileSync(primariesJsonPath, JSON.stringify(primariesDb, null, 2));
            try {
              const stamp = new Date().toISOString().replace(/[:.]/g, '-');
              fs.writeFileSync(path.join(dataDir, `primaries.${stamp}.json`), JSON.stringify(primariesDb, null, 2));
            } catch {}

            await interaction.editReply(`Primaries updated. States processed: ${scrapedStates}. Race pages fetched: ${racePages}.`);
          } finally {
            try { await page?.close(); } catch {}
          }

          return;
        }

        if (updateType === 'races') {
          // Reinstate working races scraper
          await interaction.editReply('Updating races across all states...');

          const racesJsonPath = path.join(dataDir, 'races.json');
          let browser, page;
          try {
            const statesList = getAllStatesList();
            const sess = await loginAndGet(`${BASE}/national/states`);
            browser = sess.browser;
            page = sess.page;
            try { page.setDefaultNavigationTimeout?.(15000); page.setDefaultTimeout?.(15000); } catch {}

            const statesIndexHtml = await page.content();

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

            for (const [idx, state] of statesList.entries()) {
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
                  const entry = { stateId: Number(stateId), stateName: state.name, race: race.key, raceLabel: race.label, status: parsed.active ? 'active' : 'finished', candidates };
                  racesDb.races.push(entry);
                  for (const cand of candidates) {
                    if (typeof cand.userId !== 'number' || !cand.userId) continue;
                    const key = String(cand.userId);
                    if (!racesDb.candidatesIndex[key]) racesDb.candidatesIndex[key] = [];
                    const party = cand.party || null;
                    racesDb.candidatesIndex[key].push({ stateId: Number(stateId), race: race.key, party, status: entry.status });
                  }
                }
              } catch (_) { /* continue */ }

              if ((idx + 1) % 5 === 0) {
                try { await interaction.editReply(`Updating races... processed ${idx + 1}/${statesList.length} states`); } catch {}
              }
              scrapedStates++;
            }

            racesDb.updatedAt = new Date().toISOString();
            fs.writeFileSync(racesJsonPath, JSON.stringify(racesDb, null, 2));
            try {
              const stamp = new Date().toISOString().replace(/[:.]/g, '-');
              fs.writeFileSync(path.join(dataDir, `races.${stamp}.json`), JSON.stringify(racesDb, null, 2));
            } catch {}

            await interaction.editReply(`Races updated. States processed: ${scrapedStates}. Race pages fetched: ${racePages}.`);
          } finally {
            try { await page?.close(); } catch {}
          }

          return;
        }

      } catch (error) {
        try { await interaction.editReply(`Error during ${updateType} update: ${error?.message || String(error)}`); } catch {}
        return;
      }
    }

    // Roles-only mode: do not scrape, only apply roles from existing JSON
    if (applyRoles) {
      const guild = interaction.guild;
      if (!guild) {
        return interaction.editReply('Roles option requested, but command not run in a guild.');
      }

      await interaction.editReply('Syncing roles from profiles.json...');
      await performRoleSync({ interaction, guild, db, clearRoles, useFollowUpForStatus: false });
      return;
    }

    // Scrape mode (no roles), build/update profiles.json with parallel processing
    let session = null;
    try {
      const fallbackLoginId = allIds.length ? allIds[allIds.length - 1] : baseStartId;
      const loginSeed = existingTargetIds.length ? existingTargetIds[0] : fallbackLoginId;
      const loginId = Number.isFinite(loginSeed) && loginSeed > 0 ? loginSeed : baseStartId;
      
      session = await sessionManager.authenticateSession('update', `${BASE}/users/${loginId}`);
      dlog(`auth: loginSeed=${loginSeed} loginId=${loginId}`);

      await interaction.editReply(`Updating profiles (${typeSummaryLabel})...`);

      const processor = new ParallelProcessor({
        maxConcurrency: 12,
        batchSize: 20,
        delayBetweenBatches: 200
      });

      const fetchProfile = async (targetUrl) => {
        // First attempt: use existing session navigation
        let result = await navigateWithSession(session, targetUrl, 'networkidle2');
        let finalUrl = result.finalUrl || '';
        const isLogin = /\/login\b/i.test(finalUrl);
        const isUserUrl = /\/users\//i.test(finalUrl);
        if (debug) dlog(`fetch: first url=${finalUrl} login=${isLogin} userUrl=${isUserUrl}`);
        // If redirected to login or not on a user page, try to re-auth and retry once
        if (isLogin || !isUserUrl) {
          if (debug) dlog(`fetch: reauth retry for ${targetUrl}`);
          try {
            const re = await authWithReuse({ url: targetUrl, browser: session.browser, page: session.page, waitUntil: 'networkidle2' });
            result = { html: re.html, finalUrl: re.finalUrl, status: re.status };
            finalUrl = result.finalUrl || '';
            if (debug) dlog(`fetch: after-reauth url=${finalUrl}`);
          } catch (reauthErr) {
            if (debug) dlog(`fetch: reauth failed ${reauthErr.message}`);
          }
        }
        return result;
      };

      // Process existing profiles first
      if (existingTargetIds.length > 0) {
        const missCounts = { redirect: 0, noName: 0, exception: 0, unknown: 0 };
        const profileProcessor = async (profileId) => {
          try {
            const targetUrl = `${BASE}/users/${profileId}`;
            const result = await fetchProfile(targetUrl);
            const info = parseProfile(result.html);
            const finalUrl = result.finalUrl || '';
            const isUserUrl = /\/users\//i.test(finalUrl);
            const htmlLen = (result.html || '').length;
            const infoName = info?.name || null;
            if (debug) dlog(`exist: id=${profileId} url=${finalUrl} bytes=${htmlLen} userUrl=${isUserUrl} name=${infoName || 'null'}`);
            
            // Guard against login pages or non-user URLs masquerading as profiles
            const badName = infoName && /login/i.test(infoName);
            if (info?.name && isUserUrl && !badName) {
              mergeProfileRecord(db, profileId, info);
              return { id: profileId, found: true, info };
            }
            const reason = !isUserUrl ? 'redirect' : (!infoName ? 'noName' : 'unknown');
            missCounts[reason] = (missCounts[reason] || 0) + 1;
            return { id: profileId, found: false, reason };
          } catch (error) {
            console.error(`Error processing profile ${profileId}:`, error.message);
            if (debug) dlog(`exist: id=${profileId} exception=${error.message}`);
            missCounts.exception++;
            return { id: profileId, found: false, error: error.message };
          }
        };

        const { results, errors } = await processor.processProfiles(existingTargetIds, profileProcessor, {
          onProgress: (processed, total) => {
            if (processed % 5 === 0 || processed === total) {
              const foundCount = results.filter(r => r?.found).length;
              interaction.editReply(`Updating profiles (${typeSummaryLabel})... ${processed}/${total} processed, ${foundCount} found`);
              if (debug) dlog(`progress(exist): ${processed}/${total} found=${foundCount}`);
            }
          }
        });

        found += results.filter(r => r?.found).length;
        checked += results.length;
        if (debug) dlog(`summary(exist): checked=${results.length} found=${results.filter(r=>r?.found).length} misses=${JSON.stringify(missCounts)}`);
      }

      // Process new profiles
      if (effectiveNewStartId > 0) {
        const missCountsNew = { redirect: 0, noName: 0, exception: 0, unknown: 0 };
        const newIds = [];
        for (let id = effectiveNewStartId; id < effectiveNewStartId + 100; id++) {
          newIds.push(id);
        }

        const newProfileProcessor = async (profileId) => {
          try {
            const targetUrl = `${BASE}/users/${profileId}`;
            const result = await fetchProfile(targetUrl);
            const info = parseProfile(result.html);
            const finalUrl = result.finalUrl || '';
            const isUserUrl = /\/users\//i.test(finalUrl);
            const htmlLen = (result.html || '').length;
            const infoName = info?.name || null;
            if (debug) dlog(`new: id=${profileId} url=${finalUrl} bytes=${htmlLen} userUrl=${isUserUrl} name=${infoName || 'null'}`);
            
            const badName = infoName && /login/i.test(infoName);
            if (info?.name && isUserUrl && !badName) {
              mergeProfileRecord(db, profileId, info);
              return { id: profileId, found: true, info };
            }
            const reason = !isUserUrl ? 'redirect' : (!infoName ? 'noName' : 'unknown');
            missCountsNew[reason] = (missCountsNew[reason] || 0) + 1;
            return { id: profileId, found: false, reason };
          } catch (error) {
            if (debug) dlog(`new: id=${profileId} exception=${error.message}`);
            missCountsNew.exception++;
            return { id: profileId, found: false, error: error.message };
          }
        };

        const { results: newResults } = await processor.processProfiles(newIds, newProfileProcessor, {
          onProgress: (processed, total) => {
            if (processed % 10 === 0 || processed === total) {
              const foundCount = newResults.filter(r => r?.found).length;
              interaction.editReply(`Scanning new profiles... ${processed}/${total} processed, ${foundCount} found`);
              if (debug) dlog(`progress(new): ${processed}/${total} found=${foundCount}`);
            }
          }
        });

        found += newResults.filter(r => r?.found).length;
        checked += newResults.length;
        if (debug) dlog(`summary(new): checked=${newResults.length} found=${newResults.filter(r=>r?.found).length} misses=${JSON.stringify(missCountsNew)}`);
      }

      writeDb();
      
      // Save a timestamped backup
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(dataDir, `profiles.${stamp}.json`);
      try { fs.writeFileSync(backupPath, JSON.stringify(db, null, 2)); } catch {}
      
      const secs = Math.round((Date.now() - start) / 1000);
      dlog(`final: checked=${checked} found=${found} elapsedSec=${secs}`);
      await interaction.editReply(`Updated profiles.json (${typeSummaryLabel}). Checked ${checked}, found ${found}. Time: ${secs}s.${debug ? ' (debug log: bot-health.log)' : ''}`);

      if (applyRoles) {
        const guild = interaction.guild;
        if (!guild) {
          await interaction.followUp({ content: 'Roles option requested, but command not run in a guild.', ephemeral: true });
          return;
        }

        await performRoleSync({ interaction, guild, db, clearRoles, useFollowUpForStatus: true });
      }

    } catch (err) {
      try { await interaction.editReply(`Error during update: ${err?.message || String(err)}`); } catch {}
    }
  },
};