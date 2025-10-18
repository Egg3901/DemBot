// commands/treasury.js
// Fetches the party treasury page via Puppeteer and reports totals.

const { SlashCommandBuilder } = require('discord.js');
const cheerio = require('cheerio');
const { authenticateAndNavigate, PPUSAAuthError } = require('../lib/ppusa-auth');
const { config, getEnv, toAbsoluteUrl } = require('../lib/ppusa-config');
const { recordCommandError } = require('../lib/status-tracker');

const BASE = config.baseUrl;
const DEFAULT_DEBUG = config.debug;
const TREASURY_URL = toAbsoluteUrl(getEnv('TREASURY_URL', '/parties/1/treasury'));
const DEMS_TREASURY_URL = toAbsoluteUrl(getEnv('DEMS_TREASURY_URL', TREASURY_URL));
const GOP_TREASURY_URL = toAbsoluteUrl(getEnv('GOP_TREASURY_URL', '/parties/2'));

const formatAuthErrorMessage = (err, commandLabel) => {
  if (!(err instanceof PPUSAAuthError)) return `Error: ${err.message}`;
  const details = err.details || {};
  const lines = [`Error: ${err.message}`];
  if (details.finalUrl) lines.push(`Page: ${details.finalUrl}`);

  const tried = details.triedSelectors || {};
  if (Array.isArray(tried.email) && tried.email.length) {
    lines.push(`Email selectors tried: ${tried.email.join(', ')}`);
  }
  if (Array.isArray(tried.password) && tried.password.length) {
    lines.push(`Password selectors tried: ${tried.password.join(', ')}`);
  }

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

  lines.push(`Tip: run ${commandLabel} debug:true to attach the full action log (no .env change needed).`);
  return lines.join('\n');
};

const buildDebugArtifacts = (enabled, data) => {
  if (!enabled || !data) return { suffix: '', files: undefined };
  const payload = JSON.stringify(data, null, 2);
  if (payload.length > 1500) {
    return {
      suffix: '\n\nDebug details attached (treasury_debug.json)',
      files: [{ attachment: Buffer.from(payload, 'utf8'), name: 'treasury_debug.json' }],
    };
  }
  return { suffix: `\n\nDebug: ${payload}` };
};

async function fetchTreasuryHtml(targetUrl, debug) {
  const session = await authenticateAndNavigate({ url: targetUrl, debug });
  const { browser, html, finalUrl, actions } = session;
  try {
    return { html, finalUrl, actions };
  } finally {
    try { await browser.close(); } catch (_) {}
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('treasury')
    .setDescription('Show a party treasury total')
    .addStringOption((o) =>
      o.setName('party')
        .setDescription('Choose party (dems=1, gop=2)')
        .setRequired(false)
        .addChoices(
          { name: 'Dems', value: 'dems' },
          { name: 'GOP', value: 'gop' },
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
    const choice = interaction.options.getString('party') ?? 'dems';
    const treasUrl = choice === 'gop' ? GOP_TREASURY_URL : DEMS_TREASURY_URL;
    let deferred = false;
    try {
      await interaction.deferReply();
      deferred = true;
    } catch (err) {
      if (err?.code === 10062) {
        console.warn('treasury: interaction token expired before defer; skipping response.');
        return;
      }
      throw err;
    }

    try {
      const { html, finalUrl, actions } = await fetchTreasuryHtml(treasUrl, debugFlag);
      const total = extractTreasuryTotal(html);

      if (!total) {
        const message = userDebug
          ? `Fetched treasury page but could not find a $ amount. Final URL: ${finalUrl}`
          : 'Could not find a balance on the page.';
        console.warn(`[treasury] No balance found at ${finalUrl}`);
        try {
          recordCommandError(interaction.commandName, new Error(`Treasury total not found (${finalUrl || 'unknown'})`));
        } catch (_) {}
        interaction._dembotHandledError = true;
        const { suffix, files } = buildDebugArtifacts(userDebug, { finalUrl, actions });
        return interaction.editReply({ content: `${message}${suffix}`, files });
      }

      const fields = [];
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

      const { suffix, files } = buildDebugArtifacts(userDebug, { finalUrl, actions });
      const payload = { embeds: [embed] };
      if (suffix) payload.content = suffix;
      if (files) payload.files = files;

      try {
        await interaction.editReply(payload);
      } catch (editErr) {
        if (editErr?.code === 10062) {
          console.warn('treasury: interaction expired before final reply could be sent.');
        } else {
          throw editErr;
        }
      }
    } catch (err) {
      interaction._dembotHandledError = true;
      recordCommandError(interaction.commandName, err);
      const isAuthError = err instanceof PPUSAAuthError;
      const details = isAuthError ? (err.details || {}) : {};
      const debugData = userDebug ? {
        finalUrl: details.finalUrl ?? null,
        actions: details.actions ?? [],
        screenshot: details.screenshot ?? null,
      } : null;
      if (deferred) {
        const { suffix, files } = buildDebugArtifacts(userDebug, debugData);
        const baseMessage = isAuthError
          ? formatAuthErrorMessage(err, '/treasury')
          : `Error: ${err.message}`;
        const note = details.screenshot && userDebug
          ? `${suffix}\nScreenshot saved at ${details.screenshot}`.trim()
          : suffix;
        const content = note ? `${baseMessage}${note}` : baseMessage;
        try {
          await interaction.editReply({ content, files });
        } catch (editErr) {
          if (editErr?.code === 10062) {
            console.warn('treasury: unable to edit reply because the interaction expired.');
          } else {
            throw editErr;
          }
        }
      }
    }
  },
};

function extractTreasuryTotal(html) {
  const $ = cheerio.load(html);
  $('#ppusa-bottombar, .ppusa-bottombar, #ppusa-topbar, .ppusa-topbar, nav, header, footer').remove();

  const financesH3 = $('h3').filter((_, el) => /party\s*finances/i.test($(el).text())).first();
  if (financesH3.length) {
    const container = financesH3.closest('.container, .container-fluid, .row').length
      ? financesH3.closest('.container, .container-fluid, .row')
      : financesH3.parent();

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

    const sectionText = container.text().replace(/\s+/g, ' ');
    const m = [...sectionText.matchAll(/\$\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)/g)].map((x) => x[0]);
    if (m.length) {
      const withVal = m.map((s) => ({ s, v: Number(s.replace(/[^0-9.]/g, '').replace(/,(?=\d{3}(\D|$))/g, '')) }));
      withVal.sort((a, b) => b.v - a.v);
      return withVal[0].s;
    }
  }

  const moneyCandidate = $('*.ppusa-money-color').map((_, el) => ($(el).text() || '').trim()).get()
    .find((t) => /\$\s*\d/.test(t));
  if (moneyCandidate) return moneyCandidate;

  const text = $('body').text().replace(/\s+/g, ' ');
  const matches = [...text.matchAll(/\$\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)/g)].map((m) => m[0]);
  if (matches.length) {
    const withVal = matches.map((s) => ({ s, v: Number(s.replace(/[^0-9.]/g, '').replace(/,(?=\d{3}(\D|$))/g, '')) }));
    withVal.sort((a, b) => b.v - a.v);
    return withVal[0].s;
  }

  const financesBlockMatch = html.match(/<h3>\s*Party\s+Finances\s*<\/h3>[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/i);
  if (financesBlockMatch) {
    const block = financesBlockMatch[0];
    const nationalCardMatch = block.match(/<div[^>]*class="[^"]*col-md-3[^"]*text-center[^"]*"[^>]*>\s*<h5>\s*National\s+Party\s*<\/h5>\s*<h5[^>]*class="[^"]*\bppusa-money-color\b[^"]*"[^>]*>\s*([^<]+)\s*<\/h5>/i);
    if (nationalCardMatch) return nationalCardMatch[1].trim();
    const anyMoneyInBlock = block.match(/<h5[^>]*class="[^"]*\bppusa-money-color\b[^"]*"[^>]*>\s*([^<]+)\s*<\/h5>/i);
    if (anyMoneyInBlock) return anyMoneyInBlock[1].trim();
  }

  return null;
}

function extractDemFinances(html) {
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
  } catch (_) {}

  const financesBlockMatch = html.match(/<h3>\s*Party\s*Finances\s*<\/h3>[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/i);
  if (!financesBlockMatch) return null;
  const block = financesBlockMatch[0];

  const getLabeledMoney = (label) => {
    const re = new RegExp(
      `<h5>\\s*${label}\\s*<\\/h5>\\s*<h5[^>]*class=\\"[^\\"]*\\bppusa-money-color\\b[^\\"]*\\"[^>]*>\\s*([^<]+)\\s*<\\/h5>`,
      'i',
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
