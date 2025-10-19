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
const { getDebugChoice, reportCommandError } = require('../lib/command-utils');

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
    const { requested: requestedDebug, enabled: debug, denied: debugDenied, allowed: debugAllowed } = getDebugChoice(interaction);
    const stateRaw = (interaction.options.getString('state', true) || '').trim();
    const raceRaw = (interaction.options.getString('race', true) || '').trim();
    const partyRaw = (interaction.options.getString('party') || 'both').trim();

    const party = normalizeParty(partyRaw);
    const raceLabel = normalizeRace(raceRaw);
    const stateName = normalizeStateName(stateRaw);

    if (!raceLabel) return interaction.reply({ content: `Unknown race "${raceRaw}". Try one of: s1, s2, s3, gov, rep/house.`, ephemeral: true });
    if (!stateName) return interaction.reply({ content: `Unknown state "${stateRaw}". Use two-letter code or full state name.`, ephemeral: true });

    await interaction.deferReply();

    let browser;
    let page;
    const finalLogs = [];
    const addLog = (msg) => { if (msg) finalLogs.push(msg); };
    let stage = 'init';
    let stateId = null;
    let primariesUrl = null;
    let results = [];
    try {
      // 1) Login and load the states index to resolve state id
      const statesUrl = `${BASE}/states`;
      const sess = await loginAndGet(statesUrl);
      browser = sess.browser;
      page = sess.page;
      let statesHtml = sess.html;
      addLog(`Fetched /states (length=${statesHtml?.length || 0})`);
      stage = 'resolve_state_id';

      // If the /states page is not the listing we expect, try a fallback fetch of /states again
      if (!looksLikeStatesList(statesHtml)) {
        addLog('Initial /states page did not match list heuristic; retrying with live navigation.');
        await page.goto(statesUrl, { waitUntil: 'networkidle2' });
        statesHtml = await page.content();
        addLog(`Fetched /states via direct goto (length=${statesHtml?.length || 0})`);
      }

      stateId = extractStateIdFromStatesHtml(statesHtml, stateName);
      if (stateId) addLog(`Resolved state ID ${stateId} from initial HTML match.`);

      // Try a live DOM extraction (after scripts run) if not found
      if (!stateId) {
        try {
          const target = normalizeStateName(stateName);
          const idLive = await page.evaluate((targetName) => {
            const norm = (txt) => String(txt || '')
              .replace(/\u00A0/g, ' ')
              .normalize('NFKD')
              .trim().toLowerCase()
              .replace(/\s+/g, ' ')
              .replace(/^(state|commonwealth|territory)\s+of\s+/i, '')
              .replace(/\s*\(.*?\)\s*$/, '')
              .trim();
            const anchors = Array.from(document.querySelectorAll('a[href^="/states/"]'));
            for (const a of anchors) {
              const href = a.getAttribute('href') || '';
              const text = (a.textContent || '').trim();
              if (!/^\/states\/\d+/.test(href)) continue;
              if (!text) continue;
              if (norm(text) === norm(targetName)) {
                const m = href.match(/\/states\/(\d+)/);
                if (m) return Number(m[1]);
              }
            }
            return null;
          }, stateName);
          if (idLive) {
            stateId = idLive;
            addLog(`Resolved state ID ${stateId} via live DOM evaluation.`);
          }
        } catch (_) {}
      }

      // Fallback to local HTML (try any saved States listing in repo root) if not found
      if (!stateId) {
        const candidates = [
          'American States _ Power Play USA.html',
          'Power Play USA.html',
          'American States _ Power Play USA.mhtml',
        ];
        let local = null;
        for (const fname of candidates) {
          const html = readLocalHtml(fname);
          if (html && looksLikeStatesList(html)) { local = html; addLog(`Loaded local fallback states HTML: ${fname}`); break; }
        }
        if (!local) {
          // As a last resort, scan cwd for any .html containing many /states/<id> links
          try {
            const dir = process.cwd();
            const files = fs.readdirSync(dir).filter(f => /\.html?$/i.test(f));
            for (const f of files) {
              const html = readLocalHtml(f);
              if (html && looksLikeStatesList(html)) { local = html; addLog(`Loaded local fallback states HTML via directory scan: ${f}`); break; }
            }
          } catch (_) {}
        }
        if (local) {
          stateId = extractStateIdFromStatesHtml(local, stateName);
          if (stateId) addLog(`Resolved state ID ${stateId} via local saved States HTML.`);
        }
      }

      if (!stateId) {
        await reportCommandError(interaction, new Error('State lookup failed'), {
          message: `Could not find a state matching "${stateName}" on the states listing.`,
          meta: {
            reason: 'state_id_not_found',
            stateRaw,
            stateName,
            race: raceLabel,
            party,
            stage,
            logs: finalLogs.slice(-20),
            debugRequested: requestedDebug,
            debugAllowed,
          },
        });
        return;
      }
      addLog(`State ID confirmed: ${stateId}.`);

      // 2) Go to state page first, then primaries page
      const stateUrl = `${BASE}/states/${stateId}`;
      try {
        stage = 'visit_state_page';
        await page.goto(stateUrl, { waitUntil: 'networkidle2' });
        addLog(`Visited state page: ${stateUrl}`);
      } catch (e) {
        addLog(`State page visit error: ${e?.message || e}`);
      }
      primariesUrl = `${BASE}/states/${stateId}/primaries`;
      stage = 'visit_primaries_page';
      await page.goto(primariesUrl, { waitUntil: 'networkidle2' });
      const primariesHtml = await page.content();
      addLog(`Loaded primaries page: ${primariesUrl} (length=${primariesHtml?.length || 0})`);

      // 3) Find the requested race block, extract Dem/GOP primary links + meta
      const raceInfo = extractRacePrimariesFromStatePage(primariesHtml, raceLabel);
      if (!raceInfo) {
        await reportCommandError(interaction, new Error('Primary race not found'), {
          message: `No "${raceLabel}" primary found for ${stateName}.`,
          meta: {
            reason: 'primary_race_missing',
            stateName,
            stateId,
            primariesUrl,
            race: raceLabel,
            party,
            stage,
            logs: finalLogs.slice(-20),
            hasDemLink: Boolean(raceInfo?.dem),
            hasGopLink: Boolean(raceInfo?.gop),
            debugRequested: requestedDebug,
            debugAllowed,
          },
        });
        return;
      }
      addLog(`Race "${raceLabel}" found. Dem link: ${raceInfo.dem?.url || 'none'}, GOP link: ${raceInfo.gop?.url || 'none'}.`);

      // 4) For each matched party (or both), fetch details and parse candidates
      const partyTargets = (party === 'both')
        ? ['dem', 'gop']
        : [party];

      results = [];
      for (const p of partyTargets) {
        const link = p === 'dem' ? raceInfo.dem?.url : raceInfo.gop?.url;
        const label = p === 'dem' ? 'Democratic Primary' : 'Republican Primary';
        const count = p === 'dem' ? raceInfo.dem?.count : raceInfo.gop?.count;
        const deadline = p === 'dem' ? raceInfo.dem?.deadline : raceInfo.gop?.deadline;

        if (!link) {
          addLog(`No ${label} link present.`);
          results.push({ party: p, label, error: 'No primary link found', candidates: [] });
          continue;
        }

        try {
          stage = `visit_${p}_primary`;
          if (page.url() !== link) await page.goto(link, { waitUntil: 'networkidle2' });
          const html = await page.content();
          addLog(`Fetched ${label} page (${link}) length=${html?.length || 0}.`);
          const candidates = extractPrimaryCandidates(html);
          results.push({ party: p, label, url: link, candidates, count, deadline });
        } catch (e) {
          addLog(`Error fetching ${label} at ${link}: ${e?.message || e}`);
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
        const clipped = finalLogs.slice(-10);
        let joined = clipped.join('\n');
        if (joined.length > 950) {
          joined = joined.slice(joined.length - 950);
          joined = `…${joined}`;
        }
        embFields.push({ name: 'Debug', value: joined });
      }

      await interaction.editReply({ embeds: [embed] });
      if (debugDenied && requestedDebug) {
        try {
          await interaction.followUp({ content: 'Debug output is restricted to authorized users.', ephemeral: true });
        } catch (followErr) {
          if (followErr?.code !== 10062) console.warn('primary: failed to send debug denial follow-up:', followErr);
        }
      }
    } catch (err) {
      await reportCommandError(interaction, err, {
        message: `Error: ${err?.message || String(err)}`,
        meta: {
          reason: 'primary_command_exception',
          stateRaw,
          stateName,
          stateId,
          raceRaw,
          race: raceLabel,
          party,
          primariesUrl,
          stage,
          logs: finalLogs.slice(-20),
          debugRequested: requestedDebug,
          debugAllowed,
          resultsSummary: Array.isArray(results)
            ? results.map((r) => ({
                party: r.party,
                label: r.label,
                candidates: r.candidates?.length ?? 0,
                error: r.error || null,
              }))
            : null,
        },
      });
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
  // Try name normalization (strip prefixes like "State of ")
  const name = raw
    .replace(/^\s+|\s+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^(state|commonwealth|territory)\s+of\s+/i, '')
    .toLowerCase();
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
    const normalizeText = (txt) => String(txt || '')
      .replace(/\u00A0/g, ' ')
      .normalize('NFKD')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/^(state|commonwealth|territory)\s+of\s+/i, '')
      .replace(/\s*\(.*?\)\s*$/, '')
      .trim();

    const target = normalizeText(stateName);

    $('a[href^="/states/"]').each((_, a) => {
      const href = String($(a).attr('href') || '');
      const text = ($(a).text() || '').trim();
      if (!/^\/states\/\d+/.test(href)) return;
      if (!text) return;
      const normText = normalizeText(text);
      if (normText === target || normText.includes(target) || target.includes(normText)) {
        const m = href.match(/\/states\/(\d+)/);
        if (m) { id = Number(m[1]); return false; }
      }
    });
    if (id) return id;
    // Fallback: look for any heading like "State of X" and pick id from nearby links
    const heading = $('h5,h4,h3').filter((_, el) => normalizeText($(el).text()) === target).first();
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
