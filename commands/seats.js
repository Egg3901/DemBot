// commands/seats.js
// Summarize congressional chamber seat counts and majority control.

const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const { loginAndGet, BASE } = require('../lib/ppusa');
const cheerio = require('cheerio');

const CHAMBER_OPTIONS = {
  senate: { id: 1, label: 'United States Senate' },
  house: { id: 2, label: 'United States House of Representatives' },
  congress: { id: null, label: 'United States Congress' },
};

const PARTY_ORDER = ['Democrats', 'Republicans', 'Independent', 'Independents', 'Other', 'Unfilled', 'Vacant'];

const parsePartiesObject = (scriptText) => {
  if (!scriptText) return null;
  const match = scriptText.match(/const\s+parties\s*=\s*(\{[\s\S]*?\});/);
  if (!match) return null;
  const rawObject = match[1];
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(`"use strict"; return (${rawObject});`);
    const value = fn();
    if (value && typeof value === 'object') return value;
  } catch (_) {}
  return null;
};

const normaliseParties = (obj) => {
  if (!obj) return [];
  return Object.entries(obj).map(([name, meta]) => ({
    name,
    seats: Number(meta?.seats ?? 0),
    colour: meta?.colour || '#666666',
  }));
};

const sortParties = (parties) => {
  const orderIndex = (name) => {
    const idx = PARTY_ORDER.findIndex((entry) => entry.toLowerCase() === name.toLowerCase());
    return idx === -1 ? PARTY_ORDER.length + 1 : idx;
  };
  return parties.slice().sort((a, b) => {
    const seatDiff = (b.seats || 0) - (a.seats || 0);
    if (seatDiff !== 0) return seatDiff;
    return orderIndex(a.name) - orderIndex(b.name);
  });
};

const computeControl = (parties) => {
  const filtered = parties.filter((p) => p.name.toLowerCase() !== 'unfilled' && p.name.toLowerCase() !== 'vacant');
  if (!filtered.length) return null;
  const top = filtered[0];
  const second = filtered[1];
  const margin = second ? top.seats - second.seats : top.seats;
  const totalSeats = parties.reduce((sum, party) => sum + (party.seats || 0), 0);
  return {
    leader: top.name,
    seats: top.seats,
    margin,
    totalSeats,
  };
};

const DIAGRAM_SELECTORS = ['#senate-diagram', '#house-diagram', '#chamber-diagram', '[data-chamber-diagram]'];

const selectDiagramHandle = async (page) => {
  for (const selector of DIAGRAM_SELECTORS) {
    const handle = await page.$(selector);
    if (handle) return { handle, selector };
  }
  return { handle: null, selector: null };
};

const fetchChamber = async (page, id) => {
  const url = `${BASE}/chambers/${id}`;
  const response = await page.goto(url, { waitUntil: 'networkidle2' }).catch(() => null);
  const status = response?.status?.() ?? 200;
  if (status >= 400) throw new Error(`Failed to load chamber page (${status})`);
  const selectorList = DIAGRAM_SELECTORS.join(', ');
  await page.waitForSelector(selectorList, { timeout: 5000 }).catch(() => null);
  const html = await page.content();
  const $ = cheerio.load(html);
  const scriptBlock = $('script[type="module"]')
    .filter((_, el) => $(el).text().includes('const parties'))
    .first()
    .text();
  const partiesObj = parsePartiesObject(scriptBlock);
  const parties = sortParties(normaliseParties(partiesObj));
  const control = computeControl(parties);
  let svgHtml = null;
  let pngBuffer = null;

  const { handle: diagramHandle } = await selectDiagramHandle(page);
  if (diagramHandle) {
    try {
      svgHtml = await page.evaluate((el) => el.innerHTML, diagramHandle);
      const svgHandle = await diagramHandle.$('svg');
      const targetHandle = svgHandle || diagramHandle;
      pngBuffer = await targetHandle.screenshot({ type: 'png' });
      await svgHandle?.dispose();
    } catch (_) {
      svgHtml = null;
      pngBuffer = null;
    } finally {
      await diagramHandle.dispose();
    }
  }

  if (!svgHtml && parties.length) {
    svgHtml = await buildSvg(parties);
  }

  return { parties, control, svgHtml, pngBuffer, url };
};

let parliamentSvgLib = null;
let toHtmlLib = null;

const ensureSvgLibs = async () => {
  if (parliamentSvgLib && toHtmlLib) return;
  const ps = await import('parliament-svg');
  parliamentSvgLib = ps.default || ps;
  const h = await import('hast-util-to-html');
  toHtmlLib = h.toHtml || h.default;
};

const buildSvg = async (parties) => {
  await ensureSvgLibs();
  const formatted = parties.reduce((acc, party) => {
    acc[party.name] = { seats: party.seats, colour: party.colour || '#666666' };
    return acc;
  }, {});
  const diagram = parliamentSvgLib(formatted, { seatCount: false });
  return toHtmlLib(diagram);
};

const formatPartyLines = (parties) =>
  parties
    .map((party) => `• ${party.name}: ${party.seats}${party.name.toLowerCase() === 'unfilled' ? ' (vacant)' : ''}`)
    .join('\n');

const buildEmbed = ({ label, data, attachmentName }) => {
  const { parties, control, url } = data;
  const lines = formatPartyLines(parties);
  const summary = control
    ? `Control: **${control.leader}** (${control.seats} seats, +${control.margin}). Total seats: ${control.totalSeats}.`
    : 'Control: Unknown.';
  return {
    title: label,
    url,
    description: `${summary}\n\n${lines}`,
    image: attachmentName ? { url: `attachment://${attachmentName}` } : undefined,
    footer: { text: new URL(BASE).hostname },
    timestamp: new Date().toISOString(),
  };
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('seats')
    .setDescription('Show congressional chamber seat totals and control')
    .addStringOption((opt) =>
      opt
        .setName('chamber')
        .setDescription('Select Senate, House, or combined Congress view')
        .setRequired(true)
        .addChoices(
          { name: 'Senate', value: 'senate' },
          { name: 'House', value: 'house' },
          { name: 'Congress (both chambers)', value: 'congress' },
        ),
    ),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    await interaction.deferReply();
    const choice = interaction.options.getString('chamber', true);
    const config = CHAMBER_OPTIONS[choice];
    if (!config) {
      return interaction.editReply('Unknown chamber. Choose senate, house, or congress.');
    }

    let browser;
    let page;
    try {
      const initial = await loginAndGet(`${BASE}/chambers/${config.id || 1}`);
      browser = initial.browser;
      page = initial.page;

      const attachments = [];

      if (choice === 'senate') {
        const senate = await fetchChamber(page, 1);
        if (senate.pngBuffer || senate.svgHtml) {
          const name = senate.pngBuffer ? 'senate-seats.png' : 'senate-seats.svg';
          const data = senate.pngBuffer || Buffer.from(senate.svgHtml, 'utf8');
          attachments.push(new AttachmentBuilder(data, { name }));
          senate.attachmentName = name;
        }
        const embed = buildEmbed({ label: config.label, data: senate, attachmentName: senate.attachmentName });
        await interaction.editReply({ embeds: [embed], files: attachments });
        return;
      }

      if (choice === 'house') {
        const house = await fetchChamber(page, 2);
        if (house.pngBuffer || house.svgHtml) {
          const name = house.pngBuffer ? 'house-seats.png' : 'house-seats.svg';
          const data = house.pngBuffer || Buffer.from(house.svgHtml, 'utf8');
          attachments.push(new AttachmentBuilder(data, { name }));
          house.attachmentName = name;
        }
        const embed = buildEmbed({ label: config.label, data: house, attachmentName: house.attachmentName });
        await interaction.editReply({ embeds: [embed], files: attachments });
        return;
      }

      // Congress: both chambers
      const senateData = await fetchChamber(page, 1);
      const houseData = await fetchChamber(page, 2);
      if (senateData.pngBuffer || senateData.svgHtml) {
        const name = senateData.pngBuffer ? 'senate-seats.png' : 'senate-seats.svg';
        const data = senateData.pngBuffer || Buffer.from(senateData.svgHtml, 'utf8');
        attachments.push(new AttachmentBuilder(data, { name }));
        senateData.attachmentName = name;
      }
      if (houseData.pngBuffer || houseData.svgHtml) {
        const name = houseData.pngBuffer ? 'house-seats.png' : 'house-seats.svg';
        const data = houseData.pngBuffer || Buffer.from(houseData.svgHtml, 'utf8');
        attachments.push(new AttachmentBuilder(data, { name }));
        houseData.attachmentName = name;
      }

      const embeds = [
        buildEmbed({ label: 'United States Senate', data: senateData, attachmentName: senateData.attachmentName }),
        buildEmbed({ label: 'United States House of Representatives', data: houseData, attachmentName: houseData.attachmentName }),
      ];

      await interaction.editReply({ embeds, files: attachments });
    } catch (err) {
      await interaction.editReply(`Error fetching chamber data: ${err?.message || String(err)}`);
    } finally {
      try { await page?.close(); } catch (_) {}
    }
  },
};
