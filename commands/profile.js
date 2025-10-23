// commands/profile.js
// Version: 2.0 - Enhanced with parallel processing and smart caching
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { parseProfile, BASE } = require('../lib/ppusa');
const { loadProfileDb, writeProfileDb, mergeProfileRecord } = require('../lib/profile-cache');
const { sessionManager } = require('../lib/session-manager');
const { ParallelProcessor } = require('../lib/parallel-processor');
const { smartCache, SmartCache } = require('../lib/smart-cache');
const { navigateWithSession } = require('../lib/ppusa-auth-optimized');

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
    ),

  /**
   * Execute the /profile command with optimizations
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @returns {Promise<void>}
   */
  async execute(interaction) {
    await interaction.deferReply();

    const discordUser = interaction.options.getUser('user');
    const queryRaw = (interaction.options.getString('query') || '').trim();
    const page = interaction.options.getInteger('page') || 1;
    const sortBy = interaction.options.getString('sort') || 'name';

    console.log(`[Profile Command Debug] discordUser: ${discordUser?.username || 'none'}, queryRaw: "${queryRaw}", page: ${page}, sortBy: ${sortBy}`);

    // If user or query provided, do specific lookup
    if (discordUser || queryRaw) {
      console.log(`[Profile Command Debug] Going to lookupSpecificProfile`);
      return this.lookupSpecificProfile(interaction, discordUser, queryRaw);
    }

    // Show all profiles with pagination
    console.log(`[Profile Command Debug] Going to showAllProfiles`);
    return this.showAllProfiles(interaction, page, sortBy);
  },

  async lookupSpecificProfile(interaction, discordUser, queryRaw) {
    const { db } = loadProfileDb();
    const profiles = db.profiles || {};
    const byDiscord = db.byDiscord || {};
    let dbDirty = false;

    const idSet = new Set();

    const addIds = (value) => {
      const addOne = (v) => {
        const num = typeof v === 'number' ? v : Number(v);
        if (!Number.isNaN(num)) idSet.add(num);
      };
      if (Array.isArray(value)) value.forEach(addOne);
      else addOne(value);
    };

    const lookupDiscord = (name) => {
      if (!name) return;
      const key = name.toLowerCase();
      if (byDiscord[key]) addIds(byDiscord[key]);
      else {
        for (const [pid, info] of Object.entries(profiles)) {
          if ((info.discord || '').toLowerCase() === key) addIds(Number(pid));
        }
      }
    };

    if (discordUser) {
      lookupDiscord(discordUser.username);
      if (discordUser.discriminator && discordUser.discriminator !== '0') {
        lookupDiscord(`${discordUser.username}#${discordUser.discriminator}`);
      }
      if (discordUser.globalName) lookupDiscord(discordUser.globalName);
    }

    const handleQuery = async () => {
      if (!queryRaw) return;
      const mentionMatch = queryRaw.match(/^<@!?([0-9]{5,})>$/);
      if (mentionMatch) {
        try {
          const fetched = await interaction.client.users.fetch(mentionMatch[1]);
          if (fetched) {
            lookupDiscord(fetched.username);
            if (fetched.discriminator && fetched.discriminator !== '0') {
              lookupDiscord(`${fetched.username}#${fetched.discriminator}`);
            }
            if (fetched.globalName) lookupDiscord(fetched.globalName);
          }
        } catch (_) {}
        return;
      }

      const plain = queryRaw.replace(/^@/, '').trim();

      if (/^\d+$/.test(plain)) {
        addIds(Number(plain));
        return;
      }

      lookupDiscord(plain);
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
    console.log(`[Profile Command Debug] Found ${ids.length} profile IDs: ${ids.join(', ')}`);
    
    if (ids.length === 0) {
      const label = discordUser ? `Discord user "${discordUser.username}"` : `"${queryRaw}"`;
      return interaction.editReply(`No profile found for ${label}. Try /update to refresh the cache.`);
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
        return interaction.editReply(`Error fetching profiles: ${error.message}`);
      }
    }

    // Combine cached and fresh profiles
    const allProfiles = [...cachedProfiles, ...freshProfiles];

    // Update database with fresh profiles
    for (const profile of freshProfiles) {
      mergeProfileRecord(db, profile.id, profile);
      dbDirty = true;
    }

    // Build embeds with enhanced validation
    console.log(`[Profile Command Debug] Processing ${allProfiles.length} profiles for display`);
    const embeds = allProfiles.map(profile => {
      // Skip profiles that appear to be login pages or have invalid data
      if (!profile.name || /login/i.test(profile.name) || profile.name === 'Power Play USA' || profile.name.length < 2) {
        console.log(`[Profile Command] Skipping invalid profile: ${JSON.stringify(profile)}`);
        return null;
      }

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

      return {
        title: `${profile.name} (ID ${profile.id})`,
        url: `${BASE}/users/${profile.id}`,
        fields,
        ...(profile.avatar ? { thumbnail: { url: profile.avatar } } : {}),
        footer: { text: new URL(BASE).hostname },
        timestamp: new Date().toISOString(),
        color: 0x3b82f6, // Blue color for valid profiles
      };
    }).filter(Boolean); // Remove null embeds

    console.log(`[Profile Command Debug] Created ${embeds.length} embeds for display`);
    await interaction.editReply({ embeds });

    if (dbDirty) {
      try {
        writeProfileDb(db);
      } catch (error) {
        console.error('Error saving profile database:', error);
      }
    }
  },

  async showAllProfiles(interaction, page, sortBy) {
    const { db } = loadProfileDb();
    const profiles = db.profiles || {};
    const profileEntries = Object.entries(profiles);

    console.log(`[Profile Command Debug] showAllProfiles: Found ${profileEntries.length} profiles in database`);

    if (profileEntries.length === 0) {
      return interaction.editReply('No profiles found. Try running /update to populate the database.');
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

    console.log(`[Profile Command Debug] showAllProfiles: Displaying ${pageProfiles.length} profiles on page ${page}/${totalPages}`);

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
  },
};
