// commands/status.js
// Show bot uptime and last update times for profiles, states, primaries, and races

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');
const { getStatus } = require('../lib/status-tracker');

function safeReadJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours || parts.length) parts.push(`${hours}h`);
  if (minutes || parts.length) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

function toDisplay(ts) {
  return ts ? new Date(ts).toLocaleString() : 'N/A';
}

function latestDate(...dates) {
  const valid = dates.map((d) => (d ? new Date(d).getTime() : 0)).filter((n) => Number.isFinite(n) && n > 0);
  if (!valid.length) return null;
  return new Date(Math.max(...valid)).toISOString();
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show bot uptime and last update times for profiles, states, primaries, and races'),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction) {
    await interaction.deferReply();

    try {
      // Bot runtime status
      const status = getStatus();
      const readyAt = status?.bot?.readyAt || null;
      const uptimeMs = status?.bot?.uptimeMs ?? null;

      // Files
      const dataDir = path.join(process.cwd(), 'data');
      const profilesPath = path.join(dataDir, 'profiles.json');
      const statesPath = path.join(dataDir, 'states.json');
      const primariesPath = path.join(dataDir, 'primaries.json');

      const profilesDb = safeReadJson(profilesPath, null);
      const statesDb = safeReadJson(statesPath, null);
      const primariesDb = safeReadJson(primariesPath, null);

      const profilesUpdatedAt = profilesDb?.updatedAt || (fs.existsSync(profilesPath) ? new Date(fs.statSync(profilesPath).mtime).toISOString() : null);
      const statesUpdatedAt = statesDb?.updatedAt || (fs.existsSync(statesPath) ? new Date(fs.statSync(statesPath).mtime).toISOString() : null);
      const primariesUpdatedAt = primariesDb?.updatedAt || (fs.existsSync(primariesPath) ? new Date(fs.statSync(primariesPath).mtime).toISOString() : null);

      // Command run history (from status-tracker)
      const cmdMap = (status?.commands || []).reduce((acc, c) => { acc[c.name] = c; return acc; }, {});
      const lastUpdateCmd = cmdMap['update']?.lastSuccessAt || null;
      const lastPrimaryCmd = cmdMap['primary']?.lastSuccessAt || null;
      const lastRaceCmd = cmdMap['race']?.lastSuccessAt || null;

      // Last "single update" → most recent among primary/race command runs
      const lastSingle = latestDate(lastPrimaryCmd, lastRaceCmd);

      const embed = new EmbedBuilder()
        .setTitle('🩺 Bot Status')
        .setColor(0x16a34a)
        .setTimestamp(new Date())
        .addFields(
          { name: 'Uptime', value: formatDuration(uptimeMs ?? 0), inline: true },
          { name: 'Ready Since', value: toDisplay(readyAt), inline: true },
          { name: '\u200b', value: '\u200b', inline: true },
        );

      // Profiles
      const profileCount = profilesDb?.profiles ? Object.keys(profilesDb.profiles).length : null;
      embed.addFields({
        name: 'Profiles',
        value: `${profileCount != null ? `${profileCount} cached` : 'N/A'}\nUpdated: ${toDisplay(profilesUpdatedAt)}`,
        inline: true,
      });

      // States
      const stateCount = statesDb?.states ? Object.keys(statesDb.states).length : null;
      embed.addFields({
        name: 'States',
        value: `${stateCount != null ? `${stateCount} scraped` : 'N/A'}\nUpdated: ${toDisplay(statesUpdatedAt)}`,
        inline: true,
      });

      // Primaries
      const primariesCount = Array.isArray(primariesDb?.primaries) ? primariesDb.primaries.length : null;
      embed.addFields({
        name: 'Primaries',
        value: `${primariesCount != null ? `${primariesCount} races` : 'N/A'}\nUpdated: ${toDisplay(primariesUpdatedAt)}`,
        inline: true,
      });

      // Commands last run
      embed.addFields(
        { name: 'Last /update run', value: toDisplay(lastUpdateCmd), inline: true },
        { name: 'Last /primary run', value: toDisplay(lastPrimaryCmd), inline: true },
        { name: 'Last /race run', value: toDisplay(lastRaceCmd), inline: true },
      );

      // Last single update (most recent interactive query)
      embed.addFields({ name: 'Last Single Update', value: toDisplay(lastSingle), inline: true });

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      await interaction.editReply(`❌ Error: ${err.message}`);
    }
  },
};


