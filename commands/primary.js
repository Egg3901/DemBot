// commands/primary.js
// Presidential primary overview: show results for Democratic or Republican and attach map snapshot

const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const cheerio = require('cheerio');

const { loginAndGet, BASE } = require('../lib/ppusa');
const { recordCommandError } = require('../lib/status-tracker');

const PARTY_ALIASES = {
  dem: 'dem', dems: 'dem', d: 'dem', democratic: 'dem', democrat: 'dem',
  gop: 'gop', r: 'gop', rep: 'gop', republican: 'gop', republicans: 'gop'
};

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const normalizeParty = (p) => PARTY_ALIASES[String(p || '').toLowerCase()] || 'dem';

function extractPrimaryLinksFromOverview(html) {
  const $ = cheerio.load(html || '');
  const findLink = (text) => $('a[href]')
    .filter((_, el) => /primary/i.test($(el).text()) && new RegExp(text, 'i').test($(el).text()))
    .first()
    .attr('href') || null;
  const dem = findLink('Democratic');
  const gop = findLink('Republican');
  return {
    dem: dem ? new URL(dem, BASE).toString() : null,
    gop: gop ? new URL(gop, BASE).toString() : null,
  };
}

function extractPresidentialPrimaryResults(html) {
  const $ = cheerio.load(html || '');
  const results = [];
  // find first table with Candidate and Delegates headers
  let table = null;
  $('table').each((_, t) => {
    const headers = $(t).find('thead th').map((__, th) => ($(th).text() || '').trim().toLowerCase()).get();
    if (headers.includes('candidate') && headers.includes('%')) { table = $(t); return false; }
  });
  if (!table || !table.length) return results;
  table.find('tbody tr').each((_, tr) => {
    const row = $(tr);
    const tds = row.find('td');
    if (tds.length < 7) return;
    const name = row.find('td').eq(1).find('a[href^="/users/"] h6, a[href^="/users/"]').first().text().trim() || null;
    const runningMate = row.find('td').eq(2).find('a[href^="/users/"] h6, a[href^="/users/"]').first().text().trim() || null;
    const delegates = (tds.eq(5).text() || '').replace(/[^0-9]/g, '');
    const percent = (tds.eq(6).text() || '').replace(/[^0-9.]/g, '');
    if (name) results.push({ name, runningMate: runningMate || null, delegates: delegates || null, percent: percent || null });
  });
  return results;
}

async function screenshotMap(page) {
  try {
    const selector = '#map';
    await page.waitForSelector(selector, { timeout: 8000 }).catch(() => null);
    // Give time for async fetch/colouring to complete
    await delay(1200);
    const handle = await page.$(selector);
    if (!handle) return null;
    try {
      const png = await handle.screenshot({ type: 'png' });
      return png || null;
    } finally {
      await handle.dispose();
    }
  } catch (_) {
    return null;
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('primary')
    .setDescription('Show Presidential primary results and a US map snapshot')
    .addStringOption((opt) =>
      opt
        .setName('party')
        .setDescription('Presidential primary party')
        .setRequired(true)
        .addChoices(
          { name: 'Democrats', value: 'dem' },
          { name: 'Republicans', value: 'gop' },
        ),
    )
    .addBooleanOption((opt) =>
      opt.setName('debug').setDescription('Include diagnostics').setRequired(false),
    ),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction) {
    const debug = interaction.options.getBoolean('debug') ?? false;
    const partyChoice = normalizeParty(interaction.options.getString('party', true));

    await interaction.deferReply();

    let page;
    try {
      // 1) Open overview and resolve current primary link for selected party
      const initial = await loginAndGet(`${BASE}/presidential/overview`, { debug });
      page = initial.page;
      const overviewHtml = initial.html || await page.content();
      const links = extractPrimaryLinksFromOverview(overviewHtml);
      const targetUrl = partyChoice === 'gop' ? links.gop : links.dem;
      if (!targetUrl) {
        await interaction.editReply(`Could not find ${partyChoice === 'gop' ? 'Republican' : 'Democratic'} primary link on overview.`);
        return;
      }

      // 2) Navigate to primary page
      const resp = await page.goto(targetUrl, { waitUntil: 'domcontentloaded' }).catch(() => null);
      const status = resp?.status?.() ?? 200;
      if (status >= 400) throw new Error(`Failed to load primary page (${status})`);
      // give scripts time
      await delay(500);
      const html = await page.content();

      // 3) Parse results
      const results = extractPresidentialPrimaryResults(html);

      // 4) Snapshot the map
      const png = await screenshotMap(page);
      const attachments = [];
      let attachmentName = null;
      if (png) {
        attachmentName = `${partyChoice}-primary-map.png`;
        attachments.push(new AttachmentBuilder(png, { name: attachmentName }));
      }

      // 5) Build embed
      const $ = cheerio.load(html);
      const title = $('title').first().text().trim() || `${partyChoice === 'gop' ? 'Republican' : 'Democratic'} Presidential Primary`;
      const list = results.length
        ? results.map((r) => `- ${r.name}${r.runningMate ? ` / ${r.runningMate}` : ''} – ${r.delegates || '0'} delegates, ${r.percent || '0'}%`).join('\n')
        : 'No results available.';

      const embed = {
        title,
        url: page.url(),
        description: list,
        image: attachmentName ? { url: `attachment://${attachmentName}` } : undefined,
        footer: { text: new URL(BASE).hostname },
        timestamp: new Date().toISOString(),
      };

      await interaction.editReply({ embeds: [embed], files: attachments });
    } catch (err) {
      recordCommandError(interaction.commandName, err);
      await interaction.editReply(`Error fetching presidential primary: ${err?.message || String(err)}`);
    } finally {
      try { await page?.close(); } catch (_) {}
    }
  }
};
