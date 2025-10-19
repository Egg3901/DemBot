// commands/positions.js
// View a state's demographic snapshot and policy positions.

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
    if (!text) return;
    const href = cell.find('a[href]').first().attr('href');
    info[key] = {
      text,
      link: href ? new URL(href, baseUrl).toString() : null,
    };
  });
  return info;
}

function buildPositionsEmbed({ stateName, stateId, info }) {
  const embed = new EmbedBuilder()
    .setTitle(`${stateName} — Positions`)
    .setURL(`${BASE}/states/${stateId}`)
    .setColor(0x2563eb)
    .setFooter({ text: new URL(BASE).hostname })
    .setTimestamp(new Date());

  const snapshotLines = SNAPSHOT_KEYS.map((key) => {
    const entry = info[key];
    if (!entry) return null;
    if (key === 'Politicians' && entry.link) {
      return `**${key}:** [${entry.text.replace(/\s*\(view\)/i, '').trim()}](${entry.link}) (View)`;
    }
    return `**${key}:** ${entry.text}`;
  }).filter(Boolean);

  if (snapshotLines.length) {
    embed.addFields({ name: 'State Snapshot', value: snapshotLines.join('\n') });
  }

  const positionLines = POSITION_KEYS.map((key) => {
    const entry = info[key];
    if (!entry) return null;
    const emoji = POSITION_EMOJIS[key] || '•';
    return `${emoji} **${key}:** ${entry.text}`;
  }).filter(Boolean);

  if (positionLines.length) {
    embed.addFields({ name: 'Policy Positions', value: positionLines.join('\n') });
  }

  if (!snapshotLines.length && !positionLines.length) {
    embed.setDescription('No position data found for this state.');
  }

  return embed;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('positions')
    .setDescription('View a state’s snapshot and policy positions')
    .addStringOption((opt) =>
      opt
        .setName('state')
        .setDescription('State code (e.g., ca) or full name')
        .setRequired(true),
    )
    .addBooleanOption((opt) =>
      opt
        .setName('debug')
        .setDescription('Include diagnostics (ephemeral)')
        .setRequired(false),
    ),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction) {
    const stateRaw = (interaction.options.getString('state', true) || '').trim();
    const { requested, enabled: debugEnabled, denied } = getDebugChoice(interaction, 'debug');
    if (denied) {
      return interaction.reply({
        content: 'Debug mode is restricted to authorized users.',
        ephemeral: true,
      });
    }
    const debugFlag = debugEnabled || (!requested && DEFAULT_DEBUG);

    const stateName = normalizeStateName(stateRaw);
    if (!stateName) {
      return interaction.reply({
        content: `Unknown state "${stateRaw}". Use a two-letter code or full state name.`,
        ephemeral: true,
      });
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

      const stateId = resolveStateIdFromIndex(statesHtml, stateName);
      if (!stateId) {
        const dbgPath = path.join(process.cwd(), `states_index_${Date.now()}.html`);
        try { fs.writeFileSync(dbgPath, statesHtml || '', 'utf8'); } catch {}
        const { suffix, files } = buildDebugArtifacts(debugFlag, { finalUrl: statesUrl, saved: dbgPath });
        await interaction.editReply({
          content: `Could not find a state matching "${stateName}" on the states listing.${suffix}`,
          files,
        });
        return;
      }

      // Visit overview (required before positions are visible), then fetch final HTML.
      await fetchHtmlWithSession(`${BASE}/states/${stateId}`, page, 'domcontentloaded');
      const statePage = await fetchHtmlWithSession(`${BASE}/states/${stateId}`, page, 'load');
      const info = extractStateInfo(statePage.html, { baseUrl: BASE });

      if (!info) {
        const { suffix, files } = buildDebugArtifacts(debugFlag, {
          stateId,
          finalUrl: statePage.finalUrl,
          htmlSample: (statePage.html || '').slice(0, 2000),
        });
        await interaction.editReply({
          content: `Could not locate a positions table for ${stateName}.${suffix}`,
          files,
        });
        return;
      }

      const embed = buildPositionsEmbed({ stateName, stateId, info });
      await interaction.editReply({ embeds: [embed] });
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
