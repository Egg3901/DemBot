// commands/profile.js
// Version: 2.0 - Enhanced with parallel processing and smart caching
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { parseProfile, BASE } = require('../lib/ppusa');
const { loadProfileDb, writeProfileDb, mergeProfileRecord, cleanupDatabase } = require('../lib/profile-cache');
const { recordCommandDebug } = require('../lib/status-tracker');
const { sessionManager } = require('../lib/session-manager');
const { ParallelProcessor } = require('../lib/parallel-processor');
const { smartCache, SmartCache } = require('../lib/smart-cache');
const { navigateWithSession } = require('../lib/ppusa-auth-optimized');

// Log channel ID for debug information
const LOG_CHANNEL_ID = '1430939330406383688';

// Helper function to log debug information to Discord channel and status tracker
async function logDebugToChannel(client, message, error = false) {
  try {
    // Log to status tracker for API visibility
    recordCommandDebug('profile', message, {
      source: 'debug',
      isError: error,
      timestamp: new Date().toISOString()
    });

    if (!client || !client.isReady()) {
      console.log('Discord client not ready, skipping channel log');
      return;
    }

    const channel = await client.channels.fetch(LOG_CHANNEL_ID);
    const timestamp = new Date().toISOString();
    const prefix = error ? '❌' : '🔍';
    const content = `${prefix} **Profile Debug** [${timestamp}]\n${message}`;

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
    console.error('Failed to log debug info to Discord channel:', err);
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('profile')
    .setDescription('Show Power Play USA profiles - all profiles or specific user lookup')
    .addUserOption(opt =>
      opt.setName('user')
        .setDescription('Discord user to look up (optional - shows all if not specified)')
        .setRequired(false)
    )
    .addStringOption(opt =>
      opt.setName('query')
        .setDescription('Profile name, Discord username, mention, or numeric id (optional)')
        .setRequired(false)
    )
    .addIntegerOption(opt =>
      opt.setName('page')
        .setDescription('Page number for all profiles view (default: 1)')
        .setRequired(false)
        .setMinValue(1)
    )
    .addStringOption(opt =>
      opt.setName('sort')
        .setDescription('Sort by: name, cash, es, party, state, position')
        .setRequired(false)
        .addChoices(
          { name: 'Name', value: 'name' },
          { name: 'Cash', value: 'cash' },
          { name: 'ES', value: 'es' },
          { name: 'Party', value: 'party' },
          { name: 'State', value: 'state' },
          { name: 'Position', value: 'position' }
        )
    )
    .addBooleanOption(opt =>
      opt.setName('cleanup')
        .setDescription('Clean up duplicate profiles in database (admin only)')
        .setRequired(false)
    ),

  /**
   * Execute the /profile command with optimizations
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @returns {Promise<void>}
   */
  async execute(interaction) {
    try {
      await interaction.deferReply();

      const discordUser = interaction.options.getUser('user');
      const queryRaw = (interaction.options.getString('query') || '').trim();
      const page = interaction.options.getInteger('page') || 1;
      const sortBy = interaction.options.getString('sort') || 'name';
      const shouldCleanup = interaction.options.getBoolean('cleanup') || false;

      const debugInfo = `discordUser: ${discordUser?.username || 'none'}, queryRaw: "${queryRaw}", page: ${page}, sortBy: ${sortBy}, cleanup: ${shouldCleanup}`;
      console.log(`[Profile Command Debug] ${debugInfo}`);
      await logDebugToChannel(interaction.client, debugInfo);

      // Handle database cleanup if requested
      if (shouldCleanup) {
        try {
          const { duplicatesRemoved } = cleanupDatabase();
          const message = duplicatesRemoved > 0 
            ? `✅ Database cleanup completed! Removed ${duplicatesRemoved} duplicate profiles.`
            : `✅ Database cleanup completed! No duplicates found.`;
          
          await interaction.editReply(message);
          return;
        } catch (error) {
          console.error('Database cleanup failed:', error);
          await interaction.editReply(`❌ Database cleanup failed: ${error.message}`);
          return;
        }
      }

      // If user or query provided, do specific lookup
      if (discordUser || queryRaw) {
        console.log(`[Profile Command Debug] Going to lookupSpecificProfile`);
        await logDebugToChannel(interaction.client, 'Going to lookupSpecificProfile');
        return this.lookupSpecificProfile(interaction, discordUser, queryRaw);
      }

      // Show all profiles with pagination
      console.log(`[Profile Command Debug] Going to showAllProfiles`);
      await logDebugToChannel(interaction.client, 'Going to showAllProfiles');
      return this.showAllProfiles(interaction, page, sortBy);
    } catch (error) {
      console.error('Profile command execute error:', error);
      await reportCommandError(interaction, error, {
        message: `Profile command failed: ${error.message}`,
        meta: {
          step: 'execute',
          discordUser: interaction.options.getUser('user')?.username,
          query: interaction.options.getString('query'),
          page: interaction.options.getInteger('page'),
          sortBy: interaction.options.getString('sort')
        }
      });
    }
  },

  async lookupSpecificProfile(interaction, discordUser, queryRaw) {
    try {
      const { db, jsonPath } = loadProfileDb();
      const profiles = db.profiles || {};
      const byDiscord = db.byDiscord || {};
      let dbDirty = false;

    // Debug: Check what file is being loaded
    const fs = require('fs');
    const fileExists = fs.existsSync(jsonPath);
    const fileStats = fileExists ? fs.statSync(jsonPath) : null;
    const fileSize = fileStats ? fileStats.size : 0;
    const fileModified = fileStats ? fileStats.mtime.toISOString() : 'N/A';
    
    console.log(`[Profile Command Debug] Loading from: ${jsonPath}`);
    console.log(`[Profile Command Debug] File exists: ${fileExists}, size: ${fileSize}, modified: ${fileModified}`);
    await logDebugToChannel(interaction.client, `Loading from: ${jsonPath} | File exists: ${fileExists}, size: ${fileSize}, modified: ${fileModified}`);

    // Debug: Check if we can find egg3901 in the loaded data
    const debugEgg3901 = [];
    debugEgg3901.push(`Loaded profiles count: ${Object.keys(profiles).length}`);
    debugEgg3901.push(`Loaded byDiscord count: ${Object.keys(byDiscord).length}`);
    debugEgg3901.push(`Direct byDiscord['egg3901']: ${JSON.stringify(byDiscord['egg3901'])}`);
    
    // Check specific profile IDs that should have egg3901
    const expectedIds = [1157, 1240, 1241];
    for (const id of expectedIds) {
      const profile = profiles[id];
      if (profile) {
        debugEgg3901.push(`Profile ${id}: discord="${profile.discord}", name="${profile.name}"`);
      } else {
        debugEgg3901.push(`Profile ${id}: NOT FOUND`);
      }
    }
    
    console.log(`[Profile Command Debug] Database loading debug: ${debugEgg3901.join(' | ')}`);
    await logDebugToChannel(interaction.client, `Database loading debug: ${debugEgg3901.join(' | ')}`);

    const debugInfo = [];
    const totalProfiles = Object.keys(profiles).length;
    const validProfileCount = Object.values(profiles).filter(p => p && typeof p === 'object').length;
    debugInfo.push(`Database stats: ${validProfileCount} valid profiles (${totalProfiles} total entries), ${Object.keys(byDiscord).length} Discord entries`);
    debugInfo.push(`Sample byDiscord entries: ${Object.keys(byDiscord).slice(0, 5).join(', ')}`);
    
    // Check if egg3901 exists in byDiscord index
    const egg3901InIndex = byDiscord['egg3901'];
    debugInfo.push(`egg3901 in byDiscord: ${JSON.stringify(egg3901InIndex)}`);
    
    // Check if egg3901 exists in profiles
    const egg3901Profiles = Object.entries(profiles).filter(([pid, info]) => 
      info && typeof info === 'object' && (info.discord || '').toLowerCase() === 'egg3901'
    );
    debugInfo.push(`egg3901 in profiles: ${egg3901Profiles.length} matches`);
    if (egg3901Profiles.length > 0) {
      debugInfo.push(`egg3901 profile details: ${JSON.stringify(egg3901Profiles.map(([pid, info]) => ({ id: pid, discord: info.discord, name: info.name })))}`);
    } else {
      // Look for similar Discord usernames
      const similarDiscords = Object.entries(profiles)
        .filter(([pid, info]) => info && typeof info === 'object' && info.discord)
        .map(([pid, info]) => info.discord.toLowerCase())
        .filter(discord => discord.includes('egg') || discord.includes('3901'))
        .slice(0, 10);
      if (similarDiscords.length > 0) {
        debugInfo.push(`Similar Discord usernames found: ${similarDiscords.join(', ')}`);
      }
      
      // Check for exact case variations
      const exactMatches = Object.entries(profiles)
        .filter(([pid, info]) => info && typeof info === 'object' && info.discord)
        .filter(([pid, info]) => info.discord.toLowerCase() === 'egg3901')
        .map(([pid, info]) => ({ id: pid, discord: info.discord, name: info.name }));
      if (exactMatches.length > 0) {
        debugInfo.push(`Exact matches (case variations): ${JSON.stringify(exactMatches)}`);
      }
    }
    
    console.log(`[Profile Command Debug] ${debugInfo.join(' | ')}`);
    await logDebugToChannel(interaction.client, debugInfo.join(' | '));

    const idSet = new Set();

    const addIds = (value) => {
      const addOne = (v) => {
        const num = typeof v === 'number' ? v : Number(v);
        if (!Number.isNaN(num)) idSet.add(num);
      };
      if (Array.isArray(value)) value.forEach(addOne);
      else addOne(value);
    };

    const lookupDiscord = async (name) => {
      if (!name) return;
      const key = name.toLowerCase();
      const lookupMsg = `Looking up Discord: "${name}" -> key: "${key}"`;
      console.log(`[Profile Command Debug] ${lookupMsg}`);
      debugInfo.push(lookupMsg);
      await logDebugToChannel(interaction.client, lookupMsg);
      
      if (byDiscord[key]) {
        const foundMsg = `Found in byDiscord index: ${JSON.stringify(byDiscord[key])}`;
        console.log(`[Profile Command Debug] ${foundMsg}`);
        debugInfo.push(foundMsg);
        await logDebugToChannel(interaction.client, foundMsg);
        addIds(byDiscord[key]);
      } else {
        const notFoundMsg = `Not in byDiscord index, searching profiles...`;
        console.log(`[Profile Command Debug] ${notFoundMsg}`);
        debugInfo.push(notFoundMsg);
        await logDebugToChannel(interaction.client, notFoundMsg);
        
        let found = false;
        let searchCount = 0;
        let validProfileCount = 0;
        
        for (const [pid, info] of Object.entries(profiles)) {
          searchCount++;
          
          // Skip null/undefined profiles
          if (!info || typeof info !== 'object') {
            continue;
          }
          
          validProfileCount++;
          const profileDiscord = (info.discord || '').toLowerCase();
          if (profileDiscord === key) {
            const profileFoundMsg = `Found in profiles: ID ${pid}, Discord: "${info.discord}"`;
            console.log(`[Profile Command Debug] ${profileFoundMsg}`);
            debugInfo.push(profileFoundMsg);
            await logDebugToChannel(interaction.client, profileFoundMsg);
            addIds(Number(pid));
            found = true;
          }
        }
        
        // Log search statistics
        const searchStats = `Searched ${validProfileCount} valid profiles (${searchCount} total entries) for key "${key}", found: ${found}`;
        console.log(`[Profile Command Debug] ${searchStats}`);
        debugInfo.push(searchStats);
        await logDebugToChannel(interaction.client, searchStats);
        if (!found) {
          const noMatchMsg = `No matching Discord found in profiles`;
          console.log(`[Profile Command Debug] ${noMatchMsg}`);
          debugInfo.push(noMatchMsg);
          await logDebugToChannel(interaction.client, noMatchMsg);
        }
      }
    };

    if (discordUser) {
      const userObj = {
        username: discordUser.username,
        discriminator: discordUser.discriminator,
        globalName: discordUser.globalName,
        id: discordUser.id
      };
      console.log(`[Profile Command Debug] Discord user object:`, userObj);
      debugInfo.push(`Discord user: ${JSON.stringify(userObj)}`);
      await logDebugToChannel(interaction.client, `Discord user: ${JSON.stringify(userObj)}`);
      
      await lookupDiscord(discordUser.username);
      if (discordUser.discriminator && discordUser.discriminator !== '0') {
        await lookupDiscord(`${discordUser.username}#${discordUser.discriminator}`);
      }
      if (discordUser.globalName) await lookupDiscord(discordUser.globalName);
    }

    const handleQuery = async () => {
      if (!queryRaw) return;
      const mentionMatch = queryRaw.match(/^<@!?([0-9]{5,})>$/);
      if (mentionMatch) {
        try {
          const fetched = await interaction.client.users.fetch(mentionMatch[1]);
          if (fetched) {
            await lookupDiscord(fetched.username);
            if (fetched.discriminator && fetched.discriminator !== '0') {
              await lookupDiscord(`${fetched.username}#${fetched.discriminator}`);
            }
            if (fetched.globalName) await lookupDiscord(fetched.globalName);
          }
        } catch (_) {}
        return;
      }

      const plain = queryRaw.replace(/^@/, '').trim();

      if (/^\d+$/.test(plain)) {
        addIds(Number(plain));
        return;
      }

      await lookupDiscord(plain);
      if (idSet.size) return;

      const nameNorm = plain.toLowerCase();
      const exact = Object.entries(profiles)
        .filter(([, info]) => (info.name || '').toLowerCase() === nameNorm)
        .map(([pid]) => Number(pid));
      exact.forEach(addIds);
      if (idSet.size) return;

      const partial = Object.entries(profiles)
        .filter(([, info]) => (info.name || '').toLowerCase().includes(nameNorm))
        .slice(0, 10)
        .map(([pid]) => Number(pid));
      partial.forEach(addIds);
    };

    await handleQuery();

    const ids = Array.from(idSet).slice(0, 10);
    const resultMsg = `Found ${ids.length} profile IDs: ${ids.join(', ')}`;
    console.log(`[Profile Command Debug] ${resultMsg}`);
    await logDebugToChannel(interaction.client, resultMsg);
    
    if (ids.length === 0) {
      const label = discordUser ? `Discord user "${discordUser.username}"` : `"${queryRaw}"`;
      const debugText = debugInfo.length > 0 ? `\n\n**Debug Info:**\n\`\`\`\n${debugInfo.join('\n')}\`\`\`` : '';
      await logDebugToChannel(interaction.client, `No profile found for ${label}`, true);
      return interaction.editReply(`No profile found for ${label}. Try /update to refresh the cache.${debugText}`);
    }

    // Check cache first
    const cachedProfiles = [];
    const uncachedIds = [];

    for (const id of ids) {
      const cacheKey = SmartCache.createProfileKey(id);
      const cached = smartCache.get(cacheKey);
      if (cached) {
        cachedProfiles.push({ id, ...cached });
      } else {
        uncachedIds.push(id);
      }
    }

    // Process uncached profiles in parallel
    let freshProfiles = [];
    if (uncachedIds.length > 0) {
      try {
        const session = await sessionManager.authenticateSession('profile', `${BASE}/users/${uncachedIds[0]}`);
        const processor = new ParallelProcessor({ maxConcurrency: 8, batchSize: 10 });

        const profileProcessor = async (profileId) => {
          try {
            const targetUrl = `${BASE}/users/${profileId}`;
            const result = await navigateWithSession(session, targetUrl, 'networkidle2');
            const info = parseProfile(result.html);

            // Cache the result
            const cacheKey = SmartCache.createProfileKey(profileId);
            smartCache.set(cacheKey, info, 10 * 60 * 1000); // 10 minutes TTL

            return { id: profileId, ...info };
          } catch (error) {
            console.error(`Error processing profile ${profileId}:`, error.message);
            return null;
          }
        };

        const { results } = await processor.processProfiles(uncachedIds, profileProcessor, {
          onProgress: (processed, total) => {
            if (processed % 2 === 0 || processed === total) {
              interaction.editReply(`Loading profiles... ${processed}/${total}`);
            }
          }
        });

        freshProfiles = results.filter(Boolean);
      } catch (error) {
        console.error('Error in parallel processing:', error);
        await reportCommandError(interaction, error, {
          message: `Error fetching profiles: ${error.message}`,
          meta: {
            step: 'parallelProcessing',
            uncachedIds: uncachedIds.length,
            discordUser: discordUser?.username,
            query: queryRaw
          }
        });
        return;
      }
    }

    // Combine cached and fresh profiles
    const allProfiles = [...cachedProfiles, ...freshProfiles];

    // Update database with fresh profiles
    try {
      for (const profile of freshProfiles) {
        mergeProfileRecord(db, profile.id, profile);
        dbDirty = true;
      }
    } catch (error) {
      console.error('Error updating database with fresh profiles:', error);
      await reportCommandError(interaction, error, {
        message: `Error updating database: ${error.message}`,
        meta: {
          step: 'databaseUpdate',
          freshProfilesCount: freshProfiles.length,
          discordUser: discordUser?.username,
          query: queryRaw
        }
      });
    }

    // Build embeds with enhanced validation
    console.log(`[Profile Command Debug] Processing ${allProfiles.length} profiles for display`);
    const validProfiles = allProfiles.filter((profile) => {
      if (!profile.name || /login/i.test(profile.name) || profile.name === 'Power Play USA' || profile.name.length < 2) {
        console.log(`[Profile Command] Skipping invalid profile: ${JSON.stringify(profile)}`);
        return false;
      }
      return true;
    });

    // If multiple profiles found, paginate one profile per page
    if (validProfiles.length > 1) {
      const idsJoined = validProfiles.map((p) => p.id).join('-');
      const pageNum = 1;

      const renderOne = (profile, extraDebug) => {
        const fields = [];
        if (profile.discord) fields.push({ name: 'Discord', value: profile.discord, inline: true });
        if (profile.party) fields.push({ name: 'Party', value: profile.party, inline: true });
        if (profile.state) fields.push({ name: 'State', value: profile.state, inline: true });
        if (profile.position) fields.push({ name: 'Position', value: profile.position, inline: true });
        if (profile.es) fields.push({ name: 'ES', value: String(profile.es), inline: true });
        if (profile.co) fields.push({ name: 'CO', value: String(profile.co), inline: true });
        if (profile.nr) fields.push({ name: 'NR', value: String(profile.nr), inline: true });
        if (profile.cash) fields.push({ name: '$', value: profile.cash, inline: true });
        if (profile.accountAge) fields.push({ name: 'Account Age', value: profile.accountAge, inline: true });

        const embed = new EmbedBuilder()
          .setTitle(`${profile.name} (ID ${profile.id})`)
          .setURL(`${BASE}/users/${profile.id}`)
          .setColor(0x3b82f6)
          .setFooter({ text: new URL(BASE).hostname })
          .setTimestamp();
        if (profile.avatar) embed.setThumbnail(profile.avatar);
        if (fields.length) embed.addFields(fields);
        if (extraDebug) embed.setDescription(extraDebug);
        return embed;
      };

      // Compose debug text (trimmed)
      let debugText = '';
      if (debugInfo.length > 0) {
        const joined = debugInfo.join('\n');
        debugText = joined.length > 1000
          ? `**Debug Info:**\n\`\`\`\n${joined.substring(0, 900)}...\`\`\``
          : `**Debug Info:**\n\`\`\`\n${joined}\`\`\``;
      }

      const embed = renderOne(validProfiles[0], debugText);
      const totalPages = validProfiles.length;
      const components = [
        {
          type: 1,
          components: [
            { type: 2, style: 2, label: 'Previous', custom_id: `profile_multi_prev_${pageNum}_${idsJoined}`, disabled: true },
            { type: 2, style: 1, label: `${pageNum}/${totalPages}`, custom_id: `profile_multi_page_${pageNum}_${idsJoined}`, disabled: true },
            { type: 2, style: totalPages > 1 ? 1 : 2, label: 'Next', custom_id: `profile_multi_next_${pageNum}_${idsJoined}`, disabled: totalPages <= 1 },
          ],
        },
      ];
      await interaction.editReply({ embeds: [embed], components });
    } else {
      // Single profile (or none) -> behave like before
      const embeds = validProfiles.map((profile) => {
        const fields = [];
        if (profile.discord) fields.push({ name: 'Discord', value: profile.discord, inline: true });
        if (profile.party) fields.push({ name: 'Party', value: profile.party, inline: true });
        if (profile.state) fields.push({ name: 'State', value: profile.state, inline: true });
        if (profile.position) fields.push({ name: 'Position', value: profile.position, inline: true });
        if (profile.es) fields.push({ name: 'ES', value: String(profile.es), inline: true });
        if (profile.co) fields.push({ name: 'CO', value: String(profile.co), inline: true });
        if (profile.nr) fields.push({ name: 'NR', value: String(profile.nr), inline: true });
        if (profile.cash) fields.push({ name: '$', value: profile.cash, inline: true });
        if (profile.accountAge) fields.push({ name: 'Account Age', value: profile.accountAge, inline: true });

        const embed = new EmbedBuilder()
          .setTitle(`${profile.name} (ID ${profile.id})`)
          .setURL(`${BASE}/users/${profile.id}`)
          .setColor(0x3b82f6)
          .setFooter({ text: new URL(BASE).hostname })
          .setTimestamp();
        if (profile.avatar) embed.setThumbnail(profile.avatar);
        if (fields.length) embed.addFields(fields);
        return embed;
      });

      console.log(`[Profile Command Debug] Created ${embeds.length} embeds for display`);

      if (debugInfo.length > 0) {
        const debugText = debugInfo.join('\n');
        if (embeds.length > 0) {
          // Add to first embed if we have embeds
          if (debugText.length > 1000) {
            embeds[0].setDescription(`${embeds[0].data.description || ''}\n\n**Debug Info:**\n\`\`\`\n${debugText.substring(0, 900)}...\`\`\``);
          } else {
            embeds[0].setDescription(`${embeds[0].data.description || ''}\n\n**Debug Info:**\n\`\`\`\n${debugText}\`\`\``);
          }
          await interaction.editReply({ embeds });
        } else {
          const debugMessage = `**Debug Info:**\n\`\`\`\n${debugText}\`\`\``;
          await interaction.editReply(debugMessage);
        }
      } else {
        await interaction.editReply({ embeds });
      }
    }

    if (dbDirty) {
      try {
        writeProfileDb(db);
      } catch (error) {
        console.error('Error saving profile database:', error);
        await reportCommandError(interaction, error, {
          message: `Error saving profile database: ${error.message}`,
          meta: {
            step: 'databaseWrite',
            discordUser: discordUser?.username,
            query: queryRaw
          }
        });
      }
    }
    } catch (error) {
      console.error('Profile lookup error:', error);
      await reportCommandError(interaction, error, {
        message: `Failed to lookup profile: ${error.message}`,
        meta: {
          discordUser: discordUser?.username,
          query: queryRaw,
          step: 'lookup'
        }
      });
    }
  },

  // Render a specific page for multi-profile pagination (one profile per page)
  async showMultipleProfiles(interaction, ids, page) {
    try {
      const targetIds = (Array.isArray(ids) ? ids : String(ids).split('-')
        .filter(Boolean)
        .map((s) => Number(s))
        .filter((n) => Number.isFinite(n)));
      const totalPages = targetIds.length || 1;
      const index = Math.min(Math.max(1, Number(page) || 1), totalPages) - 1;
      const profileId = targetIds[index];

      if (!profileId) {
        return interaction.update?.({ content: 'No profiles to display.', components: [], embeds: [] })
          || interaction.editReply({ content: 'No profiles to display.', components: [], embeds: [] });
      }

      // Try cache first else fetch
      const cacheKey = SmartCache.createProfileKey(profileId);
      let profile = smartCache.get(cacheKey);
      if (!profile) {
        try {
          const session = await sessionManager.authenticateSession('profile', `${BASE}/users/${profileId}`);
          const result = await navigateWithSession(session, `${BASE}/users/${profileId}`, 'networkidle2');
          profile = parseProfile(result.html);
          smartCache.set(cacheKey, profile, 10 * 60 * 1000);
        } catch (e) {
          console.error('Failed to fetch profile during pagination:', e);
        }
      }

      // Build embed
      const fields = [];
      if (profile?.discord) fields.push({ name: 'Discord', value: profile.discord, inline: true });
      if (profile?.party) fields.push({ name: 'Party', value: profile.party, inline: true });
      if (profile?.state) fields.push({ name: 'State', value: profile.state, inline: true });
      if (profile?.position) fields.push({ name: 'Position', value: profile.position, inline: true });
      if (profile?.es) fields.push({ name: 'ES', value: String(profile.es), inline: true });
      if (profile?.co) fields.push({ name: 'CO', value: String(profile.co), inline: true });
      if (profile?.nr) fields.push({ name: 'NR', value: String(profile.nr), inline: true });
      if (profile?.cash) fields.push({ name: '$', value: profile.cash, inline: true });
      if (profile?.accountAge) fields.push({ name: 'Account Age', value: profile.accountAge, inline: true });

      const embed = new EmbedBuilder()
        .setTitle(`${profile?.name || 'Unknown'} (ID ${profileId})`)
        .setURL(`${BASE}/users/${profileId}`)
        .setColor(0x3b82f6)
        .setFooter({ text: new URL(BASE).hostname })
        .setTimestamp();
      if (profile?.avatar) embed.setThumbnail(profile.avatar);
      if (fields.length) embed.addFields(fields);

      const idsJoined = targetIds.join('-');
      const components = [
        {
          type: 1,
          components: [
            { type: 2, style: index > 0 ? 1 : 2, label: 'Previous', custom_id: `profile_multi_prev_${index + 1}_${idsJoined}`, disabled: index <= 0 },
            { type: 2, style: 1, label: `${index + 1}/${totalPages}`, custom_id: `profile_multi_page_${index + 1}_${idsJoined}`, disabled: true },
            { type: 2, style: index < totalPages - 1 ? 1 : 2, label: 'Next', custom_id: `profile_multi_next_${index + 1}_${idsJoined}`, disabled: index >= totalPages - 1 },
          ],
        },
      ];

      if (interaction.isButton && interaction.update) {
        await interaction.update({ embeds: [embed], components });
      } else {
        await interaction.editReply({ embeds: [embed], components });
      }
    } catch (error) {
      console.error('Profile lookup error:', error);
      await reportCommandError(interaction, error, {
        message: `Failed to lookup profile: ${error.message}`,
        meta: {
          discordUser: interaction.user?.username,
          query: 'multi-profile',
          step: 'lookup'
        }
      });
    }
  },

  async showAllProfiles(interaction, page, sortBy) {
    try {
      const { db } = loadProfileDb();
      const profiles = db.profiles || {};
      const profileEntries = Object.entries(profiles);

    const debugInfo = [];
    debugInfo.push(`showAllProfiles: Found ${profileEntries.length} profiles in database`);
    debugInfo.push(`Page: ${page}, Sort: ${sortBy}`);
    
    console.log(`[Profile Command Debug] ${debugInfo.join(' | ')}`);

    if (profileEntries.length === 0) {
      const debugText = debugInfo.length > 0 ? `\n\n**Debug Info:**\n\`\`\`\n${debugInfo.join('\n')}\`\`\`` : '';
      return interaction.editReply(`No profiles found. Try running /update to populate the database.${debugText}`);
    }

    const PROFILES_PER_PAGE = 10;
    const totalPages = Math.ceil(profileEntries.length / PROFILES_PER_PAGE);
    const startIndex = (page - 1) * PROFILES_PER_PAGE;
    const endIndex = startIndex + PROFILES_PER_PAGE;

    // Sort profiles
    const sortedProfiles = profileEntries.sort((a, b) => {
      const [, profileA] = a;
      const [, profileB] = b;

      switch (sortBy) {
        case 'cash':
          const cashA = parseFloat(profileA.cash?.replace(/[$,]/g, '') || '0');
          const cashB = parseFloat(profileB.cash?.replace(/[$,]/g, '') || '0');
          return cashB - cashA;
        case 'es':
          return (profileB.es || 0) - (profileA.es || 0);
        case 'party':
          return (profileA.party || '').localeCompare(profileB.party || '');
        case 'state':
          return (profileA.state || '').localeCompare(profileB.state || '');
        case 'position':
          return (profileA.position || '').localeCompare(profileB.position || '');
        case 'name':
        default:
          return (profileA.name || '').localeCompare(profileB.name || '');
      }
    });

    const pageProfiles = sortedProfiles.slice(startIndex, endIndex);

    debugInfo.push(`Displaying ${pageProfiles.length} profiles on page ${page}/${totalPages}`);
    console.log(`[Profile Command Debug] ${debugInfo.join(' | ')}`);

    // Create embed
    const embed = new EmbedBuilder()
      .setTitle(`All Profiles (Page ${page}/${totalPages})`)
      .setDescription(`Showing ${startIndex + 1}-${Math.min(endIndex, profileEntries.length)} of ${profileEntries.length} profiles`)
      .setColor(0x3b82f6)
      .setFooter({
        text: `Sorted by ${sortBy} • Last updated: ${new Date(db.updatedAt).toLocaleString()}`,
        iconURL: interaction.guild?.iconURL()
      })
      .setTimestamp();

    // Add profile fields with validation
    for (const [id, profile] of pageProfiles) {
      // Skip invalid profiles
      if (!profile.name || /login/i.test(profile.name) || profile.name === 'Power Play USA' || profile.name.length < 2) {
        console.log(`[Profile All Command] Skipping invalid profile: ${JSON.stringify(profile)}`);
        continue;
      }

      const name = profile.name;
      const party = profile.party ? ` [${profile.party}]` : '';
      const state = profile.state ? ` - ${profile.state}` : '';
      const cash = profile.cash ? ` • $${profile.cash}` : '';
      const es = profile.es ? ` • ES:${profile.es}` : '';
      const position = profile.position ? ` (${profile.position})` : '';

      const value = `${party}${state}${position}${cash}${es}`;

      embed.addFields({
        name: `${name} (ID ${id})`,
        value: value || 'No additional info',
        inline: false
      });
    }

    // Add pagination info if multiple pages
    if (totalPages > 1) {
      const components = [];

      if (totalPages > 1) {
        const paginationRow = {
          type: 1, // ACTION_ROW
          components: [
            {
              type: 2, // BUTTON
              style: page > 1 ? 1 : 2, // PRIMARY or SECONDARY
              label: 'Previous',
              custom_id: `profile_prev_${page}_${sortBy}`,
              disabled: page <= 1
            },
            {
              type: 2, // BUTTON
              style: 1, // PRIMARY
              label: `${page}/${totalPages}`,
              custom_id: `profile_page_${page}_${sortBy}`,
              disabled: true
            },
            {
              type: 2, // BUTTON
              style: page < totalPages ? 1 : 2, // PRIMARY or SECONDARY
              label: 'Next',
              custom_id: `profile_next_${page}_${sortBy}`,
              disabled: page >= totalPages
            }
          ]
        };
        components.push(paginationRow);
      }

      // Handle button interaction vs command interaction
      if (interaction.isButton && interaction.update) {
        await interaction.update({
          embeds: [embed],
          components
        });
      } else {
        await interaction.editReply({
          embeds: [embed],
          components
        });
      }
    } else {
      // Handle button interaction vs command interaction
      if (interaction.isButton && interaction.update) {
        await interaction.update({ embeds: [embed] });
      } else {
        await interaction.editReply({ embeds: [embed] });
      }
    }
    } catch (error) {
      console.error('Show all profiles error:', error);
      await reportCommandError(interaction, error, {
        message: `Failed to show all profiles: ${error.message}`,
        meta: {
          page,
          sortBy,
          step: 'showAllProfiles'
        }
      });
    }
  },
};
