// commands/primary.js
// Slash command: view a state's primary race (Senate classes, Governor, House) and candidate stats.
// Examples:
//   /primary state:ca race:s3
//   /primary state:california race:gov party:both
//   /primary state:tx race:house party:gop

const { SlashCommandBuilder } = require('discord.js');
const cheerio = require('cheerio');
const { authenticateAndNavigate, PPUSAAuthError } = require('../lib/ppusa-auth');
const { config, toAbsoluteUrl } = require('../lib/ppusa-config');
const { recordCommandError } = require('../lib/status-tracker');

const BASE = config.baseUrl;

// We deliberately authenticate first against a protected page (party treasury)
// because /national/states may NOT redirect when unauthenticated.
// This mirrors the working pattern in treasury.js.
const PROTECTED_LOGIN_URL = toAbsoluteUrl('/parties/1/treasury');

// National states list, used to resolve state -> numeric id
const STATES_INDEX_URL = toAbsoluteUrl('/national/states');

// Race aliases found in site headers/tables
const RACE_ALIASES = {
  s1: 'Senate Class 1', sen1: 'Senate Class 1', senate1: 'Senate Class 1', class1: 'Senate Class 1',
  s2: 'Senate Class 2', sen2: 'Senate Class 2', senate2: 'Senate Class 2', class2: 'Senate Class 2',
  s3: 'Senate Class 3', sen3: 'Senate Class 3', senate3: 'Senate Class 3', class3: 'Senate Class 3',
  gov: 'Governor', governor: 'Governor', gubernatorial: 'Governor',
  rep: 'House of Representatives', reps: 'House of Representatives', house: 'House of Representatives', representatives: 'House of Representatives',
};

const PARTY_ALIASES = {
  dem: 'dem', dems: 'dem', d: 'dem', democratic: 'dem', democrat: 'dem',
  gop: 'gop', r: 'gop', rep: 'gop', republican: 'gop', republicans: 'gop',
  both: 'both', all: 'both',
};

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

module.exports = {
  data: new SlashCommandBuilder()
    .setName('primary')
    .setDescription('View a state primary race (Senate class, Governor, or House) and candidate stats')
    .addStringOption(o =>
      o.setName('state').setDescription('State code (e.g., ca) or full name').setRequired(true))
    .addStringOption(o =>
      o.setName('race').setDescription('Race: s1, s2, s3, gov, rep/house').setRequired(true))
    .addStringOption(o =>
      o.setName('party')
        .setDescription('Filter party: dem, gop, or both (default)')
        .setRequired(false)
        .addChoices(
          { name: 'Both', value: 'both' },
          { name: 'Democratic', value: 'dem' },
          { name: 'Republican', value: 'gop' },
        ))
    .addBooleanOption(o =>
      o.setName('debug').setDescription('Include diagnostics (ephemeral)').setRequired(false)),
  
  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction) {
    const debug = interaction.options.getBoolean('debug') ?? false;
    const stateRaw = (interaction.options.getString('state', true) || '').trim();
    const raceRaw  = (interaction.options.getString('race',  true) || '').trim();
    const partyRaw = (interaction.options.getString('party') || 'both').trim();

    const party = normalizeParty(partyRaw);
    const raceLabel = normalizeRace(raceRaw);
    const stateName = normalizeStateName(stateRaw);

    if (!raceLabel) {
      return interaction.reply({ content: `Unknown race "${raceRaw}". Try: s1, s2, s3, gov, rep/house.`, ephemeral: true });
    }
    if (!stateName) {
      return interaction.reply({ content: `Unknown state "${stateRaw}". Use two-letter code or full state name.`, ephemeral: true });
    }

    let deferred = false;
    try { await interaction.deferReply(); deferred = true; } catch (e) {
      if (e?.code === 10062) { console.warn('primary: token expired before defer.'); return; }
      throw e;
    }

    const logs = [];
    const note = (m) => { if (m) logs.push(m); };

    /** Browser/session lifecycle is owned by authenticateAndNavigate */
    let browser, page;
    try {
      // Step 1: Authenticate via a protected URL (guaranteed login flow), then reuse that session.
      const auth = await authenticateAndNavigate({ url: PROTECTED_LOGIN_URL, debug });
      browser = auth.browser;
      page = auth.page;
      note(`Authenticated via ${auth.finalUrl || PROTECTED_LOGIN_URL}`);

      // Step 2: Open the national states index (list of states with links to /states/{id})
      await page.goto(STATES_INDEX_URL, { waitUntil: 'domcontentloaded' });
      await safeWaitFor(page, 'a[href^="/states/"]', 8000).catch(() => {});
      const statesHtml = await page.content();
      note(`Loaded ${STATES_INDEX_URL} (len=${(statesHtml || '').length})`);

      // Step 3: Resolve state id from index page
      const stateId = resolveStateIdFromIndex(statesHtml, stateName);
      if (!stateId) {
        throw new Error(`Could not find a state matching "${stateName}" on the states listing.`);
      }
      note(`Resolved state id: ${stateId}`);

      // Step 4: Navigate to the state's primaries page
      const primariesUrl = toAbsoluteUrl(`/states/${stateId}/primaries`);
      await page.goto(primariesUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(200); // minor paint settle
      const primariesHtml = await page.content();
      note(`Loaded ${primariesUrl} (len=${(primariesHtml || '').length})`);

      // Step 5: Extract Dem/GOP primary links + counts/deadlines for the chosen race
      const raceInfo = extractRacePrimariesFromStatePage(primariesHtml, raceLabel);
      if (!raceInfo) {
        throw new Error(`No "${raceLabel}" primary found for ${stateName}.`);
      }

      // Step 6: Visit each party primary page and parse candidate blocks
      const parties = party === 'both' ? ['dem', 'gop'] : [party];
      const results = [];
      for (const p of parties) {
        const link = p === 'dem' ? raceInfo.dem?.url : raceInfo.gop?.url;
        const count = p === 'dem' ? raceInfo.dem?.count : raceInfo.gop?.count;
        const deadline = p === 'dem' ? raceInfo.dem?.deadline : raceInfo.gop?.deadline;
        const label = p === 'dem' ? 'Democratic Primary' : 'Republican Primary';

        if (!link) {
          results.push({ party: p, label, error: 'No primary link found', candidates: [], count, deadline });
          continue;
        }

        try {
          await page.goto(link, { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(150);
          const html = await page.content();
          const candidates = extractPrimaryCandidates(html);
          results.push({ party: p, label, url: link, candidates, count, deadline });
        } catch (err) {
          results.push({ party: p, label, url: link, error: err?.message || 'Fetch error', candidates: [], count, deadline });
        }
      }

      // Step 7: Build the embed
      const fields = [];
      for (const r of results) {
        let value;
        if (r.error) value = `Error: ${r.error}`;
        else if (!r.candidates || r.candidates.length === 0) value = 'No candidates filed.';
        else {
          value = r.candidates.map((c) => {
            const metrics = compactMetrics(c.metrics);
            const pct = c.percent != null ? ` – ${c.percent}%` : '';
            return `- ${c.name}${metrics ? ` ${metrics}` : ''}${pct}`;
          }).join('\n');
        }

        const suffix = [];
        if (typeof r.count === 'number') suffix.push(`${r.count} filed`);
        if (r.deadline) suffix.push(`Deadline: ${r.deadline}`);
        if (suffix.length) value += `\n${suffix.join(' | ')}`;

        fields.push({ name: r.label, value: value || '—' });
      }

      const embed = {
        title: `${stateName} – ${raceLabel}`,
        url: toAbsoluteUrl(`/states/${stateId}/primaries`),
        fields,
        footer: { text: new URL(BASE).hostname },
        timestamp: new Date().toISOString(),
      };

      // Optional compact debug trail
      if (debug && logs.length) {
        const snippet = logs.slice(-10).join('\n').slice(-950);
        fields.push({ name: 'Debug', value: (snippet.length < logs.join('\n').length ? `…${snippet}` : snippet) || '-' });
      }

      try { await interaction.editReply({ embeds: [embed] }); }
      catch (e) {
        if (e?.code !== 10062) throw e;
        console.warn('primary: interaction expired before editReply.');
      }
    } catch (err) {
      recordCommandError(interaction.commandName, err);
      const isAuth = err instanceof PPUSAAuthError;
      const msg = isAuth
        ? formatAuthErrorMessage(err, '/primary')
        : `Error: ${err.message}`;
      if (deferred) {
        try { await interaction.editReply({ content: withDebug(msg, debug, logs) }); }
        catch (e) {
          if (e?.code !== 10062) throw e;
          console.warn('primary: interaction expired while sending error.');
        }
      }
    } finally {
      try { await page?.browser()?.close?.(); } catch {}
    }
  },
};

/* -------------------------- helpers -------------------------- */

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
  const key = raw.toLowerCase();
  if (US_STATE_ABBR[key]) return US_STATE_ABBR[key];

  // Common short forms
  const alias = new Map([
    ['cal', 'California'], ['cali', 'California'],
    ['wash', 'Washington'], ['wash state', 'Washington'],
    ['mass', 'Massachusetts'], ['jersey', 'New Jersey'],
    ['carolina', 'North Carolina'], // heuristic
    ['dc', 'District of Columbia'], ['d.c.', 'District of Columbia'], ['d c', 'District of Columbia'],
    ['pr', 'Puerto Rico'],
  ]);
  if (alias.has(key)) return alias.get(key);

  const name = raw
    .replace(/^\s+|\s+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^(state|commonwealth|territory)\s+of\s+/i, '')
    .toLowerCase();

  const match = Object.values(US_STATE_ABBR).find(n => n.toLowerCase() === name);
  return match || null;
}

// Extract state id from the national states listing (anchors to /states/{id})
function resolveStateIdFromIndex(html, stateName) {
  const $ = cheerio.load(html || '');
  const norm = (t) => String(t || '')
    .replace(/\u00A0/g, ' ')
    .normalize('NFKD')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^(state|commonwealth|territory)\s+of\s+/i, '');

  const target = norm(stateName);

  // Prefer explicit /states/{id} anchors whose text (or nearby text) matches the state name.
  let found = null;
  $('a[href^="/states/"]').each((_, a) => {
    if (found) return;
    const href = String($(a).attr('href') || '');
    const m = href.match(/\/states\/(\d+)\b/);
    if (!m) return;

    const texts = [
      ($(a).text() || '').trim(),
      $(a).attr('title') || '',
      $(a).closest('tr,li,div').text().trim(),
    ].filter(Boolean);

    for (const t of texts) {
      const nt = norm(t);
      if (nt === target || nt.includes(target) || target.includes(nt)) {
        found = Number(m[1]);
        break;
      }
    }
  });

  return found;
}

// Parse the primaries page for a given race header and collect party links/counts/deadlines.
function extractRacePrimariesFromStatePage(html, raceLabel) {
  const $ = cheerio.load(html || '');

  // Find an <h4> whose text equals the race label (as shown on site)
  let header = null;
  $('h4').each((_, el) => {
    const t = ($(el).text() || '').trim();
    if (t.toLowerCase() === String(raceLabel).toLowerCase()) { header = $(el); return false; }
  });
  if (!header) return null;

  const container = header.closest('.container, .container-fluid, .bg-white').length
    ? header.closest('.container, .container-fluid, .bg-white')
    : header.parent();

  const table = container.find('table').first();
  if (!table.length) return null;

  const result = { dem: null, gop: null };
  table.find('tbody tr').each((_, tr) => {
    const row = $(tr);
    const firstTd = row.find('td').first();
    const a = firstTd.find('a[href*="/primaries/"]').first();
    if (!a.length) return;

    const href = a.attr('href') || '';
    const url = href.startsWith('http') ? href : toAbsoluteUrl(href);
    const partyText = (a.text() || '').toLowerCase();
    const tds = row.find('td');

    const deadlineText = (tds.eq(1).text() || '').replace(/\s+/g, ' ').trim() || null;
    const countText = (tds.eq(2).text() || '').trim();
    const count = countText && /\d+/.test(countText) ? Number((countText.match(/\d+/) || [])[0]) : null;

    const obj = { url, deadline: deadlineText, count };
    if (partyText.includes('democrat')) result.dem = obj;
    if (partyText.includes('republican')) result.gop = obj;
  });

  if (!result.dem && !result.gop) return null;
  return result;
}

// Parse a party primary page and pull candidate blocks (name, metrics, %, etc.)
function extractPrimaryCandidates(html) {
  const $ = cheerio.load(html || '');
  let scope = $('#electionresult');
  if (!scope.length) scope = $('body');

  const items = [];
  scope.find('.progress-wrapper').each((_, el) => {
    const wrap = $(el);
    const label = wrap.find('.progress-label a').first();
    let full = (label.text() || '').replace(/\s+/g, ' ').trim();

    let name = full;
    const metrics = {};

    // Pattern: "Name (CO: 20.5, NR: 30.1, AR: 40.0, ES: 12.3)"
    const m = full.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
    if (m) {
      name = m[1].trim();
      const parts = m[2].split(',').map(s => s.trim());
      for (const part of parts) {
        const mm = part.match(/^(ES|CO|NR|AR)\s*[:]\s*([0-9]+(?:\.[0-9]+)?)$/i);
        if (mm) metrics[mm[1].toUpperCase()] = mm[2];
      }
    }

    // Percent from text or width style
    let percent = null;
    const pctText = (wrap.find('.progress-percentage .text-primary').first().text() || '').trim();
    if (/\d/.test(pctText)) {
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
  const order = ['ES', 'CO', 'NR', 'AR'];
  const parts = order.filter(k => metrics[k]).map(k => `${k} ${metrics[k]}`);
  return parts.length ? `(${parts.join(', ')})` : '';
}

function withDebug(message, debug, logs) {
  if (!debug || !logs?.length) return message;
  const joined = logs.join('\n');
  const clipped = joined.length > 1500 ? `…${joined.slice(-1500)}` : joined;
  return `${message}\n\nDebug:\n${clipped}`;
}

async function safeWaitFor(page, selector, timeoutMs) {
  try { await page.waitForSelector(selector, { timeout: timeoutMs }); }
  catch (_) {}
}

function formatAuthErrorMessage(err, cmdLabel) {
  if (!(err instanceof PPUSAAuthError)) return `Error: ${err.message}`;
  const d = err.details || {};
  const lines = [`Error: ${err.message}`];
  if (d.finalUrl) lines.push(`Page: ${d.finalUrl}`);
  if (d.challenge === 'cloudflare-turnstile') {
    lines.push('Cloudflare Turnstile is blocking automated login.');
    lines.push('Workaround: sign in manually, copy your ppusa session cookie into PPUSA_COOKIE, then restart.');
  }
  lines.push(`Tip: run ${cmdLabel} debug:true to include a debug trail.`);
  return lines.join('\n');
}
