// commands/treasury.js
// Uses Puppeteer to perform a real browser login, then scrapes the treasury balance.
// Requirements: discord.js v14, Node 18+, `npm i puppeteer`
//
// .env needed:
//   PPUSA_BASE_URL=https://powerplayusa.net
//   PPUSA_LOGIN_PAGE=/login
//   TREASURY_URL=https://powerplayusa.net/parties/1/treasury
//   PPUSA_EMAIL=you@example.com
//   PPUSA_PASSWORD=your_password
//
// Optional (for slower servers):
//   PPUSA_NAV_TIMEOUT_MS=20000
//
// Run: /treasury  (or /treasury debug:true)

const { SlashCommandBuilder } = require('discord.js');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');

const E = (k, d = '') => process.env[k] ?? d;

const BASE         = E('PPUSA_BASE_URL', 'https://powerplayusa.net');
const LOGIN_PAGE   = E('PPUSA_LOGIN_PAGE', '/login');
const TREASURY_URL = E('TREASURY_URL', `${BASE}/parties/1/treasury`);
const DEMS_TREASURY_URL = E('DEMS_TREASURY_URL', `${BASE}/parties/1/treasury`);
const GOP_TREASURY_URL  = E('GOP_TREASURY_URL', `${BASE}/parties/2`);
const EMAIL        = E('PPUSA_EMAIL');
const PASSWORD     = E('PPUSA_PASSWORD');
const NAV_TIMEOUT  = Number(E('PPUSA_NAV_TIMEOUT_MS', '20000'));

// common selectors on that site + fallbacks
const EMAIL_CANDIDATES = [
  'input[type="email"]',
  'input[name="email"]',
  'input[name="username"]',
  'input[name*="email" i]',
  'input[name*="user" i]'
];

const PASS_CANDIDATES = [
  'input[type="password"]',
  'input[name="password"]',
  'input[name*="pass" i]'
];

const SUBMIT_CANDIDATES = [
  'button[type="submit"]',
  'input[type="submit"]',
  'button[name="login"]',
  'button:has-text("Login")',
  'button:has-text("Sign in")'
];

function pickFirst(page, selectors) {
  return Promise.any(
    selectors.map(sel => page.waitForSelector(sel, { timeout: 3000 }).then(() => sel))
  ).catch(() => null);
}

// replace your existing extractBalance(html) with this:
function extractBalance(html) {
  // 1) Narrow to the “Party Finances” block
  const financesBlockMatch = html.match(
    /<h3>\s*Party\s+Finances\s*<\/h3>[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/i
  );
  if (!financesBlockMatch) return null;
  const block = financesBlockMatch[0];

  // 2) In that block, find the “National Party” card and its <h5 class="ppusa-money-color">…</h5>
  const nationalCardMatch = block.match(
    /<div[^>]*class="[^"]*col-md-3[^"]*text-center[^"]*"[^>]*>\s*<h5>\s*National\s+Party\s*<\/h5>\s*<h5[^>]*class="[^"]*\bppusa-money-color\b[^"]*"[^>]*>\s*([^<]+)\s*<\/h5>/i
  );
  if (nationalCardMatch) {
    return nationalCardMatch[1].trim(); // e.g. "$125,932,248"
  }

  // 3) Fallbacks (still avoid the bottom bar):
  // Try any ppusa-money-color right under Party Finances grid
  const anyMoneyInBlock = block.match(
    /<h5[^>]*class="[^"]*\bppusa-money-color\b[^"]*"[^>]*>\s*([^<]+)\s*<\/h5>/i
  );
  if (anyMoneyInBlock) return anyMoneyInBlock[1].trim();

  // DO NOT look at #ppusa-bottombar — that is the personal HUD. (e.g., "$1,885,405") :contentReference[oaicite:2]{index=2}
  return null;
}


async function loginAndGrabTreasuryHTML(debug = false) {
  if (!EMAIL || !PASSWORD) throw new Error('Missing PPUSA_EMAIL or PPUSA_PASSWORD in .env');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0');
    page.setDefaultNavigationTimeout(NAV_TIMEOUT);

    // 1) Go to login
    const loginUrl = LOGIN_PAGE.startsWith('http') ? LOGIN_PAGE : BASE + LOGIN_PAGE;
    await page.goto(loginUrl, { waitUntil: 'networkidle2' });

    // 2) Find email/password inputs
    const emailSel = await pickFirst(page, EMAIL_CANDIDATES);
    const passSel  = await pickFirst(page, PASS_CANDIDATES);
    if (!emailSel || !passSel) {
      throw new Error('Could not find email/password fields on the login page.');
    }

    // 3) Type credentials
    await page.focus(emailSel);
    await page.keyboard.type(EMAIL, { delay: 15 });
    await page.focus(passSel);
    await page.keyboard.type(PASSWORD, { delay: 15 });

    // 4) Submit (button if present, else press Enter)
    const submitSel = await pickFirst(page, SUBMIT_CANDIDATES);
    if (submitSel) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: NAV_TIMEOUT }),
        page.click(submitSel),
      ]);
    } else {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: NAV_TIMEOUT }),
        page.keyboard.press('Enter'),
      ]);
    }

    // 5) Navigate to the treasury page (if not already there)
    const treasUrl = TREASURY_URL.startsWith('http') ? TREASURY_URL : BASE + TREASURY_URL;
    if (!page.url().startsWith(treasUrl)) {
      await page.goto(treasUrl, { waitUntil: 'networkidle2' });
    }

    // 6) Verify we didn’t get bounced back to login
    if (/\/login\b/i.test(page.url())) {
      throw new Error('Still on login page after submitting credentials (auth rejected).');
    }

    const html = await page.content();
    if (debug) {
      console.log('[DEBUG] Final URL:', page.url());
    }
    return { html, finalUrl: page.url() };
  } finally {
    await browser.close();
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('treasury')
    .setDescription('Show a party treasury total')
    .addStringOption(o =>
      o.setName('party')
        .setDescription('Choose party (dems=1, gop=2)')
        .setRequired(false)
        .addChoices(
          { name: 'Dems', value: 'dems' },
          { name: 'GOP', value: 'gop' }
        )
    )
    .addBooleanOption(o =>
      o.setName('debug')
        .setDescription('Include diagnostics (ephemeral)')
        .setRequired(false)
    ),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction) {
    const debug = interaction.options.getBoolean('debug') ?? false;
    const choice = interaction.options.getString('party') ?? 'dems';
    const treasUrl = choice === 'gop' ? GOP_TREASURY_URL : DEMS_TREASURY_URL;
    await interaction.deferReply(); // public

    try {
      const { html, finalUrl } = await loginAndGrabTreasuryHTMLForUrl(treasUrl, debug);
      const total = extractTreasuryTotal(html);

      if (!total) {
        return interaction.editReply(
          debug
            ? `Fetched treasury page but could not find a $ amount. Final URL: ${finalUrl}`
            : 'Could not find a balance on the page.'
        );
      }

      // For Dems, include "Caucuses" and "Members" amounts from the Party Finances grid
      let fields = [];
      let embedDesc = `**${total}**`;
      if (choice !== 'gop') {
        const dem = extractDemFinances(html);
        if (dem?.total) embedDesc = `**${dem.total}**`;
        if (dem?.caucuses) fields.push({ name: 'Caucuses', value: dem.caucuses, inline: true });
        if (dem?.members) fields.push({ name: 'Members', value: dem.members, inline: true });
      }

      const embed = {
        title: `${choice === 'gop' ? 'Republican Party' : 'Democratic Party'} Treasury`,
        description: embedDesc,
        ...(fields.length ? { fields } : {}),
        footer: { text: new URL(treasUrl).hostname },
        timestamp: new Date().toISOString(),
      };

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      await interaction.editReply(`Error: ${err?.message ?? String(err)}`);
    }
  },
};

// New: target a specific treasury URL and fetch HTML
async function loginAndGrabTreasuryHTMLForUrl(targetUrl, debug = false) {
  if (!EMAIL || !PASSWORD) throw new Error('Missing PPUSA_EMAIL or PPUSA_PASSWORD in .env');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0');
    page.setDefaultNavigationTimeout(NAV_TIMEOUT);

    const loginUrl = LOGIN_PAGE.startsWith('http') ? LOGIN_PAGE : BASE + LOGIN_PAGE;
    await page.goto(loginUrl, { waitUntil: 'networkidle2' });

    const emailSel = await pickFirst(page, EMAIL_CANDIDATES);
    const passSel = await pickFirst(page, PASS_CANDIDATES);
    if (!emailSel || !passSel) throw new Error('Could not find email/password fields on the login page.');

    await page.focus(emailSel); await page.keyboard.type(EMAIL, { delay: 15 });
    await page.focus(passSel);  await page.keyboard.type(PASSWORD, { delay: 15 });

    const submitSel = await pickFirst(page, SUBMIT_CANDIDATES);
    if (submitSel) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: NAV_TIMEOUT }),
        page.click(submitSel),
      ]);
    } else {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: NAV_TIMEOUT }),
        page.keyboard.press('Enter'),
      ]);
    }

    if (/\/login\b/i.test(page.url())) throw new Error('Still on login page after submitting credentials (auth rejected).');

    const treasUrl = targetUrl.startsWith('http') ? targetUrl : BASE + targetUrl;
    await page.goto(treasUrl, { waitUntil: 'networkidle2' });

    const html = await page.content();
    if (debug) console.log('[DEBUG] Final URL:', page.url());
    return { html, finalUrl: page.url() };
  } finally {
    await browser.close();
  }
}

// New: extract only the treasury total robustly across pages
function extractTreasuryTotal(html) {
  const $ = cheerio.load(html);

  // Remove personal HUD/bottom bar to avoid picking personal balance
  $('#ppusa-bottombar, .ppusa-bottombar, #ppusa-topbar, .ppusa-topbar, nav, header, footer').remove();

  // 1) Try the National Party card under Party Finances
  const financesH3 = $('h3').filter((_, el) => /party\s*finances/i.test($(el).text())).first();
  if (financesH3.length) {
    const container = financesH3.closest('.container, .container-fluid, .row').length
      ? financesH3.closest('.container, .container-fluid, .row')
      : financesH3.parent();

    // Prefer a money value whose preceding h5 label contains "Party"
    let labeled = null;
    container.find('h5.ppusa-money-color, .ppusa-money-color').each((_, el) => {
      if (labeled) return;
      const $el = $(el);
      const label = ($el.prevAll('h5').first().text() || '').trim();
      if (/party/i.test(label)) {
        const t = ($el.text() || '').trim();
        if (/\$\s*\d/.test(t)) labeled = t;
      }
    });
    if (labeled) return labeled;

    // Fallback: any currency-looking value within this section; choose the largest
    const sectionText = container.text().replace(/\s+/g, ' ');
    const m = [...sectionText.matchAll(/\$\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)/g)].map(x => x[0]);
    if (m.length) {
      const withVal = m.map(s => ({ s, v: Number(s.replace(/[^0-9.]/g, '').replace(/,(?=\d{3}(\D|$))/g, '')) }));
      withVal.sort((a, b) => b.v - a.v);
      return withVal[0].s;
    }
  }

  // 2) Any ppusa-money-color that looks like currency
  const moneyCandidate = $('*.ppusa-money-color').map((_, el) => ($(el).text() || '').trim()).get()
    .find(t => /\$\s*\d/.test(t));
  if (moneyCandidate) return moneyCandidate;

  // 3) Fallback: find all currency-looking numbers and pick the max
  const text = $('body').text().replace(/\s+/g, ' ');
  const matches = [...text.matchAll(/\$\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)/g)].map(m => m[0]);
  if (matches.length) {
    const withVal = matches.map(s => ({ s, v: Number(s.replace(/[^0-9.]/g, '').replace(/,(?=\d{3}(\D|$))/g, '')) }));
    withVal.sort((a, b) => b.v - a.v);
    return withVal[0].s;
  }

  // 4) Final fallback: original regex method looking for Party Finances/National Party in raw HTML
  const financesBlockMatch = html.match(/<h3>\s*Party\s+Finances\s*<\/h3>[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/i);
  if (financesBlockMatch) {
    const block = financesBlockMatch[0];
    const nationalCardMatch = block.match(/<div[^>]*class=\"[^\"]*col-md-3[^\"]*text-center[^\"]*\"[^>]*>\s*<h5>\s*National\s+Party\s*<\/h5>\s*<h5[^>]*class=\"[^\"]*\bppusa-money-color\b[^\"]*\"[^>]*>\s*([^<]+)\s*<\/h5>/i);
    if (nationalCardMatch) return nationalCardMatch[1].trim();
    const anyMoneyInBlock = block.match(/<h5[^>]*class=\"[^\"]*\bppusa-money-color\b[^\"]*\"[^>]*>\s*([^<]+)\s*<\/h5>/i);
    if (anyMoneyInBlock) return anyMoneyInBlock[1].trim();
  }

  return null;
}

// Extract members and caucuses counts from page text
function extractDemFinances(html) {
  // First try a DOM-driven parse
  try {
    const $ = cheerio.load(html);
    $('#ppusa-bottombar, .ppusa-bottombar, #ppusa-topbar, .ppusa-topbar, nav, header, footer').remove();

    const h3 = $('h3').filter((_, el) => /party\s*finances/i.test($(el).text())).first();
    if (h3.length) {
      const container = h3.closest('.container, .container-fluid, .row').length
        ? h3.closest('.container, .container-fluid, .row')
        : h3.parent();

      const total = (container.find('h5.ppusa-money-color').first().text() || '').trim() || null;

      const findAmountAfterLabel = (labelRe) => {
        const lab = container.find('h5').filter((_, el) => labelRe.test(($(el).text() || '').trim())).first();
        if (!lab.length) return null;
        const nextMoney = lab.nextAll('h5').filter((_, el) => /ppusa-money-color/.test($(el).attr('class') || '')).first();
        return (nextMoney.text() || '').trim() || null;
      };

      const caucuses = findAmountAfterLabel(/\bCaucuses?\b/i);
      const members = findAmountAfterLabel(/\bMembers?\b/i);

      if (total || caucuses || members) return { total, caucuses, members };
    }
  } catch (_) {
    // fall through to regex
  }

  // Fallback: regex parse using known Dem structure
  const financesBlockMatch = html.match(/<h3>\s*Party\s*Finances\s*<\/h3>[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/i);
  if (!financesBlockMatch) return null;
  const block = financesBlockMatch[0];

  const getLabeledMoney = (label) => {
    const re = new RegExp(
      `<h5>\\s*${label}\\s*<\\/h5>\\s*<h5[^>]*class=\\"[^\\"]*\\bppusa-money-color\\b[^\\"]*\\"[^>]*>\\s*([^<]+)\\s*<\\/h5>`,
      'i'
    );
    const m = block.match(re);
    return m ? m[1].trim() : null;
  };

  const total = getLabeledMoney('National\\s+Party');
  const caucuses = getLabeledMoney('Caucuses?');
  const members = getLabeledMoney('Members?');

  if (total || caucuses || members) return { total, caucuses, members };
  return null;
}
/**
 * Project: DemBot (Discord automation for Power Play USA)
 * File: commands/treasury.js
 * Purpose: Login and display party treasury totals (Dems/GOP) in embeds
 * Author: egg3901
 * Created: 2025-10-16
 * Last Updated: 2025-10-16
 */
