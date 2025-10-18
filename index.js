// File: index.js
require('dotenv').config();
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
} = require('./lib/status-tracker');
const { startDashboardServer } = require('./lib/dashboard-server');

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

if (!DISCORD_TOKEN) {
  console.error('❌ Missing DISCORD_TOKEN in .env');
  process.exit(1);
}

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

// Periodic heartbeat (keeps dashboard status fresh even without command traffic)
setInterval(() => markHeartbeat(), 60_000).unref();

// ---- Load commands ----
const commandsPath = path.join(__dirname, 'commands');
if (!fs.existsSync(commandsPath)) {
  console.warn(`⚠️ Commands folder not found: ${commandsPath}`);
} else {
  const files = fs.readdirSync(commandsPath).filter((f) => f.endsWith('.js'));
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
startDashboardServer({ port: DASHBOARD_PORT, host: DASHBOARD_HOST });

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
  } catch (err) {
    console.error('❌ Registration error:', err);
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

  try {
    await cmd.execute(interaction);
    if (interaction._dembotHandledError) return;
    if (!interaction.deferred && !interaction.replied) {
      console.warn(`Command ${interaction.commandName} returned without responding (maybe interaction expired).`);
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
/**
 * Project: DemBot (Discord automation for Power Play USA)
 * File: index.js
 * Purpose: Bot bootstrap, command loading/registration, and interaction routing
 * Author: egg3901
 * Created: 2025-10-16
 * Last Updated: 2025-10-16
 * Notes:
 *   - Reads slash-command modules from ./commands and registers them (guild/global).
 *   - Uses environment variables from .env (see README or .env for details).
 */
