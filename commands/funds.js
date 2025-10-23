// commands/funds.js
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { isBypassUser } = require('../lib/permissions');

// ===== CONFIG =====
const ALLOWED_CHANNEL = '1426053522113433770';
const ROLE_NATIONAL = '1257715735090954270';
const ROLE_SECOND = '1408832907707027547';
const ROLE_THIRD = '1257715382287073393';

// ✅ Only this role gets pinged
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
   * Sends a SEPARATE ping message (mentions only ROLE_PING) and a SEPARATE embed message that gets edited on approval.
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    // --- Channel restriction (skip in DMs; bypass for privileged user) ---
    if (interaction.inGuild() && interaction.channelId !== ALLOWED_CHANNEL && !isBypassUser(interaction.user?.id)) {
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

    // We will always create TWO messages in guilds:
    //   1) A ping message (content-only) that mentions ROLE_PING
    //   2) A follow-up embed message (no mentions) which will be edited on approval
    // In DMs: only the embed is sent.

    let embedMessage;

    if (interaction.inGuild()) {
      // 1) 📣 PING MESSAGE (separate message; content-only)
      // Use channel.send so it's fully separate from the embed reply.
      await interaction.channel.send({
        content: `📣 Attention: <@&${ROLE_PING}> — a new fund request has been submitted.`,
        allowedMentions: { parse: [], roles: [ROLE_PING], users: [] }, // restrict mention to ROLE_PING only
      });

      // 2) 🟡 EMBED MESSAGE (separate message; will be edited later)
      const requestEmbed = buildRequestEmbed({ amount, requesterTag, reason });

      // We still need to acknowledge the interaction—send a lightweight ephemeral ack to the caller,
      // then post the actual embed to the channel as a standalone message.
      await interaction.reply({
        content: '✅ Fund request posted.',
        ephemeral: true,
      });

      embedMessage = await interaction.channel.send({
        embeds: [requestEmbed],
        allowedMentions: { parse: [], roles: [], users: [] },
      });
    } else {
      // In DMs: just send the embed as the reply (no ping possible)
      const requestEmbed = buildRequestEmbed({ amount, requesterTag, reason });
      await interaction.reply({
        embeds: [requestEmbed],
        allowedMentions: { parse: [], roles: [], users: [] },
      });
      embedMessage = await interaction.fetchReply();
    }

    // Skip reaction collector outside guilds
    if (!interaction.inGuild()) return;

    // React on the EMBED message and wait for approval from authorized roles
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

      // 🔁 Edit ONLY the embed message to reflect approval (ping message remains untouched)
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
 * Purpose: Request funds with cooldown; sends a SEPARATE role-restricted ping, then a SEPARATE embed that gets edited on approval
 * Author: egg3901
 * Created: 2025-10-16
 * Last Updated: 2025-10-18
 * Notes:
 *   - Ping message: channel.send with ROLE_PING mention only (no users).
 *   - Embed message: separate message (no mentions) that is edited upon approval.
 *   - Interaction is acknowledged ephemerally to keep UX clean and avoid mixing ping/embed.
 */
