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

// Democratic-leaning states based on recent electoral data
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
  return typeof profile.lastOnlineDays === 'number' && profile.lastOnlineDays < 3;
}

function analyzePlayerDistribution(profiles) {
  const activeProfiles = profiles.filter(isActive);
  const demProfiles = activeProfiles.filter(p => partyBucket(p.party) === 'dem');
  
  const stateCounts = {};
  const regionCounts = { west: 0, south: 0, northeast: 0, rust_belt: 0 };
  
  // Count Democrats by state
  demProfiles.forEach(profile => {
    const state = normalizeStateName(profile.state);
    if (state) {
      stateCounts[state] = (stateCounts[state] || 0) + 1;
    }
    
    // Count by region
    if (profile.region && regionCounts.hasOwnProperty(profile.region)) {
      regionCounts[profile.region]++;
    }
  });
  
  // Find overcrowded states (more than 4 Democrats - governor + 2 senators + 1 house rep)
  const overcrowdedStates = Object.entries(stateCounts)
    .filter(([state, count]) => count > 4)
    .sort((a, b) => b[1] - a[1]);
  
  // Find underutilized Democratic states (fewer than 2 Democrats)
  const underutilizedStates = Object.entries(DEMOCRATIC_STATES)
    .filter(([state, data]) => {
      const currentCount = stateCounts[state] || 0;
      return currentCount < 2;
    })
    .map(([state, data]) => ({
      state,
      currentCount: stateCounts[state] || 0,
      lean: data.lean,
      electoral: data.electoral,
      population: data.population
    }))
    .sort((a, b) => b.electoral - a.electoral); // Prioritize by electoral votes
  
  return {
    totalActive: activeProfiles.length,
    totalDemocrats: demProfiles.length,
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
  
  const prompt = `You are analyzing player distribution in a political simulation game called Power Play USA. 

Current Democratic player distribution:
- Total active Democrats: ${analysis.totalDemocrats}
- Overcrowded states (5+ Democrats - more than governor + 2 senators + 1 house rep): ${analysis.overcrowdedStates.map(([state, count]) => `${state} (${count})`).join(', ')}
- Underutilized Democratic-leaning states (<2 Democrats): ${analysis.underutilizedStates.map(s => `${s.state} (${s.currentCount}, ${s.lean} lean, ${s.electoral} electoral votes)`).join(', ')}

Provide strategic recommendations for Democratic players to move from overcrowded states to underutilized Democratic-leaning states. Focus on:
1. Electoral impact (higher electoral vote states)
2. Competitive advantage (states where Democrats can make a difference)
3. Practical considerations (population centers, existing infrastructure)

Keep recommendations concise and actionable. Format as bullet points.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-3-haiku-20240307", // Lightweight model
      max_tokens: 500,
      messages: [{
        role: "user",
        content: prompt
      }]
    });
    
    return response.content[0].text;
  } catch (error) {
    console.error('Error calling Anthropic API:', error);
    return "Unable to generate AI recommendations at this time. Please check API configuration.";
  }
}

function buildAnalysisEmbed(analysis, recommendations) {
  const embed = new EmbedBuilder()
    .setTitle('🎯 Democratic Player Distribution Analysis')
    .setColor(0x1e40af)
    .setTimestamp(new Date())
    .setFooter({ text: 'Power Play USA Strategic Analysis' });

  // Summary stats
  embed.addFields({
    name: '📊 Current Status',
    value: `**Active Democrats:** ${analysis.totalDemocrats}\n**Total Active Players:** ${analysis.totalActive}\n**Democratic Share:** ${((analysis.totalDemocrats / analysis.totalActive) * 100).toFixed(1)}%`,
    inline: false
  });

  // Overcrowded states
  if (analysis.overcrowdedStates.length > 0) {
    const overcrowdedText = analysis.overcrowdedStates
      .slice(0, 5)
      .map(([state, count]) => `• **${state}**: ${count} Democrats`)
      .join('\n');
    
    embed.addFields({
      name: '🚨 Overcrowded States (5+ Democrats - more than governor + 2 senators + 1 house rep)',
      value: overcrowdedText,
      inline: false
    });
  }

  // Top underutilized states
  if (analysis.underutilizedStates.length > 0) {
    const underutilizedText = analysis.underutilizedStates
      .slice(0, 8)
      .map(s => `• **${s.state}**: ${s.currentCount} Democrats (${s.electoral} electoral votes, ${s.lean} lean)`)
      .join('\n');
    
    embed.addFields({
      name: '🎯 Priority Target States',
      value: underutilizedText,
      inline: false
    });
  }

  // AI Recommendations
  if (recommendations && recommendations !== "Unable to generate AI recommendations at this time. Please check API configuration.") {
    embed.addFields({
      name: '🤖 Strategic Recommendations',
      value: recommendations.slice(0, 1000), // Discord embed limit
      inline: false
    });
  }

  return embed;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('analyze')
    .setDescription('Analyze Democratic player distribution and recommend strategic movements')
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
    await interaction.deferReply();
    
    try {
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

      // Analyze distribution
      const analysis = analyzePlayerDistribution(profiles);
      
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

    } catch (error) {
      console.error('Error in analyze command:', error);
      await interaction.editReply(`❌ Error: ${error.message}`);
    }
  },
};
