// commands/race.js
// Version: 1.0
// Show a state race snapshot (Senate class 1/2/3, Governor, House):
// - Outcome for the most recently finished round (Primary/General/Runoff)
// - If active, also show the next race time (if available)
// - Always include the most recent poll for this race

const { SlashCommandBuilder } = require('discord.js');
const cheerio = require('cheerio');
const { authenticateAndNavigate, PPUSAAuthError } = require('../lib/ppusa-auth');
const { config } = require('../lib/ppusa-config');
const { normalizeStateName, resolveStateIdFromIndex } = require('../lib/state-utils');
const { reportCommandError } = require('../lib/command-utils');

const BASE = config.baseUrl;

const RACE_ALIASES = {
  s1: 'Senate Class 1', sen1: 'Senate Class 1', senate1: 'Senate Class 1', class1: 'Senate Class 1',
  s2: 'Senate Class 2', sen2: 'Senate Class 2', senate2: 'Senate Class 2', class2: 'Senate Class 2',
  s3: 'Senate Class 3', sen3: 'Senate Class 3', senate3: 'Senate Class 3', class3: 'Senate Class 3',
  gov: 'Governor', governor: 'Governor', gubernatorial: 'Governor',
  rep: 'House of Representatives', reps: 'House of Representatives', house: 'House of Representatives', representatives: 'House of Representatives',
};

function normalizeRace(r) {
  const key = String(r || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return RACE_ALIASES[key] || null;
}

async function fetchHtml(page, url, waitUntil = 'domcontentloaded') {
  await page.goto(url, { waitUntil, timeout: 15000 }).catch(() => {});
  return { html: await page.content(), finalUrl: page.url() };
}

function pickLatestResults(html) {
  const $ = cheerio.load(html || '');
  const blocks = [];

  $('h4,h3').each((_, h) => {
    const title = ($(h).text() || '').replace(/\s+/g, ' ').trim();
    if (!/results|final|primary|general|runoff/i.test(title)) return;
    const table = $(h).nextAll('table').first();
    if (!table.length) return;
    const rows = [];
    table.find('tbody tr').each((__, tr) => {
      const tds = $(tr).find('td');
      const raw = tds.map((i, el) => ($(el).text() || '').replace(/\s+/g, ' ').trim()).get();
      const name = (raw[0] || '').trim();
      const pctTxt = (raw.find((t) => /%$/.test(t)) || '').replace(/[,"\s]/g, '');
      const percent = pctTxt ? Number((pctTxt.match(/([0-9]+(?:\.[0-9]+)?)%?/) || [])[1]) : null;
      if (name) rows.push({ name, percent });
    });
    if (rows.length >= 2) blocks.push({ title, rows });
  });

  if (blocks.length === 0) {
    const rows = [];
    $('.progress-wrapper').each((_, pw) => {
      const label = ($(pw).find('.progress-label').first().text() || '').replace(/\s+/g, ' ').trim();
      const name = (label.match(/^(.+?)\s*\(/) || [])[1] || label;
      let percent = null;
      const pctText = ($(pw).find('.progress-percentage .text-primary').first().text() || '').trim();
      const mp = pctText.match(/([0-9]+(?:\.[0-9]+)?)/);
      if (mp) percent = Number(mp[1]);
      if (name) rows.push({ name, percent });
    });
    if (rows.length >= 2) blocks.push({ title: 'Results', rows });
  }

  if (blocks.length === 0) return null;
  const latest = blocks[blocks.length - 1];
  const rows = latest.rows.slice().sort((a, b) => (b.percent ?? -1) - (a.percent ?? -1)).slice(0, 2);
  return { title: latest.title, rows };
}

function extractNextRaceTime(html) {
  const $ = cheerio.load(html || '');
  const candidates = [];
  $('*').each((_, el) => {
    const t = ($(el).text() || '').replace(/\s+/g, ' ').trim();
    if (/next\s*race|election\s*day|starts\s*in|next\s*round|polls\s*open|polls\s*close/i.test(t)) {
      candidates.push(t.replace(/(AM|PM)(Week)/, '$1 - $2'));
    }
  });
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0] || null;
}

function findRaceInfoFromStateElections(html, raceLabel) {
  const $ = cheerio.load(html || '');
  const target = String(raceLabel || '').trim().toLowerCase();
  let match = null;

  $('h4').each((_, heading) => {
    const headingText = ($(heading).text() || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (headingText !== target) return;

    const section = $(heading).closest('.container-fluid');
    if (!section.length) return;

    const rows = section.find('table tbody tr');
    let nextRaceText = null;
    let raceUrl = null;
    let ended = true;

    rows.each((__, tr) => {
      const row = $(tr);
      const cells = row.find('td');
      const dateText = (cells.eq(0).text() || '').replace(/\s+/g, ' ').trim().replace(/(AM|PM)(Week)/, '$1 - $2');
      const statusText = (cells.eq(1).text() || '').replace(/\s+/g, ' ').trim().replace(/(AM|PM)(Week)/, '$1 - $2');
      const anchor = row.find('a[href]').first();
      const isEnded = /ended|finished|complete/i.test(statusText);
      ended = ended && isEnded;
      if (!nextRaceText && dateText && !isEnded) {
        nextRaceText = statusText ? `${dateText} - ${statusText}` : dateText;
      }
      if (!raceUrl && anchor.length) {
        raceUrl = anchor.attr('href');
        if (raceUrl && !/^https?:/i.test(raceUrl)) {
          raceUrl = new URL(raceUrl, BASE).toString();
        }
      }
      if (nextRaceText && raceUrl) return false;
    });

    if (!nextRaceText && rows.length) {
      const firstRow = rows.first();
      const cells = firstRow.find('td');
      const dateText = (cells.eq(0).text() || '').replace(/\s+/g, ' ').trim().replace(/(AM|PM)(Week)/, '$1 - $2');
      const statusText = (cells.eq(1).text() || '').replace(/\s+/g, ' ').trim().replace(/(AM|PM)(Week)/, '$1 - $2');
      if (dateText || statusText) {
        nextRaceText = statusText ? `${dateText} - ${statusText}`.trim() : dateText;
      }
    }

    if (!raceUrl) {
      const anchor = section.find('a[href*="/elections/"]').first();
      if (anchor.length) {
        let href = anchor.attr('href');
        if (href && !/^https?:/i.test(href)) {
          href = new URL(href, BASE).toString();
        }
        raceUrl = href;
      }
    }

    match = { url: raceUrl || null, nextRace: nextRaceText || null, ended };
    return false;
  });

  return match;
}

function formatPollText(text) {
  if (!text) return null;
  let formatted = text.replace(/\s+/g, ' ').trim();
  formatted = formatted.replace(/%(\S)/g, '% $1');
  formatted = formatted.replace(/(\d)V\s+/i, '$1 | ');
  return formatted;
}

function extractLatestPoll(html, stateName, raceLabel) {
  const $ = cheerio.load(html || '');
  let best = null;
  $('table').each((_, table) => {
    $(table).find('tbody tr').each((__, tr) => {
      const rowText = ($(tr).text() || '').replace(/\s+/g, ' ').trim();
      if (!rowText) return;
      const matchState = stateName ? rowText.toLowerCase().includes(stateName.toLowerCase()) : true;
      const matchRace = raceLabel ? rowText.toLowerCase().includes(raceLabel.toLowerCase()) : true;
      if (!matchState || !matchRace) return;
      const cols = $(tr).find('td').map((i, el) => {
        const raw = ($(el).text() || '').replace(/\s+/g, ' ').trim();
        return formatPollText(raw) || raw;
      }).get();
      const link = $(tr).find('a[href]').first().attr('href');
      best = {
        text: formatPollText(rowText) || rowText,
        cols,
        url: link ? new URL(link, BASE).toString() : null,
      };
      return false;
    });
    if (best) return false;
  });
  if (best) return best;
  const tr = $('table tbody tr').first();
  if (tr.length) {
    const rowTextRaw = tr.text().replace(/\s+/g, ' ').trim();
    const rowText = formatPollText(rowTextRaw) || rowTextRaw;
    const cols = tr.find('td').map((i, el) => {
      const raw = ($(el).text() || '').replace(/\s+/g, ' ').trim();
      return formatPollText(raw) || raw;
    }).get();
    const link = tr.find('a[href]').first().attr('href');
    return { text: rowText, cols, url: link ? new URL(link, BASE).toString() : null };
  }
  return null;
}

function extractPollAverage(html, stateName, raceLabel) {
  const $ = cheerio.load(html || '');
  let avg = null;
  const contains = (haystack, needle) => String(haystack || '').toLowerCase().includes(String(needle || '').toLowerCase());

  const tryFind = (requireFilters) => {
    let found = null;
    $('table').each((_, table) => {
      $(table)
        .find('tbody tr')
        .each((__, tr) => {
          const rowText = ($(tr).text() || '').replace(/\s+/g, ' ').trim();
          if (!rowText) return;
          const hasAvg = /\baverage\b/i.test(rowText) || /overall/i.test(rowText);
          if (!hasAvg) return;
          if (requireFilters) {
            const okState = stateName ? contains(rowText, stateName) : true;
            const okRace = raceLabel ? contains(rowText, raceLabel) : true;
            if (!okState || !okRace) return;
          }
          const cols = $(tr)
            .find('td')
            .map((i, el) => {
              const raw = ($(el).text() || '').replace(/\s+/g, ' ').trim();
              return formatPollText(raw) || raw;
            })
            .get();
          const link = $(tr).find('a[href]').first().attr('href');
          found = {
            text: formatPollText(rowText) || rowText,
            cols,
            url: link ? new URL(link, BASE).toString() : null,
          };
          return false;
        });
      if (found) return false;
    });
    return found;
  };

  avg = tryFind(true);
  if (!avg) avg = tryFind(false);
  return avg || null;
}

function extractRecentPolls(html, stateName, raceLabel, limit = 5) {
  const $ = cheerio.load(html || '');
  const matches = [];
  $('table').each((_, table) => {
    $(table)
      .find('tbody tr')
      .each((__, tr) => {
        const rowText = ($(tr).text() || '').replace(/\s+/g, ' ').trim();
        if (!rowText) return;
        const matchState = stateName ? rowText.toLowerCase().includes(stateName.toLowerCase()) : true;
        const matchRace = raceLabel ? rowText.toLowerCase().includes(raceLabel.toLowerCase()) : true;
        if (!matchState || !matchRace) return;
        const cols = $(tr)
          .find('td')
          .map((i, el) => {
            const raw = ($(el).text() || '').replace(/\s+/g, ' ').trim();
            return formatPollText(raw) || raw;
          })
          .get();
        const link = $(tr).find('a[href]').first().attr('href');
        matches.push({
          text: formatPollText(rowText) || rowText,
          cols,
          url: link ? new URL(link, BASE).toString() : null,
        });
      });
  });

  if (matches.length) return matches.slice(0, Math.max(1, limit));

  // Fallback: take first N rows regardless of filter
  const rows = [];
  const trList = $('table tbody tr');
  trList.each((i, tr) => {
    if (rows.length >= limit) return false;
    const rowTextRaw = ($(tr).text() || '').replace(/\s+/g, ' ').trim();
    if (!rowTextRaw) return;
    const cols = $(tr)
      .find('td')
      .map((j, el) => {
        const raw = ($(el).text() || '').replace(/\s+/g, ' ').trim();
        return formatPollText(raw) || raw;
      })
      .get();
    const link = $(tr).find('a[href]').first().attr('href');
    rows.push({ text: formatPollText(rowTextRaw) || rowTextRaw, cols, url: link ? new URL(link, BASE).toString() : null });
  });
  return rows.slice(0, Math.max(1, limit));
}

function extractFinalResultCandidates(html) {
  const $ = cheerio.load(html || '');
  const clean = (text) => String(text || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const metricsRegex = /\b(?:ES|CO|NR|AR|CR)\s*[:]/i;

  const wrappers = $('#statewide-info .progress-wrapper, .progress-wrapper:has(.progress-label span:contains("Party"))');
  const results = [];

  wrappers.each((_, el) => {
    const wrap = $(el);
    const label = wrap.find('.progress-label').first();
    if (!label.length) return;

    let nameText = clean(label.find('a .text-primary, .text-primary').first().text());
    if (!nameText) {
      nameText = clean(label.contents().filter((__, node) => node.type === 'text').text());
    }
    const name = clean(nameText);
    if (!name) return;

    const statsNode = label
      .find('span')
      .filter((__, node) => metricsRegex.test($(node).text()))
      .first();
    const stats = clean(statsNode.text());

    const partyNode = label
      .find('span')
      .filter((__, node) => /party/i.test($(node).text()))
      .first();
    const party = clean(partyNode.text());

    const percentageNode = wrap
      .find('.progress-percentage span')
      .filter((__, node) => /%/.test($(node).text()))
      .last();
    const percentMatch = clean(percentageNode.text()).match(/([0-9]+(?:\.[0-9]+)?)/);
    const percent = percentMatch ? Number(percentMatch[1]) : null;

    const votesNode = wrap
      .find('.progress-percentage span')
      .filter((__, node) => /votes/i.test($(node).text()))
      .first();
    const votesMatch = clean(votesNode.text()).match(/([0-9][0-9,]*)/);
    const votes = votesMatch ? votesMatch[1] : null;

    results.push({ name, stats, party, votes, percent });
  });

  if (results.length) {
    return results.sort((a, b) => (b.percent ?? -1) - (a.percent ?? -1));
  }

  const heading = $('h4').filter((_, el) => ($(el).text() || '').trim().toLowerCase().includes('final results')).first();
  if (!heading.length) return [];

  const sectionTexts = [];
  let node = heading.parent();
  while ((node = node.next()).length) {
    if (node.is('h4')) break;
    sectionTexts.push(node.text());
  }
  const section = sectionTexts.join('\n').replace(/\s+/g, ' ').trim();
  if (!section) return [];

  const legacy = [];
  const regex = /([A-Za-z0-9' .-]+?)\s*\(([^)]*CO:[^)]*)\)\s*\(([^)]*Party)\)\s*\(([^)]+) votes\)\s*([0-9]+(?:\.[0-9]+)?)%/gi;
  let match;
  while ((match = regex.exec(section))) {
    const name = match[1].trim();
    const stats = match[2].trim();
    const party = match[3].replace(/^\(|\)$/g, '').trim();
    const votesRaw = match[4].replace(/,/g, '').trim();
    const percent = Number(match[5]);
    legacy.push({
      name,
      stats,
      party,
      votes: votesRaw ? Number(votesRaw).toLocaleString('en-US') : null,
      percent: Number.isFinite(percent) ? percent : null,
    });
  }
  return legacy;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('race')
    .setDescription('Show outcome, timing, and latest poll for a state race')
    .addStringOption((opt) => opt.setName('state').setDescription('State code or full name').setRequired(true))
    .addStringOption((opt) => opt.setName('race').setDescription('s1, s2, s3, gov, house').setRequired(true)),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction) {
    const stateRaw = (interaction.options.getString('state') || '').trim();
    const raceRaw = (interaction.options.getString('race') || '').trim();

    if (!stateRaw || !raceRaw) {
      return interaction.reply({ content: 'Provide both a state and a race (s1, s2, s3, gov, house).', ephemeral: true });
    }

    const raceLabel = normalizeRace(raceRaw);
    if (!raceLabel) {
      return interaction.reply({ content: `Unknown race "${raceRaw}". Use s1, s2, s3, gov, or house.`, ephemeral: true });
    }

    const stateName = normalizeStateName(stateRaw);
    if (!stateName) {
      return interaction.reply({ content: `Unknown state "${stateRaw}". Use a two-letter code or full state name.`, ephemeral: true });
    }

    let deferred = false;
    try {
      await interaction.deferReply();
      deferred = true;
    } catch (e) {
      if (e?.code === 10062) return;
      throw e;
    }

    let browser = null;
    let page = null;

    try {
      const session = await authenticateAndNavigate({ url: `${BASE}/national/states`, debug: !!config.debug });
      browser = session.browser;
      page = session.page;
      try { page.setDefaultNavigationTimeout?.(15000); page.setDefaultTimeout?.(15000); } catch (_) {}
      let statesHtml = session.html;
      if (!statesHtml || statesHtml.length < 300) {
        const ref = await fetchHtml(page, `${BASE}/national/states`, 'load');
        statesHtml = ref.html;
      }

      const stateId = resolveStateIdFromIndex(statesHtml, stateName);
      if (!stateId) {
        return interaction.editReply({ content: `Could not find a state matching "${stateName}" on the states listing.` });
      }

      const elections = await fetchHtml(page, `${BASE}/states/${stateId}/elections`, 'domcontentloaded');
      const raceMeta = findRaceInfoFromStateElections(elections.html, raceLabel);
      if (!raceMeta?.url) {
        return interaction.editReply({ content: `Could not find a ${raceLabel} election page for ${stateName}.` });
      }

      const racePage = await fetchHtml(page, raceMeta.url, 'load');
      const latest = pickLatestResults(racePage.html);
      const finalCandidates = extractFinalResultCandidates(racePage.html);
      const raceEnded = !!raceMeta?.ended;
      const nextInfo = raceEnded ? null : (extractNextRaceTime(racePage.html) || raceMeta.nextRace || null);

      let pollResult = null;
      let pollsUrl = null;
      let pollsHtml = null;
      const $race = cheerio.load(racePage.html);
      const pollHref = $race('a[href*="poll"]').first().attr('href');
      if (pollHref) {
        const absolute = new URL(pollHref, BASE).toString();
        const pollPage = await fetchHtml(page, absolute, 'domcontentloaded');
        pollsUrl = pollPage.finalUrl || absolute;
        pollsHtml = pollPage.html;
        pollResult = extractLatestPoll(pollsHtml, stateName, raceLabel);
      }
      if (!pollResult) {
        const fallback = await fetchHtml(page, `${BASE}/elections/polling`, 'domcontentloaded');
        pollsUrl = fallback.finalUrl || `${BASE}/elections/polling`;
        pollsHtml = fallback.html;
        pollResult = extractLatestPoll(pollsHtml, stateName, raceLabel);
      }

      const fields = [];
      if (raceEnded && finalCandidates.length) {
        const formatted = finalCandidates.map((cand) => {
          const lines = [];
          lines.push(`**${cand.name}**${cand.percent != null ? ` - ${cand.percent}%` : ''}${cand.votes ? ` (${cand.votes} votes)` : ''}`);
          if (cand.stats) lines.push(cand.stats);
          if (cand.party) lines.push(cand.party);
          return lines.join('\n');
        }).join('\n\n');
        const note = finalCandidates.length === 1 ? `${formatted}\n_Unopposed_` : formatted;
        fields.push({ name: 'Final Results', value: note, inline: false });
      } else if (latest && latest.rows.length >= 2) {
        const [a, b] = latest.rows;
        fields.push({
          name: latest.title || 'Latest Finished Round',
          value: [
            `**${a.name}**${a.percent != null ? ` - ${a.percent}%` : ''}`,
            `**${b.name}**${b.percent != null ? ` - ${b.percent}%` : ''}`,
          ].join('\n'),
          inline: false,
        });
      } else {
        fields.push({ name: 'Latest Finished Round', value: 'No finished results found yet', inline: false });
      }

      if (nextInfo) {
        fields.push({ name: 'Race Ends', value: nextInfo, inline: false });
      }

      // Polling average (overall)
      let pollAverage = null;
      if (pollsHtml) {
        pollAverage = extractPollAverage(pollsHtml, stateName, raceLabel);
      }

      if (pollAverage) {
        const avgText = pollAverage.cols && pollAverage.cols.length ? pollAverage.cols.join(' | ') : pollAverage.text;
        fields.push({ name: 'Poll Average', value: avgText || 'Unknown', inline: false });
      }

      if (pollResult) {
        const pollText = pollResult.cols && pollResult.cols.length ? pollResult.cols.join(' | ') : pollResult.text;
        fields.push({ name: 'Most Recent Poll', value: pollText || 'Unknown', inline: false });
        if (pollResult.url) fields.push({ name: 'Poll Link', value: pollResult.url, inline: false });
      } else {
        fields.push({ name: 'Most Recent Poll', value: 'No poll located', inline: false });
      }

      const embed = {
        title: `${stateName} - ${raceLabel}`,
        url: racePage.finalUrl,
        fields,
        footer: { text: new URL(BASE).hostname },
        timestamp: new Date().toISOString(),
      };

      // Build page 2: Top recent polls (up to 5)
      const pages = [embed];
      if (pollsHtml) {
        const recentPolls = extractRecentPolls(pollsHtml, stateName, raceLabel, 5);
        if (recentPolls && recentPolls.length) {
          const lines = recentPolls.map((p, i) => {
            const text = p.cols && p.cols.length ? p.cols.join(' | ') : p.text;
            return `${i + 1}. ${text}`;
          });
          const pollsEmbed = {
            title: `${stateName} - ${raceLabel} (Recent Polls)`,
            url: pollsUrl || undefined,
            fields: [
              { name: 'Top 5 Most Recent Polls', value: lines.join('\n'), inline: false },
              ...(pollsUrl ? [{ name: 'Polling Page', value: pollsUrl, inline: false }] : []),
            ],
            footer: { text: new URL(BASE).hostname },
            timestamp: new Date().toISOString(),
          };
          pages.push(pollsEmbed);
        }
      }

      await interaction.editReply({ embeds: [pages[0]] });

      // Add reaction-based pagination controls (like positions)
      const message = await interaction.fetchReply();
      if (message && typeof message.react === 'function' && pages.length > 1) {
        const controls = ['\u2B05\uFE0F', '\u27A1\uFE0F']; // ⬅️, ➡️
        let reactionsReady = true;
        for (const emoji of controls) {
          try {
            await message.react(emoji);
          } catch (err) {
            reactionsReady = false;
            break;
          }
        }

        if (!reactionsReady) {
          await interaction
            .followUp({
              content:
                'Unable to add reaction controls for pagination (missing permission to add reactions?). Showing first page only.',
              ephemeral: true,
            })
            .catch(() => {});
        } else {
          let index = 0;
          const filter = (reaction, user) => controls.includes(reaction.emoji.name) && user.id === interaction.user.id;
          const collector = message.createReactionCollector({ filter, time: 5 * 60 * 1000 });

          collector.on('collect', async (reaction, user) => {
            if (reaction.emoji.name === controls[0]) index = (index - 1 + pages.length) % pages.length;
            else if (reaction.emoji.name === controls[1]) index = (index + 1) % pages.length;
            try {
              await interaction.editReply({ embeds: [pages[index]] });
            } catch (_) {}
            try {
              await reaction.users.remove(user.id);
            } catch (_) {}
          });

          collector.on('end', async () => {
            try {
              await message.reactions.removeAll();
            } catch (_) {}
          });
        }
      }
    } catch (err) {
      if (err instanceof PPUSAAuthError) {
        await reportCommandError(interaction, err, { message: err.message, followUp: true });
        return;
      }
      await reportCommandError(interaction, err, { message: `Error: ${err.message}`, meta: { command: 'race' } });
      if (deferred) {
        try { await interaction.editReply({ content: `Error: ${err.message}` }); } catch (_) {}
      }
    } finally {
      try { await browser?.close(); } catch {}
    }
  },
};
