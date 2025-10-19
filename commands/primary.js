// commands/primary.js
// View a state primary race (Senate class 1/2/3, Governor, or House) and candidate stats.
// Examples:
//   /primary state:ca race:s1
//   /primary state:california race:gov party:both
//   /primary state:tx race:house party:gop

const { SlashCommandBuilder } = require('discord.js');
const cheerio = require('cheerio');
const { authenticateAndNavigate, PPUSAAuthError } = require('../lib/ppusa-auth');
const { config } = require('../lib/ppusa-config');
const { recordCommandError } = require('../lib/status-tracker');

const BASE = config.baseUrl;
const DEFAULT_DEBUG = config.debug;

// --- Dictionaries ---
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

// --- Debug formatting like treasury.js ---
const formatAuthErrorMessage = (err, cmdLabel) => {
  if (!(err instanceof PPUSAAuthError)) return `Error: ${err.message}`;
  const details = err.details || {};
  const lines = [`Error: ${err.message}`];
  if (details.finalUrl) lines.push(`Page: ${details.finalUrl}`);

  const tried = details.triedSelectors || {};
  if (Array.isArray(tried.email) && tried.email.length) lines.push(`Email selectors tried: ${tried.email.join(', ')}`);
  if (Array.isArray(tried.password) && tried.password.length) lines.push(`Password selectors tried: ${tried.password.join(', ')}`);

  if (Array.isArray(details.inputSnapshot) && details.inputSnapshot.length) {
    const sample = details.inputSnapshot.slice(0, 4).map((input) => {
      const bits = [];
      if (input.type) bits.push(`type=${input.type}`);
      if (input.name) bits.push(`name=${input.name}`);
      if (input.id) bits.push(`id=${input.id}`);
      if (input.placeholder) bits.push(`placeholder=${input.placeholder}`);
      bits.push(input.visible ? 'visible' : 'hidden');
      return bits.join(' ');
    });
    lines.push(`Detected inputs: ${sample.join(' | ')}`);
  }

  if (Array.isArray(details.actions) && details.actions.length) {
    const last = details.actions[details.actions.length - 1];
    lines.push(`Last recorded step: ${last.step || 'unknown'} (${last.success ? 'ok' : 'failed'})`);
  }

  if (details.challenge === 'cloudflare-turnstile') {
    lines.push('Cloudflare Turnstile is blocking automated login.');
    lines.push('Workaround: sign in manually in a browser, grab the `ppusa_session=...` cookie, and set it in PPUSA_COOKIE.');
    lines.push('The bot will reuse that session and skip the challenge.');
    lines.push('Helper: run `npm run cookie:update` and paste the cookie values, then restart the bot.');
  }

  lines.push(`Tip: run ${cmdLabel} debug:true to attach the full action log.`);
  return lines.join('\n');
};

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

// --- Tiny utils ---
const normalizeParty = (p) => PARTY_ALIASES[String(p || '').toLowerCase()] || 'both';
const normalizeRace = (r) => {
  const key = String(r || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return RACE_ALIASES[key] || null;
};
function normalizeStateName(s) {
  const raw = String(s || '').trim();
  if (!raw) return null;

  const abbr = raw.toLowerCase();
  if (US_STATE_ABBR[abbr]) return US_STATE_ABBR[abbr];

  // some nicknames
  const aliases = new Map([
    ['cal', 'California'], ['cali', 'California'],
    ['wash', 'Washington'], ['wash state', 'Washington'],
    ['mass', 'Massachusetts'], ['jersey', 'New Jersey'],
    ['carolina', 'North Carolina'],
    ['dc', 'District of Columbia'], ['d.c.', 'District of Columbia'], ['d.c', 'District of Columbia'], ['d c', 'District of Columbia'],
    ['pr', 'Puerto Rico'],
  ]);
  if (aliases.has(abbr)) return aliases.get(abbr);

  const name = raw
    .replace(/^\s+|\s+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^(state|commonwealth|territory)\s+of\s+/i, '')
    .replace(/\b(st|st\.)\b/ig, 'saint')
    .toLowerCase();

  const match = Object.values(US_STATE_ABBR).find(n => n.toLowerCase() === name);
  return match || null;
}

// --- HTML parsers ---
function getStateIdFromStatesIndex(html, stateName) {
  try {
    const $ = cheerio.load(html || '');
    const norm = (t) => String(t || '')
      .replace(/\u00A0/g, ' ')
      .normalize('NFKD')
      .trim().toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/^(state|commonwealth|territory)\s+of\s+/i, '')
      .replace(/\s*\(.*?\)\s*$/, '');

    const target = norm(stateName);
    let id = null;

    $('a[href^="/states/"], a[href^="/national/states/"]').each((_, a) => {
      const href = String($(a).attr('href') || '');
      const text = ($(a).text() || '').trim();
      if (!/\/(?:national\/)?states\/\d+/.test(href)) return;
      if (!text) return;
      const nt = norm(text);
      if (nt === target || nt.includes(target) || target.includes(nt)) {
        const m = href.match(/\/(?:national\/)?states\/(\d+)/);
        if (m) { id = Number(m[1]); return false; }
      }
    });

    if (id) return id;

    // fallback: nearby heading region
    const heading = $('h5,h4,h3').filter((_, el) => norm($(el).text()) === target).first();
    if (heading.length) {
      const near = heading.closest('.container, .container-fluid').find('a[href^="/states/"], a[href^="/national/states/"]').first();
      const m = String(near.attr('href') || '').match(/\/(?:national\/)?states\/(\d+)/);
      if (m) return Number(m[1]);
    }
  } catch {}
  return null;
}

function extractRaceBlockFromPrimaries(html, raceLabel) {
  const $ = cheerio.load(html || '');
  let raceHeader = null;
  $('h4').each((_, el) => {
    const t = ($(el).text() || '').trim();
    if (t.toLowerCase() === String(raceLabel || '').toLowerCase()) { raceHeader = $(el); return false; }
  });
  if (!raceHeader) return null;

  const container = raceHeader.closest('.container, .container-fluid, .bg-white').length
    ? raceHeader.closest('.container, .container-fluid, .bg-white')
    : raceHeader.parent();

  const table = container.find('table').first();
  if (!table.length) return null;

  const out = { dem: null, gop: null };
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
    const deadline = (tds.eq(1).text() || '').replace(/\s+/g, ' ').trim() || null;
    const countText = (tds.eq(2).text() || '').trim();
    const count = countText && /\d+/.test(countText) ? Number(countText.match(/\d+/)[0]) : null;

    const obj = { id, url, deadline, count };
    if (partyText.includes('democrat')) out.dem = obj;
    else if (partyText.includes('republican')) out.gop = obj;
  });

  if (!out.dem && !out.gop) return null;
  return out;
}

function extractPrimaryCandidates(html) {
  const $ = cheerio.load(html || '');
  let scope = $('#electionresult');
  if (!scope.length) scope = $('body');

  const items = [];
  scope.find('.progress-wrapper').each((_, pw) => {
    const wrap = $(pw);
    const label = wrap.find('.progress-label a').first();
    let nameFull = (label.text() || '').replace(/\s+/g, ' ').trim();
    if (!nameFull) return;

    let name = nameFull;
    const metrics = {};
    const m = nameFull.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
    if (m) {
      name = m[1].trim();
      m[2].split(',').map((s) => s.trim()).forEach((part) => {
        const mm = part.match(/^(ES|CO|NR|AR)[:\s]+([0-9]+(?:\.[0-9]+)?)$/i);
        if (mm) metrics[mm[1].toUpperCase()] = mm[2];
      });
    }

    let percent = null;
    const pctText = (wrap.find('.progress-percentage .text-primary').first().text() || '').trim();
    if (/[0-9]/.test(pctText)) {
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

const compactMetrics = (metrics) => {
  if (!metrics) return '';
  const parts = [];
  for (const k of ['ES', 'CO', 'NR', 'AR']) if (metrics[k]) parts.push(`${k} ${metrics[k]}`);
  return parts.length ? `(${parts.join(', ')})` : '';
};

// --- One-shot auth fetch (like treasury.js) ---
async function fetchHtml(url, debug) {
  const session = await authenticateAndNavigate({ url, debug });
  const { browser, html, finalUrl, actions } = session;
  try {
    return { html, finalUrl, actions };
  } finally {
    try { await browser.close(); } catch (_) {}
  }
}

// --- Command definition ---
module.exports = {
  data: new SlashCommandBuilder()
    .setName('primary')
    .setDescription('View a state primary (Senate class, Governor, or House) and candidate stats')
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
        .setDescription('Filter party: dem, gop, or both (default)')
        .setRequired(false)
        .addChoices(
          { name: 'Both', value: 'both' },
          { name: 'Democratic', value: 'dem' },
          { name: 'Republican', value: 'gop' },
        ),
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

    const stateRaw = (interaction.options.getString('state', true) || '').trim();
    const raceRaw = (interaction.options.getString('race', true) || '').trim();
    const partyRaw = (interaction.options.getString('party') || 'both').trim();

    const party = normalizeParty(partyRaw);
    const raceLabel = normalizeRace(raceRaw);
    const stateName = normalizeStateName(stateRaw);

    if (!raceLabel) {
      return interaction.reply({ content: `Unknown race "${raceRaw}". Try one of: s1, s2, s3, gov, rep/house.`, ephemeral: true });
    }
    if (!stateName) {
      return interaction.reply({ content: `Unknown state "${stateRaw}". Use a two-letter code or full state name.`, ephemeral: true });
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

    const debugData = { steps: [], inputs: { stateRaw, raceRaw, partyRaw }, results: null };
    try {
      // STEP 1: open /national/states (this is where the index lives)
      const statesUrl = `${BASE}/national/states`;
      debugData.steps.push({ step: 'navigate_states_index', url: statesUrl });

      const s1 = await fetchHtml(statesUrl, debugFlag);
      const stateId = getStateIdFromStatesIndex(s1.html, stateName);
      debugData.steps.push({ step: 'resolve_state_id', stateId });

      if (!stateId) {
        const msg = `Could not find a state matching "${stateName}" on the states listing.`;
        const content = userDebug ? `${msg}\n\nLast URL: ${s1.finalUrl || statesUrl}` : msg;
        await interaction.editReply({ content });
        return;
      }

      // STEP 2: go to /states/:id/primaries
      const primariesUrl = `${BASE}/states/${stateId}/primaries`;
      debugData.steps.push({ step: 'navigate_state_primaries', url: primariesUrl });

      const s2 = await fetchHtml(primariesUrl, debugFlag);
      const raceInfo = extractRaceBlockFromPrimaries(s2.html, raceLabel);
      if (!raceInfo) {
        const content = `No "${raceLabel}" primary found for ${stateName}.`;
        await interaction.editReply({ content });
        return;
      }

      // STEP 3: follow party links
      const targets = party === 'both' ? ['dem', 'gop'] : [party];
      const out = [];

      for (const p of targets) {
        const info = p === 'dem' ? raceInfo.dem : raceInfo.gop;
        const label = p === 'dem' ? 'Democratic Primary' : 'Republican Primary';

        if (!info || !info.url) {
          out.push({ label, error: 'No primary link found', candidates: [], count: info?.count ?? null, deadline: info?.deadline ?? null });
          continue;
        }

        debugData.steps.push({ step: 'navigate_party_primary', party: p, url: info.url });
        const s3 = await fetchHtml(info.url, debugFlag);
        const candidates = extractPrimaryCandidates(s3.html) || [];
        out.push({ label, url: info.url, candidates, count: info.count ?? null, deadline: info.deadline ?? null });
      }

      debugData.results = out;

      // STEP 4: build embed
      const fields = out.map((r) => {
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

        const suffix = [];
        if (typeof r.count === 'number') suffix.push(`${r.count} filed`);
        if (r.deadline) suffix.push(`Deadline: ${r.deadline}`);
        if (suffix.length) value += `\n${suffix.join(' | ')}`;

        return { name: r.label, value: value || '—' };
      });

      const embed = {
        title: `${stateName} – ${raceLabel}`,
        url: `${BASE}/states/${stateId}/primaries`,
        fields,
        footer: { text: new URL(BASE).hostname },
        timestamp: new Date().toISOString(),
      };

      const { suffix, files } = buildDebugArtifacts(userDebug, {
        finalStatesUrl: s1.finalUrl ?? statesUrl,
        finalPrimariesUrl: s2.finalUrl ?? `${BASE}/states/${stateId}/primaries`,
        stateId,
        steps: debugData.steps,
      });

      const content = suffix ? suffix.trim() : undefined;
      await interaction.editReply({ content, embeds: [embed], files });

    } catch (err) {
      const isAuthError = err instanceof PPUSAAuthError;
      const content = isAuthError ? formatAuthErrorMessage(err, '/primary') : `Error: ${err.message}`;
      try {
        if (deferred) await interaction.editReply({ content });
      } catch (editErr) {
        if (editErr?.code === 10062) {
          console.warn('primary: unable to edit reply because the interaction expired.');
        } else {
          throw editErr;
        }
      }

      try {
        await recordCommandError('/primary', {
          message: err.message,
          stack: err.stack,
          details: err.details || null,
          debug: debugFlag ? debugData : null,
        });
      } catch (_) {}
    }
  },
};

// --- helper wired to the parser above (kept near module for clarity) ---
function getStateIdFromStatesIndex(html, stateName) {
  return getStateIdFromStatesIndex._impl(html, stateName);
}
getStateIdFromStatesIndex._impl = getStateIdFromStatesIndex;
