/**
 * Project: DemBot (Discord automation for Power Play USA)
 * File: commands/analyze.js
 * Purpose: Analyze player distribution and recommend movements to Democratic-leaning states
 * Author: AI Assistant
 * Created: 2025-10-19
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');
const Anthropic = require('@anthropic-ai/sdk');
const { checkPermissions } = require('../lib/permissions');

// Party-leaning states based on recent electoral data
const DEMOCRATIC_STATES = {
  'california': { lean: 'strong', electoral: 55, population: 39.5 },
  'new york': { lean: 'strong', electoral: 28, population: 19.5 },
  'illinois': { lean: 'strong', electoral: 20, population: 12.7 },
  'massachusetts': { lean: 'strong', electoral: 11, population: 7.0 },
  'maryland': { lean: 'strong', electoral: 10, population: 6.2 },
  'connecticut': { lean: 'strong', electoral: 7, population: 3.6 },
  'washington': { lean: 'strong', electoral: 12, population: 7.7 },
  'oregon': { lean: 'strong', electoral: 8, population: 4.2 },
  'vermont': { lean: 'strong', electoral: 3, population: 0.6 },
  'hawaii': { lean: 'strong', electoral: 4, population: 1.4 },
  'delaware': { lean: 'strong', electoral: 3, population: 1.0 },
  'rhode island': { lean: 'strong', electoral: 4, population: 1.1 },
  'new jersey': { lean: 'moderate', electoral: 14, population: 9.3 },
  'minnesota': { lean: 'moderate', electoral: 10, population: 5.7 },
  'michigan': { lean: 'moderate', electoral: 15, population: 10.1 },
  'wisconsin': { lean: 'moderate', electoral: 10, population: 5.9 },
  'pennsylvania': { lean: 'moderate', electoral: 19, population: 13.0 },
  'nevada': { lean: 'moderate', electoral: 6, population: 3.1 },
  'new mexico': { lean: 'moderate', electoral: 5, population: 2.1 },
  'colorado': { lean: 'moderate', electoral: 10, population: 5.8 },
  'virginia': { lean: 'moderate', electoral: 13, population: 8.6 },
  'maine': { lean: 'moderate', electoral: 4, population: 1.4 },
  'new hampshire': { lean: 'moderate', electoral: 4, population: 1.4 }
};

const REPUBLICAN_STATES = {
  'texas': { lean: 'strong', electoral: 40, population: 30.0 },
  'florida': { lean: 'strong', electoral: 30, population: 22.2 },
  'ohio': { lean: 'moderate', electoral: 17, population: 11.8 },
  'georgia': { lean: 'moderate', electoral: 16, population: 10.9 },
  'north carolina': { lean: 'moderate', electoral: 16, population: 10.7 },
  'tennessee': { lean: 'strong', electoral: 11, population: 7.0 },
  'indiana': { lean: 'strong', electoral: 11, population: 6.8 },
  'missouri': { lean: 'strong', electoral: 10, population: 6.2 },
  'alabama': { lean: 'strong', electoral: 9, population: 5.0 },
  'south carolina': { lean: 'strong', electoral: 9, population: 5.2 },
  'louisiana': { lean: 'strong', electoral: 8, population: 4.6 },
  'kentucky': { lean: 'strong', electoral: 8, population: 4.5 },
  'oklahoma': { lean: 'strong', electoral: 7, population: 4.0 },
  'arkansas': { lean: 'strong', electoral: 6, population: 3.0 },
  'mississippi': { lean: 'strong', electoral: 6, population: 2.9 },
  'kansas': { lean: 'strong', electoral: 6, population: 2.9 },
  'utah': { lean: 'strong', electoral: 6, population: 3.3 },
  'nebraska': { lean: 'strong', electoral: 5, population: 1.9 },
  'west virginia': { lean: 'strong', electoral: 5, population: 1.8 },
  'idaho': { lean: 'strong', electoral: 4, population: 1.9 },
  'montana': { lean: 'moderate', electoral: 4, population: 1.1 },
  'wyoming': { lean: 'strong', electoral: 3, population: 0.6 },
  'north dakota': { lean: 'strong', electoral: 3, population: 0.8 },
  'south dakota': { lean: 'strong', electoral: 3, population: 0.9 },
  'alaska': { lean: 'moderate', electoral: 3, population: 0.7 }
};

// State code to name mapping
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

function normalizeStateName(input) {
  if (!input) return null;
  const raw = String(input).trim().toLowerCase();
  if (!raw) return null;
  
  // Handle state codes
  const code = raw.toUpperCase();
  if (STATE_CODE_TO_NAME[code]) return STATE_CODE_TO_NAME[code];
  
  // Clean up common variations
  return raw.replace(/^state of\s+/i, '').trim();
}

function partyBucket(party) {
  const p = (party || '').toLowerCase();
  if (/republican/.test(p)) return 'gop';
  if (/democrat/.test(p)) return 'dem';
  return 'other';
}

function isActive(profile) {
  return typeof profile.lastOnlineDays === 'number' && profile.lastOnlineDays < 5;
}

function analyzePlayerDistribution(profiles, party = 'dem') {
  const activeProfiles = profiles.filter(isActive);
  const partyProfiles = activeProfiles.filter(p => partyBucket(p.party) === party);
  
  const stateCounts = {};
  const regionCounts = { west: 0, south: 0, northeast: 0, rust_belt: 0 };
  
  // Count party members by state
  partyProfiles.forEach(profile => {
    const state = normalizeStateName(profile.state);
    if (state) {
      stateCounts[state] = (stateCounts[state] || 0) + 1;
    }
    
    // Count by region
    if (profile.region && regionCounts.hasOwnProperty(profile.region)) {
      regionCounts[profile.region]++;
    }
  });
  
  // Get party-leaning states
  const partyStates = party === 'dem' ? DEMOCRATIC_STATES : REPUBLICAN_STATES;
  
  // Find overcrowded states (more than 4 party members - governor + 2 senators + 1 house rep)
  const overcrowdedStates = Object.entries(stateCounts)
    .filter(([state, count]) => count > 4)
    .sort((a, b) => b[1] - a[1]);
  
  // Find underutilized party-leaning states (fewer than 2 party members)
  const underutilizedStates = Object.entries(partyStates)
    .filter(([state, data]) => {
      const currentCount = stateCounts[state] || 0;
      return currentCount < 2;
    })
    .map(([state, data]) => ({
      state,
      currentCount: stateCounts[state] || 0,
      lean: data.lean,
      electoral: data.electoral,
      population: data.population,
      hasActivePlayers: (stateCounts[state] || 0) > 0
    }))
    .sort((a, b) => b.electoral - a.electoral); // Prioritize by electoral votes
  
  return {
    party,
    totalActive: activeProfiles.length,
    totalPartyMembers: partyProfiles.length,
    stateCounts,
    regionCounts,
    overcrowdedStates,
    underutilizedStates
  };
}

async function generateRecommendations(analysis) {
  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });
  
  const partyName = analysis.party === 'dem' ? 'Democratic' : 'Republican';
  
  const prompt = `You are analyzing Power Play USA, a political simulation game where players compete for elected offices (Governor, Senator, House Rep). Players can move between states to run for different positions.

Current ${partyName} player distribution:
- Active ${partyName}s: ${analysis.totalPartyMembers}
- Overcrowded states (>4 ${partyName}s): ${analysis.overcrowdedStates.map(([state, count]) => `${state}(${count})`).join(', ')}
- Available target states (<2 ${partyName}s): ${analysis.underutilizedStates.slice(0, 5).map(s => `${s.state}(${s.currentCount},${s.electoral}ev)`).join(', ')}

Provide 3-4 concise strategic recommendations for MOVING existing ${partyName} players from overcrowded states to underutilized ${partyName}-leaning states. This is about redistributing current players, not adding new ones. Focus on high electoral impact states with minimal ${partyName} presence. Keep each recommendation under 50 words.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-3-haiku-20240307",
      max_tokens: 300,
      messages: [{
        role: "user",
        content: prompt
      }]
    });
    
    return response.content[0].text;
  } catch (error) {
    console.error('Error calling Anthropic API:', error);
    return "AI recommendations unavailable.";
  }
}

function buildAnalysisEmbed(analysis, recommendations) {
  const partyName = analysis.party === 'dem' ? 'Democratic' : 'Republican';
  const partyColor = analysis.party === 'dem' ? 0x1e40af : 0xdc2626;
  const partyEmoji = analysis.party === 'dem' ? '🔵' : '🔴';
  
  const embed = new EmbedBuilder()
    .setTitle(`${partyEmoji} ${partyName} Player Movement Analysis`)
    .setColor(partyColor)
    .setTimestamp(new Date())
    .setFooter({ text: 'Power Play USA' });

  // Concise summary
  const partyShare = ((analysis.totalPartyMembers / analysis.totalActive) * 100).toFixed(1);
  embed.setDescription(`**${analysis.totalPartyMembers}** active ${partyName}s (${partyShare}% of ${analysis.totalActive} total)`);

  // Overcrowded states - only show top 3
  if (analysis.overcrowdedStates.length > 0) {
    const overcrowdedText = analysis.overcrowdedStates
      .slice(0, 3)
      .map(([state, count]) => `• **${state}**: ${count} ${partyName}s`)
      .join('\n');
    
    embed.addFields({
      name: `🚨 Move FROM (>4 ${partyName}s)`,
      value: overcrowdedText,
      inline: true
    });
  }

  // Top underutilized states - only show top 5
  if (analysis.underutilizedStates.length > 0) {
    const underutilizedText = analysis.underutilizedStates
      .slice(0, 5)
      .map(s => `• **${s.state}**: ${s.currentCount} (${s.electoral}ev) ${s.hasActivePlayers ? '⚠️' : '✅'}`)
      .join('\n');
    
    embed.addFields({
      name: `🎯 Move TO (<2 ${partyName}s)`,
      value: underutilizedText + '\n✅ = No active players\n⚠️ = Has active players',
      inline: true
    });
  }

  // AI Recommendations - concise
  if (recommendations && recommendations !== "AI recommendations unavailable.") {
    embed.addFields({
      name: '🤖 Strategic Movement Recommendations',
      value: recommendations.slice(0, 800),
      inline: false
    });
  }

  return embed;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('analyze')
    .setDescription('Analyze party player distribution and recommend strategic state movements')
    .addStringOption(opt =>
      opt
        .setName('party')
        .setDescription('Party to analyze')
        .setRequired(false)
        .addChoices(
          { name: 'Democratic', value: 'dem' },
          { name: 'Republican', value: 'gop' }
        )
    )
    .addStringOption(opt =>
      opt
        .setName('type')
        .setDescription('Analysis type')
        .setRequired(false)
        .addChoices(
          { name: 'Player Movement', value: 'movement' },
          { name: 'Race Analysis', value: 'races' },
          { name: 'Primary Analysis', value: 'primaries' }
        )
    )
    .addBooleanOption(opt =>
      opt
        .setName('ai')
        .setDescription('Include AI-powered strategic recommendations')
        .setRequired(false)
    ),

  /**
   * Execute the /analyze command
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    // Check permissions - restrict to party leadership/admin
    const hasPermission = await checkPermissions(interaction, ['party_leadership', 'admin']);
    if (!hasPermission) {
      return interaction.reply({
        content: '❌ This command is restricted to party leadership and administrators.',
        ephemeral: true
      });
    }

    await interaction.deferReply();
    
    try {
      const party = interaction.options.getString('party') ?? 'dem';
      const analysisType = interaction.options.getString('type') ?? 'movement';
      const includeAI = interaction.options.getBoolean('ai') ?? true;
      
      // Load profiles data
      const jsonPath = path.join(process.cwd(), 'data', 'profiles.json');
      if (!fs.existsSync(jsonPath)) {
        return interaction.editReply('❌ profiles.json not found. Run `/update` first to cache player data.');
      }
      
      let db = {};
      try {
        db = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      } catch (e) {
        return interaction.editReply('❌ Failed to read profiles.json.');
      }
      
      const profiles = Object.values(db.profiles || {});
      if (profiles.length === 0) {
        return interaction.editReply('❌ profiles.json is empty. Run `/update` to populate it.');
      }

      // Handle different analysis types
      if (analysisType === 'movement') {
        // Analyze distribution
        const analysis = analyzePlayerDistribution(profiles, party);
        
        // Generate AI recommendations if requested
        let recommendations = null;
        if (includeAI) {
          if (!process.env.ANTHROPIC_API_KEY) {
            recommendations = "⚠️ AI recommendations unavailable: ANTHROPIC_API_KEY not configured.";
          } else {
            recommendations = await generateRecommendations(analysis);
          }
        }

        // Build and send embed
        const embed = buildAnalysisEmbed(analysis, recommendations);
        await interaction.editReply({ embeds: [embed] });
      } else if (analysisType === 'races') {
        await interaction.editReply('🏛️ Race analysis coming soon! This will analyze competitive races and recommend strategic candidate placements.');
      } else if (analysisType === 'primaries') {
        await interaction.editReply('🗳️ Primary analysis coming soon! This will analyze primary races and recommend candidate strategies.');
      } else {
        await interaction.editReply('❌ Unknown analysis type. Please select a valid option.');
      }

    } catch (error) {
      console.error('Error in analyze command:', error);
      await interaction.editReply(`❌ Error: ${error.message}`);
    }
  },
};
