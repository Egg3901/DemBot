// commands/update.js
const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');
const cheerio = require('cheerio');
const { loginAndGet, parseProfile, parseStateData, BASE } = require('../lib/ppusa');
const { canManageBot } = require('../lib/permissions');
const { ensureDbShape, mergeProfileRecord } = require('../lib/profile-cache');

// Inactive (offline) role and threshold (days)
const INACTIVE_ROLE_ID = '1427236595345522708';
const OFFLINE_THRESHOLD_DAYS = 4;
const WARNING_THRESHOLD_DAYS = 3;

const TYPE_CHOICES = new Set(['all', 'dems', 'gop', 'new', 'states', 'races', 'primaries']);
const TYPE_LABELS = {
  all: 'All Profiles',
  dems: 'Democratic Profiles',
  gop: 'Republican Profiles',
  new: 'New Accounts',
  states: 'State Data',
  races: 'Race Data',
  primaries: 'Primary Data',
};

/**
 * Detects blank or redirected pages that shouldn't be parsed.
 */
function isBlankOrRedirect(html = '', finalUrl = '') {
  try {
    const raw = String(html || '');
    // Very small pages or obvious blank wrappers
    if (raw.length < 400) return true;
    const text = raw.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
    const textLen = text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().length;
    if (textLen < 80) return true;
    // Meta refresh or JS redirects
    if (/http-equiv\s*=\s*["']refresh["']/i.test(raw)) return true;
    if (/window\.location\s*=|location\.href\s*=|location\.replace\(/i.test(raw)) return true;
    // Login or not-found redirects
    if (/\/login\b/i.test(finalUrl)) return true;
    if (/404|not\s*found/i.test(text)) return true;
  } catch (_) {}
  return false;
}

/**
 * Helper to force resource cleanup on a page
 */
async function clearPageResources(page) {
  try {
    // Clear cookies and cache to free memory
    const client = await page.target().createCDPSession();
    await client.send('Network.clearBrowserCookies');
    await client.send('Network.clearBrowserCache');
    await client.detach();
  } catch (err) {
    // Silently ignore errors - this is best-effort cleanup
  }
}

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
    }

    const offlineDetails = g.offlineDetails;
    const totalWithData = offlineDetails.length;
    const over4Raw = offlineDetails.filter((d) => d.lastOnlineDays > OFFLINE_THRESHOLD_DAYS);
    const hasActivityData = totalWithData > 0;
    const allOver4 = totalWithData > 0 && over4Raw.length === totalWithData;
    const warnableDetails = offlineDetails.filter((d) => {
      const rounded = d.lastOnlineDaysRounded;
      return rounded !== null && rounded <= 10;
    });
    const warnOver4 = warnableDetails.filter((d) => d.lastOnlineDaysRounded > OFFLINE_THRESHOLD_DAYS);
    const someOver4 = warnOver4.length > 0 && warnOver4.length < warnableDetails.length;
    const over3 = warnableDetails.filter((d) => d.lastOnlineDaysRounded >= WARNING_THRESHOLD_DAYS);
    over3.forEach((d) => {
      const entry = profileOfflineMap.get(d.id);
      if (entry) offlineProfilesOver3.push(entry);
    });

    if (someOver4) {
      partialOfflineWarnings.push({
        member: member.user?.tag || member.displayName,
        ids: warnOver4.map((d) => d.id),
        total: warnableDetails.length,
        count: warnOver4.length,
      });
    }

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

  const warningLines = [];
  if (partialOfflineWarnings.length) {
    partialOfflineWarnings.slice(0, 30).forEach((w) => {
      warningLines.push(`Partial inactivity: ${w.member} has ${w.count}/${w.total} linked profiles offline >${OFFLINE_THRESHOLD_DAYS} days (IDs: ${w.ids.join(', ')})`);
    });
    if (partialOfflineWarnings.length > 30) {
      warningLines.push(`...and ${partialOfflineWarnings.length - 30} more partial inactivity warnings.`);
    }
  }
  if (offlineProfilesOver3.length) {
    const uniqueOver3 = new Map();
    offlineProfilesOver3.forEach((entry) => {
      if (!uniqueOver3.has(entry.id)) uniqueOver3.set(entry.id, entry);
    });
    Array.from(uniqueOver3.values()).slice(0, 40).forEach((entry) => {
      warningLines.push(`Profile offline >${WARNING_THRESHOLD_DAYS} days: ${entry.name || `ID ${entry.id}`} (ID ${entry.id}) - ${entry.text || `${entry.days} days ago`}`);
    });
    if (uniqueOver3.size > 40) {
      warningLines.push(`...and ${uniqueOver3.size - 40} more offline profile warnings.`);
    }
  }
  if (warningLines.length) {
    const chunked = [];
    let bucket = [];
    let len = 0;
    for (const line of warningLines) {
      const addition = line.length + 1;
      if (len + addition > 1800) {
        chunked.push(bucket.join('\n'));
        bucket = [];
        len = 0;
      }
      bucket.push(line);
      len += addition;
    }
    if (bucket.length) chunked.push(bucket.join('\n'));
    for (const chunk of chunked) {
      await interaction.followUp(`Warnings:\n${chunk}`);
    }
  }
}

const MAX_CONSECUTIVE_MISSES = 20;
const DEFAULT_MAX_ID = Number(process.env.PPUSA_MAX_USER_ID || '0');
const DEFAULT_START_ID = Number(process.env.PPUSA_START_USER_ID || '1000');

/**
 * Scrape state data from all states
 */
async function scrapeStatesData(interaction, page, writeDb) {
  const statesData = {};
  let found = 0;
  let checked = 0;
  
  // Get state IDs from the states index page instead of hardcoded list
  await interaction.editReply('Getting states list...');

  let stateIds = [];

  try {
    // Use longer timeout and different wait strategy for the initial states page load
    await page.goto(`${BASE}/national/states`, { waitUntil: 'load', timeout: 20000 });
    await new Promise(resolve => setTimeout(resolve, 1000)); // Give it extra time to fully load
    const statesIndexHtml = await page.content();

    // Extract state IDs from the index page using improved logic from primary.js
    const cheerio = require('cheerio');
    const $ = cheerio.load(statesIndexHtml);

    $('a[href^="/states/"]').each((_, a) => {
      const href = String($(a).attr('href') || '');
      const m = href.match(/\/states\/(\d+)\b/);
      if (m) {
        const stateId = Number(m[1]);
        if (!stateIds.includes(stateId)) {
          stateIds.push(stateId);
        }
      }
    });

    if (stateIds.length === 0) {
      throw new Error('No states found on states index page');
    }
    
    // Sort state IDs for consistent processing
    stateIds.sort((a, b) => a - b);
  } catch (err) {
    console.error('Failed to load states index page:', err.message);
    // Fallback to a reasonable list of state IDs if the index page fails
    console.log('Using fallback state ID list');
    stateIds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40,
                41, 42, 43, 44, 45, 46, 47, 48, 49, 50];
  }

    await interaction.editReply(`Found ${stateIds.length} states. Starting scrape...`);

    // Process states in batches to avoid timeouts and resource exhaustion
    const batchSize = 5;
    const batches = [];
    for (let i = 0; i < stateIds.length; i += batchSize) {
      batches.push(stateIds.slice(i, i + batchSize));
    }

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      const batchStart = batchIndex * batchSize + 1;
      const batchEnd = Math.min((batchIndex + 1) * batchSize, stateIds.length);

      await interaction.editReply(`Scraping states ${batchStart}-${batchEnd} of ${stateIds.length}...`);

      for (const stateId of batch) {
        checked++;
        try {
          // Use improved loading options with better timeout handling
          const resp = await page.goto(`${BASE}/states/${stateId}`, {
            waitUntil: 'domcontentloaded',
            timeout: 12000  // Increased timeout for better reliability
          });
          
          const status = resp?.status?.() ?? 200;
          const finalUrl = page.url();
          
          const isStateUrl = /\/states\//i.test(finalUrl);
          if (status >= 400 || !isStateUrl) {
            console.log(`Skipping state ${stateId}: status ${status}, URL ${finalUrl}`);
            continue;
          }
          
          const html = await page.content();
          if (isBlankOrRedirect(html, finalUrl)) {
            console.log(`Skipping state ${stateId}: blank or redirect page`);
            continue;
          }
          
          const stateData = parseStateData(html);

          if (stateData && stateData.stateName) {
            statesData[stateId] = {
              id: stateId,
              ...stateData,
              scrapedAt: new Date().toISOString()
            };
            found++;
            
            // More frequent progress updates
            if (found % 3 === 0 || checked % 5 === 0) {
              await interaction.editReply(`Scraping state data... found ${found}/${stateIds.length} states. Latest: ${stateData.stateName} (${checked}/${stateIds.length} checked)`);
            }
          } else {
            console.log(`No valid state data found for state ${stateId}`);
          }
        } catch (err) {
          console.error(`Error scraping state ${stateId}:`, err?.message || err);
          // Continue with next state instead of failing completely
          // Add a small delay to prevent rapid-fire errors
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

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
  }
  
  // Final cleanup of the last page
  try {
    await clearPageResources(page);
  } catch (err) {
    console.warn('⚠️ Failed to clear final page resources:', err.message);
  }
  
  // Update the database with state data
  const dataDir = path.join(process.cwd(), 'data');
  const statesPath = path.join(dataDir, 'states.json');
  
  let existingStates = {};
  if (fs.existsSync(statesPath)) {
    try {
      existingStates = JSON.parse(fs.readFileSync(statesPath, 'utf8'));
    } catch (err) {
      console.error('Error reading existing states data:', err);
    }
  }
  
  const updatedStates = { ...existingStates, ...statesData };
  fs.writeFileSync(statesPath, JSON.stringify(updatedStates, null, 2));
  
  await interaction.editReply(`Scraped ${found}/${stateIds.length} states successfully (${checked} total checked).`);
}

/**
 * Scrape race data
 */
async function scrapeRacesData(interaction, page, writeDb) {
  await interaction.editReply('Scraping race data from all states...');

  // First, get the states index page to resolve state IDs
  let stateIds = [];

  try {
    await page.goto(`${BASE}/national/states`, { waitUntil: 'load', timeout: 20000 });
    await new Promise(resolve => setTimeout(resolve, 1000)); // Give it extra time to fully load
    const statesHtml = await page.content();

    // Extract all state IDs from the states index using improved logic from primary.js
    const $ = cheerio.load(statesHtml);

    $('a[href^="/states/"]').each((_, a) => {
      const href = String($(a).attr('href') || '');
      const m = href.match(/\/states\/(\d+)\b/);
      if (m) {
        const stateId = Number(m[1]);
        if (!stateIds.includes(stateId)) {
          stateIds.push(stateId);
        }
      }
    });

    if (stateIds.length === 0) {
      throw new Error('No states found on states index page');
    }
    
    // Sort state IDs for consistent processing
    stateIds.sort((a, b) => a - b);
  } catch (err) {
    console.error('Failed to load states index page for races:', err.message);
    // Fallback to a reasonable list of state IDs if the index page fails
    console.log('Using fallback state ID list for races');
    stateIds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
                21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40,
                41, 42, 43, 44, 45, 46, 47, 48, 49, 50];
  }

  let found = 0;
  let checked = 0;

  // Process states in batches to avoid timeouts and resource exhaustion
  const batchSize = 5;
  const batches = [];
  for (let i = 0; i < stateIds.length; i += batchSize) {
    batches.push(stateIds.slice(i, i + batchSize));
  }

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      const batchStart = batchIndex * batchSize + 1;
      const batchEnd = Math.min((batchIndex + 1) * batchSize, stateIds.length);

      await interaction.editReply(`Scraping races ${batchStart}-${batchEnd} of ${stateIds.length}...`);

      for (const stateId of batch) {
        checked++;
        try {
          // Go to state page first with better error handling
          await page.goto(`${BASE}/states/${stateId}`, { waitUntil: 'domcontentloaded', timeout: 12000 });
          await new Promise(resolve => setTimeout(resolve, 300)); // Brief pause

          // Then go to races page
          const resp = await page.goto(`${BASE}/states/${stateId}/races`, { waitUntil: 'domcontentloaded', timeout: 12000 });
          const status = resp?.status?.() ?? 200;
          const finalUrl = page.url();
          const html = await page.content();
          
          if (isBlankOrRedirect(html, finalUrl)) {
            console.log(`Skipping races for state ${stateId}: blank or redirect page`);
            continue;
          }

          const isRacesUrl = /\/races\b/i.test(finalUrl);
          if (status >= 400 || !isRacesUrl) {
            console.log(`Skipping races for state ${stateId}: status ${status}, URL ${finalUrl}`);
            continue;
          }

          // Parse races data from the page
          const racesData = parseRacesFromStatePage(html);
          if (racesData && Object.keys(racesData).length > 0) {
            // Update the database with races data
            const dataDir = path.join(process.cwd(), 'data');
            const racesPath = path.join(dataDir, 'races.json');

            let existingRaces = {};
            if (fs.existsSync(racesPath)) {
              try {
                existingRaces = JSON.parse(fs.readFileSync(racesPath, 'utf8'));
              } catch (err) {
                console.error('Error reading existing races data:', err);
              }
            }

            const updatedRaces = { ...existingRaces, ...racesData };
            fs.writeFileSync(racesPath, JSON.stringify(updatedRaces, null, 2));

            found++;

            // More frequent progress updates
            if (found % 3 === 0 || checked % 5 === 0) {
              await interaction.editReply(`Scraping race data... found data for ${found}/${stateIds.length} states. Latest: State ${stateId} (${checked}/${stateIds.length} checked)`);
            }
          } else {
            console.log(`No valid races data found for state ${stateId}`);
          }
        } catch (err) {
          console.error(`Error scraping races for state ${stateId}:`, err?.message || err);
          // Continue with next state instead of failing completely
          // Add a small delay to prevent rapid-fire errors
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

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
    }

  // Final cleanup of the last page
  try {
    await clearPageResources(page);
  } catch (err) {
    console.warn('⚠️ Failed to clear final page resources:', err.message);
  }

  await interaction.editReply(`Scraped race data for ${found}/${stateIds.length} states successfully (${checked} total checked).`);
}

/**
 * Parse races data from a state races page
 */
function parseRacesFromStatePage(html) {
  const $ = cheerio.load(html || '');

  const racesData = {};

  // Look for race sections - similar structure to primaries but for races
  $('h4').each((_, el) => {
    const header = $(el);
    const raceText = header.text().trim().toLowerCase();

    // Check if this is a race we care about
    const raceTypes = ['senate class 1', 'senate class 2', 'senate class 3', 'governor', 'house of representatives'];
    const matchedRace = raceTypes.find(race => raceText.includes(race.replace('class ', '')));

    if (matchedRace) {
      const raceKey = matchedRace.toLowerCase().replace(/\s+/g, '_');
      const container = header.closest('.container, .container-fluid, .bg-white');
      const table = container.find('table').first();

      if (table.length) {
        const raceData = { dem: null, gop: null };

        table.find('tbody tr').each((_, tr) => {
          const row = $(tr);
          const a = row.find('a[href*="/races/"]').first();
          if (a.length) {
            const href = a.attr('href') || '';
            const url = href.startsWith('http') ? href : new URL(href, BASE).toString();
            const tds = row.find('td');
            const partyText = (a.text() || '').toLowerCase();
            const statusText = (tds.eq(1).text() || '').replace(/\s+/g, ' ').trim() || null;

            const obj = { url, status: statusText };
            if (partyText.includes('democrat')) raceData.dem = obj;
            if (partyText.includes('republican')) raceData.gop = obj;
          }
        });

        if (raceData.dem || raceData.gop) {
          racesData[raceKey] = raceData;
        }
      }
    }
  });

  return Object.keys(racesData).length > 0 ? racesData : null;
}

/**
 * Scrape primary data
 */
async function scrapePrimariesData(interaction, page, writeDb) {
  const cheerio = require('cheerio');
  const { normalizeStateName, resolveStateIdFromIndex } = require('../lib/state-utils');

  await interaction.editReply('Scraping primary data from all states...');

  // First, get the states index page to resolve state IDs
  let stateIds = [];

  try {
    await page.goto(`${BASE}/national/states`, { waitUntil: 'load', timeout: 20000 });
    await new Promise(resolve => setTimeout(resolve, 1000)); // Give it extra time to fully load
    const statesHtml = await page.content();

    // Extract all state IDs from the states index using improved logic from primary.js
    const $ = cheerio.load(statesHtml);

    $('a[href^="/states/"]').each((_, a) => {
      const href = String($(a).attr('href') || '');
      const m = href.match(/\/states\/(\d+)\b/);
      if (m) {
        const stateId = Number(m[1]);
        if (!stateIds.includes(stateId)) {
          stateIds.push(stateId);
        }
      }
    });

    if (stateIds.length === 0) {
      throw new Error('No states found on states index page');
    }
    
    // Sort state IDs for consistent processing
    stateIds.sort((a, b) => a - b);
  } catch (err) {
    console.error('Failed to load states index page for primaries:', err.message);
    // Fallback to a reasonable list of state IDs if the index page fails
    console.log('Using fallback state ID list for primaries');
    stateIds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
                21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40,
                41, 42, 43, 44, 45, 46, 47, 48, 49, 50];
  }

  let found = 0;
  let checked = 0;

    // Process states in batches to avoid timeouts and resource exhaustion
    const batchSize = 5;
    const batches = [];
    for (let i = 0; i < stateIds.length; i += batchSize) {
      batches.push(stateIds.slice(i, i + batchSize));
    }

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      const batchStart = batchIndex * batchSize + 1;
      const batchEnd = Math.min((batchIndex + 1) * batchSize, stateIds.length);

      await interaction.editReply(`Scraping primaries ${batchStart}-${batchEnd} of ${stateIds.length}...`);

      for (const stateId of batch) {
        checked++;
        try {
          // Go to state page first with better error handling
          await page.goto(`${BASE}/states/${stateId}`, { waitUntil: 'domcontentloaded', timeout: 12000 });
          await new Promise(resolve => setTimeout(resolve, 300)); // Brief pause

          // Then go to primaries page
          const resp = await page.goto(`${BASE}/states/${stateId}/primaries`, { waitUntil: 'domcontentloaded', timeout: 12000 });
          const status = resp?.status?.() ?? 200;
          const finalUrl = page.url();
          const html = await page.content();
          
          if (isBlankOrRedirect(html, finalUrl)) {
            console.log(`Skipping primaries for state ${stateId}: blank or redirect page`);
            continue;
          }

          const isPrimariesUrl = /\/primaries\b/i.test(finalUrl);
          if (status >= 400 || !isPrimariesUrl) {
            console.log(`Skipping primaries for state ${stateId}: status ${status}, URL ${finalUrl}`);
            continue;
          }

          // Parse primaries data from the page
          const primariesData = parsePrimariesFromStatePage(html);
          if (primariesData && Object.keys(primariesData).length > 0) {
            // Update the database with primaries data
            const dataDir = path.join(process.cwd(), 'data');
            const primariesPath = path.join(dataDir, 'primaries.json');

            let existingPrimaries = {};
            if (fs.existsSync(primariesPath)) {
              try {
                existingPrimaries = JSON.parse(fs.readFileSync(primariesPath, 'utf8'));
              } catch (err) {
                console.error('Error reading existing primaries data:', err);
              }
            }

            const updatedPrimaries = { ...existingPrimaries, ...primariesData };
            fs.writeFileSync(primariesPath, JSON.stringify(updatedPrimaries, null, 2));

            found++;

            // More frequent progress updates
            if (found % 3 === 0 || checked % 5 === 0) {
              await interaction.editReply(`Scraping primary data... found data for ${found}/${stateIds.length} states. Latest: State ${stateId} (${checked}/${stateIds.length} checked)`);
            }
          } else {
            console.log(`No valid primaries data found for state ${stateId}`);
          }
        } catch (err) {
          console.error(`Error scraping primaries for state ${stateId}:`, err?.message || err);
          // Continue with next state instead of failing completely
          // Add a small delay to prevent rapid-fire errors
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

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
    }

  // Final cleanup of the last page
  try {
    await clearPageResources(page);
  } catch (err) {
    console.warn('⚠️ Failed to clear final page resources:', err.message);
  }

  await interaction.editReply(`Scraped primary data for ${found}/${stateIds.length} states successfully (${checked} total checked).`);
}

/**
 * Parse primaries data from a state primaries page
 */
function parsePrimariesFromStatePage(html) {
  const cheerio = require('cheerio');
  const $ = cheerio.load(html || '');

  const primariesData = {};

  // Look for race sections (similar to primary command)
  $('h4').each((_, el) => {
    const header = $(el);
    const raceText = header.text().trim().toLowerCase();

    // Check if this is a race we care about
    const raceTypes = ['senate class 1', 'senate class 2', 'senate class 3', 'governor', 'house of representatives'];
    const matchedRace = raceTypes.find(race => raceText.includes(race.replace('class ', '')));

    if (matchedRace) {
      const raceKey = matchedRace.toLowerCase().replace(/\s+/g, '_');
      const container = header.closest('.container, .container-fluid, .bg-white');
      const table = container.find('table').first();

      if (table.length) {
        const raceData = { dem: null, gop: null };

        table.find('tbody tr').each((_, tr) => {
          const row = $(tr);
          const a = row.find('a[href*="/primaries/"]').first();
          if (a.length) {
            const href = a.attr('href') || '';
            const url = href.startsWith('http') ? href : new URL(href, BASE).toString();
            const tds = row.find('td');
            const partyText = (a.text() || '').toLowerCase();
            const deadlineText = (tds.eq(1).text() || '').replace(/\s+/g, ' ').trim() || null;
            const countText = (tds.eq(2).text() || '').trim();
            const count = countText && /\d+/.test(countText) ? Number((countText.match(/\d+/) || [])[0]) : null;

            const obj = { url, deadline: deadlineText, count };
            if (partyText.includes('democrat')) raceData.dem = obj;
            if (partyText.includes('republican')) raceData.gop = obj;
          }
        });

        if (raceData.dem || raceData.gop) {
          primariesData[raceKey] = raceData;
        }
      }
    }
  });

  return Object.keys(primariesData).length > 0 ? primariesData : null;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('update')
    .setDescription('Crawl player profiles (id 1..max) and update profiles.json')
    .addStringOption((opt) =>
      opt
        .setName('type')
        .setDescription('Which data to refresh (profiles, states, races, or primaries)')
        .setRequired(false)
        .addChoices(
          { name: 'All profiles', value: 'all' },
          { name: 'Democrats', value: 'dems' },
          { name: 'Republicans', value: 'gop' },
          { name: 'New accounts only', value: 'new' },
          { name: 'State data', value: 'states' },
          { name: 'Race data', value: 'races' },
          { name: 'Primary data', value: 'primaries' },
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
    const scrapeOfflineWarnings = [];


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

    // Handle new command types (states, races, primaries)
    if (updateType === 'states' || updateType === 'races' || updateType === 'primaries') {
      await interaction.editReply(`Scraping ${typeLabel.toLowerCase()}...`);
      
      let browser, page;
      try {
        const sess = await loginAndGet(`${BASE}/`);
        browser = sess.browser;
        page = sess.page;

        if (updateType === 'states') {
          await scrapeStatesData(interaction, page, writeDb);
        } else if (updateType === 'races') {
          await scrapeRacesData(interaction, page, writeDb);
        } else if (updateType === 'primaries') {
          await scrapePrimariesData(interaction, page, writeDb);
        }

        const secs = Math.round((Date.now() - start) / 1000);
        await interaction.editReply(`Updated ${typeLabel.toLowerCase()} data. Time: ${secs}s.`);
        
      } catch (err) {
        try { await interaction.editReply(`Error during ${typeLabel.toLowerCase()} update: ${err?.message || String(err)}`); } catch {}
      } finally {
        try { await browser?.close(); } catch {}
      }
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
          resp = await page.goto(`${BASE}/users/${id}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
        } catch (_) {}
        const status = resp?.status?.() ?? 200;
        const finalUrl = page.url();
        const html = await page.content();
        const info = parseProfile(html);
        const isUserUrl = /\/users\//i.test(finalUrl);
        const isMiss = (status >= 400) || !isUserUrl || !info?.name;
        if (isMiss) return { ok: false };

        mergeProfileRecord(db, id, info);
        const los = typeof info.lastOnlineDays === 'number' ? info.lastOnlineDays : null;
        if (los !== null && los > WARNING_THRESHOLD_DAYS) {
          scrapeOfflineWarnings.push({
            id,
            name: info.name || null,
            days: los,
            text: info.lastOnlineText || null,
          });
        }
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

      if (scrapeOfflineWarnings.length) {
        const lines = [];
        scrapeOfflineWarnings.slice(0, 50).forEach((entry) => {
          lines.push(`Profile offline >${WARNING_THRESHOLD_DAYS} days: ${entry.name || `ID ${entry.id}`} (ID ${entry.id}) - ${entry.text || `${entry.days} days ago`}`);
        });
        if (scrapeOfflineWarnings.length > 50) {
          lines.push(`...and ${scrapeOfflineWarnings.length - 50} more offline profile warnings.`);
        }
        const chunked = [];
        let bucket = [];
        let len = 0;
        for (const line of lines) {
          const addition = line.length + 1;
          if (len + addition > 1800) {
            chunked.push(bucket.join("\n"));
            bucket = [];
            len = 0;
          }
          bucket.push(line);
          len += addition;
        }
        if (bucket.length) chunked.push(bucket.join("\n"));
        for (const chunk of chunked) {
          await interaction.followUp(`Warnings:\n${chunk}`);
        }
      }

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
      try { await browser?.close(); } catch {}
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


















