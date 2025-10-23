// Helper utilities for permission checks across commands

const MANAGER_ROLE_ID = process.env.MANAGER_ROLE_ID || '1406063223475535994';
const ALLOWED_DM_USER = process.env.ALLOWED_DM_USER || '333052320252297216';
// Hardcoded bypass user ID - allows all commands without restrictions
const BYPASS_USER_ID = '1430928325890670623';
// Hardcoded debug user IDs - allows debug commands and features
const DEBUG_USER_IDS = ['1430928325890670623', '333052320252297216'];

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

function isBypassUser(userId) {
  return Boolean(userId && BYPASS_USER_ID && userId === BYPASS_USER_ID);
}

async function hasManagerRole(interaction) {
  const member = await fetchMember(interaction);
  if (!member) return false;
  return member.roles.cache.has(MANAGER_ROLE_ID);
}

async function canManageBot(interaction) {
  const userId = interaction?.user?.id;
  if (isBypassUser(userId)) return true;
  if (!interaction?.inGuild?.()) {
    return isAllowedDmUser(userId);
  }
  return hasManagerRole(interaction);
}

function canUseDebug(interaction) {
  const userId = interaction?.user?.id;
  if (!userId) return false;
  if (isBypassUser(userId)) return true;
  if (!DEBUG_USER_IDS.length) return true;
  return DEBUG_USER_IDS.includes(userId);
}

async function canUseAnalyze(interaction) {
  // Analyze command is restricted to managers/leadership
  return canManageBot(interaction);
}

module.exports = {
  MANAGER_ROLE_ID,
  ALLOWED_DM_USER,
  BYPASS_USER_ID,
  DEBUG_USER_IDS,
  fetchMember,
  isAllowedDmUser,
  isBypassUser,
  hasManagerRole,
  canManageBot,
  canUseDebug,
  canUseAnalyze,
};
