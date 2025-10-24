// commands/update.js
// Version: 2.0 - Enhanced with parallel processing and smart caching
const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');
const { parseProfile, BASE } = require('../lib/ppusa');
const cheerio = require('cheerio');
const { canManageBot } = require('../lib/permissions');
const { ensureDbShape, mergeProfileRecord } = require('../lib/profile-cache');
const { resolveStateIdFromIndex } = require('../lib/state-utils');
const { parseStateData, getAllStatesList } = require('../lib/state-scraper');
const { sessionManager } = require('../lib/session-manager');
const { ParallelProcessor } = require('../lib/parallel-processor');
const { smartCache } = require('../lib/smart-cache');
const { performRoleSync } = require('../lib/role-sync');
const { navigateWithSession } = require('../lib/ppusa-auth-optimized');

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

// Scan configuration (align with cron-service defaults)
const START_USER_ID = Number(process.env.PPUSA_START_USER_ID || '1');
const MAX_USER_ID = Number(process.env.PPUSA_MAX_USER_ID || '0'); // 0 = no cap
const MAX_NEW_PROFILES = Number(process.env.PPUSA_MAX_NEW_PROFILES || '500');
const MAX_CONSECUTIVE_MISSES = 20;
const MAX_IDS_PER_RUN = Number(process.env.PPUSA_MAX_IDS_PER_RUN || '1000');

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
    const baseStartId = START_USER_ID > 0 ? START_USER_ID : 1;
    const newStartId = Math.max(maxKnownIdAll + 1, baseStartId);
    const effectiveNewStartId = MAX_USER_ID > 0 ? Math.min(newStartId, MAX_USER_ID) : newStartId;
    const typeSummaryLabel = updateType === 'new' ? 'New accounts' : `${typeLabel} + new accounts`;

    const start = Date.now();
    let found = 0;
    let checked = 0;

    // Handle special update types (states, primaries, races)
    if (['states', 'primaries', 'races'].includes(updateType)) {
      // These would be handled similarly to the original but with parallel processing
      await interaction.editReply(`${updateType} update not yet optimized - use original /update command`);
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

    // Scrape mode (no roles), build/update profiles.json with parallel processing
    let session = null;
    try {
      const fallbackLoginId = allIds.length ? allIds[allIds.length - 1] : baseStartId;
      const loginSeed = existingTargetIds.length ? existingTargetIds[0] : fallbackLoginId;
      const loginId = Number.isFinite(loginSeed) && loginSeed > 0 ? loginSeed : baseStartId;
      
      session = await sessionManager.authenticateSession('update', `${BASE}/users/${loginId}`);

      await interaction.editReply(`Updating profiles (${typeSummaryLabel})...`);

      const processor = new ParallelProcessor({
        maxConcurrency: 12,
        batchSize: 20,
        delayBetweenBatches: 200
      });

      // Process existing profiles first
      if (existingTargetIds.length > 0) {
        const profileProcessor = async (profileId) => {
          try {
            const targetUrl = `${BASE}/users/${profileId}`;
            const result = await navigateWithSession(session, targetUrl, 'networkidle2');
            const info = parseProfile(result.html);
            
            if (info?.name) {
              mergeProfileRecord(db, profileId, info);
              return { id: profileId, found: true, info };
            }
            
            return { id: profileId, found: false };
          } catch (error) {
            console.error(`Error processing profile ${profileId}:`, error.message);
            return { id: profileId, found: false, error: error.message };
          }
        };

        const { results, errors } = await processor.processProfiles(existingTargetIds, profileProcessor, {
          onProgress: (processed, total) => {
            if (processed % 5 === 0 || processed === total) {
              const foundCount = results.filter(r => r?.found).length;
              interaction.editReply(`Updating profiles (${typeSummaryLabel})... ${processed}/${total} processed, ${foundCount} found`);
            }
          }
        });

        found += results.filter(r => r?.found).length;
        checked += results.length;
      }

      // Process new profiles (discovery loop similar to cron)
      if (effectiveNewStartId > 0) {
        let id = effectiveNewStartId;
        let newProfilesFound = 0;
        let consecutiveMisses = 0; // legacy counter
        let consecutiveMissIds = 0; // strict per-ID counter
        let scannedIds = 0;
        const rangeStart = id;
        let stopReason = null;
        const NEW_PROFILE_BATCH_SIZE = 20;

        const newProfileProcessor = async (profileId) => {
          try {
            const targetUrl = `${BASE}/users/${profileId}`;
            const result = await navigateWithSession(session, targetUrl, 'networkidle2');
            const info = parseProfile(result.html);
            if (info?.name) {
              mergeProfileRecord(db, profileId, info);
              return { id: profileId, found: true, info };
            }
            return { id: profileId, found: false };
          } catch (error) {
            return { id: profileId, found: false, error: error.message };
          }
        };

        while (true) {
          if (MAX_USER_ID > 0 && id > MAX_USER_ID) { stopReason = 'max_user_id'; break; }
          if (newProfilesFound >= Math.max(1, MAX_NEW_PROFILES)) { stopReason = 'max_new_profiles'; break; }

          const batchEnd = Math.min(id + NEW_PROFILE_BATCH_SIZE, MAX_USER_ID > 0 ? MAX_USER_ID + 1 : id + NEW_PROFILE_BATCH_SIZE);
          const batchIds = [];
          for (let batchId = id; batchId < batchEnd; batchId++) batchIds.push(batchId);

          const { results: batchResults } = await processor.processProfiles(batchIds, newProfileProcessor);
          checked += batchResults.length;

          // Walk through IDs in order to compute per-ID consecutive misses
          const byId = new Map(batchIds.map((bid, i) => [bid, batchResults[i]]));
          let batchFound = 0;
          let shouldStop = false;
          for (let cur = id; cur < batchEnd; cur++) {
            const r = byId.get(cur);
            const hit = !!(r && r.found);
            scannedIds++;
            if (hit) {
              consecutiveMisses = 0; consecutiveMissIds = 0; batchFound++; found++; newProfilesFound++;
            } else {
              consecutiveMisses++; consecutiveMissIds++;
            }
            if (newProfilesFound >= Math.max(1, MAX_NEW_PROFILES)) { stopReason = 'max_new_profiles'; shouldStop = true; break; }
            if (consecutiveMissIds >= MAX_CONSECUTIVE_MISSES) { stopReason = 'consecutive_misses'; shouldStop = true; break; }
            if (scannedIds >= MAX_IDS_PER_RUN) { stopReason = 'max_ids_per_run'; shouldStop = true; break; }
          }

          await interaction.editReply(`Scanning new profiles... checked ${checked}, found ${found} (new ${newProfilesFound})`);
          id = batchEnd;
          if (batchFound === 0 && consecutiveMisses >= MAX_CONSECUTIVE_MISSES) { stopReason = stopReason || 'legacy_consecutive_misses'; break; }
          if (shouldStop) break;
        }

        console.log(`Discovery summary (/update): rangeStart=${rangeStart}, lastTriedId=${id - 1}, scanned=${scannedIds}, newFound=${newProfilesFound}, stopReason=${stopReason || 'loop_end'}`);
      }

      writeDb();
      
      // Save a timestamped backup
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(dataDir, `profiles.${stamp}.json`);
      try { fs.writeFileSync(backupPath, JSON.stringify(db, null, 2)); } catch {}
      
      const secs = Math.round((Date.now() - start) / 1000);
      await interaction.editReply(`Updated profiles.json (${typeSummaryLabel}). Checked ${checked}, found ${found}. Time: ${secs}s.`);

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
