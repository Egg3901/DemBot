// commands/funds.js
const { SlashCommandBuilder } = require('discord.js');

// ===== CONFIG =====
const ALLOWED_CHANNEL = '1426053522113433770';
const ROLE_NATIONAL = '1257715735090954270';
const ROLE_SECOND = '1408832907707027547';
const ROLE_THIRD = '1257715382287073393';

// ✅ The only role that should be pinged in the request message
const ROLE_PING = '1406063223475535994';

const COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes

// Track cooldowns: userId => timestamp
const cooldowns = new Map();

module.exports = {
  data: new SlashCommandBuilder()
    .setName('funds')
    .setDescription('Request funds from the National Committee')
    .setDMPermission(true)
    .addNumberOption(opt =>
      opt
        .setName('amount')
        .setDescription('Amount (in dollars) to request')
        .setRequired(true)
        .setMinValue(0.01)
    )
    .addStringOption(opt =>
      opt
        .setName('reason')
        .setDescription('Optional reason for the request')
        .setRequired(false)
    ),

  /**
   * Execute the /funds command.
   * Enforces channel + cooldown, posts a request message (pinging only ROLE_PING),
   * and allows committee approval via reaction.
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    // --- Channel restriction (skip in DMs) ---
    if (interaction.inGuild() && interaction.channelId !== ALLOWED_CHANNEL) {
      return interaction.reply({
        content: '🚫 This command can only be used in the designated **fund-request** channel.',
        ephemeral: true,
      });
    }

    const userId = interaction.user.id;
    const now = Date.now();

    // --- Cooldown check ---
    if (cooldowns.has(userId)) {
      const lastUsed = cooldowns.get(userId);
      const diff = now - lastUsed;

      if (diff < COOLDOWN_MS) {
        const timeLeft = Math.ceil((COOLDOWN_MS - diff) / 60000);
        return interaction.reply({
          content: `⏳ Please wait **${timeLeft} more minute${timeLeft !== 1 ? 's' : ''}** before requesting funds again.`,
          ephemeral: true,
        });
      }
    }

    cooldowns.set(userId, now);

    // --- Command logic ---
    const amount = interaction.options.getNumber('amount', true);
    const reason = interaction.options.getString('reason') || '';
    const requester = interaction.user;

    const formattedAmount = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);

    // Build message — mention ONLY ROLE_PING (and only when in a guild)
    const roleMention = interaction.inGuild() ? `<@&${ROLE_PING}>` : '';
    const messageLines = [
      '**FUND REQUEST**',
      '',
      roleMention ? `Attention: ${roleMention}` : 'Attention: Committee',
      '',
      `Amount Requested: ${formattedAmount}`,
      `Requested By: ${requester.tag}`,
      reason ? `Reason: ${reason}` : null,
      '',
      'Please review the request and send funds in a timely manner.',
    ].filter(Boolean);

    await interaction.reply({
      content: messageLines.join('\n'),
      // ✅ Only allow pinging the single role; do NOT allow any other mentions
      allowedMentions: interaction.inGuild()
        ? { parse: [], roles: [ROLE_PING], users: [] }
        : { parse: [], roles: [], users: [] },
    });

    const sentMessage = await interaction.fetchReply();

    // Skip reaction collector outside guilds
    if (!interaction.inGuild()) return;

    // React and wait for approval
    const approvalEmoji = '💰';
    await sentMessage.react(approvalEmoji);

    const filter = (reaction, user) =>
      reaction.emoji.name === approvalEmoji && !user.bot;

    const collector = sentMessage.createReactionCollector({
      filter,
      time: 24 * 60 * 60 * 1000, // 24h window
    });

    collector.on('collect', async (reaction, user) => {
      const member = await reaction.message.guild.members.fetch(user.id);
      const hasRole =
        member.roles.cache.has(ROLE_NATIONAL) ||
        member.roles.cache.has(ROLE_SECOND) ||
        member.roles.cache.has(ROLE_THIRD);

      if (!hasRole) return;

      collector.stop('approved');

      const completedLines = [
        `**FUND REQUEST — COMPLETED BY ${user.tag}**`,
        '',
        `Amount Requested: ${formattedAmount}`,
        `Requested By: ${requester.tag}`,
        reason ? `Reason: ${reason}` : null,
        '',
        'Funds have been approved and processed by the committee.',
      ].filter(Boolean);

      await sentMessage.edit({
        content: completedLines.join('\n'),
        // No further pings on edit
        allowedMentions: { parse: [], roles: [], users: [] },
      });
    });
  },
};
/**
 * Project: DemBot (Discord automation for Power Play USA)
 * File: commands/funds.js
 * Purpose: Request funds with cooldown + role-verified approval via reaction
 * Author: egg3901
 * Created: 2025-10-16
 * Last Updated: 2025-10-18
 * Notes:
 *   - Only pings role 1406063223475535994 in the initial message (and only in guild channels).
 *   - allowedMentions restricted to that role; no other roles/users are pinged.
 */
