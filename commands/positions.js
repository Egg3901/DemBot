// commands/positions.js
// View a state's demographic snapshot and policy positions, optionally comparing a player against them.

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');
const cheerio = require('cheerio');

const { authenticateAndNavigate, PPUSAAuthError } = require('../lib/ppusa-auth');
const { config } = require('../lib/ppusa-config');
const { normalizeStateName, resolveStateIdFromIndex } = require('../lib/state-utils');
const { getDebugChoice, reportCommandError } = require('../lib/command-utils');

const BASE = config.baseUrl;
const DEFAULT_DEBUG = !!config.debug;

const SNAPSHOT_KEYS = [
  'Population',
  'Politicians',
  'House Seats',
  'Electoral Votes',
  'Governor Term Limit',
];

const POSITION_KEYS = [
  'Social',
  'Economic',
  'Foreign Policy',
  'Criminal Justice',
  'Abortion',
  'LGBTQ Rights',
  'Immigration',
  'Income Inequality',
  'Fiscal Solvency',
  'Conservation',
];

const POSITION_EMOJIS = {
  Social: '🧭',
  Economic: '🏛️',
  'Foreign Policy': '🌐',
  'Criminal Justice': '⚖️',
  Abortion: '🩺',
  'LGBTQ Rights': '🏳️‍🌈',
  Immigration: '🛂',
  'Income Inequality': '💵',
  'Fiscal Solvency': '📊',
  Conservation: '🌲',
};

function buildDebugArtifacts(enabled, data) {
  if (!enabled || !data) return { suffix: '', files: undefined };
  const payload = JSON.stringify(data, null, 2);
  if (payload.length > 1500) {
    return {
      suffix: '\n\nDebug details attached (positions_debug.json)',
      files: [{ attachment: Buffer.from(payload, 'utf8'), name: 'positions_debug.json' }],
    };
  }
  return { suffix: `\n\nDebug: ${payload}` };
}

async function fetchHtmlWithSession(url, page, waitUntil = 'domcontentloaded') {
  await page.goto(url, { waitUntil }).catch(() => {});
  return { html: await page.content(), finalUrl: page.url() };
}

function cleanPositionText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .trim();
}

function extractStateFromPosition(positionText) {
  if (!positionText) return null;
  const text = String(positionText).trim();
  const match = text.match(/\b(?:from|of)\s+([A-Za-z][A-Za-z\s\.'-]*?)$/i);
  if (match && match[1]) {
    return match[1].replace(/\s+/g, ' ').trim();
  }
  return null;
}

function extractStateInfo(html, { baseUrl }) {
  const $ = cheerio.load(html || '');
  const heading = $('h4')
    .filter((_, el) => $(el).text().replace(/\s+/g, ' ').trim().toLowerCase().includes('state info'))
    .first();
  if (!heading.length) return null;

  const container = heading.closest('.container-fluid');
  const table = container.find('table').first();
  if (!table.length) return null;

  const info = {};
  table.find('tbody tr').each((_, row) => {
    const key = $(row).find('th').text().replace(/\s+/g, ' ').trim();
    if (!key) return;
    const cell = $(row).find('td').first();
    const text = cell.text().replace(/\s+/g, ' ').trim();
    const href = cell.find('a[href]').first().attr('href');
    info[key] = {
      text,
      link: href ? new URL(href, baseUrl).toString() : null,
    };
  });
  return info;
}

function extractPlayerPoliticalInfo(html, { baseUrl, profileId }) {
  const $ = cheerio.load(html || '');
  const title = ($('title').first().text() || '').trim();
  const name = title.split('|')[0]?.trim() || `ID ${profileId ?? ''}`.trim();

  const heading = $('h4')
    .filter((_, el) => $(el).text().replace(/\s+/g, ' ').trim().toLowerCase().includes('political info'))
    .first();
  if (!heading.length) {
    return { name, stateName: null, positions: null };
  }

  const container = heading.closest('.container-fluid');
  const table = container.find('table').first();
  if (!table.length) return { name, stateName: null, positions: null };

  const info = {};
  table.find('tbody tr').each((_, row) => {
    const key = $(row).find('th').text().replace(/\s+/g, ' ').trim();
    if (!key) return;
    const cell = $(row).find('td').first();
    const text = cell.text().replace(/\s+/g, ' ').trim();
    const href = cell.find('a[href]').first().attr('href');
    info[key] = {
      text,
      link: href ? new URL(href, baseUrl).toString() : null,
    };
  });

  const positions = {};
  for (const key of POSITION_KEYS) {
    if (info[key]) positions[key] = info[key].text;
  }

  const stateName = cleanPositionText(info.State?.text) || null;
  const party = info.Party?.text || null;
  return { name, stateName, positions, party };
}

function buildComparisonData(stateInfo, playerPositions) {
  const data = [];

  for (const key of POSITION_KEYS) {
    const stateRaw = stateInfo?.[key]?.text ?? '';
    const playerRaw = playerPositions?.[key] ?? '';
    const stateValue = cleanPositionText(stateRaw);
    const playerValue = cleanPositionText(playerRaw);
    const hasState = !!stateValue;
    const hasPlayer = !!playerValue;
    const matches = hasState && hasPlayer && playerValue.toLowerCase() === stateValue.toLowerCase();

    data.push({
      key,
      emoji: POSITION_EMOJIS[key] || null,
      stateValue: hasState ? stateValue : null,
      playerValue: hasPlayer ? playerValue : null,
      matches,
    });
  }

  return data;
}

function buildStateEmbed({ stateName, stateId, info }) {
  const embed = new EmbedBuilder()
    .setTitle(`${stateName} - Positions`)
    .setURL(`${BASE}/states/${stateId}`)
    .setColor(0x2563eb)
    .setFooter({ text: new URL(BASE).hostname })
    .setTimestamp(new Date());

  const snapshotLines = SNAPSHOT_KEYS.map((key) => {
    const entry = info[key];
    if (!entry) return null;
    if (key === 'Politicians' && entry.link) {
      const sanitized = entry.text.replace(/\s*\(view\)/i, '').trim();
      return `**${key}:** [${sanitized}](${entry.link}) (View)`;
    }
    return `**${key}:** ${entry.text}`;
  }).filter(Boolean);

  if (snapshotLines.length) {
    embed.addFields({ name: 'State Snapshot', value: snapshotLines.join('\n') });
  }

  const positionLines = POSITION_KEYS.map((key) => {
    const entry = info[key];
    if (!entry) return null;
    const emoji = POSITION_EMOJIS[key] ? `${POSITION_EMOJIS[key]} ` : '';
    return `${emoji}**${key}:** ${entry.text}`;
  }).filter(Boolean);

  if (positionLines.length) {
    embed.addFields({ name: 'Policy Positions', value: positionLines.join('\n') });
  }

  if (!snapshotLines.length && !positionLines.length) {
    embed.setDescription('No position data found for this state.');
  }

  return embed;
}

function buildSummaryEmbed({ stateName, stateId, comparison, player, totalPages = 1 }) {
  const embed = new EmbedBuilder()
    .setTitle(`${stateName} - Alignment Summary`)
    .setURL(`${BASE}/states/${stateId}`)
    .setFooter({ text: new URL(BASE).hostname })
    .setTimestamp(new Date());

  const mismatches = comparison.filter((item) => !item.matches);
  embed.setColor(mismatches.length ? 0xf97316 : 0x22c55e);

  const lines = [];
  const displayName = player.displayName || 'Player';

  if (player.stateName && player.stateMismatch) {
    lines.push(`⚠️ Player profile lists ${player.stateName}; state analyzed: ${stateName}.`);
  } else if (player.stateName) {
    lines.push(`State on profile: ${player.stateName}.`);
  }
  if (player.party) lines.push(`Party: ${player.party}.`);

  if (mismatches.length === 0) {
    lines.push(`✅ **${displayName} matches all recorded positions for ${stateName}.**`);
  } else {
    const aggregateKeys = new Set(['Social', 'Economic']);
    const actionable = mismatches.filter((item) => !aggregateKeys.has(item.key));
    const aggregateOnly = mismatches.filter((item) => aggregateKeys.has(item.key));

    if (actionable.length) {
      lines.push(`⚠️ **${displayName} differs on these positions:**`);
      for (const item of actionable) {
        const emoji = item.emoji ? `${item.emoji} ` : '';
        if (!item.playerValue) {
          lines.push(`• **${emoji}${item.key}** — no player stance recorded (state: ${item.stateValue ?? 'n/a'}).`);
        } else if (!item.stateValue) {
          lines.push(`• **${emoji}${item.key}** — player is ${item.playerValue}, state has no stance recorded.`);
        } else {
          lines.push(`• **${emoji}${item.key}** — player ${item.playerValue} vs state ${item.stateValue}. Please update to **${item.stateValue}**.`);
        }
      }
    }

    if (aggregateOnly.length) {
      lines.push(
        `ℹ️ Aggregate ratings (Social/Economic) differ; see the detailed page for values.`
      );
    }
  }

  if (totalPages > 1) {
    lines.push('');
    lines.push('Use ⬅️ / ➡️ reactions to switch pages (available for 5 minutes).');
  }

  embed.setDescription(lines.join('\n').slice(0, 4000));
  return embed;
}

function buildDetailsEmbed({ stateName, stateId, comparison, player }) {
  const embed = new EmbedBuilder()
    .setTitle(`${stateName} - Detailed Stances`)
    .setURL(`${BASE}/states/${stateId}`)
    .setColor(0x2563eb)
    .setFooter({ text: new URL(BASE).hostname })
    .setTimestamp(new Date());

  const stateLines = [];
  const playerLines = [];

  for (const item of comparison) {
    const emoji = item.emoji ? `${item.emoji} ` : '';
    stateLines.push(`${emoji}${item.key}: ${item.stateValue ?? '—'}`);
    const status = item.matches ? '✅ ' : item.playerValue ? '⚠️ ' : '⚪ ';
    playerLines.push(`${status}${emoji}${item.key}: ${item.playerValue ?? '—'}`);
  }

  embed.addFields(
    {
      name: 'State Positions',
      value: stateLines.join('\n').slice(0, 1024) || 'No data',
      inline: true,
    },
    {
      name: player.displayName ? `${player.displayName}'s Positions` : 'Player Positions',
      value: playerLines.join('\n').slice(0, 1024) || 'No data',
      inline: true,
    },
  );

  return embed;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('positions')
    .setDescription('View a state’s snapshot and policy positions')
    .addUserOption((opt) =>
      opt
        .setName('user')
        .setDescription('Discord user to compare against the state')
        .setRequired(false),
    )
    .addStringOption((opt) =>
      opt
        .setName('player')
        .setDescription('Player name, profile id, or Discord mention/username')
        .setRequired(false),
    )
    .addStringOption((opt) =>
      opt
        .setName('state')
        .setDescription('State code (e.g., ca) or full name')
        .setRequired(false),
    )
    .addBooleanOption((opt) =>
      opt
        .setName('debug')
        .setDescription('Include diagnostics (ephemeral)')
        .setRequired(false),
    ),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction) {
    const discordUser = interaction.options.getUser('user');
    const playerQueryRaw = (interaction.options.getString('player') || '').trim();
    const stateRawInput = (interaction.options.getString('state') || '').trim();

    const { requested, enabled: debugEnabled, denied } = getDebugChoice(interaction, 'debug');
    if (denied) {
      return interaction.reply({
        content: 'Debug mode is restricted to authorized users.',
        ephemeral: true,
      });
    }
    const debugFlag = debugEnabled || (!requested && DEFAULT_DEBUG);

    if (!discordUser && !playerQueryRaw && !stateRawInput) {
      return interaction.reply({
        content: 'Provide a state or a player (mention, id, or name) to look up.',
        ephemeral: true,
      });
    }

    const jsonPath = path.join(process.cwd(), 'data', 'profiles.json');
    let profilesDb = null;
    if (discordUser || playerQueryRaw) {
      if (!fs.existsSync(jsonPath)) {
        return interaction.reply({
          content: 'profiles.json not found. Run /update first to cache player data.',
          ephemeral: true,
        });
      }
      try {
        profilesDb = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      } catch (err) {
        return interaction.reply({
          content: `Failed to read profiles.json: ${err.message}`,
          ephemeral: true,
        });
      }
    }

    const profiles = profilesDb?.profiles || {};
    const byDiscord = profilesDb?.byDiscord || {};

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

    const handlePlayerQuery = async () => {
      if (!playerQueryRaw) return;

      const mentionMatch = playerQueryRaw.match(/^<@!?([0-9]{5,})>$/);
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

      const plain = playerQueryRaw.replace(/^@/, '').trim();

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
        .slice(0, 5)
        .map(([pid]) => Number(pid));
      partial.forEach(addIds);
    };

    if (playerQueryRaw) await handlePlayerQuery();

    const profileIds = Array.from(idSet);
    if ((discordUser || playerQueryRaw) && profileIds.length === 0) {
      const label = discordUser ? `Discord user "${discordUser.username}"` : `"${playerQueryRaw}"`;
      return interaction.reply({
        content: `No profile found for ${label}. Try /update to refresh the cache.`,
        ephemeral: true,
      });
    }

    const profileId = profileIds.length ? profileIds[0] : null;
    const cachedProfile = profileId ? profiles[profileId] || null : null;

    let stateTargetName = stateRawInput || null;
    if (!stateTargetName && cachedProfile?.state) {
      stateTargetName = cachedProfile.state;
    }
    if (!stateTargetName && cachedProfile?.position) {
      stateTargetName = extractStateFromPosition(cachedProfile.position);
    }

    let deferred = false;
    try {
      await interaction.deferReply();
      deferred = true;
    } catch (err) {
      if (err?.code === 10062) {
        console.warn('positions: interaction token expired before defer.');
        return;
      }
      throw err;
    }

    let browser = null;
    let page = null;

    try {
      const session = await authenticateAndNavigate({ url: `${BASE}/national/states`, debug: debugFlag });
      browser = session.browser;
      page = session.page;

      let statesHtml = session.html;
      let statesUrl = session.finalUrl || `${BASE}/national/states`;

      if ((statesHtml || '').length < 400) {
        const refreshed = await fetchHtmlWithSession(`${BASE}/national/states`, page, 'load');
        statesHtml = refreshed.html;
        statesUrl = refreshed.finalUrl;
      }

      let playerInfo = null;
      if (profileId) {
        const profilePage = await fetchHtmlWithSession(`${BASE}/users/${profileId}`, page, 'load');
        playerInfo = extractPlayerPoliticalInfo(profilePage.html, { baseUrl: BASE, profileId });
        if (!stateTargetName && playerInfo?.stateName) {
          stateTargetName = playerInfo.stateName;
        }
      } else if (!stateTargetName && cachedProfile?.state) {
        stateTargetName = cachedProfile.state;
      }

      if (!stateTargetName) {
        return interaction.editReply('Could not determine which state to inspect. Provide a state explicitly.');
      }

      const normalizedStateName = normalizeStateName(stateTargetName) || stateTargetName;
      if (!normalizedStateName) {
        return interaction.editReply(`Unknown state "${stateTargetName}". Use a two-letter code or full state name.`);
      }

      const stateId = resolveStateIdFromIndex(statesHtml, normalizedStateName);
      if (!stateId) {
        const dbgPath = path.join(process.cwd(), `states_index_${Date.now()}.html`);
        try { fs.writeFileSync(dbgPath, statesHtml || '', 'utf8'); } catch {}
        const { suffix, files } = buildDebugArtifacts(debugFlag, {
          finalUrl: statesUrl,
          saved: dbgPath,
        });
        await interaction.editReply({
          content: `Could not find a state matching "${normalizedStateName}" on the states listing.${suffix}`,
          files,
        });
        return;
      }

      await fetchHtmlWithSession(`${BASE}/states/${stateId}`, page, 'domcontentloaded');
      const statePage = await fetchHtmlWithSession(`${BASE}/states/${stateId}`, page, 'load');
      const stateInfo = extractStateInfo(statePage.html, { baseUrl: BASE });

      if (!stateInfo) {
        const { suffix, files } = buildDebugArtifacts(debugFlag, {
          stateId,
          finalUrl: statePage.finalUrl,
          htmlSample: (statePage.html || '').slice(0, 2000),
        });
        await interaction.editReply({
          content: `Could not locate a positions table for ${normalizedStateName}.${suffix}`,
          files,
        });
        return;
      }

      const comparisonData = playerInfo?.positions
        ? buildComparisonData(stateInfo, playerInfo.positions)
        : null;

      const playerNormalizedState = normalizeStateName(
        playerInfo?.stateName || cachedProfile?.state || stateTargetName || ''
      );

      if (profileId && comparisonData) {
        const player = {
          id: profileId,
          name: playerInfo?.name || cachedProfile?.name || `Profile ${profileId}`,
          displayName: playerInfo?.name || cachedProfile?.name || `Profile ${profileId}`,
          label: playerInfo?.name
            ? `Player Alignment - [${playerInfo.name}](${BASE}/users/${profileId})`
            : `Player Alignment - [Profile ${profileId}](${BASE}/users/${profileId})`,
          stateName: playerInfo?.stateName || cachedProfile?.state || null,
          stateMismatch:
            !!(
              playerNormalizedState &&
              normalizedStateName &&
              playerNormalizedState.toLowerCase() !== normalizedStateName.toLowerCase()
            ),
          party: playerInfo?.party || cachedProfile?.party || null,
          comparison: comparisonData,
        };

        const totalPages = 2;
        const pages = [
          buildSummaryEmbed({
            stateName: normalizedStateName,
            stateId,
            comparison: comparisonData,
            player,
            totalPages,
          }),
          buildDetailsEmbed({
            stateName: normalizedStateName,
            stateId,
            comparison: comparisonData,
            player,
          }),
        ];

        await interaction.editReply({ embeds: [pages[0]] });

        const message = await interaction.fetchReply();
        if (message && typeof message.react === 'function' && pages.length > 1) {
          const controls = ['\u2B05\uFE0F', '\u27A1\uFE0F']; // ⬅️, ➡️
          let reactionsReady = true;
          for (const emoji of controls) {
            try {
              await message.react(emoji);
            } catch (err) {
              reactionsReady = false;
              break;
            }
          }

          if (!reactionsReady) {
            await interaction.followUp({
              content: 'Unable to add reaction controls for pagination (missing permission to add reactions?). Showing first page only.',
              ephemeral: true,
            }).catch(() => {});
            return;
          }

          let index = 0;
          const filter = (reaction, user) =>
            controls.includes(reaction.emoji.name) && user.id === interaction.user.id;
          const collector = message.createReactionCollector({ filter, time: 5 * 60 * 1000 });

          collector.on('collect', async (reaction, user) => {
            if (reaction.emoji.name === controls[0]) index = (index - 1 + pages.length) % pages.length;
            else if (reaction.emoji.name === controls[1]) index = (index + 1) % pages.length;
            try {
              await interaction.editReply({ embeds: [pages[index]] });
            } catch (_) {}
            try {
              await reaction.users.remove(user.id);
            } catch (_) {}
          });

          collector.on('end', async () => {
            try { await message.reactions.removeAll(); } catch (_) {}
          });
        }
      } else {
        const embed = buildStateEmbed({
          stateName: normalizedStateName,
          stateId,
          info: stateInfo,
        });
        await interaction.editReply({ embeds: [embed] });
      }
    } catch (err) {
      if (err instanceof PPUSAAuthError) {
        await reportCommandError(interaction, err, {
          message: err.message,
          followUp: false,
        });
        return;
      }

      await reportCommandError(interaction, err, {
        message: `Error: ${err.message}`,
        meta: { command: 'positions' },
      });
    } finally {
      try { await browser?.close(); } catch {}
    }
  },
};

