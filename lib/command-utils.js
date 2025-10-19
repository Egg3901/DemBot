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
} = {}) {
  const errObj = error instanceof Error ? error : new Error(error?.message || String(error));
  const commandName = interaction?.commandName || 'unknown';
  try {
    recordCommandError(commandName, errObj, meta);
  } catch (trackerErr) {
    console.warn('reportCommandError: failed to record error meta', trackerErr);
  }

  if (interaction) interaction._dembotHandledError = true;

  const payload = { content: message || `Error: ${errObj.message}`, ephemeral };

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

module.exports = {
  resolveDebug,
  getDebugChoice,
  reportCommandError,
};
