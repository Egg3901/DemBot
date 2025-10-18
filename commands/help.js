const {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  Collection,
} = require('discord.js');

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
 * @param {Collection<string, any>} commandCollection
 */
function buildOverviewEmbed(commandCollection) {
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

  const commands = [...commandCollection.values()]
    .map((cmd) => ({
      name: cmd.data.name,
      description: cmd.data.description,
      signature: buildSignature(cmd.data),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const chunkSize = 6;
  for (let i = 0; i < commands.length; i += chunkSize) {
    const chunk = commands.slice(i, i + chunkSize);
    embed.addFields({
      name: `Commands ${Math.floor(i / chunkSize) + 1}`,
      value: chunk
        .map((cmd) => `**${cmd.signature}**\n${INDENT}${cmd.description || '_No description provided_'}`)
        .join('\n\n'),
    });
  }

  return embed;
}

/**
 * Detailed embed for a single command.
 * @param {*} commandModule
 */
function buildDetailEmbed(commandModule) {
  const json = commandModule.data.toJSON();
  return new EmbedBuilder()
    .setTitle(`/${json.name}`)
    .setDescription(json.description || 'No description set.')
    .addFields(
      { name: 'Signature', value: `\`${buildSignature(commandModule.data)}\`` },
      { name: 'Options', value: formatOptions(json.options) },
    )
    .setColor(BRAND_COLOR)
    .setFooter({ text: 'Need another command? Try /help without arguments.' })
    .setTimestamp(new Date());
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
      const embed = buildDetailEmbed(entry);
      return interaction.reply(withVisibility({ embeds: [embed] }));
    }

    const embed = buildOverviewEmbed(commands);
    return interaction.reply(withVisibility({ embeds: [embed] }));
  },
};
