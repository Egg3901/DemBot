// Helper utilities for permission checks across commands

const MANAGER_ROLE_ID = process.env.MANAGER_ROLE_ID || '1406063223475535994';
const DEMOCRATIC_LEADERSHIP_ROLE_ID = process.env.DEMOCRATIC_LEADERSHIP_ROLE_ID || '1406063223475535994';
const REPUBLICAN_LEADERSHIP_ROLE_ID = process.env.REPUBLICAN_LEADERSHIP_ROLE_ID || '1406063223475535994';
const ALLOWED_DM_USER = process.env.ALLOWED_DM_USER || '333052320252297216';
const DEBUG_USERS_ENV = process.env.DEBUG_USER_IDS || process.env.DEBUG_USER_ID || '';
const DEBUG_USER_IDS = DEBUG_USERS_ENV
  ? DEBUG_USERS_ENV.split(',').map((id) => id.trim()).filter(Boolean)
  : (ALLOWED_DM_USER ? [ALLOWED_DM_USER] : []);

async function fetchMember(interaction) {
  if (!interaction?.inGuild?.()) return null;
  if (interaction.member && interaction.member.roles) return interaction.member;
  try {
    return await interaction.guild.members.fetch(interaction.user.id);
  } catch (_) {
    return null;
  }
}

function isAllowedDmUser(userId) {
  return Boolean(userId && ALLOWED_DM_USER && userId === ALLOWED_DM_USER);
}

async function hasManagerRole(interaction) {
  const member = await fetchMember(interaction);
  if (!member) return false;
  return member.roles.cache.has(MANAGER_ROLE_ID);
}

async function canManageBot(interaction) {
  const userId = interaction?.user?.id;
  if (!interaction?.inGuild?.()) {
    return isAllowedDmUser(userId);
  }
  return hasManagerRole(interaction);
}

async function hasPartyLeadershipRole(interaction) {
  const member = await fetchMember(interaction);
  if (!member) return false;
  return member.roles.cache.has(DEMOCRATIC_LEADERSHIP_ROLE_ID) || 
         member.roles.cache.has(REPUBLICAN_LEADERSHIP_ROLE_ID);
}

async function canUseAnalyze(interaction) {
  const userId = interaction?.user?.id;
  if (!interaction?.inGuild?.()) {
    return isAllowedDmUser(userId);
  }
  return hasManagerRole(interaction) || hasPartyLeadershipRole(interaction);
}

function canUseDebug(interaction) {
  const userId = interaction?.user?.id;
  if (!userId) return false;
  if (!DEBUG_USER_IDS.length) return true;
  return DEBUG_USER_IDS.includes(userId);
}

module.exports = {
  MANAGER_ROLE_ID,
  DEMOCRATIC_LEADERSHIP_ROLE_ID,
  REPUBLICAN_LEADERSHIP_ROLE_ID,
  ALLOWED_DM_USER,
  DEBUG_USER_IDS,
  fetchMember,
  isAllowedDmUser,
  hasManagerRole,
  canManageBot,
  hasPartyLeadershipRole,
  canUseAnalyze,
  canUseDebug,
};
