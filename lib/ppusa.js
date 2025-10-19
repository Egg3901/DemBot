/**
 * Project: DemBot (Discord automation for Power Play USA)
 * File: lib/ppusa.js
 * Purpose: Shared PPUSA helpers (login session + HTML parsing)
 */
const cheerio = require('cheerio');
const { authenticateAndNavigate, config } = require('./ppusa-auth');
const { toAbsoluteUrl } = require('./ppusa-config');

const BASE = config.baseUrl;

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
  const title = ($('title').first().text() || '').trim();
  const name = title.split('|')[0]?.trim() || null;

  // Discord row
  let discord = null;
  $('table tr').each((_, tr) => {
    const th = $(tr).find('th').first().text().trim();
    if (/^Discord$/i.test(th)) {
      const tdText = $(tr).find('td').text().replace(/\s+/g, ' ').trim();
      discord = tdText.split(' ').pop() || tdText;
    }
  });

  // Account Age
  let accountAge = null;
  $('table tr').each((_, tr) => {
    const th = $(tr).find('th').first().text().trim();
    if (/^Account\s*Age$/i.test(th)) {
      accountAge = $(tr).find('td').text().replace(/\s+/g, ' ').trim();
    }
  });

  // Party
  let party = null;
  $('table tr').each((_, tr) => {
    const th = $(tr).find('th').first().text().trim();
    if (/^Party$/i.test(th)) {
      party = $(tr).find('td a').first().text().replace(/\s+/g, ' ').trim() || $(tr).find('td').text().trim();
    }
  });

  // State (pull from profile content only; ignore global nav)
  let state = null;
  try {
    const $$ = cheerio.load($.html());
    $$('#navbar_global, #navbar-main, nav, header, footer, .ppusa-navbar, .dropdown-menu').remove();
    const stateLink = $$('a[href*="/states/"]').first();
    const stText = (stateLink.text() || '').trim();
    if (stText && /[A-Za-z]/.test(stText)) state = stText.replace(/\s+/g, ' ');
    if (!state) {
      const so = $$('h5,h4,h3').filter((_, el) => /\bState of\b/i.test($$(el).text())).first().text().trim();
      if (so) state = so.replace(/^State of\s+/i, '').trim();
    }
  } catch (_) {}

  // Current Position
  let position = null;
  const posCandidates = $('h5').map((_, el) => ($(el).text() || '').trim()).get();
  position = posCandidates.find((t) =>
    /Private Citizen|Senator|Representative|Governor|President|Vice President|Mayor|Attorney General|Speaker|Leader|Chief|Secretary|Judge|Chair|Councillor|Councilor/i.test(t)
  ) || null;

  // ES, CO, NR
  let es = null; let co = null; let nr = null;
  $('table tr').each((_, tr) => {
    const th = ($(tr).find('th').first().text() || '').trim();
    const td = ($(tr).find('td').first().text() || '').trim();
    if (/^Election\s*Stamina$/i.test(th)) {
      const m = td.match(/([0-9]+(?:\.[0-9]+)?)/);
      if (m) es = m[1];
    } else if (/^Campaign\s*Organization$/i.test(th)) {
      co = td;
    } else if (/^Name\s*Recognition$/i.test(th)) {
      nr = td;
    }
  });

  // Cash/Balance
  let cash = null;
  const fin = $('h4:contains("Finances")').closest('div').find('h5:contains("Balance")').first();
  if (fin.length) {
    const val = fin.parent().find('.ppusa-money-color').first().text().replace(/\s+/g, ' ').trim();
    if (val) cash = val;
  } else {
    const m = $('.ppusa-money-color').map((_, el) => ($(el).text() || '').trim()).get().find((t) => /^\$\s*\d/.test(t));
    if (m) cash = m;
  }

  // Avatar/profile picture
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
  if (avatar && avatar.startsWith('#')) avatar = null; // skip placeholder svg references
  if (avatar) {
    if (avatar.startsWith('//')) avatar = `https:${avatar}`;
    else if (/^\//.test(avatar)) avatar = toAbsoluteUrl(avatar);
    else if (!/^https?:\/\//i.test(avatar)) avatar = toAbsoluteUrl(avatar.replace(/^\.\/?/, ''));
  }

  // Last Online parsing
  let lastOnlineText = null;
  let lastOnlineAt = null;
  let lastOnlineDays = null;
  try {
    $('table tr').each((_, tr) => {
      const th = ($(tr).find('th').first().text() || '').trim();
      if (/^(Last\s*(Online|Active|Seen)|Status)$/i.test(th)) {
        lastOnlineText = ($(tr).find('td').first().text() || '').replace(/\s+/g, ' ').trim();
      }
    });
    if (lastOnlineText) {
      const parsed = parseRelativeTimeToDate(lastOnlineText);
      if (parsed) {
        lastOnlineAt = parsed.toISOString();
        lastOnlineDays = Math.max(0, Math.floor((Date.now() - parsed.getTime()) / (1000 * 60 * 60 * 24)));
      }
    }
  } catch (_) {}

  return { name, discord, accountAge, party, state, position, es, co, nr, cash, avatar, lastOnlineText, lastOnlineAt, lastOnlineDays };
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
