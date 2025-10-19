// commands/race.js
// Show a state race snapshot (Senate class 1/2/3, Governor, House):
// - Outcome for the most recently finished round (Primary/General/Runoff)
// - If active, also show the next race time (if available)
// - Always include the most recent poll for this race

const { SlashCommandBuilder } = require('discord.js');
const cheerio = require('cheerio');
const { authenticateAndNavigate, PPUSAAuthError } = require('../lib/ppusa-auth');
const { config } = require('../lib/ppusa-config');
const { normalizeStateName, resolveStateIdFromIndex } = require('../lib/state-utils');
const { reportCommandError } = require('../lib/command-utils');

const BASE = config.baseUrl;

const RACE_ALIASES = {
  s1: 'Senate Class 1', sen1: 'Senate Class 1', senate1: 'Senate Class 1', class1: 'Senate Class 1',
  s2: 'Senate Class 2', sen2: 'Senate Class 2', senate2: 'Senate Class 2', class2: 'Senate Class 2',
  s3: 'Senate Class 3', sen3: 'Senate Class 3', senate3: 'Senate Class 3', class3: 'Senate Class 3',
  gov: 'Governor', governor: 'Governor', gubernatorial: 'Governor',
  rep: 'House of Representatives', reps: 'House of Representatives', house: 'House of Representatives', representatives: 'House of Representatives'
};

function normalizeRace(r) {
  const key = String(r || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return RACE_ALIASES[key] || null;
}

async function fetchHtml(page, url, waitUntil = 'domcontentloaded') {
  await page.goto(url, { waitUntil }).catch(() => {});
  return { html: await page.content(), finalUrl: page.url() };
}

function pickLatestResults(html) {
  const $ = cheerio.load(html || '');
  const blocks = [];

  $('h4,h3').each((_, h) => {
    const title = ($(h).text() || '').replace(/\s+/g, ' ').trim();
    if (!/results|final|primary|general|runoff/i.test(title)) return;
    const table = $(h).nextAll('table').first();
    if (!table.length) return;
    const rows = [];
    table.find('tbody tr').each((__, tr) => {
      const tds = $(tr).find('td');
      const raw = tds.map((i, el) => ($(el).text() || '').replace(/\s+/g, ' ').trim()).get();
      const name = (raw[0] || '').trim();
      const pctTxt = (raw.find((t) => /%$/.test(t)) || '').replace(/[\,\s]/g, '');
      const percent = pctTxt ? Number((pctTxt.match(/([0-9]+(?:\.[0-9]+)?)%?/) || [])[1]) : null;
      if (name) rows.push({ name, percent });
    });
    if (rows.length >= 2) blocks.push({ title, rows });
  });

  if (blocks.length === 0) {
    const rows = [];
    $('.progress-wrapper').each((_, pw) => {
      const label = ($(pw).find('.progress-label').first().text() || '').replace(/\s+/g, ' ').trim();
      const name = (label.match(/^(.+?)\s*\(/) || [])[1] || label;
      let percent = null;
      const pctText = ($(pw).find('.progress-percentage .text-primary').first().text() || '').trim();
      const mp = pctText.match(/([0-9]+(?:\.[0-9]+)?)/);
      if (mp) percent = Number(mp[1]);
      if (name) rows.push({ name, percent });
    });
    if (rows.length >= 2) blocks.push({ title: 'Results', rows });
  }

  if (blocks.length === 0) return null;
  const latest = blocks[blocks.length - 1];
  const rows = latest.rows.slice().sort((a, b) => (b.percent ?? -1) - (a.percent ?? -1)).slice(0, 2);
  return { title: latest.title, rows };
}

function extractNextRaceTime(html) {
  const $ = cheerio.load(html || '');
  const candidates = [];
  $('*').each((_, el) => {
    const t = ($(el).text() || '').replace(/\s+/g, ' ').trim();
    if (/next\s*race|election\s*day|starts\s*in|next\s*round|polls\s*open|polls\s*close/i.test(t)) {
      candidates.push(t);
    }
  });
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0] || null;
}

function findRaceLinkFromStateElections(html, raceLabel) {
  const $ = cheerio.load(html || '');
  const target = String(raceLabel || '').toLowerCase();
  const links = [];
  $('a[href]').each((_, a) => {
    const text = ($(a).text() || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const href = $(a).attr('href') || '';
    if (!/election|senate|govern|house|class\s*[123]/i.test(text)) return;
    if (text.includes(target.split(' ').pop())) links.push(new URL(href, BASE).toString());
  });
  return links.pop() || null;
}

function extractLatestPoll(html, stateName, raceLabel) {
  const $ = cheerio.load(html || '');
  let best = null;
  $('table').each((_, table) => {
    $(table).find('tbody tr').each((__, tr) => {
      const rowText = ($(tr).text() || '').replace(/\s+/g, ' ').trim();
      if (!rowText) return;
      const matchState = stateName ? rowText.toLowerCase().includes(stateName.toLowerCase()) : true;
      const matchRace = raceLabel ? rowText.toLowerCase().includes(raceLabel.toLowerCase()) : true;
      if (!matchState || !matchRace) return;
      const cols = $(tr).find('td').map((i, el) => ($(el).text() || '').replace(/\s+/g, ' ').trim()).get();
      const link = $(tr).find('a[href]').first().attr('href');
      best = { text: rowText, cols, url: link ? new URL(link, BASE).toString() : null };
      return false;
    });
    if (best) return false;
  });
  if (best) return best;
  const tr = $('table tbody tr').first();
  if (tr.length) {
    const rowText = tr.text().replace(/\s+/g, ' ').trim();
    const cols = tr.find('td').map((i, el) => ($(el).text() || '').replace(/\s+/g, ' ').trim()).get();
    const link = tr.find('a[href]').first().attr('href');
    return { text: rowText, cols, url: link ? new URL(link, BASE).toString() : null };
  }
  return null;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('race')
    .setDescription('Show outcome, timing, and latest poll for a state race')
    .addStringOption((opt) => opt.setName('state').setDescription('State code or full name').setRequired(true))
    .addStringOption((opt) => opt.setName('race').setDescription('s1, s2, s3, gov, house').setRequired(true)),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction) {
    const stateRaw = (interaction.options.getString('state') || '').trim();
    const raceRaw = (interaction.options.getString('race') || '').trim();

    if (!stateRaw || !raceRaw) {
      return interaction.reply({ content: 'Provide both a state and a race (s1, s2, s3, gov, house).', ephemeral: true });
    }

    const raceLabel = normalizeRace(raceRaw);
    if (!raceLabel) {
      return interaction.reply({ content: `Unknown race "${raceRaw}". Use s1, s2, s3, gov, or house.`, ephemeral: true });
    }

    const stateName = normalizeStateName(stateRaw);
    if (!stateName) {
      return interaction.reply({ content: `Unknown state "${stateRaw}". Use a two-letter code or full state name.`, ephemeral: true });
    }

    let deferred = false;
    try { await interaction.deferReply(); deferred = true; } catch (e) { if (e?.code === 10062) return; else throw e; }

    let browser = null; let page = null;
    try {
      const session = await authenticateAndNavigate({ url: `${BASE}/national/states`, debug: !!config.debug });
      browser = session.browser; page = session.page;
      let statesHtml = session.html;
      if (!statesHtml || statesHtml.length < 300) {
        const ref = await fetchHtml(page, `${BASE}/national/states`, 'load');
        statesHtml = ref.html;
      }

      const stateId = resolveStateIdFromIndex(statesHtml, stateName);
      if (!stateId) {
        return interaction.editReply({ content: `Could not find a state matching "${stateName}" on the states listing.` });
      }

      const elections = await fetchHtml(page, `${BASE}/states/${stateId}/elections`, 'domcontentloaded');
      const raceLink = findRaceLinkFromStateElections(elections.html, raceLabel);
      if (!raceLink) {
        return interaction.editReply({ content: `Could not find a ${raceLabel} election page for ${stateName}.` });
      }

      const racePage = await fetchHtml(page, raceLink, 'load');
      const latest = pickLatestResults(racePage.html);
      const nextInfo = extractNextRaceTime(racePage.html);

      let pollResult = null;
      const $race = cheerio.load(racePage.html);
      const pollHref = $race('a[href*="poll"]').first().attr('href');
      if (pollHref) {
        const pollPage = await fetchHtml(page, new URL(pollHref, BASE).toString(), 'domcontentloaded');
        pollResult = extractLatestPoll(pollPage.html, stateName, raceLabel);
      }
      if (!pollResult) {
        const fallback = await fetchHtml(page, `${BASE}/elections/polling`, 'domcontentloaded');
        pollResult = extractLatestPoll(fallback.html, stateName, raceLabel);
      }

      const fields = [];
      if (latest && latest.rows.length >= 2) {
        const [a, b] = latest.rows;
        fields.push({ name: 'Latest Finished Round', value: latest.title, inline: false });
        fields.push({ name: 'Candidate A', value: `${a.name}${a.percent != null ? ` — ${a.percent}%` : ''}`, inline: true });
        fields.push({ name: 'Candidate B', value: `${b.name}${b.percent != null ? ` — ${b.percent}%` : ''}`, inline: true });
      } else {
        fields.push({ name: 'Latest Finished Round', value: 'No finished results found yet', inline: false });
      }

      if (nextInfo) fields.push({ name: 'Next Race', value: nextInfo, inline: false });

      if (pollResult) {
        const pollText = pollResult.cols && pollResult.cols.length ? pollResult.cols.join(' | ') : pollResult.text;
        fields.push({ name: 'Most Recent Poll', value: pollText || 'Unknown', inline: false });
        if (pollResult.url) fields.push({ name: 'Poll Link', value: pollResult.url, inline: false });
      } else {
        fields.push({ name: 'Most Recent Poll', value: 'No poll located', inline: false });
      }

      const embed = {
        title: `${stateName} — ${raceLabel}`,
        url: racePage.finalUrl,
        fields,
        footer: { text: new URL(BASE).hostname },
        timestamp: new Date().toISOString(),
      };

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      if (err instanceof PPUSAAuthError) {
        await reportCommandError(interaction, err, { message: err.message, followUp: true });
        return;
      }
      await reportCommandError(interaction, err, { message: `Error: ${err.message}`, meta: { command: 'race' } });
      if (deferred) { try { await interaction.editReply({ content: `Error: ${err.message}` }); } catch (_) {} }
    } finally {
      try { await browser?.close(); } catch {}
    }
  }
};
