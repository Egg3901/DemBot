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
// Scanning behavior
const STOP_AFTER_CONSECUTIVE_MISSES = 150; // stop when this many in a row are missing
const SCAN_BATCH_SIZE = 25;
const SCAN_CONCURRENCY = 10;

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
        .setName('reset')
        .setDescription('Recreate profiles.json from scratch before updating')
        .setRequired(false)
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
    const doReset = interaction.options.getBoolean('reset') || false;
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

    let db = { updatedAt: new Date().toISOString(), profiles: {}, byDiscord: {}, meta: {} };
    if (fs.existsSync(jsonPath)) {
      try {
        const loaded = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        db = ensureDbShape(loaded);
        if (loaded && typeof loaded.meta === 'object') db.meta = loaded.meta;
      } catch {
        db = { updatedAt: new Date().toISOString(), profiles: {}, byDiscord: {}, meta: {} };
      }
    }
    db = ensureDbShape(db);
    if (!db.meta || typeof db.meta !== 'object') db.meta = {};
    if (!db.updatedAt) db.updatedAt = new Date().toISOString();

    // Ensure a file exists immediately so users can see it while crawling
    const writeDb = () => {
      const payload = { ...ensureDbShape(db), meta: db.meta || {}, updatedAt: new Date().toISOString() };
      fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
    };
    if (!fs.existsSync(jsonPath)) writeDb();

    // Optional reset flow: backup current DB (if any) and start fresh
    if (doReset) {
      try {
        if (fs.existsSync(jsonPath)) {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const backupPath = path.join(dataDir, `profiles.reset.${stamp}.json`);
          fs.renameSync(jsonPath, backupPath);
        }
      } catch {}
      db = { updatedAt: new Date().toISOString(), profiles: {}, byDiscord: {}, meta: { lastGoodProfileId: 0 } };
      // Persist the empty DB immediately
      fs.writeFileSync(jsonPath, JSON.stringify({ ...db, updatedAt: new Date().toISOString() }, null, 2));
      await interaction.editReply('profiles.json reset: starting full rescan from ID #1...');
    }

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
    const lastGood = Number(db.meta?.lastGoodProfileId) || 0;
    const baseStartId = 1;
    const newStartId = Math.max(maxKnownIdAll + 1, lastGood + 1, baseStartId);
    const effectiveNewStartId = newStartId;
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
      const loginSeed = (updateType === 'new' || updateType === 'all') ? effectiveNewStartId : (existingTargetIds[0] || fallbackLoginId);
      const loginId = Number.isFinite(loginSeed) && loginSeed > 0 ? loginSeed : baseStartId;
      
      session = await sessionManager.authenticateSession('update', `${BASE}/users/${loginId}`);

      await interaction.editReply(`Updating profiles (${typeSummaryLabel})...`);

      const processor = new ParallelProcessor({
        maxConcurrency: SCAN_CONCURRENCY,
        batchSize: SCAN_BATCH_SIZE,
        delayBetweenBatches: 150
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

      // Process new profiles (sequential scan) unless specifically limited to party-only updates
      const allowScanning = (updateType === 'all' || updateType === 'new');
      if (allowScanning && effectiveNewStartId > 0) {
        let nextId = effectiveNewStartId;
        let consecutiveMisses = 0;
        let highestGoodId = lastGood;

        const scanBatch = async (startId) => {
          const ids = [];
          for (let i = 0; i < SCAN_BATCH_SIZE; i++) ids.push(startId + i);
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
          const { results: batchResults } = await processor.processProfiles(ids, newProfileProcessor);
          return batchResults;
        };

        while (consecutiveMisses < STOP_AFTER_CONSECUTIVE_MISSES) {
          const batchResults = await scanBatch(nextId);
          let batchFound = 0;
          for (const r of batchResults) {
            checked += 1;
            if (r?.found) {
              found += 1;
              consecutiveMisses = 0;
              if (r.id > highestGoodId) highestGoodId = r.id;
            } else {
              consecutiveMisses += 1;
            }
          }
          batchFound = batchResults.filter(r => r?.found).length;
          if (batchFound > 0) {
            db.meta.lastGoodProfileId = highestGoodId;
            writeDb();
          }
          await interaction.editReply(`Scanning new profiles from #${effectiveNewStartId}... checked ${checked}, found ${found} (misses in a row: ${consecutiveMisses})`);
          nextId += SCAN_BATCH_SIZE;
          if (consecutiveMisses >= STOP_AFTER_CONSECUTIVE_MISSES) break;
        }
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
