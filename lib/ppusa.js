/**
 * Project: DemBot (Discord automation for Power Play USA)
 * File: lib/ppusa.js
 * Purpose: Shared PPUSA helpers (login session + HTML parsing)
 * Author: egg3901
 * Created: 2025-10-16
 * Last Updated: 2025-10-16
 */
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');

const E = (k, d = '') => process.env[k] ?? d;
const BASE = E('PPUSA_BASE_URL', 'https://powerplayusa.net');
const LOGIN_PAGE = E('PPUSA_LOGIN_PAGE', '/login');
const EMAIL = E('PPUSA_EMAIL');
const PASSWORD = E('PPUSA_PASSWORD');
const NAV_TIMEOUT = Number(E('PPUSA_NAV_TIMEOUT_MS', '20000'));

/**
 * Login with PPUSA credentials and navigate to a target URL.
 * Returns an open browser/page for re-use, along with HTML and status.
 * @param {string} url Absolute or BASE-relative URL to visit after login
 * @returns {Promise<{browser: import('puppeteer').Browser, page: import('puppeteer').Page, html: string, status: number, finalUrl: string}>}
 */
async function loginAndGet(url) {
  if (!EMAIL || !PASSWORD) throw new Error('Missing PPUSA_EMAIL or PPUSA_PASSWORD in .env');

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);
  await page.setUserAgent('Mozilla/5.0');
  try {
    const loginUrl = LOGIN_PAGE.startsWith('http') ? LOGIN_PAGE : BASE + LOGIN_PAGE;
    await page.goto(loginUrl, { waitUntil: 'networkidle2' });

    // basic selectors
    const emailSel = await waitAny(page, [
      'input[type="email"]', 'input[name="email"]', 'input[name="username"]'
    ]);
    const passSel = await waitAny(page, [
      'input[type="password"]', 'input[name="password"]'
    ]);
    if (!emailSel || !passSel) throw new Error('Login fields not found');
    await page.type(emailSel, EMAIL, { delay: 15 });
    await page.type(passSel, PASSWORD, { delay: 15 });

    const submitSel = await waitAny(page, [
      'button[type="submit"]', 'input[type="submit"]', 'button[name="login"]'
    ]);
    if (submitSel) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: NAV_TIMEOUT }).catch(() => null),
        page.click(submitSel)
      ]);
    } else {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: NAV_TIMEOUT }).catch(() => null),
        page.keyboard.press('Enter')
      ]);
    }
    if (/\/login\b/i.test(page.url())) throw new Error('Auth rejected');

    const targetUrl = url.startsWith('http') ? url : BASE + url;
    const resp = await page.goto(targetUrl, { waitUntil: 'networkidle2' });
    const status = resp?.status?.() ?? 200;
    const html = await page.content();
    return { browser, page, html, status, finalUrl: page.url() };
  } catch (e) {
    await browser.close();
    throw e;
  }
}

/**
 * Parse a user profile HTML page into a structured object.
 * Extracts name, Discord handle, party, state, position, ES/CO/NR, cash, and account age.
 * @param {string} html
 * @returns {{name: string|null, discord: string|null, accountAge: string|null, party: string|null, state: string|null, position: string|null, es: string|null, co: string|null, nr: string|null, cash: string|null, avatar: string|null, lastOnlineText: string|null, lastOnlineAt: string|null, lastOnlineDays: number|null}}
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
      // Typically the handle is the last token
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
    // look for links to /states/<id> within main content
    const stateLink = $$('a[href*="/states/"]').first();
    const stText = (stateLink.text() || '').trim();
    if (stText && /[A-Za-z]/.test(stText)) state = stText.replace(/\s+/g, ' ');
    // fallback: headings like "State of X" within content
    if (!state) {
      const so = $$('h5,h4,h3').filter((_, el) => /\bState of\b/i.test($$(el).text())).first().text().trim();
      if (so) state = so.replace(/^State of\s+/i, '').trim();
    }
  } catch (_) {
    // ignore parse errors; leave state as null
  }

  // Current Position
  let position = null;
  const posCandidates = $('h5').map((_, el) => ($(el).text() || '').trim()).get();
  position = posCandidates.find(t => /Private Citizen|Senator|Representative|Governor|President|Vice President|Mayor|Attorney General|Speaker|Leader|Chief|Secretary|Judge|Chair|Councillor|Councilor/i.test(t)) || null;

  // ES, CO, NR (from Political Info table)
  let es = null, co = null, nr = null;
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

  // Cash/Balance from Finances card
  let cash = null;
  const fin = $('h4:contains("Finances")').closest('div').find('h5:contains("Balance")').first();
  if (fin.length) {
    const val = fin.parent().find('.ppusa-money-color').first().text().replace(/\s+/g, ' ').trim();
    if (val) cash = val;
  } else {
    // fallback: first big money value on page
    const m = $('.ppusa-money-color').map((_, el) => ($(el).text() || '').trim()).get().find(t => /^\$\s*\d/.test(t));
    if (m) cash = m;
  }

  // Avatar/profile picture
  let avatar = null;
  const imgCandidates = $('img').toArray();
  for (const el of imgCandidates) {
    const src = ($(el).attr('src') || '').trim();
    if (/\/assets\/img\/profile-pictures\//i.test(src)) {
      avatar = src; break;
    }
  }
  if (avatar) {
    if (avatar.startsWith('//')) avatar = 'https:' + avatar;
    else if (avatar.startsWith('/')) avatar = BASE + avatar;
    else if (!/^https?:\/\//i.test(avatar)) avatar = BASE + (avatar.startsWith('.') ? avatar.slice(1) : ('/' + avatar));
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
  // Try parsing as an absolute date string
  const dt = new Date(text);
  if (!isNaN(dt.getTime())) return dt;
  return null;
}

/**
 * Wait for the first selector to appear on the page.
 * @param {import('puppeteer').Page} page
 * @param {string[]} selectors
 * @returns {Promise<string|null>} matched selector or null
 */
async function waitAny(page, selectors) {
  return Promise.any(selectors.map(sel => page.waitForSelector(sel, { timeout: 3000 }).then(() => sel))).catch(() => null);
}

module.exports = {
  loginAndGet,
  parseProfile,
  BASE,
};
