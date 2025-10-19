const cheerio = require('cheerio');

// Abbreviations -> full state/territory names
const US_STATE_ABBR = {
  al: 'Alabama', ak: 'Alaska', az: 'Arizona', ar: 'Arkansas', ca: 'California', co: 'Colorado',
  ct: 'Connecticut', de: 'Delaware', fl: 'Florida', ga: 'Georgia', hi: 'Hawaii', id: 'Idaho',
  il: 'Illinois', in: 'Indiana', ia: 'Iowa', ks: 'Kansas', ky: 'Kentucky', la: 'Louisiana',
  me: 'Maine', md: 'Maryland', ma: 'Massachusetts', mi: 'Michigan', mn: 'Minnesota', ms: 'Mississippi',
  mo: 'Missouri', mt: 'Montana', ne: 'Nebraska', nv: 'Nevada', nh: 'New Hampshire', nj: 'New Jersey',
  nm: 'New Mexico', ny: 'New York', nc: 'North Carolina', nd: 'North Dakota', oh: 'Ohio', ok: 'Oklahoma',
  or: 'Oregon', pa: 'Pennsylvania', ri: 'Rhode Island', sc: 'South Carolina', sd: 'South Dakota',
  tn: 'Tennessee', tx: 'Texas', ut: 'Utah', vt: 'Vermont', va: 'Virginia', wa: 'Washington',
  wv: 'West Virginia', wi: 'Wisconsin', wy: 'Wyoming', dc: 'District of Columbia', pr: 'Puerto Rico',
};

const STATE_NAME_ALIASES = new Map([
  ['cal', 'California'], ['cali', 'California'],
  ['wash', 'Washington'], ['wash state', 'Washington'],
  ['mass', 'Massachusetts'], ['jersey', 'New Jersey'],
  ['carolina', 'North Carolina'],
  ['dc', 'District of Columbia'], ['d.c.', 'District of Columbia'], ['d.c', 'District of Columbia'], ['d c', 'District of Columbia'],
  ['pr', 'Puerto Rico'],
]);

function normalizeStateName(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  const abbr = raw.toLowerCase();
  if (US_STATE_ABBR[abbr]) return US_STATE_ABBR[abbr];
  if (STATE_NAME_ALIASES.has(abbr)) return STATE_NAME_ALIASES.get(abbr);

  const name = raw
    .replace(/^\s+|\s+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^(state|commonwealth|territory)\s+of\s+/i, '')
    .replace(/\b(st|st\.)\b/ig, 'saint')
    .toLowerCase();

  const match = Object.values(US_STATE_ABBR).find((n) => n.toLowerCase() === name);
  return match || null;
}

function resolveStateIdFromIndex(html, stateName) {
  const $ = cheerio.load(html || '');
  const norm = (text) => String(text || '')
    .replace(/\u00A0/g, ' ')
    .normalize('NFKD')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^(state|commonwealth|territory)\s+of\s+/i, '');

  const target = norm(stateName);
  let found = null;

  $('a[href^="/states/"]').each((_, anchor) => {
    if (found) return;
    const href = String($(anchor).attr('href') || '');
    const match = href.match(/\/states\/(\d+)\b/);
    if (!match) return;

    const texts = [
      ($(anchor).text() || '').trim(),
      $(anchor).attr('title') || '',
      $(anchor).closest('tr,li,div').text().trim(),
    ].filter(Boolean);

    for (const text of texts) {
      const normalized = norm(text);
      if (normalized === target || normalized.includes(target) || target.includes(normalized)) {
        found = Number(match[1]);
        break;
      }
    }
  });

  return found;
}

module.exports = {
  US_STATE_ABBR,
  normalizeStateName,
  resolveStateIdFromIndex,
};
