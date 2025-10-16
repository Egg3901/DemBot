// commands/profile.js
const { SlashCommandBuilder } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');
const { loginAndGet, parseProfile, BASE } = require('../lib/ppusa');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('profile')
    .setDescription('Show a player\'s current Power Play USA profile by Discord mention')
    .addUserOption(opt =>
      opt.setName('user').setDescription('Discord user to look up').setRequired(true)
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

    const discordUser = interaction.options.getUser('user', true);
    const username = discordUser.username.toLowerCase();

    const jsonPath = path.join(process.cwd(), 'data', 'profiles.json');
    if (!fs.existsSync(jsonPath)) {
      return interaction.editReply('profiles.json not found. Run /update first.');
    }

    let db;
    try { db = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch (e) {
      return interaction.editReply('Failed to read profiles.json.');
    }
    const byDiscord = db.byDiscord || {};
    let ids = byDiscord[username];
    if (typeof ids === 'number') ids = [ids];
    if (!Array.isArray(ids) || ids.length === 0) {
      // Fallback: scan full map
      const profiles = db.profiles || {};
      ids = Object.entries(profiles)
        .filter(([pid, info]) => (info.discord || '').toLowerCase() === username)
        .map(([pid]) => Number(pid));
    }
    if (!Array.isArray(ids) || ids.length === 0) {
      return interaction.editReply(`No profile found for Discord user "${discordUser.username}". Try /update to refresh the cache.`);
    }

    let browser, page;
    const embeds = [];
    try {
      const sess = await loginAndGet(`${BASE}/users/${ids[0]}`);
      browser = sess.browser;
      page = sess.page;

      for (const id of ids.slice(0, 10)) { // up to 10 embeds
        try {
          if (page.url() !== `${BASE}/users/${id}`) {
            await page.goto(`${BASE}/users/${id}`, { waitUntil: 'networkidle2' });
          }
          const html = await page.content();
          const info = parseProfile(html);
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
              footer: { text: new URL(BASE).hostname },
              timestamp: new Date().toISOString(),
            });
          }
        }
      }

      await interaction.editReply({ embeds });
    } catch (err) {
      await interaction.editReply(`Error fetching profile(s): ${err?.message || String(err)}`);
    } finally {
      try { await browser?.close(); } catch {}
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
