const { getEnv } = require('./ppusa-config');

const ROLE_FINANCE = getEnv('SEND_ROLE_ALLOWED', '1406063223475535994');
const ROLE_TREASURY_ADMIN = getEnv('SEND_ROLE_TREASURY_ADMIN', '1429335468276715591');
const BASE_LIMIT = Number(getEnv('SEND_MAX_AMOUNT', '2000000')) || 0;

const UNLIMITED = Infinity;

function memberHasRole(member, roleId) {
  if (!roleId) return false;
  const roles = member?.roles?.cache;
  if (!roles) return false;
  return roles.has(roleId);
}

function getSendLimit(member) {
  if (memberHasRole(member, ROLE_TREASURY_ADMIN)) return UNLIMITED;
  if (memberHasRole(member, ROLE_FINANCE)) return BASE_LIMIT;
  return 0;
}

function canUseSend(interaction) {
  if (!interaction?.inGuild?.()) return false;
  const member = interaction.member;
  if (!member) return false;
  return memberHasRole(member, ROLE_FINANCE) || memberHasRole(member, ROLE_TREASURY_ADMIN);
}

function formatLimit(limit) {
  if (limit === UNLIMITED) return 'Unlimited';
  const value = Number(limit) || 0;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);
}

module.exports = {
  ROLE_FINANCE,
  ROLE_TREASURY_ADMIN,
  BASE_LIMIT,
  UNLIMITED,
  getSendLimit,
  canUseSend,
  formatLimit,
};
