// File: index.js
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
  sampleRuntime,
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
// Welcome channel: prefer .env WELCOME_CHANNEL_ID, fallback to provided channel id
const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID || '1257518076123939017';

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
// Runtime metrics sampling (cpu/memory/load)
setInterval(() => sampleRuntime(), 60_000).unref();

// ---- Comprehensive Error Handling ----
let crashCount = 0;
const MAX_CRASHES = 5;
const CRASH_RESET_TIME = 300000; // 5 minutes

function logCrash(type, error, context = {}) {
  crashCount++;
  const timestamp = new Date().toISOString();
  const memoryUsage = process.memoryUsage();
  
  console.error(`\n🚨 CRASH DETECTED [${type}] #${crashCount}`);
  console.error(`⏰ Time: ${timestamp}`);
  console.error(`💾 Memory: RSS=${Math.round(memoryUsage.rss/1024/1024)}MB, Heap=${Math.round(memoryUsage.heapUsed/1024/1024)}MB`);
  console.error(`🔍 Error: ${error?.message || String(error)}`);
  console.error(`📊 Stack: ${error?.stack || 'No stack trace'}`);
  
  if (Object.keys(context).length > 0) {
    console.error(`📝 Context: ${JSON.stringify(context, null, 2)}`);
  }
  
  // Record crash in status tracker
  try {
    recordCommandError('SYSTEM_CRASH', error, { type, context, crashCount, timestamp });
  } catch (trackerErr) {
    console.error('Failed to record crash in tracker:', trackerErr);
  }
  
  // Reset crash count after timeout
  if (crashCount >= MAX_CRASHES) {
    console.error(`\n💀 MAXIMUM CRASHES (${MAX_CRASHES}) REACHED - BOT WILL EXIT`);
    setTimeout(() => {
      console.error('🔄 Resetting crash counter...');
      crashCount = 0;
    }, CRASH_RESET_TIME);
  }
}

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logCrash('UNCAUGHT_EXCEPTION', error, { 
    pid: process.pid,
    uptime: process.uptime(),
    argv: process.argv.slice(0, 3) // Don't log full args for security
  });
  
  if (crashCount >= MAX_CRASHES) {
    console.error('💀 Too many crashes, exiting...');
    process.exit(1);
  }
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logCrash('UNHANDLED_REJECTION', reason, { 
    promise: promise.toString(),
    pid: process.pid,
    uptime: process.uptime()
  });
  
  if (crashCount >= MAX_CRASHES) {
    console.error('💀 Too many crashes, exiting...');
    process.exit(1);
  }
});

// Monitor for memory leaks
let lastMemoryCheck = Date.now();
setInterval(() => {
  const now = Date.now();
  const memUsage = process.memoryUsage();
  const rssMB = Math.round(memUsage.rss / 1024 / 1024);
  const heapMB = Math.round(memUsage.heapUsed / 1024 / 1024);
  
  // Alert if memory usage is excessive
  if (rssMB > 1000) { // 1GB
    console.warn(`⚠️ High memory usage: RSS=${rssMB}MB, Heap=${heapMB}MB`);
  }
  
  // Check for memory leaks (growing heap over time)
  if (now - lastMemoryCheck > 300000) { // Every 5 minutes
    if (heapMB > 500) { // 500MB heap
      console.warn(`🔍 Memory check: Heap=${heapMB}MB (potential leak?)`);
    }
    lastMemoryCheck = now;
  }
}, 60000).unref(); // Check every minute

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

  const startTime = Date.now();
  const commandName = interaction.commandName;
  const userId = interaction.user?.id;
  const guildId = interaction.guild?.id;

  // Enhanced logging for command execution
  console.log(`🎯 Command: /${commandName} by ${userId} in ${guildId || 'DM'}`);

  // DM gating (why: prevent misuse in DMs)
  if (!interaction.inGuild()) {
    if (interaction.user.id !== ALLOWED_DM_USER) {
      return interaction.reply({
        content: '🚫 Commands are server-only for most users.',
        ephemeral: true,
      });
    }
  }

  const cmd = client.commands.get(commandName);
  if (!cmd) {
    console.warn(`❌ Unknown command: ${commandName}`);
    return interaction.reply({
      content: `Unknown command: \`/${commandName}\`. Use \`/help\` to see available commands.`,
      ephemeral: true,
    });
  }

  try {
    // Execute command with timeout protection
    const executionPromise = cmd.execute(interaction);
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Command execution timeout (30s)')), 30000)
    );
    
    await Promise.race([executionPromise, timeoutPromise]);
    
    const duration = Date.now() - startTime;
    console.log(`✅ Command /${commandName} completed in ${duration}ms`);
    
    if (interaction._dembotHandledError) return;
    if (!interaction.deferred && !interaction.replied) {
      console.warn(`⚠️ Command ${commandName} returned without responding (maybe interaction expired).`);
      recordCommandError(commandName, new Error('No response sent'), { 
        duration, 
        userId, 
        guildId,
        timeout: false 
      });
      return;
    }
    recordCommandSuccess(commandName);
  } catch (err) {
    const duration = Date.now() - startTime;
    const isTimeout = err.message.includes('timeout');
    
    console.error(`❌ Command /${commandName} failed after ${duration}ms:`, err.message);
    console.error(`📊 Stack trace:`, err.stack);
    
    recordCommandError(commandName, err, { 
      duration, 
      userId, 
      guildId,
      timeout: isTimeout,
      interactionType: interaction.type,
      channelId: interaction.channel?.id
    });
    
    // Enhanced error message based on error type
    let errorMessage = 'There was an error executing that command.';
    if (isTimeout) {
      errorMessage = 'Command timed out. Please try again with a simpler request.';
    } else if (err.message.includes('Missing') || err.message.includes('Invalid')) {
      errorMessage = `Error: ${err.message}`;
    } else if (err.message.includes('permission') || err.message.includes('access')) {
      errorMessage = 'You do not have permission to use this command.';
    }
    
    const msg = { 
      content: errorMessage, 
      flags: MessageFlags.Ephemeral 
    };
    
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(msg);
      } else {
        await interaction.reply(msg);
      }
    } catch (sendErr) {
      if (sendErr?.code === 10062) {
        console.warn('⚠️ Skipped error follow-up: interaction token expired.');
      } else if (sendErr?.code === 50013) {
        console.warn('⚠️ Missing permissions to send error message.');
      } else {
        console.error('❌ Failed to notify user about the error:', sendErr);
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
 * Last Updated: 2025-10-18
 * Notes:
 *   - Reads slash-command modules from ./commands and registers them (guild/global).
 *   - Uses environment variables from .env (see README or .env for details).
 *   - Welcomes new members in WELCOME_CHANNEL_ID (or system channel) with !verifyparty instructions.
 */
