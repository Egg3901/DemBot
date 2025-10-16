/**
 * Project: DemBot (Discord automation for Power Play USA)
 * File: commands/playercounts.js
 * Purpose: Count cached player profiles by party, grouped by region or specific state
 * Author: egg3901
 * Created: 2025-10-16
 * Last Updated: 2025-10-16
 */
const { SlashCommandBuilder } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');

const REGION_LABELS = {
  west: 'West',
  south: 'South',
  northeast: 'Northeast',
  rust_belt: 'Rust Belt',
};

// 2-letter state code to canonical lowercase name
const STATE_CODE_TO_NAME = {
  AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california', CO: 'colorado',
  CT: 'connecticut', DE: 'delaware', DC: 'district of columbia', FL: 'florida', GA: 'georgia',
  HI: 'hawaii', ID: 'idaho', IL: 'illinois', IN: 'indiana', IA: 'iowa', KS: 'kansas', KY: 'kentucky',
  LA: 'louisiana', ME: 'maine', MD: 'maryland', MA: 'massachusetts', MI: 'michigan', MN: 'minnesota',
  MS: 'mississippi', MO: 'missouri', MT: 'montana', NE: 'nebraska', NV: 'nevada', NH: 'new hampshire',
  NJ: 'new jersey', NM: 'new mexico', NY: 'new york', NC: 'north carolina', ND: 'north dakota',
  OH: 'ohio', OK: 'oklahoma', OR: 'oregon', PA: 'pennsylvania', RI: 'rhode island',
  SC: 'south carolina', SD: 'south dakota', TN: 'tennessee', TX: 'texas', UT: 'utah', VT: 'vermont',
  VA: 'virginia', WA: 'washington', WV: 'west virginia', WI: 'wisconsin', WY: 'wyoming',
};

function normalizeStateQuery(input) {
  if (!input) return null;
  const raw = String(input).trim();
  if (!raw) return null;
  const code = raw.toUpperCase();
  if (STATE_CODE_TO_NAME[code]) return STATE_CODE_TO_NAME[code];
  return raw.toLowerCase();
}

function partyBucket(party) {
  const p = (party || '').toLowerCase();
  if (/republican/.test(p)) return 'gop';
  if (/democrat/.test(p)) return 'dem';
  return 'other';
}

function isActive(profile) {
  // Active if lastOnlineDays is a number and < 3 (hours/minutes/online parsed as 0)
  return typeof profile.lastOnlineDays === 'number' && profile.lastOnlineDays < 3;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('playercounts')
    .setDescription('Counts players by party grouped by region or specific state')
    .addStringOption(opt =>
      opt
        .setName('state')
        .setDescription('Optional: state code (e.g., CA) or full state name')
        .setRequired(false)
    ),

  /**
   * Execute the /playercounts command
   * - If a state is provided, returns counts for that state
   * - Otherwise, returns counts for each region (West, South, Northeast, Rust Belt)
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    await interaction.deferReply();
    try {
      const stateQuery = interaction.options.getString('state');
      const stateName = normalizeStateQuery(stateQuery);

      const jsonPath = path.join(process.cwd(), 'data', 'profiles.json');
      if (!fs.existsSync(jsonPath)) {
        return interaction.editReply('profiles.json not found. Run /update first.');
      }
      let db = {};
      try { db = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch (e) {
        return interaction.editReply('Failed to read profiles.json.');
      }
      const profiles = Object.values(db.profiles || {});
      if (profiles.length === 0) {
        return interaction.editReply('profiles.json is empty. Run /update to populate it.');
      }

      if (stateName) {
        // State filter mode
        const counts = { dem: 0, gop: 0, other: 0 };
        for (const p of profiles) {
          if (!isActive(p)) continue;
          const s = (p.state || '').toLowerCase();
          // Accept matches like "California" or "State of California" in case of inconsistencies
          const cleanState = s.replace(/^state of\s+/i, '');
          if (!cleanState) continue;
          if (cleanState === stateName) {
            const b = partyBucket(p.party);
            counts[b]++;
          }
        }
        const total = counts.dem + counts.gop + counts.other;
        const embed = {
          title: `Active Player Counts — ${stateQuery.toUpperCase?.() || stateQuery}`,
          fields: [
            { name: 'Democrats', value: String(counts.dem), inline: true },
            { name: 'Republicans', value: String(counts.gop), inline: true },
            { name: 'Other/Unknown', value: String(counts.other), inline: true },
            { name: 'Total', value: String(total), inline: false },
          ],
          timestamp: new Date().toISOString(),
        };
        return interaction.editReply({ embeds: [embed] });
      }

      // Region aggregate mode
      const regions = ['west', 'south', 'northeast', 'rust_belt'];
      const regionCounts = {};
      for (const r of regions) regionCounts[r] = { dem: 0, gop: 0, other: 0 };

      for (const p of profiles) {
        if (!isActive(p)) continue;
        const r = p.region;
        if (!r || !regionCounts[r]) continue;
        const b = partyBucket(p.party);
        regionCounts[r][b]++;
      }

      const fields = [];
      for (const r of regions) {
        const label = REGION_LABELS[r];
        const c = regionCounts[r];
        const subtotal = c.dem + c.gop + c.other;
        fields.push({ name: `${label} — Democrats`, value: String(c.dem), inline: true });
        fields.push({ name: `${label} — Republicans`, value: String(c.gop), inline: true });
        fields.push({ name: `${label} — Total`, value: String(subtotal), inline: true });
      }

      const embed = {
        title: 'Active Player Counts — By Region',
        fields,
        timestamp: new Date().toISOString(),
      };
      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      return interaction.editReply(`Error: ${err?.message || String(err)}`);
    }
  },
};
