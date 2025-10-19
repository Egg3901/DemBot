// commands/primary.js
// View a state primary race (Senate class 1/2/3, Governor, House) and candidate stats.
// Examples:
//   /primary state:ca race:s1
//   /primary state:california race:gov party:both
//   /primary state:tx race:house party:gop

const { SlashCommandBuilder } = require('discord.js');
const cheerio = require('cheerio');
const fs = require('node:fs');
const path = require('node:path');

const { authenticateAndNavigate, PPUSAAuthError } = require('../lib/ppusa-auth');
const { config, toAbsoluteUrl } = require('../lib/ppusa-config');
const { recordCommandError } = require('../lib/status-tracker');

const BASE = config.baseUrl;

// ---- URLs (match the live game) ----
const STATES_INDEX_URL = toAbsoluteUrl('/national/states');    // <-- states list lives here
const STATE_URL = (id) => toAbsoluteUrl(`/states/${id}`);
const PRIMARIES_URL = (id) => toAbsoluteUrl(`/states/${id}/primaries`);

// ---- Mappings & helpers ----
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

const DEFAULT_DEBUG = config.debug === true;

// Small utility: wait without using page.waitForTimeout
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- Debug formatting (matches treasury style) ----------
const buildDebugArtifacts = (enabled, data) => {
  if (!enabled || !data) return { suffix: '', files: undefined };
  const payload = JSON.stringify(data, null, 2);
  if (payload.length > 1500) {
    return {
      suffix: '\n\nDebug details attached (primary_debug.json)',
      files: [{ attachment: Buffer.from(payload, 'utf8'), name: 'primary_debug.json' }],
    };
  }
  return { suffix: `\n\nDebug: ${payload}` };
};

const formatAuthErrorMessage = (err) => {
  if (!(err instanceof PPUSAAuthError)) return `Error: ${err.message}`;
  const details = err.details || {};
  const lines = [`Error: ${err.message}`];
  if (details.finalUrl) lines.push(`Page: ${details.finalUrl}`);
  if (Array.isArray(details.actions) && details.actions.length) {
    const last = details.actions[details.actions.length - 1];
    lines.push(`Last recorded step: ${last.step || 'unknown'} (${last.success ? 'ok' : 'failed'})`);
  }
  if (details.challenge === 'cloudflare-turnstile') {
    lines.push('Cloudflare Turnstile is blocking automated login.');
    lines.push('Workaround: log in manually, copy the ppusa session cookie into PPUSA_COOKIE env, restart the bot.');
  }
  return lines.join('\n');
};

// ---------- Parsing ----------
function normalizeState(stateRaw) {
  const raw = String(stateRaw || '').trim();
  if (!raw) return null;
  const abbr = raw.toLowerCase();
  if (US_STATE_ABBR[abbr]) return US_STATE_ABBR[abbr];

  const alias = new Map([
    ['cal', 'California'],
    ['cali', 'California'],
    ['wash', 'Washington'],
    ['wash state', 'Washington'],
    ['mass', 'Massachusetts'],
    ['jersey', 'New Jersey'],
    ['carolina', 'North Carolina'],
    ['dc', 'District of Columbia'],
    ['d.c.', 'District of Columbia'],
    ['d.c', 'District of Columbia'],
    ['d c', 'District of Columbia'],
    ['pr', 'Puerto Rico'],
  ]);
  if (alias.has(abbr)) return alias.get(abbr);

  const name = raw
    .replace(/^\s+|\s+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^(state|commonwealth|territory)\s+of\s+/i, '')
    .replace(/\b(st|st\.)\b/ig, 'saint')
    .toLowerCase();

  const match = Object.values(US_STATE_ABBR).find((n) => n.toLowerCase() === name);
  return match || null;
}

function normalizeRace(raceRaw) {
  const k = String(raceRaw || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return RACE_ALIASES[k] || null;
}

function normalizeParty(partyRaw) {
  const k = String(partyRaw || '').toLowerCase();
  return PARTY_ALIASES[k] || 'both';
}

// Find state id on /national/states
function extractStateIdFromIndex(html, targetStateName) {
  const $ = cheerio.load(html || '');
  const norm = (s) => String(s || '')
    .replace(/\u00A0/g, ' ')
    .normalize('NFKD')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');

  const target = norm(targetStateName);

  // Look for anchor text that matches state name; href like /states/5
  let stateId = null;
  $('a[href^="/states/"]').each((_, a) => {
    const href = String($(a).attr('href') || '');
    const text = norm($(a).text() || '');
    const m = href.match(/\/states\/(\d+)\b/);
    if (!m) return;

    if (text && (text === target || text.includes(target) || target.includes(text))) {
      stateId = Number(m[1]);
      return false;
    }
  });

  if (stateId) return stateId;

  // Fallback: any heading matching target, then nearest /states/<id> link
  const heading = $('h5,h4,h3').filter((_, el) => norm($(el).text()) === target).first();
  if (heading.length) {
    const near = heading.closest('.container, .container-fluid, .row').find('a[href^="/states/"]').first();
    const m = String(near.attr('href') || '').match(/\/states\/(\d+)\b/);
    if (m) return Number(m[1]);
  }

  return null;
}

// Find the race block + dem/gop rows on the state primaries page
function extractRacePrimariesFromStatePage(html, raceLabel) {
  const $ = cheerio.load(html || '');
  const raceName = String(raceLabel || '').trim().toLowerCase();

  // Locate the <h4> == raceName, then use first table in same container
  let raceHeader = null;
  $('h4').each((_, el) => {
    const t = ($(el).text() || '').trim().toLowerCase();
    if (t === raceName) { raceHeader = $(el); return false; }
  });
  if (!raceHeader) return null;

  const container = raceHeader.closest('.container, .container-fluid, .bg-white').length
    ? raceHeader.closest('.container, .container-fluid, .bg-white')
    : raceHeader.parent();

  const table = container.find('table').first();
  if (!table.length) return null;

  const result = { dem: null, gop: null };
  table.find('tbody tr').each((_, tr) => {
    const row = $(tr);
    const a = row.find('a[href*="/primaries/"]').first();
    if (!a.length) return;
    const href = a.attr('href') || '';
    const url = href.startsWith('http') ? href : new URL(href, BASE).toString();
    const tds = row.find('td');

    const partyText = (a.text() || '').toLowerCase();
    const deadlineText = (tds.eq(1).text() || '').replace(/\s+/g, ' ').trim() || null;
    const countText = (tds.eq(2).text() || '').trim();
    const count = countText && /\d+/.test(countText) ? Number(countText.match(/\d+/)[0]) : null;

    const obj = { url, deadline: deadlineText, count };
    if (partyText.includes('democrat')) result.dem = obj;
    else if (partyText.includes('republican')) result.gop = obj;
  });

  if (!result.dem && !result.gop) return null;
  return result;
}

// Parse a specific party primary page for candidates
function extractPrimaryCandidates(html) {
  const $ = cheerio.load(html || '');
  let scope = $('#electionresult');
  if (!scope.length) scope = $('body');

  const candidates = [];
  // Primary candidate list commonly rendered as ".progress-wrapper"
  scope.find('.progress-wrapper').each((_, el) => {
    const wrap = $(el);
    const label = wrap.find('.progress-label a, .progress-label').first();
    let nameFull = (label.text() || '').replace(/\s+/g, ' ').trim();
    if (!nameFull) return;

    let name = nameFull;
    const metrics = {};

    // Look for metrics in parentheses e.g. "(CO: 20.5, NR: 30.1, AR: 40.0)"
    const m = nameFull.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
    if (m) {
      name = m[1].trim();
      const parts = m[2].split(',').map((s) => s.trim());
      for (const part of parts) {
        const mm = part.match(/^(ES|CO|NR|AR)[:\s]+([0-9]+(?:\.[0-9]+)?)$/i);
        if (mm) metrics[mm[1].toUpperCase()] = mm[2];
      }
    }

    // Percent either in ".progress-percentage .text-primary" or via "style=width:%"
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

    candidates.push({ name, metrics, percent });
  });

  return candidates;
}

function compactMetrics(metrics) {
  if (!metrics) return '';
  const order = ['ES', 'CO', 'NR', 'AR'];
  const bits = [];
  for (const k of order) if (metrics[k]) bits.push(`${k} ${metrics[k]}`);
  return bits.length ? `(${bits.join(', ')})` : '';
}

// ---------- Fetchers ----------
async function fetchHtmlWithSession(url, sessionPage, waitFor = 'domcontentloaded') {
  // Reuse the already-authenticated page/session
  await sessionPage.goto(url, { waitUntil: waitFor }).catch(() => {});
  // Give SPAs a tiny chance to render anchors/text without relying on page.waitForTimeout
  await delay(150);
  return { html: await sessionPage.content(), finalUrl: sessionPage.url() };
}

// ---------- Command ----------
module.exports = {
  data: new SlashCommandBuilder()
    .setName('primary')
    .setDescription('View a state primary race and candidate stats')
    .addStringOption((o) =>
      o.setName('state')
        .setDescription('State code (e.g., ca) or full name')
        .setRequired(true),
    )
    .addStringOption((o) =>
      o.setName('race')
        .setDescription('Race: s1, s2, s3, gov, rep/house')
        .setRequired(true),
    )
    .addStringOption((o) =>
      o.setName('party')
        .setDescription('Filter party: dem, gop, or both (default: both)')
        .addChoices(
          { name: 'Both', value: 'both' },
          { name: 'Democratic', value: 'dem' },
          { name: 'Republican', value: 'gop' },
        )
        .setRequired(false),
    )
    .addBooleanOption((o) =>
      o.setName('debug')
        .setDescription('Include diagnostics (ephemeral)')
        .setRequired(false),
    ),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction) {
    const userDebug = interaction.options.getBoolean('debug') ?? false;
    const debugFlag = userDebug || DEFAULT_DEBUG;

    const stateInput = interaction.options.getString('state', true);
    const raceInput = interaction.options.getString('race', true);
    const partyInput = interaction.options.getString('party') ?? 'both';

    const stateName = normalizeState(stateInput);
    const raceLabel = normalizeRace(raceInput);
    const party = normalizeParty(partyInput);

    if (!raceLabel) {
      return interaction.reply({ content: `Unknown race "${raceInput}". Try one of: s1, s2, s3, gov, rep/house.`, ephemeral: true });
    }
    if (!stateName) {
      return interaction.reply({ content: `Unknown state "${stateInput}". Use two-letter code or full state name.`, ephemeral: true });
    }

    let deferred = false;
    try {
      await interaction.deferReply();
      deferred = true;
    } catch (err) {
      if (err?.code === 10062) {
        console.warn('primary: interaction token expired before defer; skipping response.');
        return;
      }
      throw err;
    }

    let browser = null;
    let page = null;

    try {
      // 1) Login and land on /national/states (reuses the same login flow as treasury)
      const session = await authenticateAndNavigate({ url: STATES_INDEX_URL, debug: debugFlag });
      browser = session.browser;
      page = session.page;
      let { html: statesHtml, finalUrl: statesFinalUrl } = session;

      // Heuristic: if content looks tiny (blocked/interstitial), retry with a direct goto
      if ((statesHtml || '').length < 400) {
        const refetch = await fetchHtmlWithSession(STATES_INDEX_URL, page, 'load');
        statesHtml = refetch.html;
        statesFinalUrl = refetch.finalUrl;
      }

      // 2) Extract the state id from the index
      const stateId = extractStateIdFromIndex(statesHtml, stateName);
      if (!stateId) {
        const dbgPath = path.join(process.cwd(), `states_index_snapshot_${Date.now()}.html`);
        try { fs.writeFileSync(dbgPath, statesHtml || '', 'utf8'); } catch (_) {}
        const { suffix, files } = buildDebugArtifacts(userDebug, {
          finalUrl: statesFinalUrl,
          note: `Saved snapshot to ${dbgPath}`,
        });
        const content = `Could not find a state matching "${stateName}" on the states listing.${suffix}`;
        try { await interaction.editReply({ content, files }); } catch (_) {}
        return;
      }

      // 3) Navigate to state → primaries
      await fetchHtmlWithSession(STATE_URL(stateId), page, 'domcontentloaded'); // best effort
      const primaries = await fetchHtmlWithSession(PRIMARIES_URL(stateId), page, 'domcontentloaded');
      const primariesHtml = primaries.html;
      const primariesUrl = primaries.finalUrl;

      // 4) Locate the requested race block, with dem/gop rows
      const raceInfo = extractRacePrimariesFromStatePage(primariesHtml, raceLabel);
      if (!raceInfo) {
        const { suffix, files } = buildDebugArtifacts(userDebug, { stateId, primariesUrl });
        const msg = `No "${raceLabel}" primary found for ${stateName}.${suffix}`;
        try { await interaction.editReply({ content: msg, files }); } catch (_) {}
        return;
      }

      // 5) For each requested party, fetch the party primary page and parse candidates
      const parties = (party === 'both') ? ['dem', 'gop'] : [party];
      const results = [];

      for (const p of parties) {
        const meta = (p === 'dem') ? raceInfo.dem : raceInfo.gop;
        const label = (p === 'dem') ? 'Democratic Primary' : 'Republican Primary';

        if (!meta || !meta.url) {
          results.push({ label, error: 'No primary link found', candidates: [], count: meta?.count ?? null, deadline: meta?.deadline ?? null });
          continue;
        }

        const partyPage = await fetchHtmlWithSession(meta.url, page, 'domcontentloaded');
        const candidates = extractPrimaryCandidates(partyPage.html);
        results.push({
          label, url: partyPage.finalUrl, candidates,
          count: meta.count ?? null, deadline: meta.deadline ?? null,
        });
      }

      // 6) Build embed
      const fields = results.map((r) => {
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
        const suffixBits = [];
