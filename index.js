// File: index.js
// Version: 1.0
require('dotenv').config();
const { Blob: NodeBlob } = require('node:buffer');

if (typeof globalThis.File === 'undefined') {
  class NodeFile extends NodeBlob {
    constructor(bits, name, options = {}) {
      super(bits, options);
      this.name = name ?? 'file';
      this.lastModified = options.lastModified ?? Date.now();
    }
    get [Symbol.toStringTag]() {
      return 'File';
    }
  }
  globalThis.File = NodeFile;
}
const fs = require('node:fs');
const path = require('node:path');
const {
  Client,
  GatewayIntentBits,
  Collection,
  REST,
  Routes,
  Events,
  ActivityType,
  Partials,
  MessageFlags,
} = require('discord.js');
const {
  markBotReady,
  markBotLoginError,
  markHeartbeat,
  recordCommandSuccess,
  recordCommandError,
  recordUserCommand,
  sampleRuntime,
} = require('./lib/status-tracker');
const { reportCommandErrorWithReset } = require('./lib/command-utils');
const { startDashboardServer } = require('./lib/dashboard-server');
const CronService = require('./lib/cron-service');

// Function to determine if a command should be reset based on error type
function shouldResetCommand(error, interaction) {
  // Reset for network-related errors
  if (error.code === 'ENOTFOUND' || error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
    return true;
  }
  
  // Reset for Discord API errors that might be temporary
  if (error.code === 50013 || error.code === 50001 || error.code === 50035) {
    return true;
  }
  
  // Reset for authentication errors that might be temporary
  if (error.message?.includes('authentication') || error.message?.includes('unauthorized')) {
    return true;
  }
  
  // Reset for rate limiting
  if (error.code === 429 || error.message?.includes('rate limit')) {
    return true;
  }
  
  // Don't reset for user input errors or permanent failures
  if (error.message?.includes('invalid') || error.message?.includes('not found')) {
    return false;
  }
  
  // Default to not reset for unknown errors
  return false;
}

const { File, Blob, FormData, fetch, Headers, Request, Response } = require('undici');
globalThis.File ??= File;
globalThis.Blob ??= Blob;
globalThis.FormData ??= FormData;
globalThis.fetch ??= fetch;
globalThis.Headers ??= Headers;
globalThis.Request ??= Request;
globalThis.Response ??= Response;

// ---- Env ----
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
// Hardcoded guild ID for command registration - ensures commands work in this server
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || process.env.GUILD_ID || '1430928325890670623'; // supports both, with fallback
const REGISTER_GLOBAL = String(process.env.REGISTER_GLOBAL).toLowerCase() === 'true';
const ALLOWED_DM_USER = process.env.ALLOWED_DM_USER || '333052320252297216';
// Hardcoded allowed server ID - allows commands in this server without DM restrictions
const ALLOWED_SERVER_ID = '1430928325890670623';
const DASHBOARD_PORT = Number(process.env.STATUS_PORT || process.env.DASHBOARD_PORT || 3000);
const DASHBOARD_HOST = process.env.STATUS_HOST || process.env.DASHBOARD_HOST || '0.0.0.0';
// Welcome channel: prefer .env WELCOME_CHANNEL_ID, fallback to provided channel id
const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID || '1257518076123939017';

if (!DISCORD_TOKEN) {
  console.error('❌ Missing DISCORD_TOKEN in .env');
  process.exit(1);
}

// ---- Global crash guards ----
try {
  process.on('uncaughtException', (err) => {
    try {
      console.error('UNCAUGHT EXCEPTION:', err);
    } catch (_) {}
  });
  process.on('unhandledRejection', (reason, promise) => {
    try {
      console.error('UNHANDLED REJECTION:', reason);
    } catch (_) {}
  });
} catch (_) {}

// ---- Client ----
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
    // Needed for role sync and member lookups
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.GuildMember],
});

client.commands = new Collection();
const commandsJSON = [];

// Initialize cron service
let cronService = null;

// Periodic heartbeat (keeps dashboard status fresh even without command traffic)
setInterval(() => markHeartbeat(), 60_000).unref();
// Runtime metrics sampling (cpu/memory/load)
setInterval(() => sampleRuntime(), 60_000).unref();

// ---- Load commands ----
const commandsPath = path.join(__dirname, 'commands');
if (!fs.existsSync(commandsPath)) {
  console.warn(`⚠️ Commands folder not found: ${commandsPath}`);
} else {
  const files = fs
    .readdirSync(commandsPath)
    .filter((f) => f.endsWith('.js'))
    // Ignore temp/backup fragments like treasury.head.js or *.backup.js
    .filter((f) => !/\.head\.js$/i.test(f) && !/\.backup\.js$/i.test(f));
  console.log(`📦 Found ${files.length} command file(s)`);
  for (const file of files) {
    const filePath = path.join(commandsPath, file);
    const mod = require(filePath);
    if (!mod?.data || !mod?.execute) {
      console.warn(`⚠️ Skipping ${file} (missing data/execute export)`);
      continue;
    }
    client.commands.set(mod.data.name, mod);
    commandsJSON.push(mod.data.toJSON());
  }
  console.log(`🧾 Prepared ${commandsJSON.length} command(s)`);
}

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

// Lightweight status dashboard (HTML + JSON endpoints) for ops visibility
try {
  startDashboardServer({ port: DASHBOARD_PORT, host: DASHBOARD_HOST });
} catch (e) {
  console.warn('Dashboard server failed to start:', e?.message ?? e);
}

// ---- Ready → register + verify ----
client.once(Events.ClientReady, async (c) => {
  console.log(`🤖 Logged in as ${c.user.tag}`);
  markBotReady();
  const applicationId = c.user.id;

  // Presence (why: quick visual that bot is alive)
  try {
    await client.user.setPresence({
      activities: [{ name: 'Consciousness', type: ActivityType.Streaming, url: 'https://twitch.tv/discord' }],
      status: 'online',
    });
    console.log('🎥 Presence set.');
  } catch (e) {
    console.warn('Presence error:', e?.message ?? e);
  }

  if (commandsJSON.length === 0) {
    console.warn('⚠️ No commands to register. Ensure /commands has files exporting { data, execute }.');
    return;
  }

  try {
    if (DISCORD_GUILD_ID) {
      const putGuild = await rest.put(Routes.applicationGuildCommands(applicationId, DISCORD_GUILD_ID), {
        body: commandsJSON,
      });
      console.log(`✅ Guild-registered ${putGuild.length} command(s) to ${DISCORD_GUILD_ID}`);
    }

    if (REGISTER_GLOBAL || !DISCORD_GUILD_ID) {
      const putGlobal = await rest.put(Routes.applicationCommands(applicationId), { body: commandsJSON });
      console.log(`🌍 Global-registered ${putGlobal.length} command(s)`);
      if (!DISCORD_GUILD_ID) console.log('   (No DISCORD_GUILD_ID set; only global registration performed)');
      else console.log('   (Global used alongside guild; global may propagate slowly)');
    }

    // Verify by reading back
    const [guildCmds, globalCmds] = await Promise.all([
      DISCORD_GUILD_ID ? rest.get(Routes.applicationGuildCommands(applicationId, DISCORD_GUILD_ID)) : Promise.resolve([]),
      rest.get(Routes.applicationCommands(applicationId)),
    ]);
    console.log('🔎 Guild commands:', DISCORD_GUILD_ID ? guildCmds.map((c) => c.name) : []);
    console.log('🔎 Global commands:', globalCmds.map((c) => c.name));
    console.log('👉 Type "/" in the target guild; if missing, Ctrl+R to reload Discord client.');

    // Start cron service for automated updates
    try {
      cronService = new CronService(client);
      client.cronService = cronService; // Make it accessible to commands
      cronService.start();
      console.log('⏰ Automated update cron job started');
    } catch (error) {
      console.error('❌ Failed to start cron service:', error);
      // Continue without cron service rather than crashing
    }
  } catch (err) {
    console.error('❌ Registration error:', err);
  }
});

// Extra client-level guards for stability
try {
  client.on('error', (err) => console.error('Discord client error:', err));
  client.on('warn', (msg) => console.warn('Discord client warn:', msg));
  client.on('shardError', (error) => console.error('A websocket connection encountered an error:', error));
  client.on('invalidated', () => console.error('Discord client session invalidated.')); 
} catch (_) {}

// ---- Welcome new members ----
client.on(Events.GuildMemberAdd, async (member) => {
  try {
    // Skip bots
    if (member.user?.bot) return;

    // Try the configured welcome channel first
    let channel = null;
    if (WELCOME_CHANNEL_ID) {
      try {
        channel = await member.client.channels.fetch(WELCOME_CHANNEL_ID);
      } catch (e) {
        console.warn(`⚠️ Could not fetch WELCOME_CHANNEL_ID=${WELCOME_CHANNEL_ID}:`, e?.message ?? e);
      }
    }

    // Fallback to system channel if configured one not available
    if (!channel || !channel.isTextBased?.()) {
      channel = member.guild?.systemChannel ?? null;
    }

    if (!channel || !channel.isTextBased?.()) {
      console.warn('⚠️ No suitable welcome channel found (check permissions & WELCOME_CHANNEL_ID).');
      return;
    }

    const msg =
      `👋 Welcome <@${member.id}> to the **Democratic Party** server!\n\n` +
      `To access the server channels, please run **\`!verifyparty\`** in the verification channel.\n` +
      `If you need help, ping chair/deputy chair or a member of the national committee. `;

    await channel.send({ content: msg });
    console.log(`✅ Sent welcome for ${member.user?.tag ?? member.id}`);
  } catch (err) {
    console.error('❌ Failed to send welcome message:', err);
  }
});

// ---- Button interaction handlers ----
async function handleButtonInteraction(interaction) {
  const parts = interaction.customId.split('_');
  const primary = parts[0];

  // Multi-profile pagination takes precedence: custom_id = profile_multi_{action}_{page}_{ids}
  if (primary === 'profile' && parts[1] === 'multi') {
    const action = parts[2];
    const currentPage = parts[3];
    const idsJoined = parts.slice(4).join('_');
    const nextPage = action === 'next' ? parseInt(currentPage) + 1 :
                     action === 'prev' ? parseInt(currentPage) - 1 :
                     parseInt(currentPage);
    const profileCommand = client.commands.get('profile');
    if (profileCommand?.showMultipleProfiles) {
      await profileCommand.showMultipleProfiles(interaction, idsJoined, nextPage);
    }
    return;
  }

  // All-profiles pagination: custom_id = profile_{action}_{page}_{sortBy}
  if (primary === 'profile') {
    const action = parts[1];
    const currentPage = parts[2];
    const sortBy = parts[3];
    const page = action === 'next' ? parseInt(currentPage) + 1 :
                 action === 'prev' ? parseInt(currentPage) - 1 :
                 parseInt(currentPage);
    const profileCommand = client.commands.get('profile');
    if (profileCommand?.showAllProfiles) await profileCommand.showAllProfiles(interaction, page, sortBy);
    return;
  }
}

// ---- Interaction routing ----
client.on(Events.InteractionCreate, async (interaction) => {
  // Handle button interactions for pagination
  if (interaction.isButton()) {
    return handleButtonInteraction(interaction);
  }

  if (!interaction.isChatInputCommand()) return;

  // DM gating (why: prevent misuse in DMs)
  // Allow commands in the hardcoded allowed server or for bypass users
  const isInAllowedServer = interaction.inGuild() && interaction.guild.id === ALLOWED_SERVER_ID;
  const isBypassUser = interaction.user.id === '1430928325890670623';

  if (!interaction.inGuild()) {
    if (interaction.user.id !== ALLOWED_DM_USER && !isBypassUser) {
      return interaction.reply({
        content: '🚫 Commands are server-only for most users.',
        ephemeral: true,
      });
    }
  } else if (isInAllowedServer || isBypassUser) {
    // Commands are allowed in the allowed server or for bypass users, no additional restrictions
  }

  const cmd = client.commands.get(interaction.commandName);
  if (!cmd) return;

  // Track user command usage
  const userId = interaction.user.id;
  const username = interaction.user.username || interaction.user.displayName || 'Unknown';
  recordUserCommand(userId, username, interaction.commandName);

  try {
    await cmd.execute(interaction);
    if (interaction._dembotHandledError) return;
    if (!interaction.deferred && !interaction.replied) {
      console.warn(`Command ${interaction.commandName} returned without responding (maybe interaction expired).`);
      recordCommandError(interaction.commandName, new Error('No response sent'));
      return;
    }
    recordCommandSuccess(interaction.commandName);
  } catch (err) {
    // Determine if this error should trigger a command reset
    const shouldReset = shouldResetCommand(err, interaction);
    
    // Use enhanced error reporting with reset capability
    await reportCommandErrorWithReset(interaction, err, {
      message: 'There was an error executing that command.',
      shouldReset,
      retryDelay: 2000,
      meta: {
        commandName: interaction.commandName,
        userId: interaction.user?.id,
        guildId: interaction.guildId,
      }
    });
    
    console.error(`Command ${interaction.commandName} error:`, err);
  }
});

client.login(DISCORD_TOKEN).catch((err) => {
  markBotLoginError(err);
  console.error('Client login failed:', err);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Received SIGINT, shutting down gracefully...');
  if (cronService) {
    cronService.stop();
    console.log('⏹️ Cron service stopped');
  }
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
  if (cronService) {
    cronService.stop();
    console.log('⏹️ Cron service stopped');
  }
  client.destroy();
  process.exit(0);
});
/**
 * Project: DemBot (Discord automation for Power Play USA)
 * File: index.js
 * Purpose: Bot bootstrap, command loading/registration, and interaction routing
 * Author: egg3901
 * Created: 2025-10-16
 * Last Updated: 2025-10-18
 * Notes:
 *   - Reads slash-command modules from ./commands and registers them (guild/global).
 *   - Uses environment variables from .env (see README or .env for details).
 *   - Welcomes new members in WELCOME_CHANNEL_ID (or system channel) with !verifyparty instructions.
 */
