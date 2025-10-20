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
const { canUseAnalyze } = require('../lib/permissions');
const { loadStatesData } = require('../lib/state-scraper');

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
  'maine': { lean: 'moderate', electoral: 4, population: 1.4 },
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

function hasPosition(profile) {
  // Check if player holds any office (not a Private Citizen)
  const position = (profile.position || '').toLowerCase();
  return position && !position.includes('private citizen') && !position.includes('vacant');
}

function analyzePlayerDistribution(profiles, party = 'dem', statesData = null) {
  const activeProfiles = profiles.filter(isActive);
  const partyProfiles = activeProfiles.filter(p => partyBucket(p.party) === party);
  
  const stateCounts = {};
  const regionCounts = { west: 0, south: 0, northeast: 0, rust_belt: 0 };
  const statePlayersMap = {}; // Track individual players by state
  
  // Count party members by state and track individual players
  partyProfiles.forEach(profile => {
    const state = normalizeStateName(profile.state);
    if (state) {
      stateCounts[state] = (stateCounts[state] || 0) + 1;
      
      // Track individual players
      if (!statePlayersMap[state]) statePlayersMap[state] = [];
      statePlayersMap[state].push({
        id: profile.id,
        name: profile.name,
        position: profile.position || 'Private Citizen',
        hasPosition: hasPosition(profile),
        discord: profile.discord,
      });
    }
    
    // Count by region
    if (profile.region && regionCounts.hasOwnProperty(profile.region)) {
      regionCounts[profile.region]++;
    }
  });
  
  // Get party-leaning states with updated EV data if available
  const partyStates = party === 'dem' ? DEMOCRATIC_STATES : REPUBLICAN_STATES;
  
  // Helper to determine party control of a state based on current officeholders
  const calculatePartyControl = (stateInfo, targetParty) => {
    let score = 0;
    const isTargetDem = targetParty === 'dem';
    
    // Governor (2 points)
    if (stateInfo.governor && !stateInfo.governor.vacant) {
      const govParty = (stateInfo.governor.party || '').toLowerCase();
      if ((isTargetDem && govParty.includes('democrat')) || (!isTargetDem && govParty.includes('republican'))) {
        score += 2;
      }
    }
    
    // Senators (1 point each)
    (stateInfo.senators || []).forEach(senator => {
      if (!senator.vacant) {
        const senParty = (senator.party || '').toLowerCase();
        if ((isTargetDem && senParty.includes('democrat')) || (!isTargetDem && senParty.includes('republican'))) {
          score += 1;
        }
      }
    });
    
    // House delegation (1 point if majority)
    const reps = stateInfo.representatives || [];
    let targetReps = 0;
    let totalReps = 0;
    reps.forEach(rep => {
      if (!rep.vacant) {
        totalReps += (rep.seats || 1);
        const repParty = (rep.party || '').toLowerCase();
        if ((isTargetDem && repParty.includes('democrat')) || (!isTargetDem && repParty.includes('republican'))) {
          targetReps += (rep.seats || 1);
        }
      }
    });
    if (totalReps > 0 && targetReps > totalReps / 2) {
      score += 1;
    }
    
    return score; // 0-4 scale
  };
  
  // Enhance state data with live EV counts and position holders from states.json
  const enhancedStateData = {};
  if (statesData?.states) {
    // First, add all hardcoded party-leaning states
    Object.entries(partyStates).forEach(([stateName, stateData]) => {
      const stateInfo = Object.values(statesData.states).find(s => normalizeStateName(s.name) === stateName);
      if (stateInfo) {
        enhancedStateData[stateName] = {
          ...stateData,
          electoral: stateInfo.electoralVotes || stateData.electoral,
          houseSeats: stateInfo.houseSeats || 0,
          governor: stateInfo.governor,
          senators: stateInfo.senators || [],
          representatives: stateInfo.representatives || [],
          legislatureSeats: stateInfo.legislatureSeats || { democratic: 0, republican: 0 },
          controlScore: calculatePartyControl(stateInfo, party),
        };
      }
    });
    
    // Then, check for other states with actual party control even if not in hardcoded list
    Object.values(statesData.states).forEach(stateInfo => {
      const stateName = normalizeStateName(stateInfo.name);
      if (stateName && !enhancedStateData[stateName]) {
        const controlScore = calculatePartyControl(stateInfo, party);
        // Include states with at least some party control (score >= 2)
        if (controlScore >= 2) {
          enhancedStateData[stateName] = {
            lean: 'actual',
            electoral: stateInfo.electoralVotes || 0,
            population: 0,
            houseSeats: stateInfo.houseSeats || 0,
            governor: stateInfo.governor,
            senators: stateInfo.senators || [],
            representatives: stateInfo.representatives || [],
            legislatureSeats: stateInfo.legislatureSeats || { democratic: 0, republican: 0 },
            controlScore,
          };
        }
      }
    });
  }
  
  // Use enhanced data if available, fallback to hardcoded
  const finalStateData = Object.keys(enhancedStateData).length > 0 ? enhancedStateData : partyStates;
  
  // Find overcrowded states (more than 4 party members - governor + 2 senators + 1 house rep)
  // Include list of movable players (those without positions)
  const overcrowdedStates = Object.entries(stateCounts)
    .filter(([state, count]) => count > 4)
    .map(([state, count]) => {
      const players = statePlayersMap[state] || [];
      const movablePlayers = players.filter(p => !p.hasPosition);
      const stateInfo = finalStateData[state] || null;
      return {
        state,
        count,
        totalPlayers: players.length,
        movablePlayers: movablePlayers.length,
        movablePlayersList: movablePlayers,
        electoralVotes: stateInfo?.electoral || null,
        stateData: stateInfo,
      };
    })
    .sort((a, b) => b.count - a.count);
  
  // Find underutilized party-leaning states (fewer than 2 party members)
  const underutilizedStates = Object.entries(finalStateData)
    .filter(([state, data]) => {
      const currentCount = stateCounts[state] || 0;
      return currentCount < 2;
    })
    .map(([state, data]) => {
      // Check for vacant positions or opposing party control
      const hasVacancies = statesData?.states 
        ? Object.values(statesData.states).find(s => normalizeStateName(s.name) === state)
        : null;
      
      const vacantGov = hasVacancies?.governor?.vacant || false;
      const vacantSenators = (hasVacancies?.senators || []).filter(s => s.vacant).length;
      const opportunities = vacantGov ? 'Gov vacant' : 
        vacantSenators > 0 ? `${vacantSenators} Senate seat(s) vacant` : '';
      
      return {
        state,
        currentCount: stateCounts[state] || 0,
        lean: data.lean,
        electoral: data.electoral,
        population: data.population,
        hasActivePlayers: (stateCounts[state] || 0) > 0,
        opportunities: opportunities || null,
        stateData: data,
        controlScore: data.controlScore || 0,
      };
    })
    .sort((a, b) => {
      // Heavy weighting: Actual party control >> Historical lean >> Electoral votes
      // 1. Prioritize states with strong actual control (score >= 3)
      const aStrongControl = a.controlScore >= 3 ? 1000 : 0;
      const bStrongControl = b.controlScore >= 3 ? 1000 : 0;
      if (aStrongControl !== bStrongControl) return bStrongControl - aStrongControl;
      
      // 2. Then moderate control (score == 2)
      const aModControl = a.controlScore === 2 ? 500 : 0;
      const bModControl = b.controlScore === 2 ? 500 : 0;
      if (aModControl !== bModControl) return bModControl - aModControl;
      
      // 3. Then 'actual' lean (discovered from state data)
      const aActual = a.lean === 'actual' ? 200 : 0;
      const bActual = b.lean === 'actual' ? 200 : 0;
      if (aActual !== bActual) return bActual - aActual;
      
      // 4. Then strong historical lean
      const aStrong = a.lean === 'strong' ? 100 : 0;
      const bStrong = b.lean === 'strong' ? 100 : 0;
      if (aStrong !== bStrong) return bStrong - aStrong;
      
      // 5. Finally by electoral votes
      return b.electoral - a.electoral;
    }); // Heavily prioritize actual control over historical lean
  
  return {
    party,
    totalActive: activeProfiles.length,
    totalPartyMembers: partyProfiles.length,
    stateCounts,
    regionCounts,
    overcrowdedStates,
    underutilizedStates,
    statePlayersMap,
    usingLiveStateData: Object.keys(enhancedStateData).length > 0,
  };
}

async function generateRecommendations(analysis) {
  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });
  
  const partyName = analysis.party === 'dem' ? 'Democratic' : 'Republican';
  
  // Build overcrowded states summary with movable player counts
  const overcrowdedSummary = analysis.overcrowdedStates
    .map(s => `${s.state}(${s.count} total, ${s.movablePlayers} without positions)`)
    .join(', ');
  
  const prompt = `This is a FICTIONAL GAME called "Power Play USA" - a political simulation video game where players create characters and compete for fictional elected offices.

GAME CONTEXT: Players can move their game characters between fictional states to run for in-game Governor, Senator, or Representative positions. This is entertainment, not real politics.

CURRENT GAME STATE:
- Overcrowded game states: ${overcrowdedSummary}
- Target game states: ${analysis.underutilizedStates.slice(0, 5).map(s => `${s.state}(${s.electoral}ev)`).join(', ')}

Task: Write 2-3 brief in-game strategy tips (20 words each) for why game players should move their fictional characters from overcrowded to target states for better ${partyName} team gameplay.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-3-haiku-20240307",
      max_tokens: 200,
      system: "You are a gaming strategy advisor for Power Play USA, a fictional political simulation video game. All advice relates to in-game strategy, not real-world politics.",
      messages: [{
        role: "user",
        content: prompt
      }]
    });
    
    return response.content[0].text;
  } catch (error) {
    console.error('Error calling Anthropic API:', error.message || error);
    // If AI refuses, just skip recommendations gracefully
    return null;
  }
}

function buildAnalysisEmbed(analysis, recommendations) {
  const partyName = analysis.party === 'dem' ? 'Democratic' : 'Republican';
  const partyColor = analysis.party === 'dem' ? 0x1e40af : 0xdc2626;
  const partyEmoji = analysis.party === 'dem' ? '🔵' : '🔴';
  const BASE_URL = 'https://www.powerplayusa.net';
  
  const footerText = analysis.usingLiveStateData 
    ? 'Power Play USA • Using live state data (EVs, positions)'
    : 'Power Play USA • Run /update type:states for live data';
  
  const embed = new EmbedBuilder()
    .setTitle(`${partyEmoji} ${partyName} Player Movement Analysis`)
    .setColor(partyColor)
    .setTimestamp(new Date())
    .setFooter({ text: footerText });

  // Concise summary
  const partyShare = ((analysis.totalPartyMembers / analysis.totalActive) * 100).toFixed(1);
  embed.setDescription(`**${analysis.totalPartyMembers}** active ${partyName}s (${partyShare}% of ${analysis.totalActive} total)`);

  // Overcrowded states - show top 3 with movable player counts
  if (analysis.overcrowdedStates.length > 0) {
    const overcrowdedText = analysis.overcrowdedStates
      .slice(0, 3)
      .map(s => `• **${s.state}**: ${s.count} (${s.movablePlayers} movable)`)
      .join('\n');
    
    embed.addFields({
      name: `🚨 Move FROM`,
      value: overcrowdedText,
      inline: true
    });
  }

  // Top underutilized states - only show top 5, with opportunities if available
  if (analysis.underutilizedStates.length > 0) {
    const underutilizedText = analysis.underutilizedStates
      .slice(0, 5)
      .map(s => {
        const marker = s.opportunities ? '🏛️' : s.hasActivePlayers ? '⚠️' : '✅';
        return `• **${s.state}**: ${s.electoral}ev ${marker}`;
      })
      .join('\n');
    
    embed.addFields({
      name: `🎯 Move TO`,
      value: underutilizedText + (analysis.usingLiveStateData ? '\n🏛️=vacant ✅=empty ⚠️=has players' : ''),
      inline: true
    });
  }

  // Build specific movement recommendations with player links
  if (analysis.overcrowdedStates.length > 0 && analysis.underutilizedStates.length > 0) {
    const movementRecs = [];
    
    // Prioritize states with vacant positions, then by electoral votes
    const targetStates = [...analysis.underutilizedStates.slice(0, 8)].sort((a, b) => {
      if (a.opportunities && !b.opportunities) return -1;
      if (!a.opportunities && b.opportunities) return 1;
      return b.electoral - a.electoral;
    });
    
    let targetIdx = 0;
    
    // Collect all movable players from overcrowded states
    const allMovablePlayers = [];
    for (const overcrowded of analysis.overcrowdedStates) {
      const movablePlayers = overcrowded.movablePlayersList || [];
      movablePlayers.forEach(player => {
        allMovablePlayers.push({
          ...player,
          fromState: overcrowded.state,
        });
      });
    }
    
    // Match players to target states (round-robin for better distribution)
    const maxRecommendations = Math.min(allMovablePlayers.length, targetStates.length, 10);
    
    for (let i = 0; i < maxRecommendations; i++) {
      const player = allMovablePlayers[i];
      const target = targetStates[targetIdx % targetStates.length];
      
      const playerLink = `[${player.name}](${BASE_URL}/users/${player.id})`;
      const discordNote = player.discord ? ` @${player.discord}` : '';
      const opportunityNote = target.opportunities ? ` ${target.opportunities}` : '';
      
      movementRecs.push(
        `${player.fromState} → **${target.state}** (${target.electoral}ev)${opportunityNote}\n${playerLink}${discordNote}`
      );
      
      targetIdx++;
    }
    
    if (movementRecs.length > 0) {
      embed.addFields({
        name: `📋 Recommended Movements (${movementRecs.length})`,
        value: movementRecs.join('\n\n'),
        inline: false
      });
    } else if (allMovablePlayers.length === 0 && analysis.overcrowdedStates.length > 0) {
      embed.addFields({
        name: '📋 Note',
        value: `All players in overcrowded states hold positions.`,
        inline: false
      });
    }
  }

  // AI Recommendations - concise (if provided and valid)
  if (recommendations && typeof recommendations === 'string' && recommendations.length > 20) {
    embed.addFields({
      name: '💡 Strategy',
      value: recommendations.slice(0, 500),
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
    if (!(await canUseAnalyze(interaction))) {
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

      // Load states data for enhanced analysis (if available)
      const statesData = loadStatesData();
      if (!statesData) {
        console.warn('States data not found. Run /update type:states to enable state-level analysis features.');
      }

      // Handle different analysis types
      if (analysisType === 'movement') {
        // Analyze distribution with state data integration
        const analysis = analyzePlayerDistribution(profiles, party, statesData);
        
        // Generate AI recommendations if requested
        let recommendations = null;
        if (includeAI && process.env.ANTHROPIC_API_KEY) {
          try {
            recommendations = await generateRecommendations(analysis);
          } catch (err) {
            console.warn('AI recommendations failed:', err.message);
            // Gracefully skip AI section if it fails
            recommendations = null;
          }
        }

        // Build and send embed
        const embed = buildAnalysisEmbed(analysis, recommendations);
        await interaction.editReply({ embeds: [embed] });
      } else if (analysisType === 'races') {
        // Future: Use statesData to analyze competitive races by examining current officeholders
        // and comparing with party distribution
        await interaction.editReply('🏛️ Race analysis coming soon! This will analyze competitive races and recommend strategic candidate placements.\n\n💡 Tip: Run `/update type:states` to cache state-level data for enhanced race analysis.');
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