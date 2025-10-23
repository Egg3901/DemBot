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
const { startDashboardServer } = require('./lib/dashboard-server');
const CronService = require('./lib/cron-service');

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
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || process.env.GUILD_ID; // supports both
const REGISTER_GLOBAL = String(process.env.REGISTER_GLOBAL).toLowerCase() === 'true';
const ALLOWED_DM_USER = process.env.ALLOWED_DM_USER || '333052320252297216';
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
    cronService = new CronService(client);
    client.cronService = cronService; // Make it accessible to commands
    cronService.start();
    console.log('⏰ Automated update cron job started');
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

// ---- Interaction routing ----
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // DM gating (why: prevent misuse in DMs)
  if (!interaction.inGuild()) {
    if (interaction.user.id !== ALLOWED_DM_USER) {
      return interaction.reply({
        content: '🚫 Commands are server-only for most users.',
        ephemeral: true,
      });
    }
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
    recordCommandError(interaction.commandName, err);
    console.error(err);
    const msg = { content: 'There was an error executing that command.', flags: MessageFlags.Ephemeral };
    try {
      if (interaction.deferred || interaction.replied) await interaction.followUp(msg);
      else await interaction.reply(msg);
    } catch (sendErr) {
      if (sendErr?.code === 10062) {
        console.warn('Skipped error follow-up: interaction token expired.');
      } else {
        console.error('Failed to notify user about the error:', sendErr);
      }
    }
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
