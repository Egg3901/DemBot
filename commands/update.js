// commands/update.js
// Version: 1.0
const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');
const { loginAndGet, parseProfile, BASE } = require('../lib/ppusa');
const cheerio = require('cheerio');
const { canManageBot } = require('../lib/permissions');
const { ensureDbShape, mergeProfileRecord } = require('../lib/profile-cache');
const { resolveStateIdFromIndex } = require('../lib/state-utils');
const { parseStateData, getAllStatesList } = require('../lib/state-scraper');

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

async function performRoleSync({ interaction, guild, db, clearRoles = false, useFollowUpForStatus = false }) {
  const profiles = db.profiles || {};
  if (!profiles || Object.keys(profiles).length === 0) {
    const msg = 'profiles.json is empty. Run /update (without roles) first to build the cache.';
    if (useFollowUpForStatus) await interaction.followUp(msg);
    else await interaction.editReply(msg);
    return;
  }

  const ROLE_IDS = {
    gov: '1406063203313782865',
    sen: '1406063162306072607',
    rep: '1406063176281358337',
    cabinet: '1429342639907668048',
  };
  const ROLE_NAMES = { gov: 'Governor', sen: 'Senator', rep: 'Representative', cabinet: 'Cabinet' };

  // Primary election role IDs (provided)
  const PRIMARY_ROLE_IDS = {
    class1: '1429342413893271674',
    class2: '1429342467303542907',
    class3: '1429342498848768112',
    repelect: '1429342520222941287',
    govelect: '1429342557053255690',
  };
  const PRIMARY_ROLE_NAMES = {
    class1: 'Senate Class 1 (Election)',
    class2: 'Senate Class 2 (Election)',
    class3: 'Senate Class 3 (Election)',
    repelect: 'House (Election)',
    govelect: 'Governor (Election)'
  };

  const REGION_ROLE_IDS = {
    west: '1408854788472573952',
    south: '1408854801202155520',
    northeast: '1408854812597944330',
    rust_belt: '1408854830486913157',
  };
  const REGION_NAMES = { west: 'West', south: 'South', northeast: 'Northeast', rust_belt: 'Rust Belt' };

  const updateStatus = async (message) => {
    if (useFollowUpForStatus) await interaction.followUp(message);
    else await interaction.editReply(message);
  };

  const me = await guild.members.fetchMe();
  if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    await updateStatus('Bot lacks Manage Roles permission to apply roles.');
    return;
  }

  await guild.members.fetch();
  await guild.roles.fetch();

  if (clearRoles) {
    const targets = Array.from(new Set([
      ...Object.values(ROLE_IDS).filter(Boolean),
      ...Object.values(REGION_ROLE_IDS).filter(Boolean),
    ]));
    await updateStatus('Clearing managed office and region roles...');
    let cleared = 0;
    let membersTouched = 0;
    for (const member of guild.members.cache.values()) {
      let memberCleared = 0;
      for (const rid of targets) {
        if (member.roles.cache.has(rid)) {
          try {
            await member.roles.remove(rid, 'Clear managed roles via /update clear');
            cleared++;
            memberCleared++;
          } catch (_) {}
        }
      }
      if (memberCleared > 0) membersTouched++;
    }
    await interaction.followUp(`Cleared ${cleared} managed roles across ${membersTouched} members.`);
    return;
  }

  const changeLogs = [];
  const partialOfflineWarnings = [];
  const offlineProfilesOver3 = [];
  const profileOfflineMap = new Map();

  const groups = new Map();
  for (const p of Object.values(profiles)) {
    const handle = (p.discord || '').toLowerCase();
    if (!handle) continue;
    let g = groups.get(handle);
    if (!g) {
      g = {
        ids: [],
        handle,
        office: new Set(),
        anyDem: false,
        anyGop: false,
        regions: new Set(),
        lastOnlineDays: null,
        lastOnlineText: null,
        offlineDetails: [],
      };
      groups.set(handle, g);
    }
    g.ids.push(p.id);
    if (/Democratic/i.test(p.party || '')) {
      g.anyDem = true;
      if (Array.isArray(p.rolesNeeded)) p.rolesNeeded.forEach((r) => g.office.add(r));
    }
    if (/Republican/i.test(p.party || '')) {
      g.anyGop = true;
    }
    if (p.region) g.regions.add(p.region);
    const los = typeof p.lastOnlineDays === 'number' ? p.lastOnlineDays : null;
    const losRounded = los !== null ? Math.floor(los) : null;
    if (los !== null) {
      if (g.lastOnlineDays === null || los < g.lastOnlineDays) {
        g.lastOnlineDays = los;
        g.lastOnlineText = p.lastOnlineText || null;
      }
      g.offlineDetails.push({
        id: p.id,
        name: p.name || null,
        lastOnlineDays: los,
        lastOnlineDaysRounded: losRounded,
        lastOnlineText: p.lastOnlineText || null,
      });
      const withinWarningWindow =
        losRounded !== null &&
        losRounded >= WARNING_THRESHOLD_DAYS &&
        losRounded <= 10;
      if (withinWarningWindow) {
        profileOfflineMap.set(p.id, {
          id: p.id,
          name: p.name || null,
          days: losRounded,
          text: p.lastOnlineText || null,
          handle,
        });
      }
    }
  }

  const rolesStart = Date.now();
  let applied = 0;
  let removed = 0;
  let skipped = 0;
  let matched = 0;

  for (const g of groups.values()) {
    const member = guild.members.cache.find((m) =>
      (m.user?.username?.toLowerCase?.() === g.handle) ||
      (m.displayName?.toLowerCase?.() === g.handle) ||
      (m.user?.globalName?.toLowerCase?.() === g.handle)
    );
    if (!member) {
      g.offlineDetails.forEach((d) => {
        const entry = profileOfflineMap.get(d.id);
        if (entry) offlineProfilesOver3.push(entry);
      });
      skipped++;
      continue;
    }
    matched++;

    if (g.anyGop) {
      for (const [key, roleId] of Object.entries(ROLE_IDS)) {
        if (member.roles.cache.has(roleId)) {
          try {
            await member.roles.remove(roleId, 'Republican profile present - remove managed office roles');
            removed++;
            changeLogs.push(`- ${ROLE_NAMES[key]} -> ${member.user?.tag || member.displayName} (profiles ${g.ids.join(',')}) [reason: Republican profile present]`);
          } catch (_) {}
        }
      }
      for (const [rk, rid] of Object.entries(REGION_ROLE_IDS)) {
        if (member.roles.cache.has(rid)) {
          try {
            await member.roles.remove(rid, 'Republican profile present - remove region roles');
            removed++;
            changeLogs.push(`- ${REGION_NAMES[rk]} Region -> ${member.user?.tag || member.displayName} (profiles ${g.ids.join(',')}) [reason: Republican profile present]`);
          } catch (_) {}
        }
      }
    } else {
      const desiredOffice = g.anyDem ? new Set(g.office) : new Set();
      for (const key of desiredOffice) {
        const roleId = ROLE_IDS[key];
        if (!roleId) continue;
        if (!member.roles.cache.has(roleId)) {
          try {
            await member.roles.add(roleId, 'Auto-assign via /update roles');
            applied++;
            changeLogs.push(`+ ${ROLE_NAMES[key]} -> ${member.user?.tag || member.displayName} (profiles ${g.ids.join(',')}) [reason: Democratic office requirement]`);
          } catch (_) {}
        }
      }
      for (const [key, roleId] of Object.entries(ROLE_IDS)) {
        if (member.roles.cache.has(roleId) && !desiredOffice.has(key)) {
          try {
            await member.roles.remove(roleId, 'Auto-remove via /update roles (not needed by any profile)');
            removed++;
            changeLogs.push(`- ${ROLE_NAMES[key]} -> ${member.user?.tag || member.displayName} (profiles ${g.ids.join(',')}) [reason: not needed by any profile]`);
          } catch (_) {}
        }
      }

      const desiredRegions = new Set(g.regions);
      for (const rk of desiredRegions) {
        const rid = REGION_ROLE_IDS[rk];
        if (rid && !member.roles.cache.has(rid)) {
          try {
            await member.roles.add(rid, 'Auto-assign region via /update roles');
            applied++;
            changeLogs.push(`+ ${REGION_NAMES[rk]} Region -> ${member.user?.tag || member.displayName} (profiles ${g.ids.join(',')}) [reason: profile region list includes ${rk}]`);
          } catch (_) {}
        }
      }
      for (const [rk, rid] of Object.entries(REGION_ROLE_IDS)) {
        if (member.roles.cache.has(rid) && !desiredRegions.has(rk)) {
          try {
            await member.roles.remove(rid, 'Auto-remove via /update roles (not needed by any profile)');
            removed++;
            changeLogs.push(`- ${REGION_NAMES[rk]} Region -> ${member.user?.tag || member.displayName} (profiles ${g.ids.join(',')}) [reason: not needed by any profile]`);
          } catch (_) {}
        }
      }

      // Sync election roles based on data/primaries.json and data/races.json (Democratic only)
      try {
        const fs = require('node:fs');
        const path = require('node:path');
        const primariesPath = path.join(process.cwd(), 'data', 'primaries.json');
        let userPrimaryKeys = new Set();
        if (fs.existsSync(primariesPath)) {
          const primariesDb = JSON.parse(fs.readFileSync(primariesPath, 'utf8'));
          const idx = primariesDb?.candidatesIndex || {};
          // For each PPUSA profile id tied to this Discord handle, gather desired primary roles
          for (const pid of g.ids) {
            const entries = idx[String(pid)] || [];
            for (const ent of entries) {
              // Only assign for Democratic primaries
              if (ent.party !== 'dem') continue;
              if (ent.race === 's1') userPrimaryKeys.add('class1');
              if (ent.race === 's2') userPrimaryKeys.add('class2');
              if (ent.race === 's3') userPrimaryKeys.add('class3');
              if (ent.race === 'rep') userPrimaryKeys.add('repelect');
              if (ent.race === 'gov') userPrimaryKeys.add('govelect');
            }
          }
        }

        // Also include active Democratic candidates from general races (data/races.json)
        const racesPath = path.join(process.cwd(), 'data', 'races.json');
        if (fs.existsSync(racesPath)) {
          try {
            const racesDb = JSON.parse(fs.readFileSync(racesPath, 'utf8'));
            const rIdx = racesDb?.candidatesIndex || {};
            for (const pid of g.ids) {
              const rEntries = rIdx[String(pid)] || [];
              for (const ent of rEntries) {
                // Only assign for active Democratic general races
                if (ent.party !== 'dem') continue;
                if (ent.status !== 'active') continue;
                if (ent.race === 's1') userPrimaryKeys.add('class1');
                if (ent.race === 's2') userPrimaryKeys.add('class2');
                if (ent.race === 's3') userPrimaryKeys.add('class3');
                if (ent.race === 'rep') userPrimaryKeys.add('repelect');
                if (ent.race === 'gov') userPrimaryKeys.add('govelect');
              }
            }
          } catch (_) {
            // ignore races parsing errors
          }
        }

        // Add missing primary roles
        for (const key of userPrimaryKeys) {
          const rid = PRIMARY_ROLE_IDS[key];
          if (!rid) continue;
          if (!member.roles.cache.has(rid)) {
            try {
              await member.roles.add(rid, 'Auto-assign primary election role via /update roles');
              applied++;
              changeLogs.push(`+ ${PRIMARY_ROLE_NAMES[key]} -> ${member.user?.tag || member.displayName} (profiles ${g.ids.join(',')}) [reason: active/in-progress primary]`);
            } catch (_) {}
          }
        }

        // Remove primary roles not desired
        for (const [key, rid] of Object.entries(PRIMARY_ROLE_IDS)) {
          if (member.roles.cache.has(rid) && !userPrimaryKeys.has(key)) {
            try {
              await member.roles.remove(rid, 'Auto-remove primary election role via /update roles (not in primary)');
              removed++;
              changeLogs.push(`- ${PRIMARY_ROLE_NAMES[key]} -> ${member.user?.tag || member.displayName} (profiles ${g.ids.join(',')}) [reason: not in current primary]`);
            } catch (_) {}
          }
        }
      } catch (_) {
        // ignore primary role sync errors
      }
    }

    // Remove activity warnings from role update output; only manage the inactive role silently
    const offlineDetails = g.offlineDetails;
    const totalWithData = offlineDetails.length;
    const over4Raw = offlineDetails.filter((d) => d.lastOnlineDays > OFFLINE_THRESHOLD_DAYS);
    const hasActivityData = totalWithData > 0;
    const allOver4 = totalWithData > 0 && over4Raw.length === totalWithData;

    if (INACTIVE_ROLE_ID) {
      const hasInactive = member.roles.cache.has(INACTIVE_ROLE_ID);
      const shouldBeInactive = g.anyDem && allOver4;
      if (shouldBeInactive && !hasInactive) {
        const referenceDetail = over4Raw[0] || offlineDetails[0];
        const reason = referenceDetail?.lastOnlineText
          ? `Last online ${referenceDetail.lastOnlineText}`
          : referenceDetail?.lastOnlineDays != null
            ? `Last online ${referenceDetail.lastOnlineDays} day(s) ago`
            : 'Last online status unknown';
        try {
          await member.roles.add(INACTIVE_ROLE_ID, 'Auto-assign inactivity role via /update roles');
          applied++;
          changeLogs.push(`+ Inactive -> ${member.user?.tag || member.displayName} (profiles ${g.ids.join(',')}) [reason: ${reason}]`);
        } catch (_) {}
      } else if ((!shouldBeInactive && hasInactive) || (!hasActivityData && hasInactive)) {
        try {
          await member.roles.remove(INACTIVE_ROLE_ID, 'Auto-remove inactivity role via /update roles');
          removed++;
          changeLogs.push(`- Inactive -> ${member.user?.tag || member.displayName} (profiles ${g.ids.join(',')}) [reason: recent activity detected]`);
        } catch (_) {}
      }
    }
  }

  const rolesSecs = Math.round((Date.now() - rolesStart) / 1000);
  const summary = `Role update completed in ${rolesSecs}s. Matched ${matched}, applied ${applied}, removed ${removed}, skipped ${skipped}.`;
  await interaction.followUp(summary);
  if (changeLogs.length) {
    const chunks = [];
    let buffer = [];
    let length = 0;
    for (const line of changeLogs) {
      const ln = line.length + 1;
      if (length + ln > 1800) {
        chunks.push(buffer.join('\n'));
        buffer = [];
        length = 0;
      }
      buffer.push(line);
      length += ln;
    }
    if (buffer.length) chunks.push(buffer.join('\n'));
    for (const chunk of chunks) {
      await interaction.followUp('```\n' + chunk + '\n```');
    }
  }

  // Removed activity warning follow-ups; dashboard provides these insights now
}

const MAX_CONSECUTIVE_MISSES = 20;
const DEFAULT_MAX_ID = Number(process.env.PPUSA_MAX_USER_ID || '0');
const DEFAULT_START_ID = Number(process.env.PPUSA_START_USER_ID || '1000');

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
    ),

  /**
   * Execute the /update command.
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
    const baseStartId = DEFAULT_START_ID > 0 ? DEFAULT_START_ID : 1;
    const newStartId = Math.max(maxKnownIdAll + 1, baseStartId);
    const effectiveNewStartId = DEFAULT_MAX_ID > 0 ? Math.min(newStartId, DEFAULT_MAX_ID) : newStartId;
    const typeSummaryLabel = updateType === 'new' ? 'New accounts' : `${typeLabel} + new accounts`;

    const start = Date.now();
    let found = 0;
    let checked = 0;
    let lastProgressAt = Date.now();

    // States mode: scrape state data (electoral votes, positions, officials)
    if (updateType === 'states') {
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
        
        await interaction.editReply(`Scraping state data for ${statesList.length} states...`);
        
        let scraped = 0;
        let skipped = 0;

        for (const state of statesList) {
          try {
            // Resolve state ID from the index
            const stateId = resolveStateIdFromIndex(statesIndexHtml, state.name);
            
            if (!stateId) {
              console.warn(`Could not resolve state ID for ${state.name}`);
              skipped++;
              continue;
            }

            // Navigate to state page
            const stateUrl = `${BASE}/states/${stateId}`;
            await page.goto(stateUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            const stateHtml = await page.content();
            
            // Parse state data
            const stateData = parseStateData(stateHtml, stateId);
            
            if (stateData) {
              statesDb.states[stateId] = stateData;
              scraped++;
              
              // Progress update every 10 states
              if (scraped % 10 === 0 || scraped === 1) {
                await interaction.editReply(
                  `Scraping state data... ${scraped}/${statesList.length} (Latest: ${stateData.name || state.name})`
                );
              }
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
        
        // Save backup
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = path.join(dataDir, `states.${stamp}.json`);
        try { fs.writeFileSync(backupPath, JSON.stringify(statesDb, null, 2)); } catch {}

        await interaction.editReply(
          `✅ State data update complete. Scraped ${scraped} states, skipped ${skipped}.\nSaved to: data/states.json`
        );
      } catch (err) {
        console.error('Error during state scraping:', err);
        await interaction.editReply(`❌ Error during state scraping: ${err?.message || String(err)}`);
      } finally {
        try { await page?.close(); } catch {}
      }
      return;
    }

    // Primaries mode: scrape all state primaries and persist to data/primaries.json
    if (updateType === 'primaries') {
      const dataDirPrim = path.join(process.cwd(), 'data');
      const primariesJsonPath = path.join(dataDirPrim, 'primaries.json');

      let browser, page;
      try {
        const statesList = getAllStatesList();
        const sess = await loginAndGet(`${BASE}/national/states`);
        browser = sess.browser;
        page = sess.page;
        try { page.setDefaultNavigationTimeout?.(15000); page.setDefaultTimeout?.(15000); } catch (_) {}

        const statesIndexHtml = await page.content();

        await interaction.editReply(`Scraping primaries for ${statesList.length} states...`);

        // Helper: locate race rows and party links/meta
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

        // Helper: parse candidates from primary page (capture userId + metrics)
        const extractPrimaryCandidates = (html) => {
          const $ = cheerio.load(html || '');
          const items = [];
          const pickMetrics = (txt) => {
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
          scope.find('.progress-wrapper').each((_, pw) => {
            const wrap = $(pw);
            const label = wrap.find('.progress-label a, .progress-label').first();
            const nameFull = (label.text() || '').replace(/\s+/g, ' ').trim();
            if (!nameFull) return;
            const link = wrap.find('a[href^="/users/"]').first();
            const href = link.attr('href') || '';
            const idMatch = href.match(/\/users\/(\d+)/);
            let name = nameFull;
            let metrics = pickMetrics(nameFull);
            const paren = nameFull.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
            if (paren) {
              name = paren[1].trim();
              metrics = { ...metrics, ...pickMetrics(paren[2]) };
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
              const metrics = pickMetrics(rowText);
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
            await page.goto(`${BASE}/states/${stateId}/primaries`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
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
                await page.goto(m.url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
                const partyHtml = await page.content();
                const parsed = extractPrimaryCandidates(partyHtml);
                racePages++;
                const candidates = parsed.items || [];

                // compute averages for active primaries
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
            if (scrapedStates % 10 === 0 || scrapedStates === 1) {
              await interaction.editReply(`Scraping primaries... ${scrapedStates}/${statesList.length} states (races fetched: ${racePages})`);
            }
          } catch (_) {
            // continue
          }
        }

        primariesDb.updatedAt = new Date().toISOString();
        fs.writeFileSync(primariesJsonPath, JSON.stringify(primariesDb, null, 2));
        try {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          fs.writeFileSync(path.join(dataDirPrim, `primaries.${stamp}.json`), JSON.stringify(primariesDb, null, 2));
        } catch (_) {}

        await interaction.editReply(`✅ Primaries update complete. States: ${scrapedStates}/${statesList.length}. Race pages fetched: ${racePages}. Saved to: data/primaries.json`);
      } catch (err) {
        console.error('Error during primaries scraping:', err);
        await interaction.editReply(`❌ Error during primaries scraping: ${err?.message || String(err)}`);
      } finally {
        try { await page?.close(); } catch {}
      }
      return;
    }

    // Races mode: scrape all state general races and persist to data/races.json
    if (updateType === 'races') {
      const dataDirRace = path.join(process.cwd(), 'data');
      const racesJsonPath = path.join(dataDirRace, 'races.json');

      let browser, page;
      try {
        const statesList = getAllStatesList();
        const sess = await loginAndGet(`${BASE}/national/states`);
        browser = sess.browser;
        page = sess.page;
        try { page.setDefaultNavigationTimeout?.(15000); page.setDefaultTimeout?.(15000); } catch (_) {}

        const statesIndexHtml = await page.content();

        await interaction.editReply(`Scraping races for ${statesList.length} states...`);

        // Helper: from /states/:id/elections find target race section and URL
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

        // Helper: extract candidates from race page (attempt to capture userId and party)
        const extractRaceCandidates = (html) => {
          const $ = cheerio.load(html || '');
          const items = [];
          const wrappers = $('#statewide-info .progress-wrapper, .progress-wrapper');
          wrappers.each((_, el) => {
            const wrap = $(el);
            const aUser = wrap.find('a[href^="/users/"]').first();
            const href = aUser.attr('href') || '';
            const idMatch = href.match(/\/users\/(\d+)/);
            const name = (wrap.find('.progress-label a .text-primary, .progress-label .text-primary, .progress-label').first().text() || '').replace(/\s+/g, ' ').trim();
            if (!name) return;
            let party = null;
            const partyNode = wrap.find('.progress-label span').filter((__, node) => /party/i.test($(node).text())).first();
            const partyText = (partyNode.text() || '').toLowerCase();
            if (/democrat/.test(partyText)) party = 'dem';
            else if (/republican/.test(partyText)) party = 'gop';
            let percent = null;
            const pctText = (wrap.find('.progress-percentage span').filter((__, node) => /%/.test($(node).text())).last().text() || '').trim();
            const mp = pctText.match(/([0-9]+(?:\.[0-9]+)?)/);
            if (mp) percent = Number(mp[1]);
            items.push({ userId: idMatch ? Number(idMatch[1]) : null, name, party, percent });
          });

          // Determine activity: if there are wrappers and no explicit "Final Results" header, treat as active
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
            await page.goto(`${BASE}/states/${stateId}/elections`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            const electionsHtml = await page.content();

            for (const race of races) {
              const meta = findRaceFromElections(electionsHtml, race.label);
              if (!meta?.url) continue;
              await page.goto(meta.url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
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
            if (scrapedStates % 10 === 0 || scrapedStates === 1) {
              await interaction.editReply(`Scraping races... ${scrapedStates}/${statesList.length} states (race pages fetched: ${racePages})`);
            }
          } catch (_) {
            // continue
          }
        }

        racesDb.updatedAt = new Date().toISOString();
        fs.writeFileSync(racesJsonPath, JSON.stringify(racesDb, null, 2));
        try {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          fs.writeFileSync(path.join(dataDirRace, `races.${stamp}.json`), JSON.stringify(racesDb, null, 2));
        } catch (_) {}

        await interaction.editReply(`✅ Races update complete. States: ${scrapedStates}/${statesList.length}. Race pages fetched: ${racePages}. Saved to: data/races.json`);
      } catch (err) {
        console.error('Error during races scraping:', err);
        await interaction.editReply(`❌ Error during races scraping: ${err?.message || String(err)}`);
      } finally {
        try { await page?.close(); } catch {}
      }
      return;
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

    // Scrape mode (no roles), build/update profiles.json
    let browser, page;
    try {
      const fallbackLoginId = allIds.length
        ? allIds[allIds.length - 1]
        : baseStartId;
      const loginSeed = existingTargetIds.length ? existingTargetIds[0] : fallbackLoginId;
      const loginId = Number.isFinite(loginSeed) && loginSeed > 0 ? loginSeed : baseStartId;
      const sess = await loginAndGet(`${BASE}/users/${loginId}`);
      browser = sess.browser;
      page = sess.page;

      await interaction.editReply(`Updating profiles (${typeSummaryLabel})...`);

      const maybeReportProgress = async (id, info) => {
        const now = Date.now();
        if (
          found === 1 ||
          (found % 25 === 0) ||
          (checked % 300 === 0) ||
          (now - lastProgressAt > 10_000)
        ) {
          writeDb();
          lastProgressAt = now;
          const latestName = info?.name || 'Unknown';
          await interaction.editReply(`Updating profiles (${typeSummaryLabel})... checked ${checked}, found ${found}. Latest: ${latestName} (id ${id})`);
        }
      };

      const scrapeId = async (id) => {
        checked++;
        let resp = null;
        try {
          resp = await page.goto(`${BASE}/users/${id}`, { waitUntil: 'networkidle2' });
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
        await maybeReportProgress(id, info);
        return { ok: true, info };
      };

      if (existingTargetIds.length) {
        for (const id of existingTargetIds) {
          await scrapeId(id);
        }
      }

      let consecutiveMisses = 0;
      if (effectiveNewStartId > 0) {
        let id = effectiveNewStartId;
        while (true) {
          if (DEFAULT_MAX_ID > 0 && id > DEFAULT_MAX_ID) break;
          const { ok } = await scrapeId(id);
          if (ok) {
            consecutiveMisses = 0;
          } else {
            consecutiveMisses++;
            if (DEFAULT_MAX_ID === 0 && consecutiveMisses >= MAX_CONSECUTIVE_MISSES) break;
          }
          id++;
        }
      }

      writeDb();
      // Save a timestamped backup
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(dataDir, `profiles.${stamp}.json`);
      try { fs.writeFileSync(backupPath, JSON.stringify(db, null, 2)); } catch {}
      const secs = Math.round((Date.now() - start) / 1000);
      await interaction.editReply(`Updated profiles.json (${typeSummaryLabel}). Checked ${checked}, found ${found}. Time: ${secs}s.`);

      // Activity warnings removed - dashboard provides these insights now

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
    } finally {
      try { await page?.close(); } catch {}
    }
  },
};
/**
 * Project: DemBot (Discord automation for Power Play USA)
 * File: commands/update.js
 * Purpose: Crawl player profiles and persist a local cache for fast lookup
 * Author: egg3901
 * Created: 2025-10-16
 * Last Updated: 2025-10-16
 *
 * Behavior:
 *   - Logs in once (using PPUSA_EMAIL / PPUSA_PASSWORD) and iterates user ids.
 *   - Starts at PPUSA_START_USER_ID (default 1000). Stops at PPUSA_MAX_USER_ID if set.
 *   - Early-stop when 20 consecutive non-profile pages are encountered.
 *   - Persists to data/profiles.json and writes a timestamped backup when finished.
 */


















