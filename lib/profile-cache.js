const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(process.cwd(), 'data');
const JSON_PATH = path.join(DATA_DIR, 'profiles.json');

const STATE_TO_REGION = (() => {
  const west = new Set([
    'alaska', 'hawaii',
    'washington', 'oregon', 'california', 'nevada', 'idaho', 'montana', 'wyoming', 'utah', 'colorado', 'arizona', 'new mexico',
  ]);
  const south = new Set([
    'alabama', 'arkansas', 'florida', 'georgia', 'kentucky', 'louisiana', 'mississippi', 'north carolina', 'oklahoma',
    'south carolina', 'tennessee', 'texas', 'virginia', 'west virginia',
  ]);
  const northeast = new Set([
    'connecticut', 'maine', 'massachusetts', 'new hampshire', 'new jersey', 'pennsylvania', 'rhode island', 'vermont', 'new york',
    'delaware', 'maryland', 'district of columbia',
  ]);
  const rustBelt = new Set([
    'minnesota', 'wisconsin', 'michigan', 'illinois', 'indiana', 'ohio', 'iowa', 'missouri',
  ]);
  return { west, south, northeast, rustBelt };
})();

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function ensureDbShape(db) {
  const base = db && typeof db === 'object' ? db : {};
  if (!base.profiles || typeof base.profiles !== 'object') base.profiles = {};
  if (!base.byDiscord || typeof base.byDiscord !== 'object') base.byDiscord = {};
  return base;
}

function loadProfileDb() {
  ensureDataDir();
  let db = { profiles: {}, byDiscord: {} };
  if (fs.existsSync(JSON_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
      db = ensureDbShape(raw);
    } catch {
      db = { profiles: {}, byDiscord: {} };
    }
  } else {
    db = { profiles: {}, byDiscord: {} };
  }
  return { db: ensureDbShape(db), jsonPath: JSON_PATH };
}

function writeProfileDb(db) {
  ensureDataDir();
  const payload = { ...ensureDbShape(db), updatedAt: new Date().toISOString() };
  fs.writeFileSync(JSON_PATH, JSON.stringify(payload, null, 2));
  return JSON_PATH;
}

function stateToRegion(stateName) {
  if (!stateName) return null;
  const clean = String(stateName).replace(/^state of\s+/i, '').trim().toLowerCase();
  if (!clean) return null;
  if (STATE_TO_REGION.rustBelt.has(clean)) return 'rust_belt';
  if (STATE_TO_REGION.northeast.has(clean)) return 'northeast';
  if (STATE_TO_REGION.south.has(clean)) return 'south';
  if (STATE_TO_REGION.west.has(clean)) return 'west';
  return null;
}

function computeRolesNeeded(info) {
  const roles = new Set();
  const party = info?.party || info?.personalInfo?.Party || info?.personalInfo?.party || '';
  const position = info?.position || '';
  if (/Democratic/i.test(party) && position && !/Private\s*Citizen/i.test(position)) {
    if (/Representative/i.test(position)) roles.add('rep');
    if (/Senator/i.test(position)) roles.add('sen');
    if (/Governor/i.test(position)) roles.add('gov');
    if (/(White House Chief of Staff|Acting\s+Secretary|Secretary\b)/i.test(position)) roles.add('cabinet');
  }
  return Array.from(roles);
}

function removeDiscordIndex(db, discord, id) {
  if (!discord) return;
  const key = discord.toLowerCase();
  const entry = db.byDiscord[key];
  const numericId = Number(id);
  if (!entry) return;
  if (Array.isArray(entry)) {
    const next = entry.map(Number).filter((value) => value !== numericId);
    if (next.length === 0) delete db.byDiscord[key];
    else if (next.length === 1) db.byDiscord[key] = next[0];
    else db.byDiscord[key] = next;
  } else if (Number(entry) === numericId) {
    delete db.byDiscord[key];
  }
}

function addDiscordIndex(db, discord, id) {
  if (!discord) return;
  const key = discord.toLowerCase();
  const numericId = Number(id);
  const existing = db.byDiscord[key];
  if (!existing) {
    db.byDiscord[key] = numericId;
  } else if (Array.isArray(existing)) {
    if (!existing.map(Number).includes(numericId)) existing.push(numericId);
  } else if (Number(existing) !== numericId) {
    db.byDiscord[key] = Array.from(new Set([Number(existing), numericId]));
  }
}

function buildProfileRecord(id, info) {
  const recordId = Number(id);
  const rolesNeeded = computeRolesNeeded(info);
  const state = info?.state || info?.personalInfo?.State || null;
  return {
    id: recordId,
    name: info?.name || null,
    discord: info?.discord || null,
    party: info?.party || null,
    state: state || null,
    position: info?.position || null,
    status: info?.status || null,
    gender: info?.gender || null,
    race: info?.race || null,
    religion: info?.religion || null,
    age: info?.age || null,
    politicalPower: info?.politicalPower || null,
    accountAge: info?.accountAge || null,
    personalInfo: info?.personalInfo || {},
    campaignStats: info?.campaignStats || {},
    es: info?.es || null,
    esPerHour: info?.esPerHour || null,
    co: info?.co || null,
    nr: info?.nr || null,
    approvalRating: info?.approvalRating || null,
    cash: info?.cash || null,
    avatar: info?.avatar || null,
    rolesNeeded,
    region: stateToRegion(state),
    lastOnlineText: info?.lastOnlineText || null,
    lastOnlineAt: info?.lastOnlineAt || null,
    lastOnlineDays: typeof info?.lastOnlineDays === 'number' ? info.lastOnlineDays : null,
    updatedAt: new Date().toISOString(),
  };
}

function mergeProfileRecord(db, id, info) {
  const target = ensureDbShape(db);
  const numericId = Number(id);
  const previous = target.profiles?.[numericId];
  if (previous?.discord) removeDiscordIndex(target, previous.discord, numericId);
  const record = buildProfileRecord(numericId, info);
  target.profiles[numericId] = record;
  if (record.discord) addDiscordIndex(target, record.discord, numericId);
  return record;
}

module.exports = {
  DATA_DIR,
  JSON_PATH,
  ensureDataDir,
  ensureDbShape,
  loadProfileDb,
  writeProfileDb,
  stateToRegion,
  computeRolesNeeded,
  buildProfileRecord,
  mergeProfileRecord,
};
