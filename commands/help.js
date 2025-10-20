// commands/help.js
// Version: 1.0
const {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  Collection,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const { fetchMember, canManageBot } = require('../lib/permissions');
const { getSendLimit, formatLimit, ROLE_TREASURY_ADMIN, BASE_LIMIT, UNLIMITED } = require('../lib/send-access');

const BRAND_COLOR = 0x5865f2;

const OPTION_ICONS = {
  string: '🔤',
  integer: '#️⃣',
  number: '🔢',
  boolean: '🔘',
  user: '👤',
  channel: '📺',
  role: '🏷️',
  mentionable: '💬',
  attachment: '📎',
  subcommand: '🧩',
  group: '🗂️',
};

const INDENT = '  ';

const OPTION_TYPE_LABEL = {
  1: 'subcommand',
  2: 'group',
  3: 'string',
  4: 'integer',
  5: 'boolean',
  6: 'user',
  7: 'channel',
  8: 'role',
  9: 'mentionable',
  10: 'number',
  11: 'attachment',
};

const ACCESS_GENERAL = 'General access';
const ACCESS_MANAGER = 'Manager role';
const ACCESS_FINANCE = 'Finance role';

const COMMAND_REQUIREMENTS = {
  restart: {
    defaultLabel: ACCESS_MANAGER,
    groupKey: ACCESS_MANAGER,
    check: async (_interaction, context) => context.isManager,
  },
  update: {
    defaultLabel: ACCESS_MANAGER,
    groupKey: ACCESS_MANAGER,
    check: async (_interaction, context) => context.isManager,
  },
  send: {
    defaultLabel: ACCESS_FINANCE,
    groupKey: ACCESS_FINANCE,
    check: async (interaction, context) => {
      if (!interaction.inGuild?.()) {
        return { allowed: false, label: `${ACCESS_FINANCE} (guild only)`, groupKey: ACCESS_FINANCE };
      }
      const member = context.member;
      const limit = getSendLimit(member);
      if (limit > 0) {
        const isAdmin = member?.roles?.cache?.has(ROLE_TREASURY_ADMIN) || false;
        const label = isAdmin
          ? `Treasury Admin (limit: ${formatLimit(UNLIMITED)})`
          : `Finance role (limit: ${formatLimit(limit)})`;
        return { allowed: true, label, groupKey: ACCESS_FINANCE };
      }
      return { allowed: false, label: `Finance role (limit: ${formatLimit(BASE_LIMIT)})`, groupKey: ACCESS_FINANCE };
    },
  },
};

/**
 * Build a quick signature like `/treasury (party?) (debug?)`.
 * @param {import('@discordjs/builders').SlashCommandBuilder} builder
 * @returns {string}
 */
function buildSignature(builder) {
  const json = builder.toJSON();
  const pieces = [`/${json.name}`];
  if (Array.isArray(json.options) && json.options.length) {
    const hasSubcommands = json.options.some((opt) => opt.type === 1 || opt.type === 2);
    if (hasSubcommands) {
      pieces.push('[subcommand]');
    }
    for (const opt of json.options) {
      if (opt.type === 1 || opt.type === 2) continue;
      const wrapper = opt.required ? ['<', '>'] : ['[', ']'];
      pieces.push(`${wrapper[0]}${opt.name}${wrapper[1]}`);
    }
  }
  return pieces.join(' ');
}

/**
 * Render a multi-line description of options.
 * @param {any[]} options
 * @param {number} depth
 * @returns {string}
 */
function formatOptions(options = [], depth = 0) {
  if (!options.length) return `${INDENT}- No options`;
  return options
    .map((opt) => {
      const typeLabel = OPTION_TYPE_LABEL[opt.type] || 'value';
      const icon = OPTION_ICONS[typeLabel] || '✨';
      const req = opt.required ? 'required' : 'optional';
      const indent = INDENT.repeat(depth + 1);

      if (opt.type === 1 || opt.type === 2) {
        const header = `${indent}${icon} **${opt.name}** (${typeLabel}) – ${opt.description || 'No description'}`;
        const children = formatOptions(opt.options || [], depth + 1);
        return `${header}\n${children}`;
      }

      const choices = Array.isArray(opt.choices) && opt.choices.length
        ? `\n${indent}${INDENT}• Choices: ${opt.choices.map((c) => `\`${c.name}\``).join(', ')}`
        : '';
      return `${indent}${icon} \`${opt.name}\` (${typeLabel}, ${req}) – ${opt.description || 'No description'}${choices}`;
    })
    .join('\n');
}

/**
 * Create an embed listing all commands at a glance.
 * @param {Array<{ name: string, description: string, signature: string, requirementLabel: string }>} commandInfos
 */
function buildOverviewEmbed(commandInfos) {
  const embed = new EmbedBuilder()
    .setTitle('DemBot Command Reference')
    .setDescription(
      [
        'Browse the available slash commands below.',
        'Use `/help command:<name>` for deep details on a single command.',
      ].join('\n'),
    )
    .setColor(BRAND_COLOR)
    .setTimestamp(new Date());

  // Helper: add a field, splitting into multiple fields if content exceeds Discord limits
  const addChunkedField = (name, lines) => {
    const MAX_FIELD_LEN = 1000; // under 1024 to leave margin
    if (!Array.isArray(lines) || !lines.length) return;
    let chunk = [];
    let length = 0;
    let part = 1;
    const pushChunk = () => {
      if (!chunk.length) return;
      const fieldName = part === 1 ? name : `${name} (${part})`;
      embed.addFields({ name: fieldName, value: chunk.join('\n') });
      chunk = [];
      length = 0;
      part++;
    };
    for (const line of lines) {
      const ln = line.length + 1;
      if (length + ln > MAX_FIELD_LEN) {
        pushChunk();
        // Hard stop if we exceed 25 fields total
        if (Array.isArray(embed.data.fields) && embed.data.fields.length >= 25) return;
      }
      chunk.push(line);
      length += ln;
      if (Array.isArray(embed.data.fields) && embed.data.fields.length >= 25) break;
    }
    if (chunk.length && (!Array.isArray(embed.data.fields) || embed.data.fields.length < 25)) pushChunk();
  };

  const grouped = new Map();
  for (const info of commandInfos) {
    const key = info.groupKey || info.requirementLabel || ACCESS_GENERAL;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(info);
  }

  const order = [ACCESS_GENERAL, ACCESS_MANAGER, ACCESS_FINANCE];
  for (const key of order) {
    if (!grouped.has(key)) continue;
    const list = grouped.get(key).sort((a, b) => a.name.localeCompare(b.name));
    const lines = list.map(
      (cmd) => `**${cmd.signature}**\n${INDENT}${cmd.description || '_No description provided_'}\n${INDENT}Requires: ${cmd.requirementLabel || key}`,
    );
    addChunkedField(key, lines);
    grouped.delete(key);
  }

  for (const [key, list] of grouped.entries()) {
    const sorted = list.sort((a, b) => a.name.localeCompare(b.name));
    const lines = sorted.map(
      (cmd) => `**${cmd.signature}**\n${INDENT}${cmd.description || '_No description provided_'}\n${INDENT}Requires: ${cmd.requirementLabel || key}`,
    );
    addChunkedField(key, lines);
  }

  return embed;
}

function buildOverviewPages(commandInfos) {
  const sorted = commandInfos.slice().sort((a, b) => a.name.localeCompare(b.name));
  const pageSize = 10;
  const pages = [];
  for (let i = 0; i < sorted.length; i += pageSize) {
    const slice = sorted.slice(i, i + pageSize);
    const lines = slice.map((cmd) =>
      `• **${cmd.signature}**\n${INDENT}${cmd.description || '_No description provided_'}\n${INDENT}Requires: ${cmd.requirementLabel}`
    );
    const embed = new EmbedBuilder()
      .setTitle('DemBot Commands')
      .setDescription('Use `/help command:<name>` for details on a single command.')
      .setColor(BRAND_COLOR)
      .setTimestamp(new Date())
      .addFields({ name: `Commands ${i + 1}-${Math.min(i + pageSize, sorted.length)} of ${sorted.length}`, value: lines.join('\n\n') });
    pages.push(embed);
  }
  if (pages.length === 0) {
    pages.push(new EmbedBuilder().setTitle('DemBot Commands').setDescription('No commands available.').setColor(BRAND_COLOR));
  }
  return pages;
}

function buildControlsRow(nonce, index, total) {
  const first = new ButtonBuilder().setCustomId(`help:${nonce}:first`).setEmoji('⏮️').setStyle(ButtonStyle.Secondary).setDisabled(index === 0);
  const prev = new ButtonBuilder().setCustomId(`help:${nonce}:prev`).setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(index === 0);
  const next = new ButtonBuilder().setCustomId(`help:${nonce}:next`).setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(index >= total - 1);
  const last = new ButtonBuilder().setCustomId(`help:${nonce}:last`).setEmoji('⏭️').setStyle(ButtonStyle.Secondary).setDisabled(index >= total - 1);
  const close = new ButtonBuilder().setCustomId(`help:${nonce}:close`).setEmoji('🛑').setStyle(ButtonStyle.Danger);
  return new ActionRowBuilder().addComponents(first, prev, next, last, close);
}

async function sendPaginatedHelp(interaction, commandInfos, makePublic) {
  const pages = buildOverviewPages(commandInfos);
  if (pages.length === 1) {
    return interaction.reply({ embeds: [pages[0]], ephemeral: !makePublic });
  }

  let index = 0;
  const nonce = interaction.id;
  const row = buildControlsRow(nonce, index, pages.length);
  await interaction.reply({ embeds: [pages[index]], components: [row], ephemeral: !makePublic });
  const msg = await interaction.fetchReply();

  const filter = (i) => i.user.id === interaction.user.id && typeof i.customId === 'string' && i.customId.startsWith(`help:${nonce}:`);
  const collector = msg.createMessageComponentCollector({ filter, time: 120_000 });

  collector.on('collect', async (i) => {
    const id = i.customId.split(':')[2];
    if (id === 'close') {
      collector.stop('closed');
      try { await i.update({ components: [] }); } catch (_) {}
      return;
    }
    if (id === 'first') index = 0;
    else if (id === 'prev') index = Math.max(0, index - 1);
    else if (id === 'next') index = Math.min(pages.length - 1, index + 1);
    else if (id === 'last') index = pages.length - 1;
    const rowNew = buildControlsRow(nonce, index, pages.length);
    try { await i.update({ embeds: [pages[index]], components: [rowNew] }); } catch (_) {}
  });

  collector.on('end', async () => {
    try { await interaction.editReply({ components: [] }); } catch (_) {}
  });
}

/**
 * Detailed embed for a single command.
 * @param {*} commandModule
 * @param {string} requirementLabel
 */
function buildDetailEmbed(commandModule, requirementLabel = ACCESS_GENERAL) {
  const json = commandModule.data.toJSON();
  const fields = [
    { name: 'Signature', value: `\`${buildSignature(commandModule.data)}\`` },
    { name: 'Requires', value: requirementLabel },
    { name: 'Options', value: formatOptions(json.options) },
  ];
  return new EmbedBuilder()
    .setTitle(`/${json.name}`)
    .setDescription(json.description || 'No description set.')
    .addFields(fields)
    .setColor(BRAND_COLOR)
    .setFooter({ text: 'Need another command? Try /help without arguments.' })
    .setTimestamp(new Date());
}

async function evaluateAccess(interaction, commandName, context) {
  const requirement = COMMAND_REQUIREMENTS[commandName];
  if (!requirement) {
    return { allowed: true, label: ACCESS_GENERAL, groupKey: ACCESS_GENERAL };
  }
  const fallbackLabel = (
    typeof requirement.defaultLabel === 'function' ? requirement.defaultLabel(context) : requirement.defaultLabel
  ) || ACCESS_GENERAL;
  const fallbackGroup = (
    typeof requirement.groupKey === 'function' ? requirement.groupKey(context) : requirement.groupKey
  ) || fallbackLabel;

  try {
    const result = await requirement.check(interaction, context);
    if (typeof result === 'object' && result !== null) {
      return {
        allowed: Boolean(result.allowed),
        label: result.label || fallbackLabel,
        groupKey: result.groupKey || fallbackGroup,
      };
    }
    return { allowed: Boolean(result), label: fallbackLabel, groupKey: fallbackGroup };
  } catch (_) {
    return { allowed: false, label: fallbackLabel, groupKey: fallbackGroup };
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show a modern command reference for DemBot.')
    .addStringOption((option) =>
      option
        .setName('command')
        .setDescription('Command name to inspect (e.g., treasury)')
        .setAutocomplete(false)
        .setRequired(false),
    )
    .addBooleanOption((option) =>
      option
        .setName('public')
        .setDescription('Post help publicly instead of privately (default: private)')
        .setRequired(false),
    ),

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async execute(interaction) {
    const targetName = interaction.options.getString('command');
    const makePublic = interaction.options.getBoolean('public') ?? false;
    const commands = interaction.client.commands ?? new Collection();

    const context = {
      member: interaction.inGuild?.() ? await fetchMember(interaction) : null,
      isManager: await canManageBot(interaction),
    };

    const withVisibility = (payload) => {
      if (makePublic) return payload;
      return { ...payload, ephemeral: true };
    };

    if (targetName) {
      const entry = commands.get(targetName);
      if (!entry) {
        return interaction.reply(
          withVisibility({
            content: `I couldn’t find a command named \`${targetName}\`. Try \`/help\` to see everything.`,
          }),
        );
      }
      const access = await evaluateAccess(interaction, targetName, context);
      if (!access.allowed) {
        return interaction.reply(
          withVisibility({
            content: `You do not have access to \`/${targetName}\`. Requires: ${access.label}.`,
          }),
        );
      }
      const embed = buildDetailEmbed(entry, access.label);
      return interaction.reply(withVisibility({ embeds: [embed] }));
    }

    const visible = [];
    for (const cmd of commands.values()) {
      const access = await evaluateAccess(interaction, cmd.data.name, context);
      if (!access.allowed) continue;
      visible.push({
        name: cmd.data.name,
        description: cmd.data.description,
        signature: buildSignature(cmd.data),
        requirementLabel: access.label,
        groupKey: access.groupKey,
      });
    }

    if (visible.length === 0) {
      return interaction.reply(
        withVisibility({
          content: 'You do not have access to any commands.',
        }),
      );
    }

    return sendPaginatedHelp(interaction, visible, makePublic);
  },
};

