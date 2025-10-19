// commands/primary.js
// Slash command to view primary race data (Senate Class 1/2/3, Governor, House)
// Usage examples:
//   /primary state:ca race:s1
//   /primary state:california race:gov party:both
//   /primary state:tx race:house party:gop
//
// Handles:
//  - Mapping state code/name to state id (live via /national/states; fallback to local HTML if present)
//  - Finding the target race block on the state's primaries page
//  - Getting both Dem and GOP primary pages and extracting candidate stats
//  - Graceful handling of empty primaries, missing races, auth/CF interstitials, SPA rendering delays

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
      // NOTE: the game lists states at /national/states; individual state pages remain /states/:id
      const statesUrl = `${BASE}/national/states`;
      const sess = await loginAndGet(statesUrl);
      browser = sess.browser;
      page = sess.page;
      let statesHtml = sess.html;
      addLog(`Fetched /national/states (length=${statesHtml?.length || 0})`);
      stage = 'resolve_state_id';

      // --- helpers for states-list detection (supports /national/states and /states) ---
      function looksLikeStatesList(html) {
        const $ = cheerio.load(html || '');
        const title = ($('title').first().text() || '').toLowerCase();
        const linkCount = $('a[href^="/states/"], a[href^="/national/states/"]').length;
        if (/\bamerican\s+states\b/.test(title)) return true;
        if (/\bstates\b/.test(title) && linkCount >= 5) return true;
        return linkCount >= 10;
      }

      async function getAuthCookies() {
        try {
          const cookies = await page.cookies();
          const sessCookie = cookies.find(c => /ppusa|session/i.test(c.name));
          return { cookies, sessCookie };
        } catch { return { cookies: [], sessCookie: null }; }
      }

      async function assertAuthenticatedOrThrow() {
        const { sessCookie } = await getAuthCookies();
        const urlNow = page.url() || '';
        if (!sessCookie || /\/login\b/i.test(urlNow)) {
          throw new Error('Not authenticated for /national/states (missing session cookie or redirected to login).');
        }
      }

      // STEP A: ensure auth looks good
      await assertAuthenticatedOrThrow();

      // STEP B: if HTML tiny or heuristic fails, try stronger navigations
      if (!looksLikeStatesList(statesHtml) || (statesHtml?.length || 0) < 500) {
        addLog('States HTML looked tiny or heuristic failed; retrying with domcontentloaded...');
        await page.goto(statesUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
        statesHtml = await page.content();
        addLog(`After domcontentloaded goto: length=${statesHtml?.length || 0}`);

        if (!looksLikeStatesList(statesHtml) || (statesHtml?.length || 0) < 500) {
          addLog('Retrying with load event...');
          await page.goto(statesUrl, { waitUntil: 'load' }).catch(() => {});
          statesHtml = await page.content();
          addLog(`After load goto: length=${statesHtml?.length || 0}`);
        }
      }

      // STEP C: wait briefly for anchors if it’s a SPA
      if (!looksLikeStatesList(statesHtml)) {
        addLog('Waiting up to 8s for SPA to render states anchors...');
        try { await page.waitForSelector('a[href^="/states/"], a[href^="/national/states/"]', { timeout: 8000 }); } catch {}
        statesHtml = await page.content();
        addLog(`After SPA wait: length=${statesHtml?.length || 0}`);
      }

      // STEP D: last resort — authenticated fetch from the page context
      if (!looksLikeStatesList(statesHtml)) {
        addLog('Heuristic still failing; using authenticated fetch fallback.');
        try {
          const fetched = await page.evaluate(async (u) => {
            try {
              const res = await fetch(u, { credentials: 'include', cache: 'no-store' });
              return await res.text();
            } catch (e) { return `__FETCH_ERROR__:${e && e.message}`; }
          }, statesUrl);

          if (typeof fetched === 'string' && !/^__FETCH_ERROR__/.test(fetched)) {
            statesHtml = fetched;
            addLog(`Fallback fetch succeeded (length=${statesHtml.length}).`);
          } else {
            addLog(`Fallback fetch failed: ${fetched}`);
          }
        } catch (e) {
          addLog(`Fallback fetch threw: ${e?.message || e}`);
        }
      }

      // STEP E: detect common block pages early
      if ((statesHtml?.length || 0) < 200 || /cf-challenge|turnstile|captcha/i.test(statesHtml)) {
        try {
          const snapPath = path.join(process.cwd(), `debug_states_block_${Date.now()}.html`);
          fs.writeFileSync(snapPath, statesHtml || '', 'utf8');
          addLog(`Saved suspected block/interstitial snapshot to ${snapPath}`);
        } catch {}
        await reportCommandError(interaction, new Error('Blocked or not authenticated'), {
          message: 'Could not access the states listing (blocked by challenge or not authenticated).',
          meta: {
            reason: 'auth_or_block',
            url: page.url(),
            stage,
            length: statesHtml?.length || 0,
            logs: finalLogs.slice(-20),
            debugRequested: requestedDebug,
            debugAllowed,
          },
        });
        return;
      }

      // Resolve state id (HTML first) — supports /national/states and /states link forms
      stateId = extractStateIdFromStatesHtml(statesHtml, stateName);
      if (stateId) addLog(`Resolved state ID ${stateId} from HTML.`);

      // If still not found, resolve via LIVE DOM (supports both link forms)
      if (!stateId) {
        addLog('Trying live DOM resolution for state id...');
        const idLive = await page.evaluate((targetName) => {
          const norm = (s) => String(s || '')
            .replace(/\u00A0/g, ' ')
            .normalize('NFKD')
            .trim()
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .replace(/^(state|commonwealth|territory)\s+of\s+/i, '')
            .replace(/\s*\(.*?\)\s*$/, '');
        const target = norm(targetName);
        const anchors = Array.from(document.querySelectorAll('a[href^="/states/"], a[href^="/national/states/"]'));
        for (const a of anchors) {
          const href = a.getAttribute('href') || '';
          const m = href.match(/\/(?:national\/)?states\/(\d+)\b/);
          if (!m) continue;
          const texts = [
            (a.textContent || '').trim(),
            a.getAttribute('title') || '',
            a.closest('tr,li,div')?.textContent || ''
          ].filter(Boolean);
          for (const t of texts) {
            const nt = norm(t);
            if (nt === target || nt.includes(target) || target.includes(nt)) {
              return Number(m[1]);
            }
          }
        }
        return null;
        }, stateName);

        if (idLive) {
          stateId = idLive;
          addLog(`Resolved state ID ${stateId} via live DOM.`);
        }
      }

      // If still missing, attempt local fallback and snapshot
      if (!stateId) {
        try {
          const snapPath = path.join(process.cwd(), `debug_states_${Date.now()}.html`);
          fs.writeFileSync(snapPath, statesHtml || (await page.content()) || '', 'utf8');
          addLog(`Saved states snapshot to ${snapPath}`);
        } catch {}

        // Local HTML fallback
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
          try {
            const dir = process.cwd();
            const files = fs.readdirSync(dir).filter(f => /\.html?$/i.test(f));
            for (const f of files) {
              const html = readLocalHtml(f);
              if (html && looksLikeStatesList(html)) { local = html; addLog(`Loaded local fallback states HTML via directory scan: ${f}`); break; }
            }
          } catch {}
        }
        if (local && !stateId) {
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
      // NOTE: individual state & primaries pages are still at /states/:id paths
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
      if (!/\/states\/\d+\/primaries\b/.test(page.url())) {
        addLog(`Warning: Expected primaries page but current URL is ${page.url()}`);
      }
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
      const partyTargets = (party === 'both') ? ['dem', 'gop'] : [party];
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
          const lines = r.candidates.map((c) => {
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

// ---------- Helpers ----------

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

  const abbr = raw.toLowerCase();
  if (US_STATE_ABBR[abbr]) return US_STATE_ABBR[abbr];

  // Alias map with SAFE keys (strings) + multiple DC spellings
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

  const match = Object.values(US_STATE_ABBR).find(n => n.toLowerCase() === name);
  return match || null;
}

function extractStateIdFromStatesHtml(html, stateName) {
  try {
    const $ = cheerio.load(html || '');
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
    let id = null;

    $('a[href^="/states/"], a[href^="/national/states/"]').each((_, a) => {
      const href = String($(a).attr('href') || '');
      const text = ($(a).text() || '').trim();
      if (!/\/(?:national\/)?states\/\d+/.test(href)) return;
      if (!text) return;
      const nt = normalizeText(text);
      if (nt === target || nt.includes(target) || target.includes(nt)) {
        const m = href.match(/\/(?:national\/)?states\/(\d+)/);
        if (m) { id = Number(m[1]); return false; }
      }
    });

    if (id) return id;

    // Fallback: look for any heading matching the state and pick id from nearby links
    const heading = $('h5,h4,h3').filter((_, el) => normalizeText($(el).text()) === target).first();
    if (heading.length) {
      const near = heading.closest('.container, .container-fluid').find('a[href^="/states/"], a[href^="/national/states/"]').first();
      const m = String(near.attr('href') || '').match(/\/(?:national\/)?states\/(\d+)/);
      if (m) return Number(m[1]);
    }
  } catch {}
  return null;
}

function extractRacePrimariesFromStatePage(html, raceLabel) {
  const $ = cheerio.load(html || '');
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
  const $ = cheerio.load(html || '');
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
  } catch {}
  return null;
}

/**
 * Project: DemBot (Discord automation for Power Play USA)
 * File: commands/primary.js
 * Purpose: View state primary races and candidate stats (Dem/GOP)
 * Author: egg3901
 * Created: 2025-10-16
 * Last Updated: 2025-10-18
 */
