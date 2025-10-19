// commands/update.js
const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');
const { loginAndGet, parseProfile, BASE } = require('../lib/ppusa');
const { canManageBot } = require('../lib/permissions');
const { ensureDbShape, mergeProfileRecord } = require('../lib/profile-cache');

// Inactive (offline) role and threshold (days)
const INACTIVE_ROLE_ID = '1427236595345522708';
const OFFLINE_THRESHOLD_DAYS = 4;
const WARNING_THRESHOLD_DAYS = 3;

async function performRoleSync({ interaction, guild, db, clearRoles = false, useFollowUpForStatus = false }) {
  const profiles = db.profiles || {};
  if (!profiles || Object.keys(profiles).length === 0) {
    const msg = 'profiles.json is empty. Run /update (without roles) first to build the cache.';
    if (useFollowUpForStatus) await interaction.followUp(msg);
    else await interaction.editReply(msg);
    return;
  }

  const ROLE_IDS = {
    gov: '1406063203313782865',
    sen: '1406063162306072607',
    rep: '1406063176281358337',
    cabinet: '1429342639907668048',
  };
  const ROLE_NAMES = { gov: 'Governor', sen: 'Senator', rep: 'Representative', cabinet: 'Cabinet' };

  const REGION_ROLE_IDS = {
    west: '1408854788472573952',
    south: '1408854801202155520',
    northeast: '1408854812597944330',
    rust_belt: '1408854830486913157',
  };
  const REGION_NAMES = { west: 'West', south: 'South', northeast: 'Northeast', rust_belt: 'Rust Belt' };

  const updateStatus = async (message) => {
    if (useFollowUpForStatus) await interaction.followUp(message);
    else await interaction.editReply(message);
  };

  const me = await guild.members.fetchMe();
  if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    await updateStatus('Bot lacks Manage Roles permission to apply roles.');
    return;
  }

  await guild.members.fetch();
  await guild.roles.fetch();

  if (clearRoles) {
    const targets = Array.from(new Set([
      ...Object.values(ROLE_IDS).filter(Boolean),
      ...Object.values(REGION_ROLE_IDS).filter(Boolean),
    ]));
    await updateStatus('Clearing managed office and region roles...');
    let cleared = 0;
    let membersTouched = 0;
    for (const member of guild.members.cache.values()) {
      let memberCleared = 0;
      for (const rid of targets) {
        if (member.roles.cache.has(rid)) {
          try {
            await member.roles.remove(rid, 'Clear managed roles via /update clear');
            cleared++;
            memberCleared++;
          } catch (_) {}
        }
      }
      if (memberCleared > 0) membersTouched++;
    }
    await interaction.followUp(`Cleared ${cleared} managed roles across ${membersTouched} members.`);
    return;
  }

  const changeLogs = [];
  const partialOfflineWarnings = [];
  const offlineProfilesOver3 = [];
  const profileOfflineMap = new Map();

  const groups = new Map();
  for (const p of Object.values(profiles)) {
    const handle = (p.discord || '').toLowerCase();
    if (!handle) continue;
    let g = groups.get(handle);
    if (!g) {
      g = {
        ids: [],
        handle,
        office: new Set(),
        anyDem: false,
        anyGop: false,
        regions: new Set(),
        lastOnlineDays: null,
        lastOnlineText: null,
        offlineDetails: [],
      };
      groups.set(handle, g);
    }
    g.ids.push(p.id);
    if (/Democratic/i.test(p.party || '')) {
      g.anyDem = true;
      if (Array.isArray(p.rolesNeeded)) p.rolesNeeded.forEach((r) => g.office.add(r));
    }
    if (/Republican/i.test(p.party || '')) {
      g.anyGop = true;
    }
    if (p.region) g.regions.add(p.region);
    const los = typeof p.lastOnlineDays === 'number' ? p.lastOnlineDays : null;
    if (los !== null) {
      if (g.lastOnlineDays === null || los < g.lastOnlineDays) {
        g.lastOnlineDays = los;
        g.lastOnlineText = p.lastOnlineText || null;
      }
      g.offlineDetails.push({
        id: p.id,
        name: p.name || null,
        lastOnlineDays: los,
        lastOnlineText: p.lastOnlineText || null,
      });
      if (los > WARNING_THRESHOLD_DAYS) {
        profileOfflineMap.set(p.id, {
          id: p.id,
          name: p.name || null,
          days: los,
          text: p.lastOnlineText || null,
          handle,
        });
      }
    }
  }

  const rolesStart = Date.now();
  let applied = 0;
  let removed = 0;
  let skipped = 0;
  let matched = 0;

  for (const g of groups.values()) {
    const member = guild.members.cache.find((m) =>
      (m.user?.username?.toLowerCase?.() === g.handle) ||
      (m.displayName?.toLowerCase?.() === g.handle) ||
      (m.user?.globalName?.toLowerCase?.() === g.handle)
    );
    if (!member) {
      g.offlineDetails.forEach((d) => {
        const entry = profileOfflineMap.get(d.id);
        if (entry) offlineProfilesOver3.push(entry);
      });
      skipped++;
      continue;
    }
    matched++;

    if (g.anyGop) {
      for (const [key, roleId] of Object.entries(ROLE_IDS)) {
        if (member.roles.cache.has(roleId)) {
          try {
            await member.roles.remove(roleId, 'Republican profile present - remove managed office roles');
            removed++;
            changeLogs.push(`- ${ROLE_NAMES[key]} -> ${member.user?.tag || member.displayName} (profiles ${g.ids.join(',')}) [reason: Republican profile present]`);
          } catch (_) {}
        }
      }
      for (const [rk, rid] of Object.entries(REGION_ROLE_IDS)) {
        if (member.roles.cache.has(rid)) {
          try {
            await member.roles.remove(rid, 'Republican profile present - remove region roles');
            removed++;
            changeLogs.push(`- ${REGION_NAMES[rk]} Region -> ${member.user?.tag || member.displayName} (profiles ${g.ids.join(',')}) [reason: Republican profile present]`);
          } catch (_) {}
        }
      }
    } else {
      const desiredOffice = g.anyDem ? new Set(g.office) : new Set();
      for (const key of desiredOffice) {
        const roleId = ROLE_IDS[key];
        if (!roleId) continue;
        if (!member.roles.cache.has(roleId)) {
          try {
            await member.roles.add(roleId, 'Auto-assign via /update roles');
            applied++;
            changeLogs.push(`+ ${ROLE_NAMES[key]} -> ${member.user?.tag || member.displayName} (profiles ${g.ids.join(',')}) [reason: Democratic office requirement]`);
          } catch (_) {}
        }
      }
      for (const [key, roleId] of Object.entries(ROLE_IDS)) {
        if (member.roles.cache.has(roleId) && !desiredOffice.has(key)) {
          try {
            await member.roles.remove(roleId, 'Auto-remove via /update roles (not needed by any profile)');
            removed++;
            changeLogs.push(`- ${ROLE_NAMES[key]} -> ${member.user?.tag || member.displayName} (profiles ${g.ids.join(',')}) [reason: not needed by any profile]`);
          } catch (_) {}
        }
      }

      const desiredRegions = new Set(g.regions);
      for (const rk of desiredRegions) {
        const rid = REGION_ROLE_IDS[rk];
        if (rid && !member.roles.cache.has(rid)) {
          try {
            await member.roles.add(rid, 'Auto-assign region via /update roles');
            applied++;
            changeLogs.push(`+ ${REGION_NAMES[rk]} Region -> ${member.user?.tag || member.displayName} (profiles ${g.ids.join(',')}) [reason: profile region list includes ${rk}]`);
          } catch (_) {}
        }
      }
      for (const [rk, rid] of Object.entries(REGION_ROLE_IDS)) {
        if (member.roles.cache.has(rid) && !desiredRegions.has(rk)) {
          try {
            await member.roles.remove(rid, 'Auto-remove via /update roles (not needed by any profile)');
            removed++;
            changeLogs.push(`- ${REGION_NAMES[rk]} Region -> ${member.user?.tag || member.displayName} (profiles ${g.ids.join(',')}) [reason: not needed by any profile]`);
          } catch (_) {}
        }
      }
    }

    const offlineDetails = g.offlineDetails;
    const totalWithData = offlineDetails.length;
    const over4 = offlineDetails.filter((d) => d.lastOnlineDays > OFFLINE_THRESHOLD_DAYS);
    const hasActivityData = totalWithData > 0;
    const allOver4 = totalWithData > 0 && over4.length === totalWithData;
    const someOver4 = over4.length > 0 && !allOver4;
    const over3 = offlineDetails.filter((d) => d.lastOnlineDays > WARNING_THRESHOLD_DAYS);
    over3.forEach((d) => {
      const entry = profileOfflineMap.get(d.id);
      if (entry) offlineProfilesOver3.push(entry);
    });

    if (someOver4) {
      partialOfflineWarnings.push({
        member: member.user?.tag || member.displayName,
        ids: over4.map((d) => d.id),
        total: totalWithData,
        count: over4.length,
      });
    }

    if (INACTIVE_ROLE_ID) {
      const hasInactive = member.roles.cache.has(INACTIVE_ROLE_ID);
      const shouldBeInactive = g.anyDem && allOver4;
      if (shouldBeInactive && !hasInactive) {
        const referenceDetail = over4[0] || offlineDetails[0];
        const reason = referenceDetail?.lastOnlineText
          ? `Last online ${referenceDetail.lastOnlineText}`
          : referenceDetail?.lastOnlineDays != null
            ? `Last online ${referenceDetail.lastOnlineDays} day(s) ago`
            : 'Last online status unknown';
        try {
          await member.roles.add(INACTIVE_ROLE_ID, 'Auto-assign inactivity role via /update roles');
          applied++;
          changeLogs.push(`+ Inactive -> ${member.user?.tag || member.displayName} (profiles ${g.ids.join(',')}) [reason: ${reason}]`);
        } catch (_) {}
      } else if ((!shouldBeInactive && hasInactive) || (!hasActivityData && hasInactive)) {
        try {
          await member.roles.remove(INACTIVE_ROLE_ID, 'Auto-remove inactivity role via /update roles');
          removed++;
          changeLogs.push(`- Inactive -> ${member.user?.tag || member.displayName} (profiles ${g.ids.join(',')}) [reason: recent activity detected]`);
        } catch (_) {}
      }
    }
  }

  const rolesSecs = Math.round((Date.now() - rolesStart) / 1000);
  const summary = `Role update completed in ${rolesSecs}s. Matched ${matched}, applied ${applied}, removed ${removed}, skipped ${skipped}.`;
  await interaction.followUp(summary);
  if (changeLogs.length) {
    const chunks = [];
    let buffer = [];
    let length = 0;
    for (const line of changeLogs) {
      const ln = line.length + 1;
      if (length + ln > 1800) {
        chunks.push(buffer.join('\n'));
        buffer = [];
        length = 0;
      }
      buffer.push(line);
      length += ln;
    }
    if (buffer.length) chunks.push(buffer.join('\n'));
    for (const chunk of chunks) {
      await interaction.followUp('```\n' + chunk + '\n```');
    }
  }

  const warningLines = [];
  if (partialOfflineWarnings.length) {
    partialOfflineWarnings.slice(0, 30).forEach((w) => {
      warningLines.push(`Partial inactivity: ${w.member} has ${w.count}/${w.total} linked profiles offline >${OFFLINE_THRESHOLD_DAYS} days (IDs: ${w.ids.join(', ')})`);
    });
    if (partialOfflineWarnings.length > 30) {
      warningLines.push(`...and ${partialOfflineWarnings.length - 30} more partial inactivity warnings.`);
    }
  }
  if (offlineProfilesOver3.length) {
    const uniqueOver3 = new Map();
    offlineProfilesOver3.forEach((entry) => {
      if (!uniqueOver3.has(entry.id)) uniqueOver3.set(entry.id, entry);
    });
    Array.from(uniqueOver3.values()).slice(0, 40).forEach((entry) => {
      warningLines.push(`Profile offline >${WARNING_THRESHOLD_DAYS} days: ${entry.name || `ID ${entry.id}`} (ID ${entry.id}) - ${entry.text || `${entry.days} days ago`}`);
    });
    if (uniqueOver3.size > 40) {
      warningLines.push(`...and ${uniqueOver3.size - 40} more offline profile warnings.`);
    }
  }
  if (warningLines.length) {
    const chunked = [];
    let bucket = [];
    let len = 0;
    for (const line of warningLines) {
      const addition = line.length + 1;
      if (len + addition > 1800) {
        chunked.push(bucket.join('\n'));
        bucket = [];
        len = 0;
      }
      bucket.push(line);
      len += addition;
    }
    if (bucket.length) chunked.push(bucket.join('\n'));
    for (const chunk of chunked) {
      await interaction.followUp(`Warnings:\n${chunk}`);
    }
  }
}

const MAX_CONSECUTIVE_MISSES = 20;
const DEFAULT_MAX_ID = Number(process.env.PPUSA_MAX_USER_ID || '0');
const DEFAULT_START_ID = Number(process.env.PPUSA_START_USER_ID || '1000');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('update')
    .setDescription('Crawl player profiles (id 1..max) and update profiles.json')
    .addBooleanOption(opt =>
      opt
        .setName('roles')
        .setDescription('After update, apply needed roles to matching server members')
        .setRequired(false)
    )
    .addBooleanOption(opt =>
      opt
        .setName('clear')
        .setDescription('When used with roles, remove all managed office and region roles')
        .setRequired(false)
    ),

  /**
   * Execute the /update command.
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @returns {Promise<void>}
   */
  async execute(interaction) {
    await interaction.deferReply();

    const applyRoles = interaction.options.getBoolean('roles') || false;
    const clearRoles = interaction.options.getBoolean('clear') || false;
    const inGuild = interaction.inGuild();

    if (!(await canManageBot(interaction))) {
      return interaction.editReply('You do not have permission to use /update.');
    }

    if (!inGuild && applyRoles) {
      return interaction.editReply('Role syncing must be run from within the server.');
    }

    if (clearRoles && !applyRoles) {
      return interaction.editReply('Use the clear option alongside roles=true.');
    }

    const dataDir = path.join(process.cwd(), 'data');
    const jsonPath = path.join(dataDir, 'profiles.json');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    let db = { updatedAt: new Date().toISOString(), profiles: {}, byDiscord: {} };
    if (fs.existsSync(jsonPath)) {
      try {
        db = ensureDbShape(JSON.parse(fs.readFileSync(jsonPath, 'utf8')));
      } catch {
        db = { updatedAt: new Date().toISOString(), profiles: {}, byDiscord: {} };
      }
    }
    db = ensureDbShape(db);
    if (!db.updatedAt) db.updatedAt = new Date().toISOString();

    // Ensure a file exists immediately so users can see it while crawling
    const writeDb = () => {
      const payload = { ...ensureDbShape(db), updatedAt: new Date().toISOString() };
      fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
    };
    if (!fs.existsSync(jsonPath)) writeDb();

    const start = Date.now();
    let found = 0;
    let checked = 0;
    let misses = 0;
    let lastProgressAt = Date.now();
    const scrapeOfflineWarnings = [];


    // Roles-only mode: do not scrape, only apply roles from existing JSON
    if (applyRoles) {
      const guild = interaction.guild;
      if (!guild) {
        return interaction.editReply('Roles option requested, but command not run in a guild.');
      }

      await interaction.editReply('Syncing roles from profiles.json...');
      await performRoleSync({ interaction, guild, db, clearRoles, useFollowUpForStatus: false });
      return;
    }

    // Scrape mode (no roles), build/update profiles.json
    let browser, page;
    try {
      // login once
      const startId = DEFAULT_START_ID > 0 ? DEFAULT_START_ID : 1;
      const sess = await loginAndGet(`${BASE}/users/${startId}`);
      browser = sess.browser;
      page = sess.page;

      const maxId = DEFAULT_MAX_ID > 0 ? DEFAULT_MAX_ID : 10000; // upper bound if unknown
      for (let id = startId; id <= maxId; id++) {
        checked++;
        const url = `${BASE}/users/${id}`;
        const resp = await page.goto(url, { waitUntil: 'networkidle2' }).catch(() => null);
        const status = resp?.status?.() ?? 200;
        const finalUrl = page.url();
        const html = await page.content();
        const info = parseProfile(html);
        // Consider a miss when the request errors, or we land on a non-user page, or no name parsed
        const isUserUrl = /\/users\//i.test(finalUrl);
        const isMiss = (status >= 400) || !isUserUrl || !info?.name;
        if (isMiss) {
          misses++;
          if (misses >= MAX_CONSECUTIVE_MISSES && DEFAULT_MAX_ID === 0) break;
          continue;
        }
        misses = 0;

        mergeProfileRecord(db, id, info);
        const los = typeof info.lastOnlineDays === "number" ? info.lastOnlineDays : null;
        if (los !== null && los > WARNING_THRESHOLD_DAYS) {
          scrapeOfflineWarnings.push({
            id,
            name: info.name || null,
            days: los,
            text: info.lastOnlineText || null,
          });
        }
        found++;

        // Flush early: on first find, then every 25 finds, or every 300 checks, or every 10s
        const now = Date.now();
        if (found === 1 || (found % 25 === 0) || (checked % 300 === 0) || (now - lastProgressAt > 10_000)) {
          writeDb();
          lastProgressAt = now;
          await interaction.editReply(`Updating profiles... checked ${checked}, found ${found}. Latest: ${info.name} (id ${id})`);
        }
      }

      writeDb();
      // Save a timestamped backup
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(dataDir, `profiles.${stamp}.json`);
      try { fs.writeFileSync(backupPath, JSON.stringify(db, null, 2)); } catch {}
      const secs = Math.round((Date.now() - start) / 1000);
      await interaction.editReply(`Updated profiles.json. Checked ${checked}, found ${found}. Time: ${secs}s.`);

      if (scrapeOfflineWarnings.length) {
        const lines = [];
        scrapeOfflineWarnings.slice(0, 50).forEach((entry) => {
          lines.push(`Profile offline >${WARNING_THRESHOLD_DAYS} days: ${entry.name || `ID ${entry.id}`} (ID ${entry.id}) - ${entry.text || `${entry.days} days ago`}`);
        });
        if (scrapeOfflineWarnings.length > 50) {
          lines.push(`...and ${scrapeOfflineWarnings.length - 50} more offline profile warnings.`);
        }
        const chunked = [];
        let bucket = [];
        let len = 0;
        for (const line of lines) {
          const addition = line.length + 1;
          if (len + addition > 1800) {
            chunked.push(bucket.join("\n"));
            bucket = [];
            len = 0;
          }
          bucket.push(line);
          len += addition;
        }
        if (bucket.length) chunked.push(bucket.join("\n"));
        for (const chunk of chunked) {
          await interaction.followUp(`Warnings:\n${chunk}`);
        }
      }

      if (applyRoles) {
        const guild = interaction.guild;
        if (!guild) {
          await interaction.followUp({ content: 'Roles option requested, but command not run in a guild.', ephemeral: true });
          return;
        }

        await performRoleSync({ interaction, guild, db, clearRoles, useFollowUpForStatus: true });
      }

    } catch (err) {
      try { await interaction.editReply(`Error during update: ${err?.message || String(err)}`); } catch {}
    } finally {
      try { await browser?.close(); } catch {}
    }
  },
};
/**
 * Project: DemBot (Discord automation for Power Play USA)
 * File: commands/update.js
 * Purpose: Crawl player profiles and persist a local cache for fast lookup
 * Author: egg3901
 * Created: 2025-10-16
 * Last Updated: 2025-10-16
 *
 * Behavior:
 *   - Logs in once (using PPUSA_EMAIL / PPUSA_PASSWORD) and iterates user ids.
 *   - Starts at PPUSA_START_USER_ID (default 1000). Stops at PPUSA_MAX_USER_ID if set.
 *   - Early-stop when 20 consecutive non-profile pages are encountered.
 *   - Persists to data/profiles.json and writes a timestamped backup when finished.
 */


















