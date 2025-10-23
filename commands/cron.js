// commands/cron.js
// Version: 1.0
const { SlashCommandBuilder } = require('discord.js');
const { canManageBot } = require('../lib/permissions');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('cron')
    .setDescription('Manage automated update cron jobs')
    .addSubcommand(subcommand =>
      subcommand
        .setName('status')
        .setDescription('Show the current status of automated updates')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('run')
        .setDescription('Manually trigger all automated updates')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('stop')
        .setDescription('Stop the automated update cron job')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('start')
        .setDescription('Start the automated update cron job')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('restart')
        .setDescription('Restart the automated update cron job')
    ),

  async execute(interaction) {
    await interaction.deferReply();

    if (!(await canManageBot(interaction))) {
      return interaction.editReply('You do not have permission to use /cron.');
    }

    const subcommand = interaction.options.getSubcommand();
    const cronService = interaction.client.cronService;

    if (!cronService) {
      return interaction.editReply('❌ Cron service is not available. Please restart the bot.');
    }

    try {
      // Get status for all operations that need it
      const status = cronService ? cronService.getStatus() : null;

      switch (subcommand) {
        case 'status': {
          const lastRunText = status && status.lastRun
            ? status.lastRun.toLocaleString()
            : 'Never';

          const nextRunText = status && status.nextRun
            ? new Date(status.nextRun).toLocaleString()
            : 'Every hour at minute 0';

          const message = `📊 **Cron Service Status**
• **Running**: ${status && status.isRunning ? '🔄 Yes' : '⏸️ No'}
• **Scheduled**: ${status && status.scheduled ? '✅ Yes' : '❌ No'}
• **Job Active**: ${status && status.jobActive ? '✅ Yes' : '❌ No'}
• **Last Run**: ${lastRunText}
• **Next Run**: ${nextRunText}`;

          await interaction.editReply(message);
          break;
        }

        case 'run': {
          if (status && status.isRunning) {
            return interaction.editReply('❌ Update is already running. Please wait for it to complete.');
          }

          await interaction.editReply('🔄 Manually triggering all automated updates...');
          await cronService.runHourlyUpdate();
          break;
        }

        case 'stop': {
          cronService.stop();
          await interaction.editReply('⏹️ Automated update cron job stopped.');
          break;
        }

        case 'start': {
          cronService.start();
          await interaction.editReply('▶️ Automated update cron job started.');
          break;
        }

        case 'restart': {
          cronService.restart();
          await interaction.editReply('🔄 Automated update cron job restarted.');
          break;
        }

        default:
          await interaction.editReply('❌ Unknown subcommand.');
      }
    } catch (err) {
      console.error('Cron command error:', err);
      await interaction.editReply(`❌ Error: ${err?.message || String(err)}`);
    }
  },
};
