// commands/send.js
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { authenticateAndNavigate, PPUSAAuthError } = require('../lib/ppusa-auth');
const { config, getEnv, toAbsoluteUrl } = require('../lib/ppusa-config');
const { getSendLimit, ROLE_FINANCE, ROLE_TREASURY_ADMIN, UNLIMITED, formatLimit } = require('../lib/send-access');

const NAV_TIMEOUT = config.navTimeout;
const DEFAULT_DEBUG = config.debug;
const DEMS_TREASURY_URL = toAbsoluteUrl(getEnv('DEMS_TREASURY_URL', '/parties/1/treasury'));
const SEND_USE_AUTOSUGGEST = String(getEnv('SEND_USE_AUTOSUGGEST', 'false')).toLowerCase() === 'true';


// Default amount constant is unused because amount is required, but we keep it to format nicely if needed
const DEFAULT_AMOUNT = 2_000_000;

/* ---------- helpers: embeds & formatting ---------- */
const fmtUsd = (n) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    n ?? DEFAULT_AMOUNT
  );

function buildRequestEmbeds({ invokerTag, name, type, amount, limitLabel }) {
  // Embed 1: Request summary
  const summary = new EmbedBuilder()
    .setTitle('SEND FUNDS — Request')
    .setColor(0xffcc00) // amber
    .addFields(
      { name: 'Recipient', value: name, inline: true },
      { name: 'Type', value: type, inline: true },
      { name: 'Amount', value: fmtUsd(amount), inline: true }
    )
    .setFooter({ text: `Requested by ${invokerTag}` })
    .setTimestamp();

  if (limitLabel) {
    summary.addFields({ name: 'Per-Transaction Limit', value: limitLabel, inline: true });
  }

  // Embed 2: Status (pending)
  const status = new EmbedBuilder()
    .setTitle('Status')
    .setColor(0xffcc00)
    .setDescription('Processing…');

  return [summary, status];
}

function buildCompletedEmbeds({ invokerTag, name, type, amount, webResult, extraNotes, debugInline, limitLabel }) {
  const ok = !!webResult?.ok;

  // Embed 1: Final summary (unchanged)
  const summary = new EmbedBuilder()
    .setTitle('SEND FUNDS — Completed')
    .setColor(ok ? 0x34d399 : 0xf87171) // green vs red
    .addFields(
      { name: 'Recipient', value: name, inline: true },
      { name: 'Type', value: type, inline: true },
      { name: 'Amount', value: fmtUsd(amount), inline: true }
    )
    .setFooter({ text: `Requested by ${invokerTag}` })
    .setTimestamp();

  if (limitLabel) {
    summary.addFields({ name: 'Per-Transaction Limit', value: limitLabel, inline: true });
  }

  // Determine nice status line
  let statusLine;
  if (!ok) {
    statusLine = `**Failed:** ${webResult?.reason ?? 'unknown error'}`;
  } else if (webResult?.approved) {
    statusLine = '✅ Sent **and approved** on website';
  } else if (webResult?.needsApproval) {
    statusLine = '☑️ Submitted — **manual approval required**';
  } else if (webResult?.verified) {
    statusLine = '✅ Sent on website (**verified**)';
  } else if (webResult?.submitted) {
    statusLine = '✅ Sent on website (**verification pending**)';
  } else {
    statusLine = '✅ Sent on website';
  }

  // Embed 2: Status details
  const status = new EmbedBuilder()
    .setTitle('Status')
    .setColor(ok ? 0x34d399 : 0xf87171)
    .setDescription(statusLine);

  if (Array.isArray(extraNotes) && extraNotes.length) {
    status.addFields({ name: 'Notes', value: extraNotes.join('\n') });
  }

  if (debugInline) {
    status.addFields({ name: 'Diagnostics', value: debugInline.slice(0, 1000) }); // keep under embed field length
  }

  return [summary, status];
}

/* ---------- auth error pretty printer ---------- */
const formatAuthErrorMessage = (err, commandLabel) => {
  if (!(err instanceof PPUSAAuthError)) return err.message;
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
    lines.push('Workaround: sign in manually in a browser, copy the `ppusa_session=...` cookie, and set it as PPUSA_COOKIE.');
    lines.push('The bot will reuse that session and skip the challenge.');
    lines.push('Helper: run `npm run cookie:update`, paste the cookie values, then restart the bot.');
  }
  lines.push(`Tip: run ${commandLabel} debug:true to attach the full action log (no .env change needed).`);
  return lines.join('\n');
};

/* ---------- command ---------- */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('send')
    .setDescription('Send funds to a specified name and auto-approve')
    // Required: name
    .addStringOption((opt) =>
      opt.setName('name').setDescription('Recipient name (can be multiple words)').setRequired(true)
    )
    // Required: amount
    .addNumberOption((opt) =>
      opt.setName('amount').setDescription('Dollar amount to send').setRequired(true).setMinValue(0.01)
    )
    // Optional: type (defaults to player)
    .addStringOption((opt) =>
      opt
        .setName('type')
        .setDescription('Recipient type (defaults to Player)')
        .addChoices(
          { name: 'Player', value: 'player' },
          { name: 'Caucus', value: 'caucus' },
          { name: 'State Party', value: 'state_party' }
        )
        .setRequired(false)
    )
    .addBooleanOption((opt) =>
      opt.setName('debug').setDescription('Include diagnostics in the response').setRequired(false)
    )
    .setDMPermission(false),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction) {
    // Role gate
    const member =
      interaction.member ||
      (interaction.guild ? await interaction.guild.members.fetch(interaction.user.id).catch(() => null) : null);
    const hasFinanceRole = member?.roles?.cache?.has(ROLE_FINANCE) || false;
    const hasAdminRole = member?.roles?.cache?.has(ROLE_TREASURY_ADMIN) || false;
    if (!hasFinanceRole && !hasAdminRole) {
      return interaction.reply({
        content: 'You do not have permission to use this command.',
        ephemeral: true,
      });
    }

    const limit = getSendLimit(member);
    const limitLabel = formatLimit(limit);

    // Inputs
    const name = interaction.options.getString('name', true);
    const type = interaction.options.getString('type') ?? 'player'; // default
    const amount = interaction.options.getNumber('amount', true);
    const debug = interaction.options.getBoolean('debug') ?? false;
    const invokerTag = interaction.user?.tag ?? interaction.user?.id ?? 'unknown';

    if (limit !== UNLIMITED && amount > limit) {
      return interaction.reply({
        content: `Amount exceeds your per-transaction limit of ${formatLimit(limit)}.`,
        ephemeral: true,
      });
    }

    // Initial two-embed message
    await interaction.reply({
      embeds: buildRequestEmbeds({ invokerTag, name, type, amount, limitLabel }),
      allowedMentions: { parse: [] },
    });
    // Perform web send
    let webResult = null;
    try {
      if (!config.email || !config.password) {
        webResult = { ok: false, reason: 'Missing PPUSA_EMAIL/PASSWORD' };
      } else {
        webResult = await performWebSend({ type, name, amount, debug });
      }
    } catch (err) {
      webResult = { ok: false, reason: err?.message ?? String(err) };
    }

    // Decide on debug handling (inline vs file)
    const includeDebug = debug || !webResult?.ok;
    let files;
    let debugInline;
    if (includeDebug && webResult) {
      const payload = JSON.stringify(webResult, null, 2);
      if (payload.length > 1500) {
        files = [{ attachment: Buffer.from(payload, 'utf8'), name: 'send_debug.json' }];
        debugInline = 'Attached **send_debug.json**';
      } else {
        debugInline = '```json\n' + payload + '\n```';
      }
    }

    const extraNotes = [];
    if (!webResult?.ok && webResult?.reasonDetail && webResult.reasonDetail !== webResult.reason) {
      extraNotes.push(webResult.reasonDetail);
    }

    // 🟢/🔴 Edit with two embeds: summary + status
    await interaction.editReply({
      embeds: buildCompletedEmbeds({
        invokerTag,
        name,
        type,
        amount,
        webResult,
        extraNotes,
        debugInline,
        limitLabel,
      }),
      allowedMentions: { parse: [] },
      files,
    });
  },
};

/* ---------- web automation (unchanged core; uses form.requestSubmit/submit) ---------- */
async function performWebSend({ type, name, amount, debug }) {
  const actions = [];
  const note = (step, detail, extra = {}) => {
    actions.push({ step, detail, timestamp: new Date().toISOString(), ...extra });
  };
  note('start', 'Initiating web send.', { type, name, amount });

  let session;
  let browser;
  let page;
  let finalUrl = null;
  try {
    const authDebug = debug || DEFAULT_DEBUG;
    session = await authenticateAndNavigate({ url: DEMS_TREASURY_URL, debug: authDebug });
    browser = session.browser;
    page = session.page;
    finalUrl = session.finalUrl;
    const authActions = Array.isArray(session.actions) ? session.actions : [];
    for (const action of authActions) actions.push({ phase: 'auth', ...action });
    note('login-success', 'Authenticated and ready on treasury page.', { finalUrl });

    // Snapshot outgoing transactions before submitting
    const preTransactions = await scrapeOutgoingTransactions(page);
    const preData = await captureOutgoingData(page);
    note('snapshot', 'Captured pre-submit outgoing transactions.', {
      countDom: preTransactions.length,
      countData: preData.length,
    });

    // Set recipient type if selector exists
    const selectSel = '#partyTransactions select#target, #target';
    if (await page.$(selectSel)) {
      await page.select(selectSel, type);
      note('form', 'Recipient type selected.', { selectSel, type });
    } else {
      note('form', 'Recipient type selector missing.', { selectSel });
    }

    // Name input
    const nameSel = '#partyTransactions #target_id, #target_id';
    if (!(await page.$(nameSel))) {
      note('form', 'Name field missing.', { nameSel });
      return { ok: false, step: 'locate-name', reason: 'Name field not found', actions };
    }
    await page.$eval(nameSel, (el) => (el.value = ''));
    await page.type(nameSel, name, { delay: 10 });
    await page.$eval(nameSel, (el) => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    note('form', 'Recipient name filled.', { value: name });

    // Try autosuggest commit (optional)
    try {
      if (!SEND_USE_AUTOSUGGEST) throw new Error('autosuggest disabled');
      const SUGGESTION_SELECTORS = [
        '.tt-menu .tt-suggestion',
        '.autocomplete-suggestions .autocomplete-suggestion',
        'div[role="listbox"] [role="option"]',
        '.dropdown-menu .dropdown-item',
        'ul[role="listbox"] li',
        '.list-group .list-group-item',
      ];
      if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(300);
      else await new Promise((r) => setTimeout(r, 300));
      let picked = null;
      for (const sel of SUGGESTION_SELECTORS) {
        const exists = await page.$(sel);
        if (!exists) continue;
        const candidate = await page.evaluateHandle((s, want) => {
          const wantLower = (want || '').toLowerCase();
          const items = Array.from(document.querySelectorAll(s));
          let el = items.find((n) => (n.innerText || '').toLowerCase().includes(wantLower));
          if (!el) el = items[0] || null;
          if (el) {
            el.setAttribute('data-suggest-picked', '1');
            return el;
          }
          return null;
        }, sel, name);
        const el = candidate && candidate.asElement && candidate.asElement();
        if (el) {
          await page.click('[data-suggest-picked="1"]');
          picked = sel;
          break;
        }
      }
      if (!picked) {
        await page.focus(nameSel);
        await page.keyboard.press('Enter');
      }
      const committed = await page.$eval(nameSel, (el) => el.value);
      note('form', 'Recipient commit attempt finished.', { pickedSelector: picked, committedValue: committed });
    } catch (e) {
      note('form', 'Autosuggest selection step failed (continuing).', { error: e?.message || String(e) });
    }

    // Amount input
    const amountSel = '#partyTransactions #money, #money, #partyTransactions input[type="money"]';
    if (!(await page.$(amountSel))) {
      note('form', 'Amount field missing.', { amountSel });
      return { ok: false, step: 'locate-amount', reason: 'Amount field not found', actions };
    }
    const plain = String(Math.round(Number(amount))).replace(/[^0-9]/g, '');
    await page.$eval(amountSel, (el) => (el.value = ''));
    await page.type(amountSel, plain, { delay: 10 });
    await page.$eval(amountSel, (el) => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    note('form', 'Amount filled.', { amountDigits: plain });

    // Submit via form.requestSubmit()/submit()
    const formSel = '#partyTransactions form, form#partyTransactions';
    if (!(await page.$(formSel))) {
      note('form', 'Form element not found for submission.', { formSel });
      return { ok: false, step: 'locate-form', reason: 'Form not found', actions };
    }

    const postTarget = await page
      .$eval(formSel, (form) => {
        const action = (form.getAttribute('action') || '').trim();
        try {
          const u = new URL(action, window.location.origin);
          return u.pathname + (u.search || '');
        } catch {
          return action || '/parties/1/treasury';
        }
      })
      .catch(() => '/parties/1/treasury');

    note('form', 'Submitting via form.requestSubmit()/form.submit().', { formSel, postTarget });

    const postRespPromise = page
      .waitForResponse(
        (resp) => resp.request().method() === 'POST' && (resp.url().includes(postTarget) || /\/parties\/1\/treasury(?!\S)/.test(resp.url())),
        { timeout: NAV_TIMEOUT }
      )
      .catch(() => null);

    await page.$eval(formSel, (form) => {
      const f = /** @type {HTMLFormElement} */ (form);
      if (typeof f.requestSubmit === 'function') f.requestSubmit();
      else f.submit();
    });

    const navPromise = page.waitForNavigation({ waitUntil: 'networkidle2', timeout: NAV_TIMEOUT }).catch(() => null);
    const [postResp] = await Promise.all([postRespPromise, navPromise]);

    if (postResp) {
      note('post-response', 'Captured POST response.', { url: postResp.url(), status: postResp.status(), ok: postResp.ok() });
    } else {
      note('post-response', 'No POST response captured (may still have submitted).');
    }

    // Heuristic verification
    let afterHtml = await page.content();
    let amountRounded = Math.round(Number(amount));
    let amountDigits = String(amountRounded);
    let amountFmt = new Intl.NumberFormat('en-US').format(amountRounded);
    let verifiedSubmit = afterHtml.includes(name) || afterHtml.includes(amountFmt);

    if (!postResp && !verifiedSubmit) {
      const retried = await page
        .$eval(formSel, (form) => {
          try {
            const f = /** @type {HTMLFormElement} */ (form);
            if (typeof f.requestSubmit !== 'function') {
              f.submit();
              return 'submit()';
            }
          } catch {}
          return 'skipped';
        })
        .catch(() => 'error');

      note('retry', 'Retrying native submission once.', { mode: retried });
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: NAV_TIMEOUT }).catch(() => null);
      if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(500);
      afterHtml = await page.content();
      verifiedSubmit = afterHtml.includes(name) || afterHtml.includes(amountFmt);
      note('retry', 'Post-retry verification.', {
        verifiedSubmit,
        matchName: afterHtml.includes(name),
        matchAmount: afterHtml.includes(amountFmt),
      });
    }

    note('form', 'Submission sequence finished.', { currentUrl: page.url() });

    if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(1000);
    else await new Promise((resolve) => setTimeout(resolve, 1000));
    note('post-submit', 'Waited after submit for UI updates.');

    afterHtml = await page.content();
    verifiedSubmit = afterHtml.includes(name) || afterHtml.includes(amountFmt);
    note('post-submit', 'Verified submission heuristics.', {
      verifiedSubmit,
      matchName: afterHtml.includes(name),
      matchAmount: afterHtml.includes(amountFmt),
    });

    // Check inline errors
    const formIssues = await scanFormIssues(page);
    if (formIssues && (formIssues.invalids.length || formIssues.alerts.length)) {
      note('form-issues', 'Detected form errors after submit.', formIssues);
      const firstAlert = formIssues.alerts[0]?.text || formIssues.invalids[0]?.text;
      if (firstAlert) {
        return { ok: false, step: 'submit', reason: firstAlert, actions };
      }
    }

    // Refresh and locate the new transaction
    await page.reload({ waitUntil: 'networkidle2' });
    note('reload', 'Page reloaded to capture pending approvals.');

    const recipientLower = name.toLowerCase();
    const matched = await waitForTransactionEntry(page, recipientLower, amountDigits, 15000, note, false);
    if (!matched) {
      note('verify', 'Timed out waiting for new transaction row.', { recipientLower, amountDigits });
      return {
        ok: false,
        step: 'verify',
        reason: 'No new transaction detected after submit. Amount or recipient may not have matched exactly.',
        actions,
      };
    }
    note('diff', 'Matched transaction identified.', matched);

    // Approval flow if present
    let approved = false;
    let needsApproval = false;
    if (matched.hasApproveButton && matched.approveSelector) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: NAV_TIMEOUT }).catch(() => null),
        page.click(matched.approveSelector),
      ]);
      note('approval', 'Clicked approval button.', { approveSelector: matched.approveSelector });

      if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(800);
      else await new Promise((resolve) => setTimeout(resolve, 800));
      await page.reload({ waitUntil: 'networkidle2' });
      note('approval', 'Reloaded after approval click to confirm.');

      const approvedRow = await waitForTransactionEntry(page, recipientLower, amountDigits, 8000, note, true);
      approved = Boolean(approvedRow);
      if (!approved) {
        needsApproval = true;
        note('approval', 'Approval still pending after click.');
      }
    } else {
      if (matched.hasApproveButton) {
        needsApproval = true;
        note('approval', 'Approve button expected but selector missing.', matched);
      } else {
        approved = /approved/i.test(matched.approvalText || '');
        note('approval', 'No approval button present; assuming auto approval.', { approved });
      }
    }

    return {
      ok: true,
      submitted: true,
      verified: verifiedSubmit,
      approved,
      needsApproval,
      actions: debug ? actions : undefined,
    };
  } catch (err) {
    if (err instanceof PPUSAAuthError) {
      const details = err.details || {};
      if (Array.isArray(details.actions)) {
        for (const action of details.actions) actions.push({ phase: 'auth-error', ...action });
      }
      const reasonDetail = formatAuthErrorMessage(err, '/send');
      return { ok: false, step: 'auth', reason: err.message, reasonDetail, actions, authDetails: details };
    }
    throw err;
  } finally {
    if (browser) {
      try {
        actions.push({ step: 'cleanup', detail: 'Closing browser.', timestamp: new Date().toISOString() });
        await browser.close();
      } catch (closeErr) {
        actions.push({
          step: 'cleanup',
          detail: 'Browser close failed.',
          error: closeErr?.message ?? String(closeErr),
          timestamp: new Date().toISOString(),
        });
      }
    }
  }
}

/* ---------- DOM helpers ---------- */
async function scrapeOutgoingTransactions(page) {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#partyOutgoingTableBody tr'));
    return rows.map((row, idx) => {
      const identifier = row.getAttribute('data-tx-id') || `tx-${Date.now()}-${idx}`;
      row.setAttribute('data-tx-id', identifier);

      const cells = row.querySelectorAll('td');
      const timeText = cells[0]?.innerText?.trim() ?? '';
      const senderText = cells[1]?.innerText?.trim() ?? '';
      const recipientText = cells[2]?.innerText?.trim() ?? '';
      const recipientLower = recipientText.toLowerCase();
      const amountText = cells[3]?.innerText?.trim() ?? '';
      const amountDigits = amountText.replace(/[^0-9]/g, '');
      const approvalCell = cells[4];
      const approvalText = approvalCell?.innerText?.trim() ?? '';

      const approveButton = approvalCell?.querySelector('form button[name="decision"][value="1"]');
      let approveSelector = null;
      if (approveButton) {
        approveButton.setAttribute('data-approve-click', identifier);
        approveSelector = `[data-approve-click="${identifier}"]`;
      }

      return {
        id: identifier,
        timeText,
        senderText,
        recipientText,
        recipientLower,
        amountText,
        amountDigits,
        approvalText,
        hasApproveButton: Boolean(approveButton),
        approveSelector,
      };
    });
  });
}

async function captureOutgoingData(page) {
  try {
    return await page.evaluate(() => {
      const data = Array.isArray(window.partyOutgoingData) ? window.partyOutgoingData : [];
      return data.map((item, idx) => {
        const name = item.recipientName || item.recipient?.name || '';
        const lower = name.toLowerCase();
        const amountNum = typeof item.amountNum === 'number' ? item.amountNum : Number(item.amount);
        const amountDigits = Number.isFinite(amountNum)
          ? String(Math.round(amountNum)).replace(/[^0-9]/g, '')
          : String(item.amount || '').replace(/[^0-9]/g, '');
        const approvalText = typeof item.approval === 'string' ? item.approval : '';

        const amountPretty = Number.isFinite(amountNum) ? `$${Number(amountNum).toLocaleString('en-US')}` : String(item.amount ?? '');

        return {
          source: 'data',
          id: item.id ?? `data-${Date.now()}-${idx}`,
          recipientText: name,
          recipientLower: lower,
          amountText: amountPretty,
          amountDigits,
          approvalText,
          hasApproveButton: /decision/.test(approvalText || ''),
          approveSelector: null,
          raw: item,
        };
      });
    });
  } catch {
    return [];
  }
}

async function waitForTransactionEntry(page, recipientLower, amountDigits, timeoutMs, note, requireApproved) {
  try {
    const handle = await page.waitForFunction(
      (recipient, digits, requireApproved) => {
        const rows = Array.from(document.querySelectorAll('#partyOutgoingTableBody tr'));
        const matches = [];

        for (const row of rows) {
          const cells = row.querySelectorAll('td');
          if (cells.length < 4) continue;
          const recipientText = cells[2]?.innerText?.trim() ?? '';
          const lower = recipientText.toLowerCase();
          if (!lower.includes(recipient)) continue;

          const amountText = cells[3]?.innerText?.trim() ?? '';
          const digitsOnly = amountText.replace(/[^0-9]/g, '');
          if (digitsOnly !== digits) continue;

          const approvalCell = cells[4];
          const approvalText = approvalCell?.innerText?.trim() ?? '';

          if (requireApproved && !/approved/i.test(approvalText)) continue;

          const approveButton = approvalCell?.querySelector('form button[name="decision"][value="1"]');
          let approveSelector = null;
          if (approveButton) {
            const existingId = approveButton.getAttribute('data-approve-click');
            const identifier = existingId || `approve-${Date.now()}`;
            approveButton.setAttribute('data-approve-click', identifier);
            approveSelector = `[data-approve-click="${identifier}"]`;
          }

          matches.push({
            source: 'dom',
            recipientText,
            amountText,
            approvalText,
            hasApproveButton: Boolean(approveButton),
            approveSelector,
          });
        }

        const dataEntries = Array.isArray(window.partyOutgoingData) ? window.partyOutgoingData : [];
        for (const item of dataEntries) {
          const name = (item.recipientName || item.recipient?.name || '').trim();
          const lower = name.toLowerCase();
          if (!lower.includes(recipient)) continue;

          const amountNum = typeof item.amountNum === 'number' ? item.amountNum : Number(item.amount);
          const amountDigits = Number.isFinite(amountNum)
            ? String(Math.round(amountNum)).replace(/[^0-9]/g, '')
            : String(item.amount || '').replace(/[^0-9]/g, '');
          if (amountDigits !== digits) continue;

          const approvalText = typeof item.approval === 'string' ? item.approval : '';

          const amountPretty = Number.isFinite(amountNum) ? `$${Number(amountNum).toLocaleString('en-US')}` : String(item.amount ?? '');

          matches.push({
            source: 'data',
            recipientText: name,
            amountText: amountPretty,
            approvalText,
            hasApproveButton: /decision/.test(approvalText || ''),
            approveSelector: null,
            raw: item,
          });
        }

        for (const entry of matches) {
          if (requireApproved && !/approved/i.test(entry.approvalText || '')) continue;
          return entry;
        }

        return null;
      },
      { timeout: timeoutMs },
      recipientLower,
      amountDigits,
      requireApproved
    );

    const value = await handle.jsonValue();
    if (value && typeof note === 'function') {
      note('wait-row', 'Transaction row located.', { value, requireApproved });
    }
    return value;
  } catch (err) {
    if (typeof note === 'function') {
      note('wait-row-timeout', 'Failed to locate transaction row within timeout.', {
        recipientLower,
        amountDigits,
        requireApproved,
        error: err?.message ?? String(err),
      });
    }
    return null;
  }
}

async function scanFormIssues(page) {
  try {
    return await page.evaluate(() => {
      const within = document.querySelector('#partyTransactions') || document;
      const invalids = Array.from(within.querySelectorAll('.is-invalid, .invalid-feedback'))
        .map((el) => ({ text: el.textContent?.trim() || '', id: el.id || null, for: el.getAttribute('for') || null }))
        .filter((x) => x.text);
      const alerts = Array.from(document.querySelectorAll('.alert.alert-danger, .alert.alert-warning'))
        .map((el) => ({ text: el.textContent?.trim() || '' }))
        .filter((x) => x.text);
      return { invalids, alerts };
    });
  } catch {
    return { invalids: [], alerts: [] };
  }
}

/**
 * Project: DemBot (Discord automation for Power Play USA)
 * File: commands/send.js
 * Purpose: Perform treasury send + optional approval via headless browser
 * Author: egg3901
 * Created: 2025-10-16
 * Last Updated: 2025-10-18
 * Notes:
 *   - Restricted to role 1406063223475535994 at runtime.
 *   - Required options: name, amount. Optional: type (defaults to "player"), debug.
 *   - Clean message flow using TWO embeds: request summary + status.
 *   - Uses form.requestSubmit()/submit() for reliable submission.
 */

