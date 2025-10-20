// commands/help.js
// Version: 1.0
const {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  Collection,
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
    embed.addFields({
      name: key,
      value: list
        .map(
          (cmd) =>
            `**${cmd.signature}**\n${INDENT}${cmd.description || '_No description provided_'}\n${INDENT}Requires: ${
              cmd.requirementLabel || key
            }`,
        )
        .join('\n\n'),
    });
    grouped.delete(key);
  }

  for (const [key, list] of grouped.entries()) {
    const sorted = list.sort((a, b) => a.name.localeCompare(b.name));
    embed.addFields({
      name: key,
      value: sorted
        .map(
          (cmd) =>
            `**${cmd.signature}**\n${INDENT}${cmd.description || '_No description provided_'}\n${INDENT}Requires: ${
              cmd.requirementLabel || key
            }`,
        )
        .join('\n\n'),
    });
  }

  return embed;
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
      return { ...payload, flags: MessageFlags.Ephemeral };
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

    const embed = buildOverviewEmbed(visible);
    return interaction.reply(withVisibility({ embeds: [embed] }));
  },
};

