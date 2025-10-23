// commands/performance.js
// Performance monitoring and metrics command
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { performanceMonitor } = require('../lib/performance-monitor');
const { smartCache } = require('../lib/smart-cache');
const { sessionManager } = require('../lib/session-manager');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('performance')
    .setDescription('Show bot performance metrics and optimization status')
    .addStringOption(opt =>
      opt
        .setName('command')
        .setDescription('Show metrics for specific command')
        .setRequired(false)
        .addChoices(
          { name: 'All Commands', value: 'all' },
          { name: 'Profile Command', value: 'profile' },
          { name: 'Race Command', value: 'race' },
          { name: 'Update Command', value: 'update' }
        )
    )
    .addBooleanOption(opt =>
      opt
        .setName('detailed')
        .setDescription('Show detailed metrics')
        .setRequired(false)
    ),

  /**
   * Execute the /performance command
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @returns {Promise<void>}
   */
  async execute(interaction) {
    await interaction.deferReply();

    const commandFilter = interaction.options.getString('command') || 'all';
    const detailed = interaction.options.getBoolean('detailed') || false;

    try {
      const summary = performanceMonitor.getSummary();
      const cacheStats = smartCache.getStats();
      
      // Create main performance embed
      const embed = new EmbedBuilder()
        .setTitle('🤖 DemBot Performance Metrics')
        .setColor(0x00ff00)
        .setTimestamp()
        .setFooter({ text: 'Performance monitoring enabled' });

      // Uptime and basic stats
      const uptimeHours = Math.floor(summary.uptime / 3600);
      const uptimeMinutes = Math.floor((summary.uptime % 3600) / 60);
      
      embed.addFields(
        {
          name: '⏱️ Uptime',
          value: `${uptimeHours}h ${uptimeMinutes}m`,
          inline: true
        },
        {
          name: '📊 Total Commands',
          value: summary.totalCommands.toString(),
          inline: true
        },
        {
          name: '⚡ Avg Response Time',
          value: `${summary.avgCommandTime}ms`,
          inline: true
        }
      );

      // Memory usage
      const memoryUsage = (summary.memory.current / summary.memory.system) * 100;
      embed.addFields(
        {
          name: '💾 Memory Usage',
          value: `${summary.memory.current}MB / ${summary.memory.system}MB (${memoryUsage.toFixed(1)}%)`,
          inline: true
        },
        {
          name: '📈 Peak Memory',
          value: `${summary.memory.peak}MB`,
          inline: true
        },
        {
          name: '🆓 Free Memory',
          value: `${summary.memory.free}MB`,
          inline: true
        }
      );

      // Cache performance
      embed.addFields(
        {
          name: '🗄️ Cache Performance',
          value: `Hit Rate: ${cacheStats.hitRate.toFixed(1)}%\nHits: ${cacheStats.hits} | Misses: ${cacheStats.misses}`,
          inline: true
        },
        {
          name: '🔗 Session Management',
          value: `Created: ${summary.sessions.created}\nReused: ${summary.sessions.reused}\nClosed: ${summary.sessions.closed}`,
          inline: true
        },
        {
          name: '❌ Errors',
          value: Object.keys(summary.errors).length > 0 
            ? Object.entries(summary.errors).map(([type, count]) => `${type}: ${count}`).join('\n')
            : 'No errors recorded',
          inline: true
        }
      );

      // Command-specific metrics
      if (commandFilter === 'all') {
        const commandFields = Object.entries(summary.commands)
          .filter(([name]) => summary.commands[name].count > 0)
          .map(([name, data]) => ({
            name: `/${name}`,
            value: `Count: ${data.count}\nAvg: ${data.avgTime}ms\nSuccess: ${data.successRate}%`,
            inline: true
          }));

        if (commandFields.length > 0) {
          embed.addFields(
            { name: '📋 Command Performance', value: 'Detailed metrics below', inline: false },
            ...commandFields
          );
        }
      } else {
        const commandData = summary.commands[commandFilter];
        if (commandData && commandData.count > 0) {
          embed.addFields(
            {
              name: `📋 /${commandFilter} Performance`,
              value: `**Executions:** ${commandData.count}\n**Average Time:** ${commandData.avgTime}ms\n**Min Time:** ${commandData.minTime}ms\n**Max Time:** ${commandData.maxTime}ms\n**Success Rate:** ${commandData.successRate}%`,
              inline: false
            }
          );
        } else {
          embed.addFields(
            {
              name: `📋 /${commandFilter} Performance`,
              value: 'No data available for this command',
              inline: false
            }
          );
        }
      }

      // Optimization status
      const optimizationStatus = this.getOptimizationStatus();
      embed.addFields(
        {
          name: '🚀 Optimization Status',
          value: optimizationStatus,
          inline: false
        }
      );

      // Detailed metrics if requested
      if (detailed) {
        const detailedInfo = this.getDetailedInfo();
        embed.addFields(
          {
            name: '🔍 Detailed Information',
            value: detailedInfo,
            inline: false
          }
        );
      }

      await interaction.editReply({ embeds: [embed] });

    } catch (error) {
      console.error('Error in performance command:', error);
      await interaction.editReply(`❌ Error retrieving performance metrics: ${error.message}`);
    }
  },

  /**
   * Get optimization status
   * @returns {string} Optimization status text
   */
  getOptimizationStatus() {
    const features = [
      '✅ Persistent Browser Sessions',
      '✅ Parallel Processing',
      '✅ Smart Caching',
      '✅ Session Reuse',
      '✅ Memory Management',
      '✅ Error Tracking'
    ];

    return features.join('\n');
  },

  /**
   * Get detailed information
   * @returns {string} Detailed information text
   */
  getDetailedInfo() {
    const summary = performanceMonitor.getSummary();
    const cacheStats = smartCache.getStats();
    
    return [
      `**System Load:** ${require('os').loadavg()[0].toFixed(2)}`,
      `**CPU Cores:** ${require('os').cpus().length}`,
      `**Platform:** ${require('os').platform()} ${require('os').arch()}`,
      `**Node Version:** ${process.version}`,
      `**Cache Size:** ${cacheStats.active}/${cacheStats.total} active`,
      `**Session Pool:** ${sessionManager.sessions.size} active sessions`
    ].join('\n');
  }
};
