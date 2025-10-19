// commands/primary.js
// View a state primary race (Senate class 1/2/3, Governor, or House) and candidate stats.
// Examples:
//   /primary state:ca race:s1
//   /primary state:california race:gov party:both
//   /primary state:tx race:house party:gop

const { SlashCommandBuilder } = require('discord.js');
const cheerio = require('cheerio');
const fs = require('node:fs');
const path = require('node:path');

const { authenticateAndNavigate, PPUSAAuthError } = require('../lib/ppusa-auth');
const { config } = require('../lib/ppusa-config');
const { recordCommandError } = require('../lib/status-tracker');

const BASE = config.baseUrl;
const DEFAULT_DEBUG = !!config.debug;

// -------------------- Mappings --------------------
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
  rep: 'House of Representatives', reps: 'House of Representatives', house: 'House of Representatives', representatives: 'House of Representatives'
};

const PARTY_ALIASES = {
  dem: 'dem', dems: 'dem', d: 'dem', democratic: 'dem', democrat: 'dem',
  gop: 'gop', r: 'gop', rep: 'gop', republican: 'gop', republicans: 'gop',
  both: 'both', all: 'both'
};

// -------------------- Small utils --------------------
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const normalizeParty = (p) => PARTY_ALIASES[String(p || '').toLowerCase()] || 'both';

function normalizeRace(r) {
  const key = String(r || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return RACE_ALIASES[key] || null;
}

function normalizeStateName(s) {
  const raw = String(s || '').trim();
  if (!raw) return null;

  const abbr = raw.toLowerCase();
  if (US_STATE_ABBR[abbr]) return US_STATE_ABBR[abbr];

  const alias = new Map([
    ['cal', 'California'], ['cali', 'California'],
    ['wash', 'Washington'], ['wash state', 'Washington'],
    ['mass', 'Massachusetts'], ['jersey', 'New Jersey'],
    ['carolina', 'North Carolina'],
    ['dc', 'District of Columbia'], ['d.c.', 'District of Columbia'], ['d.c', 'District of Columbia'], ['d c', 'District of Columbia'],
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

// -------------------- Parsing --------------------
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

function extractRacePrimariesFromStatePage(html, raceLabel) {
  const $ = cheerio.load(html || '');
  const raceName = String(raceLabel || '').trim().toLowerCase();

  let header = null;
  $('h4').each((_, el) => {
    const t = ($(el).text() || '').trim().toLowerCase();
    if (t === raceName) { header = $(el); return false; }
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
    const a = row.find('a[href*="/primaries/"]').first();
    if (!a.length) return;

    const href = a.attr('href') || '';
    const url = href.startsWith('http') ? href : new URL(href, BASE).toString();
    const tds = row.find('td');

    const partyText = (a.text() || '').toLowerCase();
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

function extractPrimaryCandidates(html) {
  const $ = cheerio.load(html || '');
  let scope = $('#electionresult');
  if (!scope.length) scope = $('body');

  const items = [];
  scope.find('.progress-wrapper').each((_, el) => {
    const wrap = $(el);
    const label = wrap.find('.progress-label a, .progress-label').first();
    let nameFull = (label.text() || '').replace(/\s+/g, ' ').trim();
    if (!nameFull) return;

    let name = nameFull;
    const metrics = {};

    const m = nameFull.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
    if (m) {
      name = m[1].trim();
      const parts = m[2].split(',').map((s) => s.trim());
      for (const part of parts) {
        const mm = part.match(/^(ES|CO|NR|AR)[:\s]+([0-9]+(?:\.[0-9]+)?)$/i);
        if (mm) metrics[mm[1].toUpperCase()] = mm[2];
      }
    }

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

    items.push({ name, metrics, percent });
  });

  return items;
}

function compactMetrics(metrics) {
  if (!metrics) return '';
  const order = ['ES', 'CO', 'NR', 'AR'];
  const parts = order.filter((k) => metrics[k]).map((k) => `${k} ${metrics[k]}`);
  return parts.length ? `(${parts.join(', ')})` : '';
}

// -------------------- Debug helpers --------------------
function formatAuthErrorMessage(err, cmdLabel) {
  if (!(err instanceof PPUSAAuthError)) return `Error: ${err.message}`;
  const d = err.details || {};
  const lines = [`Error: ${err.message}`];
  if (d.finalUrl) lines.push(`Page: ${d.finalUrl}`);
  if (Array.isArray(d.actions) && d.actions.length) {
    const last = d.actions[d.actions.length - 1];
    lines.push(`Last recorded step: ${last.step || 'unknown'} (${last.success ? 'ok' : 'failed'})`);
  }
  if (d.challenge === 'cloudflare-turnstile') {
    lines.push('Cloudflare Turnstile is blocking automated login.');
    lines.push('Workaround: sign in manually and set PPUSA_COOKIE with your session; restart the bot.');
  }
  lines.push(`Tip: run ${cmdLabel} debug:true to include a debug trail.`);
  return lines.join('\n');
}

function buildDebugArtifacts(enabled, data) {
  if (!enabled || !data) return { suffix: '', files: undefined };
  const payload = JSON.stringify(data, null, 2);
  if (payload.length > 1500) {
    return {
      suffix: '\n\nDebug details attached (primary_debug.json)',
      files: [{ attachment: Buffer.from(payload, 'utf8'), name: 'primary_debug.json' }],
    };
  }
  return { suffix: `\n\nDebug: ${payload}` };
}

// -------------------- Network helpers (reuse session) --------------------
async function fetchHtmlWithSession(url, sessionPage, waitUntil = 'domcontentloaded') {
  await sessionPage.goto(url, { waitUntil }).catch(() => {});
  await delay(150); // allow SPA paint without relying on puppeteer-only helpers
  return { html: await sessionPage.content(), finalUrl: sessionPage.url() };
}

// -------------------- Command --------------------
module.exports = {
  data: new SlashCommandBuilder()
    .setName('primary')
    .setDescription('View a state primary race (Senate class, Governor, or House) and candidate stats')
    .addStringOption((o) =>
      o.setName('state').setDescription('State code (e.g., ca) or full name').setRequired(true)
    )
    .addStringOption((o) =>
      o.setName('race').setDescription('Race: s1, s2, s3, gov, rep/house').setRequired(true)
    )
    .addStringOption((o) =>
      o.setName('party')
        .setDescription('Filter party: dem, gop, or both (default: both)')
        .addChoices(
          { name: 'Both', value: 'both' },
          { name: 'Democratic', value: 'dem' },
          { name: 'Republican', value: 'gop' }
        )
        .setRequired(false)
    )
    .addBooleanOption((o) =>
      o.setName('debug').setDescription('Include diagnostics (ephemeral)').setRequired(false)
    ),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction) {
    const userDebug = interaction.options.getBoolean('debug') ?? false;
    const debugFlag = userDebug || DEFAULT_DEBUG;

    const stateRaw = (interaction.options.getString('state', true) || '').trim();
    const raceRaw  = (interaction.options.getString('race', true)  || '').trim();
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
    try {
      await interaction.deferReply();
      deferred = true;
    } catch (e) {
      if (e?.code === 10062) {
        console.warn('primary: token expired before defer.');
        return;
      }
      throw e;
    }

    let browser = null;
    let page = null;

    try {
      // Authenticate once and reuse the session/page.
      const session = await authenticateAndNavigate({ url: `${BASE}/national/states`, debug: debugFlag });
      browser = session.browser;
      page = session.page;

      let statesHtml = session.html;
      let statesUrlFinal = session.finalUrl || `${BASE}/national/states`;

      // If tiny (blocked/interstitial), try a harder load
      if ((statesHtml || '').length < 400) {
        const refetched = await fetchHtmlWithSession(`${BASE}/national/states`, page, 'load');
        statesHtml = refetched.html;
        statesUrlFinal = refetched.finalUrl;
      }

      // Resolve state id from the index
      const stateId = resolveStateIdFromIndex(statesHtml, stateName);
      if (!stateId) {
        const dbgPath = path.join(process.cwd(), `states_index_${Date.now()}.html`);
        try { fs.writeFileSync(dbgPath, statesHtml || '', 'utf8'); } catch {}
        const { suffix, files } = buildDebugArtifacts(userDebug, {
          finalUrl: statesUrlFinal,
          saved: dbgPath
        });
        const msg = `Could not find a state matching "${stateName}" on the states listing.${suffix}`;
        await interaction.editReply({ content: msg, files });
        return;
      }

      // Visit state page (best-effort), then primaries page
      await fetchHtmlWithSession(`${BASE}/states/${stateId}`, page, 'domcontentloaded');
      const primaries = await fetchHtmlWithSession(`${BASE}/states/${stateId}/primaries`, page, 'domcontentloaded');
      const primariesHtml = primaries.html;
      const primariesUrl = primaries.finalUrl;

      // Extract requested race section
      const raceInfo = extractRacePrimariesFromStatePage(primariesHtml, raceLabel);
      if (!raceInfo) {
        const { suffix, files } = buildDebugArtifacts(userDebug, { stateId, primariesUrl });
        await interaction.editReply({ content: `No "${raceLabel}" primary found for ${stateName}.${suffix}`, files });
        return;
      }

      // Fetch party pages and parse candidates
      const parties = party === 'both' ? ['dem', 'gop'] : [party];
      const results = [];

      for (const p of parties) {
        const meta = p === 'dem' ? raceInfo.dem : raceInfo.gop;
        const label = p === 'dem' ? 'Democratic Primary' : 'Republican Primary';

        if (!meta || !meta.url) {
          results.push({ label, error: 'No primary link found', candidates: [], count: meta?.count ?? null, deadline: meta?.deadline ?? null });
          continue;
        }

        const partyPage = await fetchHtmlWithSession(meta.url, page, 'domcontentloaded');
        const candidates = extractPrimaryCandidates(partyPage.html) || [];
        results.push({
          label,
          url: partyPage.finalUrl,
          candidates,
          count: meta.count ?? null,
          deadline: meta.deadline ?? null
        });
      }

      // Build embed
      const fields = results.map((r) => {
        let value;
        if (r.error) value = `Error: ${r.error}`;
        else if (!r.candidates || r.candidates.length === 0) value = 'No candidates filed.';
        else {
          value = r.candidates.map((c) => {
            const m = compactMetrics(c.metrics);
            const pct = c.percent != null ? ` – ${c.percent}%` : '';
            return `- ${c.name}${m ? ` ${m}` : ''}${pct}`;
          }).join('\n');
        }
        const extras = [];
        if (typeof r.count === 'number') extras.push(`${r.count} filed`);
        if (r.deadline) extras.push(`Deadline: ${r.deadline}`);
        if (extras.length) value += `\n${extras.join(' | ')}`;
        return { name: r.label, value: value || '—' };
      });

      const embed = {
        title: `${stateName} – ${raceLabel}`,
        url: primariesUrl,
        fields,
        footer: { text: new URL(BASE).hostname },
        timestamp: new Date().toISOString()
      };

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      recordCommandError(interaction.commandName, err);
      const isAuth = err instanceof PPUSAAuthError;
      const msg = isAuth ? formatAuthErrorMessage(err, '/primary') : `Error: ${err.message}`;
      if (deferred) {
        try { await interaction.editReply({ content: msg }); }
        catch (e) { if (e?.code !== 10062) throw e; }
      }
    } finally {
      try { await browser?.close(); } catch {}
    }
  }
};
