// commands/profile.js
// Shows a player's current Power Play USA profile by Discord mention, username, name, or numeric id.
const { SlashCommandBuilder } = require('discord.js');
const { loginAndGet, parseProfile, BASE } = require('../lib/ppusa');
const { loadProfileDb, writeProfileDb, mergeProfileRecord } = require('../lib/profile-cache');

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
   * Execute the /profile command.
   * Resolves all profile ids associated to the mentioned Discord user and
   * renders up to 10 profile embeds (live data when possible; cache fallback).
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

    let browser, page;
    const embeds = [];
    try {
      const sess = await loginAndGet(`${BASE}/users/${ids[0]}`);
      browser = sess.browser;
      page = sess.page;

      for (const id of ids.slice(0, 10)) { // up to 10 embeds
        try {
          // Always navigate to ensure we're on the right page (auth might redirect)
          const targetUrl = `${BASE}/users/${id}`;
          if (page.url() !== targetUrl) {
            // Use faster loading strategy with timeout
            await page.goto(targetUrl, { 
              waitUntil: 'domcontentloaded', 
              timeout: 15000 
            });
            // Small delay to ensure content is loaded
            await new Promise(resolve => setTimeout(resolve, 500));
          }
          const html = await page.content();
          const info = parseProfile(html);
          mergeProfileRecord(db, id, info);
          dbDirty = true;
          const fields = [];
          if (info.discord) fields.push({ name: 'Discord', value: info.discord, inline: true });
          if (info.party) fields.push({ name: 'Party', value: info.party, inline: true });
          if (info.state) fields.push({ name: 'State', value: info.state, inline: true });
          if (info.position) fields.push({ name: 'Position', value: info.position, inline: true });
          if (info.es) fields.push({ name: 'ES', value: String(info.es), inline: true });
          if (info.co) fields.push({ name: 'CO', value: String(info.co), inline: true });
          if (info.nr) fields.push({ name: 'NR', value: String(info.nr), inline: true });
          if (info.cash) fields.push({ name: '$', value: info.cash, inline: true });
          if (info.accountAge) fields.push({ name: 'Account Age', value: info.accountAge, inline: true });
          embeds.push({
            title: `${info.name || 'Unknown'} (ID ${id})`,
            url: `${BASE}/users/${id}`,
            fields,
            ...(info.avatar ? { thumbnail: { url: info.avatar } } : {}),
            footer: { text: new URL(BASE).hostname },
            timestamp: new Date().toISOString(),
          });
        } catch (e) {
          console.log(`Failed to fetch profile ${id}, using cache:`, e?.message || e);
          const cached = db.profiles?.[id];
          if (cached) {
            const fields = [];
            if (cached.discord) fields.push({ name: 'Discord', value: cached.discord, inline: true });
            if (cached.party) fields.push({ name: 'Party', value: cached.party, inline: true });
            if (cached.state) fields.push({ name: 'State', value: cached.state, inline: true });
            if (cached.position) fields.push({ name: 'Position', value: cached.position, inline: true });
            if (cached.es) fields.push({ name: 'ES', value: String(cached.es), inline: true });
            if (cached.co) fields.push({ name: 'CO', value: String(cached.co), inline: true });
            if (cached.nr) fields.push({ name: 'NR', value: String(cached.nr), inline: true });
            if (cached.cash) fields.push({ name: '$', value: String(cached.cash), inline: true });
            if (cached.accountAge) fields.push({ name: 'Account Age', value: String(cached.accountAge), inline: true });
            embeds.push({
              title: `${cached.name || 'Unknown'} (ID ${id})`,
              url: `${BASE}/users/${id}`,
              fields,
              ...(cached.avatar ? { thumbnail: { url: cached.avatar } } : {}),
              footer: { text: new URL(BASE).hostname },
              timestamp: new Date().toISOString(),
            });
          } else {
            // Add a placeholder embed for failed profiles
            embeds.push({
              title: `Profile ${id} (Failed to load)`,
              url: `${BASE}/users/${id}`,
              fields: [{ name: 'Error', value: 'Profile not found or failed to load', inline: false }],
              footer: { text: new URL(BASE).hostname },
              timestamp: new Date().toISOString(),
            });
          }
        }
      }

      await interaction.editReply({ embeds });
      if (dbDirty) {
        try { writeProfileDb(db); } catch (_) {}
      }
    } catch (err) {
      console.error('Profile command error:', err);
      await interaction.editReply(`Error fetching profile(s): ${err?.message || String(err)}`);
      if (dbDirty) {
        try { writeProfileDb(db); } catch (_) {}
      }
    } finally {
      try { 
        if (browser) {
          await browser.close(); 
        }
      } catch (closeErr) {
        console.warn('Failed to close browser:', closeErr.message);
      }
    }
  },
};
/**
 * Project: DemBot (Discord automation for Power Play USA)
 * File: commands/profile.js
 * Purpose: Show a Discord user's current PPUSA profile(s) as embeds
 * Author: egg3901
 * Created: 2025-10-16
 * Last Updated: 2025-10-16
 */
