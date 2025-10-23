/**
 * Project: DemBot (Discord automation for Power Play USA)
 * File: lib/ppusa.js
 * Version: 1.0
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

  // Try multiple section headings for personal info
  const personalSections = [
    'personal info',
    'personal information',
    'user info',
    'profile info',
    'user information',
    'account info',
    'account information'
  ];

  let personalRaw = {};
  let personal = {};

  for (const section of personalSections) {
    const personalSection = collectTableByHeading($, section);
    if (Object.keys(personalSection.byLabel).length > 0) {
      personalRaw = personalSection.byLabel;
      personal = personalSection.byKey;
      break;
    }
  }

  // Try multiple section headings for campaign stats
  const campaignSections = [
    'campaign stats',
    'campaign statistics',
    'election stats',
    'election statistics',
    'political stats',
    'political statistics'
  ];

  let campaignRaw = {};
  let campaign = {};

  for (const section of campaignSections) {
    const campaignSection = collectTableByHeading($, section);
    if (Object.keys(campaignSection.byLabel).length > 0) {
      campaignRaw = campaignSection.byLabel;
      campaign = campaignSection.byKey;
      break;
    }
  }

  if (personal.name) name = personal.name;

  let discord = personal.discord ? personal.discord.replace(/^@/, '').trim() : null;
  let accountAgeFallback = null;
  let party = null;
  let state = personal.state ? personal.state.replace(/^State of\s+/i, '').trim() : null;

  // Enhanced table scanning with more field patterns
  $('table tr').each((_, tr) => {
    const heading = normalizeWhitespace($(tr).find('th').first().text());
    if (!heading) return;
    const cell = $(tr).find('td').first();
    const value = cleanCellText(cell);

    // Discord patterns
    if (!discord && (/^Discord$/i.test(heading) || /discord/i.test(heading))) {
      discord = value.split(/\s+/).pop() || value;
    }
    // Account age patterns
    else if (!accountAgeFallback && (/^Account\s*Age$/i.test(heading) || /age/i.test(heading))) {
      accountAgeFallback = value;
    }
    // Party patterns
    else if (!party && (/^Party$/i.test(heading) || /party/i.test(heading))) {
      const anchor = normalizeWhitespace(cell.find('a').first().text());
      party = anchor || value;
    }
    // State patterns
    else if (!state && (/^State$/i.test(heading) || /state/i.test(heading))) {
      state = value.replace(/^State of\s+/i, '').trim();
    }
  });

  // Enhanced name extraction - try multiple sources if title parsing failed
  if (!name || name === 'Power Play USA' || /login/i.test(name)) {
    // Try h1, h2, h3 headings
    const headings = $('h1, h2, h3, h4, h5').map((_, el) => normalizeWhitespace($(el).text())).get();
    for (const heading of headings) {
      if (heading && heading !== 'Power Play USA' && !/login/i.test(heading) && heading.length > 2) {
        name = heading;
        break;
      }
    }

    // Try meta tags
    if (!name) {
      const metaName = $('meta[property="og:title"], meta[name="twitter:title"]').attr('content');
      if (metaName) {
        name = metaName.split('|')[0].trim();
      }
    }

    // Try profile-specific selectors
    if (!name) {
      const profileNameSelectors = [
        '.profile-name',
        '.user-name',
        '.player-name',
        '[data-name]',
        '.card-title',
        '.username',
        '.display-name'
      ];

      for (const selector of profileNameSelectors) {
        const element = $(selector).first();
        if (element.length) {
          const text = normalizeWhitespace(element.text());
          if (text && !/login/i.test(text) && text.length > 2) {
            name = text;
            break;
          }
        }
      }
    }
  }

  // Debug logging for troubleshooting
  if (name && /login/i.test(name)) {
    console.log(`[Profile Parse Debug] Extracted login name: "${name}" for potential profile`);
  }

  if (!state) {
    try {
      const $$ = cheerio.load($.html());
      $$('#navbar_global, #navbar-main, nav, header, footer, .ppusa-navbar, .dropdown-menu').remove();

      // Try multiple state extraction methods
      const stateLinks = $$('a[href*="/states/"]');
      for (const link of stateLinks) {
        const stText = normalizeWhitespace($$(link).text());
        if (stText && !/login|home|dashboard/i.test(stText)) {
          state = stText;
          break;
        }
      }

      if (!state) {
        // Try heading patterns
        const stateHeadings = $$('h5,h4,h3,h2').filter((_, el) => /\bState of\b/i.test($$(el).text()));
        for (const heading of stateHeadings) {
          const so = $$(heading).text().trim();
          if (so) {
            state = so.replace(/^State of\s+/i, '').trim();
            break;
          }
        }
      }

      // Try any text that contains state names
      if (!state) {
        const bodyText = $$('body').text();
        const stateMatch = bodyText.match(/\b(Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming)\b/i);
        if (stateMatch) {
          state = stateMatch[1];
        }
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

  // Try multiple cash extraction methods
  const cashPatterns = [
    // Look for finances section with balance
    () => {
      const fin = $('h4:contains("Finances"), h3:contains("Finances"), h5:contains("Finances")').closest('div, .card, .container').find('h5:contains("Balance"), .balance, .money').first();
      if (fin.length) {
        const val = fin.parent().find('.ppusa-money-color, .money, [class*="money"], [class*="cash"], [class*="balance"]').first().text().replace(/\s+/g, ' ').trim();
        return val || fin.parent().find('*').filter((_, el) => /\$\s*\d/.test($(el).text())).first().text().trim();
      }
      return null;
    },

    // Look for money-colored elements
    () => {
      const moneyElements = $('.ppusa-money-color, [class*="money"], [class*="cash"], [class*="balance"], [class*="dollar"]');
      const matches = moneyElements.map((_, el) => ($(el).text() || '').trim()).get().filter((t) => /^\$\s*\d/.test(t));
      return matches.length > 0 ? matches[0] : null;
    },

    // Look for any element with dollar amounts
    () => {
      const allElements = $('*').map((_, el) => $(el).text()).get();
      const dollarMatches = allElements.filter(text => /^\$\s*\d+[\d,]*(\.\d{2})?/.test(text.trim()));
      return dollarMatches.length > 0 ? dollarMatches[0].trim() : null;
    }
  ];

  for (const pattern of cashPatterns) {
    cash = pattern();
    if (cash) break;
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

module.exports = {
  loginAndGet,
  parseProfile,
  BASE,
  config,
};
