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
  shouldReset = false,
} = {}) {
  const errObj = error instanceof Error ? error : new Error(error?.message || String(error));
  const commandName = interaction?.commandName || 'unknown';
  
  // Enhanced error metadata
  const enhancedMeta = {
    ...meta,
    timestamp: new Date().toISOString(),
    userId: interaction?.user?.id,
    guildId: interaction?.guildId,
    channelId: interaction?.channelId,
    commandOptions: interaction?.options?.data || [],
    shouldReset,
    errorType: errObj.constructor.name,
    errorCode: errObj.code || null,
  };

  try {
    recordCommandError(commandName, errObj, enhancedMeta);
  } catch (trackerErr) {
    console.warn('reportCommandError: failed to record error meta', trackerErr);
  }

  if (interaction) interaction._dembotHandledError = true;

  // Enhanced error message with reset information
  let errorMessage = message || `Error: ${errObj.message}`;
  if (shouldReset) {
    errorMessage += '\n\n🔄 Command has been reset and will be retried automatically.';
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
    } else {
      console.error('reportCommandError: failed to notify user', sendErr);
    }
  }
}

async function resetCommand(interaction, commandName, retryDelay = 2000) {
  if (!interaction || !commandName) return false;
  
  try {
    // Mark the command for reset in the status tracker
    const { recordCommandReset } = require('./status-tracker');
    recordCommandReset(commandName, {
      userId: interaction.user?.id,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      retryDelay,
      timestamp: new Date().toISOString(),
    });

    // Schedule retry after delay
    setTimeout(async () => {
      try {
        // Re-trigger the command by simulating the interaction
        if (interaction.client && interaction.client.emit) {
          interaction.client.emit('interactionCreate', interaction);
        }
      } catch (retryError) {
        console.error(`Command reset retry failed for ${commandName}:`, retryError);
      }
    }, retryDelay);

    return true;
  } catch (error) {
    console.error('resetCommand failed:', error);
    return false;
  }
}

async function reportCommandErrorWithReset(interaction, error, options = {}) {
  const { shouldReset = false, retryDelay = 2000, ...otherOptions } = options;
  
  // Report the error with enhanced logging
  await reportCommandError(interaction, error, {
    ...otherOptions,
    shouldReset,
  });

  // Reset the command if requested
  if (shouldReset && interaction?.commandName) {
    await resetCommand(interaction, interaction.commandName, retryDelay);
  }
}

module.exports = {
  resolveDebug,
  getDebugChoice,
  reportCommandError,
  resetCommand,
  reportCommandErrorWithReset,
};
