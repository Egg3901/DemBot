/**
 * Project: DemBot (Discord automation for Power Play USA)
 * File: lib/ppusa.js
 * Purpose: Shared PPUSA helpers (login session + HTML parsing)
 */
const cheerio = require('cheerio');
const { authenticateAndNavigate, config } = require('./ppusa-auth');
const { toAbsoluteUrl } = require('./ppusa-config');

const BASE = config.baseUrl;

function normalizeWhitespace(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function toCamelCase(label) {
  if (!label) return null;
  const cleaned = String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim();
  if (!cleaned) return null;
  return cleaned
    .split(/\s+/)
    .map((part, idx) => (idx === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');
}

function cleanCellText(cell) {
  if (!cell || cell.length === 0) return '';
  const clone = cell.clone();
  clone.find('script,style').remove();
  clone.find('img,svg,i,button').remove();
  const text = normalizeWhitespace(clone.text());
  if (text) return text;
  return normalizeWhitespace(cell.text());
}

function collectTable($, table) {
  const byLabel = {};
  const byKey = {};
  if (!table || table.length === 0) return { byLabel, byKey };

  table.find('tr').each((_, tr) => {
    const heading = normalizeWhitespace($(tr).find('th').first().text());
    if (!heading) return;
    const value = cleanCellText($(tr).find('td').first());
    byLabel[heading] = value;
    const key = toCamelCase(heading);
    if (key) byKey[key] = value;
  });

  return { byLabel, byKey };
}

function collectTableByHeading($, headingText) {
  const matcher = typeof headingText === 'string'
    ? (text) => normalizeWhitespace(text).toLowerCase().includes(headingText.toLowerCase())
    : headingText;

  const heading = $('h1,h2,h3,h4,h5')
    .filter((_, el) => matcher($(el).text()))
    .first();
  if (!heading.length) return { byLabel: {}, byKey: {} };

  let table = heading.nextAll('table').first();
  if (!table.length) {
    table = heading.closest('.container-fluid, .card, .bg-body, .rounded, .row, .col-lg-6, .col-md-12').find('table').first();
  }
  if (!table.length) return { byLabel: {}, byKey: {} };

  return collectTable($, table);
}

/**
 * Login (or reuse cookie) and navigate to a target URL.
 * Wraps authenticateAndNavigate to keep backward compatibility.
 * @param {string} url Absolute or BASE-relative URL
 * @param {{debug?: boolean}} [options]
 */
async function loginAndGet(url, options = {}) {
  const target = url ?? '/';
  return authenticateAndNavigate({ url: target, debug: options.debug ?? config.debug });
}

/**
 * Parse a user profile HTML page into a structured object.
 * Extracts name, Discord handle, party, state, position, ES/CO/NR, cash, and account age.
 * @param {string} html
 */
function parseProfile(html) {
  const $ = cheerio.load(html);
  const title = normalizeWhitespace($('title').first().text());
  let name = title ? title.split('|')[0].trim() : null;

  const personalSection = collectTableByHeading($, 'personal info');
  const personalRaw = personalSection.byLabel;
  const personal = personalSection.byKey;

  const campaignSection = collectTableByHeading($, 'campaign stats');
  const campaignRaw = campaignSection.byLabel;
  const campaign = campaignSection.byKey;

  if (personal.name) name = personal.name;

  let discord = personal.discord ? personal.discord.replace(/^@/, '').trim() : null;
  let accountAgeFallback = null;
  let party = null;
  let state = personal.state ? personal.state.replace(/^State of\s+/i, '').trim() : null;

  $('table tr').each((_, tr) => {
    const heading = normalizeWhitespace($(tr).find('th').first().text());
    if (!heading) return;
    const cell = $(tr).find('td').first();
    const value = cleanCellText(cell);
    if (!discord && /^Discord$/i.test(heading)) {
      discord = value.split(/\s+/).pop() || value;
    } else if (!accountAgeFallback && /^Account\s*Age$/i.test(heading)) {
      accountAgeFallback = value;
    } else if (!party && /^Party$/i.test(heading)) {
      const anchor = normalizeWhitespace(cell.find('a').first().text());
      party = anchor || value;
    }
  });

  if (!state) {
    try {
      const $$ = cheerio.load($.html());
      $$('#navbar_global, #navbar-main, nav, header, footer, .ppusa-navbar, .dropdown-menu').remove();
      const stateLink = $$('a[href*="/states/"]').first();
      const stText = normalizeWhitespace(stateLink.text());
      if (stText) state = stText;
      if (!state) {
        const so = $$('h5,h4,h3').filter((_, el) => /\bState of\b/i.test($$(el).text())).first().text().trim();
        if (so) state = so.replace(/^State of\s+/i, '').trim();
      }
    } catch (_) {}
  }

  let position = null;
  const posCandidates = $('h5').map((_, el) => ($(el).text() || '').trim()).get();
  position = posCandidates.find((t) =>
    /Private Citizen|Senator|Representative|Governor|President|Vice President|Mayor|Attorney General|Speaker|Leader|Chief|Secretary|Judge|Chair|Councillor|Councilor/i.test(t)
  ) || null;

  const esText = campaign.electionStamina || null;
  let es = null;
  let esPerHour = null;
  if (esText) {
    const match = esText.replace(/,/g, '').match(/([0-9]+(?:\.[0-9]+)?)/);
    if (match) es = match[1];
    const regen = esText.replace(/,/g, '').match(/([+-]?[0-9]+(?:\.[0-9]+)?)\s*(?:\/\s*hr|per\s*hour)/i);
    if (regen) esPerHour = regen[1];
  }
  if (!es || !campaign.electionStamina) {
    $('table tr').each((_, tr) => {
      const heading = normalizeWhitespace($(tr).find('th').first().text());
      if (!heading) return;
      const value = cleanCellText($(tr).find('td').first());
      if (!es && /^Election\s*Stamina$/i.test(heading)) {
        const m = value.replace(/,/g, '').match(/([0-9]+(?:\.[0-9]+)?)/);
        if (m) es = m[1];
        const regen = value.replace(/,/g, '').match(/([+-]?[0-9]+(?:\.[0-9]+)?)\s*(?:\/\s*hr|per\s*hour)/i);
        if (regen) esPerHour = regen[1];
      } else if (!campaign.campaignOrganization && /^Campaign\s*Organization$/i.test(heading)) {
        campaign.campaignOrganization = value;
      } else if (!campaign.nameRecognition && /^Name\s*Recognition$/i.test(heading)) {
        campaign.nameRecognition = value;
      } else if (!campaign.approvalRating && /^Approval\s*Rating$/i.test(heading)) {
        campaign.approvalRating = value;
      }
    });
  }

  const co = campaign.campaignOrganization || null;
  const nr = campaign.nameRecognition || null;
  const approvalRating = campaign.approvalRating || null;

  let cash = null;
  const fin = $('h4:contains("Finances")').closest('div').find('h5:contains("Balance")').first();
  if (fin.length) {
    const val = fin.parent().find('.ppusa-money-color').first().text().replace(/\s+/g, ' ').trim();
    if (val) cash = val;
  } else {
    const m = $('.ppusa-money-color').map((_, el) => ($(el).text() || '').trim()).get().find((t) => /^\$\s*\d/.test(t));
    if (m) cash = m;
  }

  let avatar = null;
  const headshot = $('img.img-profile, img[src*="profile_pictures"], img[alt*="profile" i], img[alt*="avatar" i]').first();
  if (headshot.length) {
    const raw = (headshot.attr('src') || '').trim();
    if (raw) avatar = raw;
  }
  if (!avatar) {
    const meta = $('meta[property="og:image"], meta[name="og:image"]').attr('content');
    if (meta) avatar = meta.trim();
  }
  if (avatar && avatar.startsWith('#')) avatar = null;
  if (avatar) {
    if (avatar.startsWith('//')) avatar = `https:${avatar}`;
    else if (/^\//.test(avatar)) avatar = toAbsoluteUrl(avatar);
    else if (!/^https?:\/\//i.test(avatar)) avatar = toAbsoluteUrl(avatar.replace(/^\.\/?/, ''));
  }

  const status = personal.status || null;
  const gender = personal.gender || null;
  const race = personal.race || null;
  const religion = personal.religion || null;
  const age = personal.age || null;
  const politicalPower = personal.politicalPower || null;
  const accountAge = personal.accountAge || accountAgeFallback || null;

  let lastOnlineText = status ? normalizeWhitespace(status) : null;
  let lastOnlineAt = null;
  let lastOnlineDays = null;

  const applyLastOnline = (text) => {
    const cleaned = normalizeWhitespace(text);
    if (!cleaned) return;
    lastOnlineText = cleaned;
    const parsed = parseRelativeTimeToDate(cleaned);
    if (parsed) {
      lastOnlineAt = parsed.toISOString();
      lastOnlineDays = Math.max(0, Math.floor((Date.now() - parsed.getTime()) / (1000 * 60 * 60 * 24)));
    }
  };

  if (lastOnlineText) applyLastOnline(lastOnlineText);

  $('table tr').each((_, tr) => {
    const heading = normalizeWhitespace($(tr).find('th').first().text());
    if (!heading) return;
    if (/^(Last\s*(Online|Active|Seen)|Status)$/i.test(heading)) {
      applyLastOnline($(tr).find('td').first().text());
    }
  });

  discord = discord ? normalizeWhitespace(discord) : null;
  if (discord && /\s/.test(discord)) discord = discord.split(/\s+/).pop();

  return {
    name,
    discord,
    accountAge,
    party,
    state,
    position,
    es,
    esPerHour,
    co,
    nr,
    approvalRating,
    cash,
    avatar,
    lastOnlineText,
    lastOnlineAt,
    lastOnlineDays,
    status,
    gender,
    race,
    religion,
    age,
    politicalPower,
    personalInfo: personalRaw,
    campaignStats: campaignRaw,
  };
}

function parseRelativeTimeToDate(text) {
  if (!text) return null;
  const t = String(text).toLowerCase().trim();
  if (/just now|moments? ago/.test(t)) return new Date();
  const now = Date.now();
  const m = t.match(/(\d+)\s*(minute|hour|day|week|month|year)s?\s*ago/);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2];
    const ms = unit === 'minute' ? n * 60 * 1000
      : unit === 'hour' ? n * 60 * 60 * 1000
      : unit === 'day' ? n * 24 * 60 * 60 * 1000
      : unit === 'week' ? n * 7 * 24 * 60 * 60 * 1000
      : unit === 'month' ? n * 30 * 24 * 60 * 60 * 1000
      : unit === 'year' ? n * 365 * 24 * 60 * 60 * 1000
      : 0;
    return new Date(now - ms);
  }
  const dt = new Date(text);
  if (!Number.isNaN(dt.getTime())) return dt;
  return null;
}

/**
 * Parse state data from HTML page.
 * Extracts state name, electoral votes, social position, and economic position.
 * @param {string} html
 */
function parseStateData(html) {
  const $ = cheerio.load(html);
  const title = normalizeWhitespace($('title').first().text());
  let stateName = null;
  
  // Extract state name from title or page content
  if (title) {
    const titleParts = title.split('|');
    if (titleParts.length > 0) {
      stateName = titleParts[0].trim();
    }
  }
  
  // Look for state name in navigation or headers
  if (!stateName) {
    const stateNav = $('a[href*="/states/"]').first();
    if (stateNav.length) {
      stateName = normalizeWhitespace(stateNav.text());
    }
  }
  
  if (!stateName) {
    const stateHeader = $('h1, h2, h3, h4, h5').filter((_, el) => {
      const text = $(el).text();
      return /\bState of\b/i.test(text) || /\bGovernor\b/i.test(text);
    }).first();
    if (stateHeader.length) {
      const text = normalizeWhitespace(stateHeader.text());
      stateName = text.replace(/^State of\s+/i, '').replace(/\s+Governor.*$/i, '').trim();
    }
  }
  
  // If this is a general governors page, try to extract individual state info
  if (!stateName || stateName.toLowerCase().includes('governors')) {
    // Look for state-specific information in the page
    const stateElements = $('h3, h4, h5, .state-name, [class*="state"]').filter((_, el) => {
      const text = $(el).text();
      return /^[A-Z][a-z]+$/.test(text.trim()) && text.trim().length > 2 && text.trim().length < 20;
    });
    
    if (stateElements.length > 0) {
      // This appears to be a multi-state page, return null to indicate no single state
      return null;
    }
  }
  
  let electoralVotes = null;
  let socialPosition = null;
  let economicPosition = null;
  
  // Look for electoral votes in tables or text
  $('table tr, .container-fluid, .card').each((_, element) => {
    const $el = $(element);
    const text = normalizeWhitespace($el.text());
    
    // Look for electoral votes
    if (!electoralVotes) {
      const evMatch = text.match(/(\d+)\s*(?:electoral\s*votes?|EVs?)/i);
      if (evMatch) {
        electoralVotes = parseInt(evMatch[1], 10);
      }
    }
    
    // Look for social position
    if (!socialPosition) {
      const socialMatch = text.match(/social\s*position[:\s]*([^,\n]+)/i);
      if (socialMatch) {
        socialPosition = normalizeWhitespace(socialMatch[1]);
      }
    }
    
    // Look for economic position
    if (!economicPosition) {
      const econMatch = text.match(/economic\s*position[:\s]*([^,\n]+)/i);
      if (econMatch) {
        economicPosition = normalizeWhitespace(econMatch[1]);
      }
    }
  });
  
  // Try to extract from specific table sections
  const stateInfoSection = collectTableByHeading($, 'state info');
  const stateInfo = stateInfoSection.byKey;
  
  if (!electoralVotes && stateInfo.electoralVotes) {
    const evMatch = stateInfo.electoralVotes.match(/(\d+)/);
    if (evMatch) electoralVotes = parseInt(evMatch[1], 10);
  }
  
  if (!socialPosition && stateInfo.socialPosition) {
    socialPosition = stateInfo.socialPosition;
  }
  
  if (!economicPosition && stateInfo.economicPosition) {
    economicPosition = stateInfo.economicPosition;
  }
  
  // Look for governor information
  let governor = null;
  const governorSection = collectTableByHeading($, 'governor');
  if (governorSection.byKey.governor) {
    governor = governorSection.byKey.governor;
  }
  
  // Look for party control
  let partyControl = null;
  const partyMatch = $('body').text().match(/(democratic|republican)\s*control/i);
  if (partyMatch) {
    partyControl = partyMatch[1].toLowerCase();
  }
  
  return {
    stateName,
    electoralVotes,
    socialPosition,
    economicPosition,
    governor,
    partyControl,
    rawData: {
      title,
      stateInfo: stateInfoSection.byLabel,
    }
  };
}

module.exports = {
  loginAndGet,
  parseProfile,
  parseStateData,
  BASE,
  config,
};
