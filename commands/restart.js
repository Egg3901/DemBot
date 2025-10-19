// commands/restart.js
// Slash command to restart the bot process. Restricted to bot managers.

const { SlashCommandBuilder } = require('discord.js');
const { canManageBot } = require('../lib/permissions');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('restart')
    .setDescription('Restart the bot process (managers only)')
    .addBooleanOption(opt => opt.setName('now').setDescription('Restart immediately (default true)')),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    if (!(await canManageBot(interaction))) {
      return interaction.reply({ content: 'You do not have permission to restart the bot.', ephemeral: true });
    }
    const now = interaction.options.getBoolean('now');
    const delayMs = now === false ? 10_000 : 1_000;
    await interaction.reply({ content: `Restarting bot in ${(delayMs / 1000).toFixed(0)}s...`, ephemeral: true });
    setTimeout(() => {
      try { process.exit(0); } catch (_) {}
    }, delayMs).unref();
  },
};

