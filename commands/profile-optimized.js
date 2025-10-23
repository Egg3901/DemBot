// commands/profile-optimized.js
// Optimized version of profile command with parallel processing and smart caching
const { SlashCommandBuilder } = require('discord.js');
const { parseProfile, BASE } = require('../lib/ppusa');
const { loadProfileDb, writeProfileDb, mergeProfileRecord } = require('../lib/profile-cache');
const { sessionManager } = require('../lib/session-manager');
const { ParallelProcessor } = require('../lib/parallel-processor');
const { smartCache } = require('../lib/smart-cache');
const { navigateWithSession } = require('../lib/ppusa-auth-optimized');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('profile')
    .setDescription('Show a player\'s current Power Play USA profile by Discord mention, name, or id')
    .addUserOption(opt =>
      opt.setName('user')
        .setDescription('Discord user to look up')
        .setRequired(false)
    )
    .addStringOption(opt =>
      opt.setName('query')
        .setDescription('Profile name, Discord username, mention, or numeric id')
        .setRequired(false)
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

    if (!discordUser && !queryRaw) {
      return interaction.editReply('Provide a Discord user, mention, name, or numeric profile id.');
    }

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
    if (ids.length === 0) {
      const label = discordUser ? `Discord user "${discordUser.username}"` : `"${queryRaw}"`;
      return interaction.editReply(`No profile found for ${label}. Try /update to refresh the cache.`);
    }

    // Check cache first
    const cachedProfiles = [];
    const uncachedIds = [];

    for (const id of ids) {
      const cacheKey = smartCache.createProfileKey(id);
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
        const processor = new ParallelProcessor({ maxConcurrency: 3, batchSize: 5 });

        const profileProcessor = async (profileId) => {
          try {
            const targetUrl = `${BASE}/users/${profileId}`;
            const result = await navigateWithSession(session, targetUrl, 'networkidle2');
            const info = parseProfile(result.html);
            
            // Cache the result
            const cacheKey = smartCache.createProfileKey(profileId);
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

    // Build embeds
    const embeds = allProfiles.map(profile => {
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
        title: `${profile.name || 'Unknown'} (ID ${profile.id})`,
        url: `${BASE}/users/${profile.id}`,
        fields,
        ...(profile.avatar ? { thumbnail: { url: profile.avatar } } : {}),
        footer: { text: new URL(BASE).hostname },
        timestamp: new Date().toISOString(),
      };
    });

    await interaction.editReply({ embeds });
    
    if (dbDirty) {
      try { 
        writeProfileDb(db); 
      } catch (error) {
        console.error('Error saving profile database:', error);
      }
    }
  },
};
