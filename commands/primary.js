// commands/primary.js
// Version: 1.0
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
const { normalizeStateName, resolveStateIdFromIndex } = require('../lib/state-utils');
const { recordCommandError } = require('../lib/status-tracker');

const BASE = config.baseUrl;
const DEFAULT_DEBUG = !!config.debug;

// -------------------- Mappings --------------------
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

// -------------------- Parsing --------------------
// /national/states -> resolve numeric stateId
// /states/:id/primaries -> locate the race row, return party links/meta
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

// Primary page -> candidates (supports old progress layout and new "Primary Registration" table)
function extractPrimaryCandidates(html) {
  const $ = cheerio.load(html || '');
  const items = [];

  // Helper: pick metrics (ES/CO/NR/AR/CR) from surrounding text
  const pickMetrics = (txt) => {
    const out = {};
    const re = /\b(ES|CO|NR|AR|CR)\s*[:\-]\s*([0-9]+(?:\.[0-9]+)?)\b/gi;
    let m;
    while ((m = re.exec(String(txt || '')))) {
      out[m[1].toUpperCase()] = m[2];
    }
    return out;
  };

  // Layout A: legacy progress cards
  let scope = $('#electionresult');
  if (!scope.length) scope = $('body');
  scope.find('.progress-wrapper').each((_, pw) => {
    const wrap = $(pw);
    const label = wrap.find('.progress-label a, .progress-label').first();
    const nameFull = (label.text() || '').replace(/\s+/g, ' ').trim();
    if (!nameFull) return;

    let name = nameFull;
    let metrics = pickMetrics(nameFull);
    const paren = nameFull.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
    if (paren) {
      name = paren[1].trim();
      metrics = { ...metrics, ...pickMetrics(paren[2]) };
    }

    let percent = null;
    const pctText = (wrap.find('.progress-percentage .text-primary').first().text() || '').trim();
    const mp = pctText.match(/([0-9]+(?:\.[0-9]+)?)/);
    if (mp) percent = mp[1];
    if (percent == null) {
      const w = wrap.find('.progress-bar').attr('style') || '';
      const mw = w.match(/width:\s*([0-9.]+)%/i);
      if (mw) percent = mw[1];
    }

    items.push({ name, metrics, percent });
  });

  if (items.length) return items;

  // Layout B: new "Primary Registration" table
  const regHeader = $('h3').filter((_, el) => /primary\s+registration/i.test($(el).text())).first();
  const regBlock = regHeader.length
    ? regHeader.closest('.container-fluid, .bg-white, .rounded, .ppusa_background, .row, .col-sm-6')
    : $();
  const regTable = regBlock.find('table tbody');
  if (regTable.length) {
    regTable.find('tr').each((_, tr) => {
      const row = $(tr);
      const name =
        row.find('a[href^="/users/"] h5').first().text().trim() ||
        row.find('a[href^="/users/"]').first().text().trim();
      if (!name) return;

      const rowText = row.text().replace(/\s+/g, ' ');
      const metrics = pickMetrics(rowText);

      items.push({ name, metrics, percent: null });
    });
  }

  if (items.length) return items;

  // Fallback: any user names we can see, grab nearby metrics text
  $('a[href^="/users/"] h5').each((_, h5) => {
    const name = ($(h5).text() || '').trim();
    if (!name) return;
    const nearText = $(h5).closest('tr, .container-fluid, .bg-white, .rounded, .row').text().replace(/\s+/g, ' ');
    const metrics = pickMetrics(nearText);
    items.push({ name, metrics, percent: null });
  });

  return items;
}

function compactMetrics(metrics) {
  if (!metrics) return '';
  const order = ['ES', 'CO', 'NR', 'AR', 'CR']; // include CR when present
  const parts = order.filter((k) => metrics[k] != null).map((k) => `${k} ${metrics[k]}`);
  return parts.length ? `(${parts.join(', ')})` : '';
}

// -------------------- Debug helpers --------------------
function formatAuthErrorMessage(err, cmdLabel) {
  if (!(err instanceof PPUSAAuthError)) return `Error: ${err.message}`;
  const d = err.details || {};
  const lines = [`🔴 **Authentication Failed**`];
  lines.push(`**Error:** ${err.message}`);

  // Show debug information if available
  if (d.debugInfo) {
    const debug = d.debugInfo;
    lines.push(`**Debug Info:**`);
    if (debug.currentUrl) lines.push(`  • Current URL: ${debug.currentUrl}`);
    if (debug.pageTitle) lines.push(`  • Page Title: ${debug.pageTitle}`);
    if (debug.bodyText && debug.bodyText.length > 0) {
      lines.push(`  • Page Content: ${debug.bodyText}${debug.bodyText.length >= 500 ? '...' : ''}`);
    }
    if (debug.errorType) lines.push(`  • Error Type: ${debug.errorType}`);
  }

  if (d.finalUrl) lines.push(`**Final URL:** ${d.finalUrl}`);

  // Show authentication steps
  if (Array.isArray(d.actions) && d.actions.length) {
    lines.push(`**Authentication Steps:**`);
    d.actions.slice(-8).forEach((action, i) => { // Show last 8 steps
      const status = action.success ? '✅' : '❌';
      const step = action.step || 'unknown';
      const url = action.finalUrl ? ` (${action.finalUrl})` : '';
      lines.push(`  ${i+1}. ${status} ${step}${url}`);
    });
  }

  // Specific guidance based on error type
  if (d.challenge === 'cloudflare-turnstile') {
    lines.push(`**⚠️ Cloudflare Turnstile Detected**`);
    lines.push(`  • Cloudflare is blocking automated login.`);
    lines.push(`  • **Solution:** Sign in manually and set PPUSA_COOKIE with your session cookie.`);
    lines.push(`  • **Command:** Run \`/primary debug:true\` for troubleshooting steps.`);
  } else if (d.debugInfo?.errorType === 'site_unreachable') {
    lines.push(`**🌐 Site Connectivity Issue**`);
    lines.push(`  • Cannot reach the PPUSA website at all.`);
    lines.push(`  • **Possible causes:**`);
    lines.push(`    - Site is down or experiencing issues`);
    lines.push(`    - Network connectivity problems`);
    lines.push(`    - Firewall or proxy blocking access`);
    lines.push(`    - DNS resolution issues`);
    lines.push(`  • **Check:** Try accessing https://powerplayusa.net manually`);
    lines.push(`  • **Environment:** Verify PPUSA_BASE_URL setting`);
  } else if (d.debugInfo?.errorType === 'connectivity_failed') {
    lines.push(`**🔗 Base Connectivity Failed**`);
    lines.push(`  • Cannot establish connection to PPUSA base site.`);
    lines.push(`  • Check network connectivity and firewall settings.`);
  } else if (d.debugInfo?.errorType === 'browser_launch_failed') {
    lines.push(`**🌐 Browser Launch Failed**`);
    lines.push(`  • Headless browser cannot start or connect.`);
    lines.push(`  • **Common causes:**`);
    lines.push(`    - Chrome/Chromium not installed`);
    lines.push(`    - Insufficient permissions`);
    lines.push(`    - Anti-bot detection blocking browser`);
    lines.push(`  • **Try:** Run with PUPPETEER_HEADLESS=false`);
  } else if (d.debugInfo?.errorType === 'browser_connection_lost') {
    lines.push(`**🔌 Browser Connection Lost**`);
    lines.push(`  • Browser connection terminated during operation.`);
    lines.push(`  • **Likely cause:** Aggressive anti-bot detection.`);
    lines.push(`  • **Solutions:**`);
    lines.push(`    - Use cookie authentication instead`);
    lines.push(`    - Try different browser configuration`);
    lines.push(`    - Use non-headless mode temporarily`);
  } else if (d.debugInfo?.errorType === 'browser_pre_auth_failure') {
    lines.push(`**🚫 Browser Failed Before Authentication**`);
    lines.push(`  • Browser connection lost before reaching login page.`);
    lines.push(`  • **Cause:** Extreme anti-bot detection blocking automation.`);
    lines.push(`  • **Recommended:** Use cookie-based authentication`);
  } else if (d.debugInfo?.errorType === 'navigation_failed') {
    lines.push(`**🔍 Login Page Navigation Issue**`);
    lines.push(`  • Can reach base site but cannot access login page.`);
    lines.push(`  • Login page may have moved or require different permissions.`);
  } else if (d.debugInfo?.errorType === 'form_submission_failed') {
    lines.push(`**📝 Form Submission Issue**`);
    lines.push(`  • Could not submit the login form.`);
    lines.push(`  • The login form may have changed or be blocked.`);
    lines.push(`  • Try manual login first to verify credentials.`);
  }

  lines.push(`**💡 Tip:** Run \`${cmdLabel} debug:true\` to include detailed debug information.`);
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
  await sessionPage.goto(url, { waitUntil, timeout: 15000 }).catch(() => {});
  await delay(150); // small paint window
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
      // Authenticate once and reuse session/page
      const session = await authenticateAndNavigate({ url: `${BASE}/national/states`, debug: debugFlag });
      browser = session.browser;
      page = session.page;
      try { page.setDefaultNavigationTimeout?.(15000); page.setDefaultTimeout?.(15000); } catch (_) {}

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
