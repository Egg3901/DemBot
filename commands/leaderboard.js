// commands/leaderboard.js
// Display top cached profiles by cash or ES, filtered by party and recent activity.

const { SlashCommandBuilder } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');

const PARTY_CHOICES = [
  { value: 'dems', name: 'Democrats' },
  { value: 'gop', name: 'Republicans' },
  { value: 'all', name: 'All Parties' },
];

const METRIC_CHOICES = [
  { value: 'cash', name: 'Cash' },
  { value: 'es', name: 'ES' },
];

const DEFAULT_PARTY = 'dems';
const DEFAULT_METRIC = 'cash';
const MAX_ROWS = 15;
const MAX_DAYS_OFFLINE = 5;

const cleanNumber = (input) => {
  if (input === null || input === undefined) return 0;
  const num = Number(String(input).replace(/[^0-9.]/g, ''));
  return Number.isFinite(num) ? num : 0;
};

const isActive = (profile) => {
  if (typeof profile.lastOnlineDays === 'number') return profile.lastOnlineDays < MAX_DAYS_OFFLINE;
  return true;
};

const normalizeParty = (profileParty = '') => {
  const p = profileParty.toLowerCase();
  if (p.includes('democrat')) return 'dems';
  if (p.includes('republican')) return 'gop';
  return 'other';
};

const formatLastSeen = (profile) => {
  if (profile.lastOnlineText) return profile.lastOnlineText;
  if (typeof profile.lastOnlineDays === 'number') {
    if (profile.lastOnlineDays === 0) return 'Today';
    return `${profile.lastOnlineDays} day(s) ago`;
  }
  return 'Unknown';
};

const formatCash = (profile) => profile.cash || '$0';

const formatEs = (profile) => {
  const val = cleanNumber(profile.es);
  return `${val.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ES`;
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Show the top cached profiles by cash or ES')
    .addStringOption((opt) =>
      opt
        .setName('party')
        .setDescription('Filter by party (defaults to Democrats)')
        .setRequired(false)
        .addChoices(...PARTY_CHOICES.map(({ value, name }) => ({ name, value })))
    )
    .addStringOption((opt) =>
      opt
        .setName('metric')
        .setDescription('Sort by cash or ES (defaults to cash)')
        .setRequired(false)
        .addChoices(...METRIC_CHOICES.map(({ value, name }) => ({ name, value })))
    ),

  /**
   * Execute the /leaderboard command.
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    await interaction.deferReply();

    try {
      const partyInput = (interaction.options.getString('party') || DEFAULT_PARTY).toLowerCase();
      const metricInput = (interaction.options.getString('metric') || DEFAULT_METRIC).toLowerCase();
      const partyFilter = PARTY_CHOICES.some((choice) => choice.value === partyInput) ? partyInput : DEFAULT_PARTY;
      const metricFilter = METRIC_CHOICES.some((choice) => choice.value === metricInput) ? metricInput : DEFAULT_METRIC;

      const jsonPath = path.join(process.cwd(), 'data', 'profiles.json');
      if (!fs.existsSync(jsonPath)) {
        return interaction.editReply('profiles.json not found. Run /update first.');
      }

      let db;
      try {
        db = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      } catch (err) {
        return interaction.editReply('Failed to read profiles.json.');
      }

      const profiles = Object.values(db?.profiles || {});
      if (!profiles.length) return interaction.editReply('profiles.json is empty. Run /update to populate it.');

      const metricLabel = metricFilter === 'es' ? 'ES' : 'Cash';
      const partyLabel = PARTY_CHOICES.find((p) => p.value === partyFilter)?.name || 'Democrats';

      const filtered = profiles
        .filter(isActive)
        .filter((profile) => {
          if (partyFilter === 'all') return true;
          return normalizeParty(profile.party) === partyFilter;
        })
        .map((profile) => ({
          profile,
          value: metricFilter === 'es' ? cleanNumber(profile.es) : cleanNumber(profile.cash),
        }))
        .filter((entry) => Number.isFinite(entry.value))
        .sort((a, b) => b.value - a.value)
        .slice(0, MAX_ROWS);

      if (!filtered.length) {
        return interaction.editReply(`No recent profiles found for ${partyLabel} (${metricLabel}).`);
      }

      const lines = filtered.map(({ profile }, index) => {
        const metricValue = metricFilter === 'es' ? formatEs(profile) : formatCash(profile);
        const state = profile.state ? profile.state : 'Unknown';
        const lastSeen = formatLastSeen(profile);
        return `${index + 1}. **${profile.name || 'Unknown'}** - ${metricValue} | ${state} | ${lastSeen}`;
      });

      const embed = {
        title: `${partyLabel} - Top ${metricLabel}`,
        description: lines.join('\n'),
        footer: { text: 'Source: data/profiles.json - active < 5 days offline' },
        timestamp: new Date().toISOString(),
      };

      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      return interaction.editReply(`Error: ${err?.message || String(err)}`);
    }
  },
};
