const { recordCommandError } = require('./status-tracker');
const { canUseDebug } = require('./permissions');

function resolveDebug(interaction, requested) {
  const wantsDebug = Boolean(requested);
  const allowed = canUseDebug(interaction);
  if (!wantsDebug) return { enabled: false, denied: false, allowed };
  if (allowed) return { enabled: true, denied: false, allowed };
  return { enabled: false, denied: true, allowed };
}

function getDebugChoice(interaction, optionName = 'debug') {
  const requested = interaction?.options?.getBoolean?.(optionName) ?? false;
  return { requested, ...resolveDebug(interaction, requested) };
}

async function reportCommandError(interaction, error, {
  message,
  meta,
  ephemeral = true,
  followUp = false,
  includeStack = false,
} = {}) {
  const errObj = error instanceof Error ? error : new Error(error?.message || String(error));
  const commandName = interaction?.commandName || 'unknown';
  const userId = interaction?.user?.id;
  const guildId = interaction?.guild?.id;
  
  // Enhanced error logging
  console.error(`❌ Command Error [${commandName}]:`, {
    message: errObj.message,
    stack: errObj.stack,
    userId,
    guildId,
    meta: meta || {},
    timestamp: new Date().toISOString()
  });
  
  try {
    recordCommandError(commandName, errObj, {
      ...meta,
      userId,
      guildId,
      interactionType: interaction?.type,
      channelId: interaction?.channel?.id
    });
  } catch (trackerErr) {
    console.warn('reportCommandError: failed to record error meta', trackerErr);
  }

  if (interaction) interaction._dembotHandledError = true;

  // Enhanced error message based on error type
  let errorMessage = message || `Error: ${errObj.message}`;
  
  if (errObj.message.includes('timeout')) {
    errorMessage = '⏰ Command timed out. Please try again with a simpler request.';
  } else if (errObj.message.includes('Missing') || errObj.message.includes('Invalid')) {
    errorMessage = `❌ ${errObj.message}`;
  } else if (errObj.message.includes('permission') || errObj.message.includes('access')) {
    errorMessage = '🔒 You do not have permission to use this command.';
  } else if (errObj.message.includes('network') || errObj.message.includes('fetch')) {
    errorMessage = '🌐 Network error. Please try again in a moment.';
  } else if (errObj.message.includes('browser') || errObj.message.includes('puppeteer')) {
    errorMessage = '🌐 Browser error occurred. Please try again.';
  }
  
  // Add stack trace for debugging if requested and user has debug permissions
  if (includeStack && canUseDebug(interaction)) {
    errorMessage += `\n\n**Debug Info:**\n\`\`\`\n${errObj.stack}\`\`\``;
  }

  const payload = { content: errorMessage, ephemeral };

  try {
    if (followUp) {
      if (interaction?.deferred || interaction?.replied) await interaction.followUp(payload);
      else await interaction.reply(payload);
      return;
    }

    if (interaction?.deferred || interaction?.replied) await interaction.editReply(payload);
    else await interaction.reply(payload);
  } catch (sendErr) {
    if (sendErr?.code === 10062) {
      try {
        await interaction.followUp(payload);
      } catch (secondErr) {
        console.error('reportCommandError: failed to send follow-up after token expiry', secondErr);
      }
    } else if (sendErr?.code === 50013) {
      console.warn('reportCommandError: Missing permissions to send error message');
    } else {
      console.error('reportCommandError: failed to notify user', sendErr);
    }
  }
}

module.exports = {
  resolveDebug,
  getDebugChoice,
  reportCommandError,
};
