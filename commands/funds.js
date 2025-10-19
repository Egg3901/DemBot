// commands/funds.js
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

// ===== CONFIG =====
const ALLOWED_CHANNEL = '1426053522113433770';
const ROLE_NATIONAL = '1257715735090954270';
const ROLE_SECOND = '1408832907707027547';
const ROLE_THIRD = '1257715382287073393';

// ✅ The only role that should be pinged
const ROLE_PING = '1406063223475535994';

const COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes

// Track cooldowns: userId => timestamp
const cooldowns = new Map();

/* ===================== helpers ===================== */
const usd = (n) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);

function buildRequestEmbed({ amount, requesterTag, reason }) {
  const embed = new EmbedBuilder()
    .setTitle('FUND REQUEST — Pending Review')
    .setColor(0xffcc00) // amber
    .addFields(
      { name: 'Amount', value: usd(amount), inline: true },
      { name: 'Requested By', value: requesterTag, inline: true },
    )
    .setTimestamp();

  if (reason) embed.addFields({ name: 'Reason', value: reason });

  embed.setFooter({ text: 'React 💰 to approve' });
  return embed;
}

function buildApprovedEmbed({ amount, requesterTag, reason, approverTag }) {
  const embed = new EmbedBuilder()
    .setTitle('FUND REQUEST — Approved')
    .setColor(0x34d399) // green
    .addFields(
      { name: 'Amount', value: usd(amount), inline: true },
      { name: 'Requested By', value: requesterTag, inline: true },
      { name: 'Approved By', value: approverTag, inline: true },
    )
    .setTimestamp();

  if (reason) embed.addFields({ name: 'Reason', value: reason });
  return embed;
}

/* ===================== command ===================== */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('funds')
    .setDescription('Request funds from the National Committee')
    .setDMPermission(true)
    .addNumberOption((opt) =>
      opt.setName('amount').setDescription('Amount (in dollars) to request').setRequired(true).setMinValue(0.01),
    )
    .addStringOption((opt) => opt.setName('reason').setDescription('Optional reason for the request').setRequired(false)),

  /**
   * Execute the /funds command.
   * Sends a ping message (mentions only ROLE_PING), then a follow-up embed that gets edited on approval.
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

    // --- Inputs ---
    const amount = interaction.options.getNumber('amount', true);
    const reason = interaction.options.getString('reason') || '';
    const requester = interaction.user;
    const requesterTag = requester.tag ?? requester.id;

    // 1) 📣 Ping message (mentions ONLY ROLE_PING, guild-only)
    let pingMessage;
    if (interaction.inGuild()) {
      pingMessage = await interaction.reply({
        content: `📣 Attention: <@&${ROLE_PING}> — a new fund request has been submitted.`,
        allowedMentions: { parse: [], roles: [ROLE_PING], users: [] }, // restrict mention to ROLE_PING
      });
    } else {
      // In DMs, just send a neutral heads-up
      pingMessage = await interaction.reply({
        content: `📣 A new fund request has been submitted.`,
        allowedMentions: { parse: [], roles: [], users: [] },
      });
    }

    // 2) 🟡 Follow-up embed (no pings) — this is the message we'll later EDIT on approval
    const requestEmbed = buildRequestEmbed({ amount, requesterTag, reason });
    const embedMessage = await interaction.followUp({
      embeds: [requestEmbed],
      allowedMentions: { parse: [], roles: [], users: [] },
    });

    // Skip reaction collector outside guilds
    if (!interaction.inGuild()) return;

    // Add reaction to the EMBED message and wait for approval from authorized roles
    const approvalEmoji = '💰';
    await embedMessage.react(approvalEmoji);

    const filter = (reaction, user) => reaction.emoji.name === approvalEmoji && !user.bot;

    const collector = embedMessage.createReactionCollector({
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

      // 🔁 Edit the embed (not the ping message) to reflect approval
      const approvedEmbed = buildApprovedEmbed({
        amount,
        requesterTag,
        reason,
        approverTag: user.tag ?? user.id,
      });

      await embedMessage.edit({
        embeds: [approvedEmbed],
        allowedMentions: { parse: [], roles: [], users: [] },
      });
    });
  },
};

/**
 * Project: DemBot (Discord automation for Power Play USA)
 * File: commands/funds.js
 * Purpose: Request funds with cooldown; sends a role-restricted ping, then a follow-up embed that gets edited on approval
 * Author: egg3901
 * Created: 2025-10-16
 * Last Updated: 2025-10-18
 * Notes:
 *   - Only pings role 1406063223475535994 in the initial ping message (guild only).
 *   - Follow-up embed carries details and is the message that gets edited upon approval.
 *   - Approval requires a member reacting with 💰 who has one of the committee roles.
 */
