// commands/primary.js
// Slash command to view primary race data (Senate Class 1/2/3, Governor, House)
// Usage examples:
//   /primary state:ca race:s1
//   /primary state:california race:gov party:both
//   /primary state:tx race:house party:gop
//
// Handles:
//  - Mapping state code/name to state id (live via /states; fallback to local HTML if present)
//  - Finding the target race block on the state's primaries page
//  - Getting both Dem and GOP primary pages and extracting candidate stats
//  - Empty primaries (0 candidates), missing race for a given state/class, etc.

const { SlashCommandBuilder } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');
const cheerio = require('cheerio');
const { loginAndGet, BASE } = require('../lib/ppusa');

const US_STATE_ABBR = {
  al: 'Alabama', ak: 'Alaska', az: 'Arizona', ar: 'Arkansas', ca: 'California', co: 'Colorado',
  ct: 'Connecticut', de: 'Delaware', fl: 'Florida', ga: 'Georgia', hi: 'Hawaii', id: 'Idaho',
  il: 'Illinois', in: 'Indiana', ia: 'Iowa', ks: 'Kansas', ky: 'Kentucky', la: 'Louisiana',
  me: 'Maine', md: 'Maryland', ma: 'Massachusetts', mi: 'Michigan', mn: 'Minnesota', ms: 'Mississippi',
  mo: 'Missouri', mt: 'Montana', ne: 'Nebraska', nv: 'Nevada', nh: 'New Hampshire', nj: 'New Jersey',
  nm: 'New Mexico', ny: 'New York', nc: 'North Carolina', nd: 'North Dakota', oh: 'Ohio', ok: 'Oklahoma',
  or: 'Oregon', pa: 'Pennsylvania', ri: 'Rhode Island', sc: 'South Carolina', sd: 'South Dakota',
  tn: 'Tennessee', tx: 'Texas', ut: 'Utah', vt: 'Vermont', va: 'Virginia', wa: 'Washington',
  wv: 'West Virginia', wi: 'Wisconsin', wy: 'Wyoming', dc: 'District of Columbia', pr: 'Puerto Rico'
};

const RACE_ALIASES = {
  's1': 'Senate Class 1', 'sen1': 'Senate Class 1', 'senate1': 'Senate Class 1', 'class1': 'Senate Class 1',
  's2': 'Senate Class 2', 'sen2': 'Senate Class 2', 'senate2': 'Senate Class 2', 'class2': 'Senate Class 2',
  's3': 'Senate Class 3', 'sen3': 'Senate Class 3', 'senate3': 'Senate Class 3', 'class3': 'Senate Class 3',
  'gov': 'Governor', 'governor': 'Governor', 'gubernatorial': 'Governor',
  'rep': 'House of Representatives', 'reps': 'House of Representatives', 'house': 'House of Representatives', 'representatives': 'House of Representatives'
};

const PARTY_ALIASES = {
  dem: 'dem', dems: 'dem', d: 'dem', democratic: 'dem', democrat: 'dem',
  gop: 'gop', r: 'gop', rep: 'gop', republican: 'gop', republicans: 'gop',
  both: 'both', all: 'both'
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('primary')
    .setDescription('View a state primary race (Senate class, Governor, or House) and candidate stats')
    .addStringOption(opt =>
      opt.setName('state')
        .setDescription('State code (e.g., ca) or full name')
        .setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('race')
        .setDescription('Race: s1, s2, s3, gov, rep/house')
        .setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('party')
        .setDescription('Filter party: dem, gop, or both (default)')
        .setRequired(false)
        .addChoices(
          { name: 'Both', value: 'both' },
          { name: 'Democratic', value: 'dem' },
          { name: 'Republican', value: 'gop' }
        )
    )
    .addBooleanOption(opt =>
      opt.setName('debug')
        .setDescription('Include diagnostics (ephemeral)')
        .setRequired(false)
    ),

  /**
   * Execute the /primary command
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    const debug = interaction.options.getBoolean('debug') ?? false;
    const stateRaw = (interaction.options.getString('state', true) || '').trim();
    const raceRaw = (interaction.options.getString('race', true) || '').trim();
    const partyRaw = (interaction.options.getString('party') || 'both').trim();

    const party = normalizeParty(partyRaw);
    const raceLabel = normalizeRace(raceRaw);
    const stateName = normalizeStateName(stateRaw);

    if (!raceLabel) return interaction.reply({ content: `Unknown race "${raceRaw}". Try one of: s1, s2, s3, gov, rep/house.`, ephemeral: true });
    if (!stateName) return interaction.reply({ content: `Unknown state "${stateRaw}". Use two-letter code or full state name.`, ephemeral: true });

    await interaction.deferReply();

    let browser, page, finalLogs = [];
    try {
      // 1) Login and load the states index to resolve state id
      const statesUrl = `${BASE}/states`;
      const sess = await loginAndGet(statesUrl);
      browser = sess.browser;
      page = sess.page;
      let statesHtml = sess.html;

      // If the /states page is not the listing we expect, try a fallback fetch of /states again
      if (!looksLikeStatesList(statesHtml)) {
        await page.goto(statesUrl, { waitUntil: 'networkidle2' });
        statesHtml = await page.content();
      }

      let stateId = extractStateIdFromStatesHtml(statesHtml, stateName);

      // Fallback to local HTML (American States) if not found
      if (!stateId) {
        const local = readLocalHtml('American States _ Power Play USA.html');
        if (local) {
          stateId = extractStateIdFromStatesHtml(local, stateName);
          finalLogs.push('Resolved state ID via local American States HTML.');
        }
      }

      if (!stateId) {
        return await interaction.editReply(`Could not find a state matching "${stateName}" on the states listing.`);
      }

      // 2) Go to state primaries page
      const primariesUrl = `${BASE}/states/${stateId}/primaries`;
      await page.goto(primariesUrl, { waitUntil: 'networkidle2' });
      const primariesHtml = await page.content();

      // 3) Find the requested race block, extract Dem/GOP primary links + meta
      const raceInfo = extractRacePrimariesFromStatePage(primariesHtml, raceLabel);
      if (!raceInfo) {
        return await interaction.editReply(`No "${raceLabel}" primary found for ${stateName}.`);
      }

      // 4) For each matched party (or both), fetch details and parse candidates
      const partyTargets = (party === 'both')
        ? ['dem', 'gop']
        : [party];

      const results = [];
      for (const p of partyTargets) {
        const link = p === 'dem' ? raceInfo.dem?.url : raceInfo.gop?.url;
        const label = p === 'dem' ? 'Democratic Primary' : 'Republican Primary';
        const count = p === 'dem' ? raceInfo.dem?.count : raceInfo.gop?.count;
        const deadline = p === 'dem' ? raceInfo.dem?.deadline : raceInfo.gop?.deadline;

        if (!link) {
          results.push({ party: p, label, error: 'No primary link found', candidates: [] });
          continue;
        }

        try {
          if (page.url() !== link) await page.goto(link, { waitUntil: 'networkidle2' });
          const html = await page.content();
          const candidates = extractPrimaryCandidates(html);
          results.push({ party: p, label, url: link, candidates, count, deadline });
        } catch (e) {
          results.push({ party: p, label, url: link, error: e?.message || 'Fetch error', candidates: [] });
        }
      }

      // 5) Build embed
      const embFields = [];
      for (const r of results) {
        let value;
        if (r.error) {
          value = `Error: ${r.error}`;
        } else if (!r.candidates || r.candidates.length === 0) {
          value = 'No candidates filed.';
        } else {
          const lines = r.candidates.map((c, idx) => {
            const metrics = compactMetrics(c.metrics);
            const pct = c.percent != null ? ` – ${c.percent}%` : '';
            return `- ${c.name}${metrics ? ` ${metrics}` : ''}${pct}`;
          });
          value = lines.join('\n');
        }

        const suffix = [];
        if (typeof r.count === 'number') suffix.push(`${r.count} filed`);
        if (r.deadline) suffix.push(`Deadline: ${r.deadline}`);
        if (suffix.length) value += `\n${suffix.join(' | ')}`;

        embFields.push({ name: r.label, value: value || '—' });
      }

      const title = `${stateName} – ${raceLabel}`;
      const embed = {
        title,
        url: primariesUrl,
        fields: embFields,
        footer: { text: new URL(BASE).hostname },
        timestamp: new Date().toISOString(),
      };

      if (debug && finalLogs.length) {
        embFields.push({ name: 'Debug', value: finalLogs.join('\n') });
      }

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      await interaction.editReply(`Error: ${err?.message || String(err)}`);
    } finally {
      try { await browser?.close(); } catch {}
    }
  },
};

function normalizeParty(p) {
  const key = String(p || '').toLowerCase();
  return PARTY_ALIASES[key] || 'both';
}

function normalizeRace(r) {
  const key = String(r || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return RACE_ALIASES[key] || null;
}

function normalizeStateName(s) {
  const raw = String(s || '').trim();
  if (!raw) return null;
  // Try abbr
  const abbr = raw.toLowerCase();
  if (US_STATE_ABBR[abbr]) return US_STATE_ABBR[abbr];
  // Try name normalization
  const name = raw.replace(/\s+/g, ' ').toLowerCase();
  const match = Object.values(US_STATE_ABBR).find(n => n.toLowerCase() === name);
  return match || null;
}

function looksLikeStatesList(html) {
  const $ = cheerio.load(html);
  const title = ($('title').first().text() || '').toLowerCase();
  if (title.includes('american states')) return true;
  // Heuristic: many links to /states/<id>
  const links = $('a[href*="/states/"]').toArray().length;
  return links >= 10; // crude but effective
}

function extractStateIdFromStatesHtml(html, stateName) {
  try {
    const $ = cheerio.load(html);
    // Prefer main listing table anchors where anchor text equals state name
    let id = null;
    $('a[href^="/states/"]').each((_, a) => {
      const href = String($(a).attr('href') || '');
      const text = ($(a).text() || '').trim();
      if (!/^\/states\/\d+/.test(href)) return;
      if (!text) return;
      if (text.toLowerCase() === stateName.toLowerCase()) {
        const m = href.match(/\/states\/(\d+)/);
        if (m) { id = Number(m[1]); return false; }
      }
    });
    if (id) return id;
    // Fallback: look for any heading like "State of X" and pick id from nearby links
    const heading = $('h5,h4,h3').filter((_, el) => /state of/i.test(($(el).text() || ''))).first();
    if (heading.length) {
      const near = heading.closest('.container, .container-fluid').find('a[href^="/states/"]').first();
      const m = String(near.attr('href') || '').match(/\/states\/(\d+)/);
      if (m) return Number(m[1]);
    }
  } catch (_) {}
  return null;
}

function extractRacePrimariesFromStatePage(html, raceLabel) {
  const $ = cheerio.load(html);
  // Find <h4> whose text matches raceLabel
  let raceHeader = null;
  $('h4').each((_, el) => {
    const t = ($(el).text() || '').trim();
    if (t.toLowerCase() === raceLabel.toLowerCase()) { raceHeader = $(el); return false; }
  });
  if (!raceHeader) return null;

  // The table is typically the next table in the same container
  const container = raceHeader.closest('.container, .container-fluid, .bg-white').length
    ? raceHeader.closest('.container, .container-fluid, .bg-white')
    : raceHeader.parent();
  const table = container.find('table').first();
  if (!table.length) return null;

  const result = { dem: null, gop: null };
  table.find('tbody tr').each((_, tr) => {
    const row = $(tr);
    const partyCell = row.find('td').first();
    const a = partyCell.find('a[href*="/primaries/"]').first();
    if (!a.length) return;
    const href = a.attr('href') || '';
    const url = href.startsWith('http') ? href : new URL(href, BASE).toString();
    const m = href.match(/\/primaries\/(\d+)/);
    const id = m ? Number(m[1]) : null;
    const partyText = (a.text() || '').toLowerCase();
    const tds = row.find('td');
    // second cell often contains deadline
    const deadlineText = (tds.eq(1).text() || '').replace(/\s+/g, ' ').trim() || null;
    // third cell is count
    const countText = (tds.eq(2).text() || '').trim();
    const count = countText && /\d+/.test(countText) ? Number(countText.match(/\d+/)[0]) : null;
    const obj = { id, url, deadline: deadlineText, count };
    if (partyText.includes('democrat')) result.dem = obj;
    else if (partyText.includes('republican')) result.gop = obj;
  });

  if (!result.dem && !result.gop) return null;
  return result;
}

function extractPrimaryCandidates(html) {
  const $ = cheerio.load(html);
  // Focus on the statewide results block if present
  let scope = $('#electionresult');
  if (!scope.length) scope = $('body');

  const items = [];
  scope.find('.progress-wrapper').each((_, pw) => {
    const wrap = $(pw);
    const label = wrap.find('.progress-label a').first();
    let nameFull = (label.text() || '').replace(/\s+/g, ' ').trim();
    let name = nameFull;
    let metrics = {};
    // Extract metrics from parentheses: "Name (CO: 20.5, NR: 30.1, AR: 40.0)"
    const m = nameFull.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
    if (m) {
      name = m[1].trim();
      const parts = m[2].split(',').map(s => s.trim());
      for (const part of parts) {
        const mm = part.match(/^(ES|CO|NR|AR)[:\s]+([0-9]+(?:\.[0-9]+)?)$/i);
        if (mm) {
          metrics[mm[1].toUpperCase()] = mm[2];
        }
      }
    }

    // Percent from progress-percentage text or width style
    let percent = null;
    const pctText = (wrap.find('.progress-percentage .text-primary').first().text() || '').trim();
    if (pctText && /[0-9]/.test(pctText)) {
      const mp = pctText.match(/([0-9]+(?:\.[0-9]+)?)/);
      if (mp) percent = mp[1];
    } else {
      const w = wrap.find('.progress-bar').attr('style') || '';
      const mw = w.match(/width:\s*([0-9.]+)%/i);
      if (mw) percent = mw[1];
    }

    if (name) items.push({ name, metrics, percent });
  });

  return items;
}

function compactMetrics(metrics) {
  if (!metrics) return '';
  const parts = [];
  for (const k of ['ES', 'CO', 'NR', 'AR']) {
    if (metrics[k]) parts.push(`${k} ${metrics[k]}`);
  }
  return parts.length ? `(${parts.join(', ')})` : '';
}

function readLocalHtml(filename) {
  try {
    const p = path.join(process.cwd(), filename);
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  } catch (_) {}
  return null;
}

/**
 * Project: DemBot (Discord automation for Power Play USA)
 * File: commands/primary.js
 * Purpose: View state primary races and candidate stats (Dem/GOP)
 * Author: egg3901
 * Created: 2025-10-16
 * Last Updated: 2025-10-16
 */

