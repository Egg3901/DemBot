// Helper utilities for permission checks across commands

const MANAGER_ROLE_ID = process.env.MANAGER_ROLE_ID || '1406063223475535994';
const ALLOWED_DM_USER = process.env.ALLOWED_DM_USER || '333052320252297216';

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

module.exports = {
  MANAGER_ROLE_ID,
  ALLOWED_DM_USER,
  fetchMember,
  isAllowedDmUser,
  hasManagerRole,
  canManageBot,
};
