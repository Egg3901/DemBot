// commands/restart.js
// Slash command to restart the bot process. Requires Administrator or listed admin IDs.

const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');

function isAdmin(interaction) {
  try {
    const uid = interaction.user?.id;
    const adminsRaw = process.env.ADMIN_IDS || process.env.ADMINS || '';
    const adminIds = adminsRaw.split(/[,\s]+/).filter(Boolean);
    const allowedDm = process.env.ALLOWED_DM_USER || '';
    if (uid && adminIds.includes(uid)) return true;
    if (uid && allowedDm && uid === allowedDm) return true;
    if (interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) return true;
  } catch (_) {}
  return false;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('restart')
    .setDescription('Restart the bot process (admins only)')
    .addBooleanOption(opt => opt.setName('now').setDescription('Restart immediately (default true)')),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: 'You do not have permission to restart the bot.', ephemeral: true });
    }
    const now = interaction.options.getBoolean('now');
    const delayMs = now === false ? 10_000 : 1_000;
    await interaction.reply({ content: `Restarting bot in ${(delayMs/1000).toFixed(0)}s...`, ephemeral: true });
    setTimeout(() => {
      try { process.exit(0); } catch (_) {}
    }, delayMs).unref();
  },
};

