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

    // Roles-only mode: do not scrape, only apply roles from existing JSON
    if (applyRoles) {
      const profiles = db.profiles || {};
      if (!profiles || Object.keys(profiles).length === 0) {
        return interaction.editReply('profiles.json is empty. Run /update (without roles) first to build the cache.');
      }

      const guild = interaction.guild;
      if (!guild) {
        return interaction.editReply('Roles option requested, but command not run in a guild.');
      }

      // Role IDs mapping
      const ROLE_IDS = {
        gov: '1406063203313782865',
        sen: '1406063162306072607',
        rep: '1406063176281358337',
        cabinet: '1429342639907668048',
      };
      const ROLE_NAMES = { gov: 'Governor', sen: 'Senator', rep: 'Representative', cabinet: 'Cabinet' };

      // Region role IDs mapping
      const REGION_ROLE_IDS = {
        west: '1408854788472573952',
        south: '1408854801202155520',
        northeast: '1408854812597944330',
        rust_belt: '1408854830486913157',
      };
      const REGION_NAMES = { west: 'West', south: 'South', northeast: 'Northeast', rust_belt: 'Rust Belt' };

      // Ensure we can manage roles
      const me = await guild.members.fetchMe();
      if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
        return interaction.editReply('Bot lacks Manage Roles permission to apply roles.');
      }

      await interaction.editReply('Syncing roles from profiles.json...');
      const rolesStart = Date.now();
      try {
        await guild.members.fetch();
      } catch (err) {
        return interaction.followUp({
          content: `Unable to fetch guild members. Ensure the bot has the Guild Members intent enabled in the Discord Developer Portal and that this intent is granted in code. Error: ${err?.message || err}`,
          ephemeral: true,
        });
      }
      try {
        await guild.roles.fetch();
      } catch (err) {
        return interaction.followUp({
          content: `Unable to fetch guild roles. Ensure the bot can view roles. Error: ${err?.message || err}`,
          ephemeral: true,
        });
      }
      if (clearRoles) {
        const officeRoleIds = Object.values(ROLE_IDS).filter(Boolean);
        const regionRoleIdsList = Object.values(REGION_ROLE_IDS).filter(Boolean);
        const targets = Array.from(new Set([...officeRoleIds, ...regionRoleIdsList]));
        await interaction.editReply('Clearing managed office and region roles...');
        let cleared = 0;
        let membersTouched = 0;
        for (const member of guild.members.cache.values()) {
          let memberCleared = 0;
          for (const rid of targets) {
            if (!rid) continue;
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
        const msg = `Cleared ${cleared} managed roles across ${membersTouched} members.`;
        await interaction.followUp(msg);
        return;
      }
      let applied = 0, removed = 0, skipped = 0, matched = 0;
      const changeLogs = [];
      const partialOfflineWarnings = [];
      const offlineProfilesOver3 = [];
      const profileOfflineMap = new Map();
      let processed = 0;
      const inactiveRoleRef = INACTIVE_ROLE_ID ? guild.roles.cache.get(INACTIVE_ROLE_ID) : null;
      const inactiveRoleId = inactiveRoleRef?.id || null;

      // Group profiles by Discord handle and aggregate desired roles/regions
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
          if (Array.isArray(p.rolesNeeded)) p.rolesNeeded.forEach(r => g.office.add(r));
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

      for (const g of groups.values()) {
        const member = guild.members.cache.find(m =>
          (m.user?.username?.toLowerCase?.() === g.handle) ||
          (m.displayName?.toLowerCase?.() === g.handle) ||
          (m.user?.globalName?.toLowerCase?.() === g.handle)
        );
        processed++;
        if (!member) {
          g.offlineDetails.forEach((d) => {
            const entry = profileOfflineMap.get(d.id);
            if (entry) offlineProfilesOver3.push(entry);
          });
          skipped++;
          continue;
        }
        matched++;

        // If any Republican profile exists for this user, skip additions and remove managed roles
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
          // Office roles union across all Dem profiles
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

          // Region roles union across all profiles
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
                await member.roles.remove(rid, 'Auto-remove region via /update roles (not needed by any profile)');
                removed++;
                changeLogs.push(`- ${REGION_NAMES[rk]} Region -> ${member.user?.tag || member.displayName} (profiles ${g.ids.join(',')}) [reason: not needed by any profile]`);
              } catch (_) {}
            }
          }
        }

        // Activity/inactivity role handling (uses all linked profiles)
        if (inactiveRoleId) {
          const hasInactive = member.roles.cache.has(inactiveRoleId);
          const offlineDetails = g.offlineDetails;
          const totalWithData = offlineDetails.length;
          const over4 = offlineDetails.filter((d) => d.lastOnlineDays > OFFLINE_THRESHOLD_DAYS);
          const hasActivityData = totalWithData > 0;
          const allOver4 = totalWithData > 0 && over4.length === totalWithData;
          const someOver4 = over4.length > 0 && !allOver4;
          const over3 = offlineDetails.filter((d) => d.lastOnlineDays > WARNING_THRESHOLD_DAYS);
          over3.forEach((d) => {
            const existing = profileOfflineMap.get(d.id);
            if (existing) offlineProfilesOver3.push(existing);
          });

          if (someOver4) {
            partialOfflineWarnings.push({
              member: member.user?.tag || member.displayName,
              ids: over4.map((d) => d.id),
              total: totalWithData,
              count: over4.length,
            });
          }

          const shouldBeInactive = g.anyDem && allOver4;

          if (shouldBeInactive && !hasInactive) {
            const reason = g.lastOnlineText
              ? `Last online ${g.lastOnlineText}`
              : `Last online ${g.lastOnlineDays} day(s) ago`;
            try {
              await member.roles.add(inactiveRoleId, 'Auto-assign inactivity role via /update roles');
              applied++;
              changeLogs.push(
                `+ Inactive -> ${member.user?.tag || member.displayName} (profiles ${g.ids.join(',')}) [reason: ${reason}]`
              );
            } catch (_) {}
          } else if ((!shouldBeInactive && hasInactive) || (!hasActivityData && hasInactive)) {
            try {
              await member.roles.remove(inactiveRoleId, 'Auto-remove inactivity role via /update roles');
              removed++;
              changeLogs.push(
                `- Inactive -> ${member.user?.tag || member.displayName} (profiles ${g.ids.join(',')}) [reason: recent activity detected]`
              );
            } catch (_) {}
          }
        }

        if (processed % 50 === 0) {
          await interaction.followUp(`Progress: processed ${processed}, matched ${matched}, applied ${applied}, removed ${removed}, skipped ${skipped}...`);
        }
      }

      const rolesSecs = Math.round((Date.now() - rolesStart) / 1000);
      const summary = `Role update completed in ${rolesSecs}s. Matched ${matched}, applied ${applied}, removed ${removed}, skipped ${skipped}.`;
      if (changeLogs.length === 0) {
        await interaction.followUp(summary);
      } else {
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
        await interaction.followUp(summary);
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
          warningLines.push(`Profile offline >${WARNING_THRESHOLD_DAYS} days: ${entry.name || `ID ${entry.id}`} (ID ${entry.id}) — ${entry.text || `${entry.days} days ago`}`);
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

      if (applyRoles) {
        const guild = interaction.guild;
        if (!guild) {
          return interaction.followUp({ content: 'Roles option requested, but command not run in a guild.', ephemeral: true });
        }

        // Role IDs mapping
        const ROLE_IDS = {
          gov: '1406063203313782865',
          sen: '1406063162306072607',
          rep: '1406063176281358337',
          cabinet: '1429342639907668048',
        };
        const ROLE_NAMES = { gov: 'Governor', sen: 'Senator', rep: 'Representative', cabinet: 'Cabinet' };

        // Region role IDs mapping
        const REGION_ROLE_IDS = {
          west: '1408854788472573952',
          south: '1408854801202155520',
          northeast: '1408854812597944330',
          rust_belt: '1408854830486913157',
        };
        const REGION_NAMES = { west: 'West', south: 'South', northeast: 'Northeast', rust_belt: 'Rust Belt' };

        // Ensure we can manage roles
        const me = await guild.members.fetchMe();
        if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
          return interaction.followUp({ content: 'Bot lacks Manage Roles permission to apply roles.', ephemeral: true });
        }

        // Fetch members for matching by username/display name
        await guild.members.fetch();
        const rolesStart2 = Date.now();
        const profiles = db.profiles || {};
        let applied = 0, removed = 0, skipped = 0, matched = 0;
        const changeLogs = [];

        // Group by handle and aggregate desired roles/regions/offline across all profiles
        const groups = new Map();
        for (const p of Object.values(profiles)) {
          const handle = (p.discord || '').toLowerCase();
          if (!handle) continue;
          let g = groups.get(handle);
          if (!g) { g = { ids: [], handle, office: new Set(), anyDem: false, regions: new Set() }; groups.set(handle, g); }
          g.ids.push(p.id);
          if (/Democratic/i.test(p.party || '')) { g.anyDem = true; if (Array.isArray(p.rolesNeeded)) p.rolesNeeded.forEach(r => g.office.add(r)); }
          if (p.region) g.regions.add(p.region);
        }

        for (const g of groups.values()) {
          const member = guild.members.cache.find(m =>
            (m.user?.username?.toLowerCase?.() === g.handle) ||
            (m.displayName?.toLowerCase?.() === g.handle) ||
            (m.user?.globalName?.toLowerCase?.() === g.handle)
          );
          if (!member) { skipped++; continue; }
          matched++;

          const desiredOffice = g.anyDem ? new Set(g.office) : new Set();
          for (const key of desiredOffice) {
            const roleId = ROLE_IDS[key]; if (!roleId) continue;
            if (!member.roles.cache.has(roleId)) {
              try { await member.roles.add(roleId, 'Auto-assign via /update roles'); applied++; changeLogs.push(`+ ${ROLE_NAMES[key]} -> ${member.user?.tag || member.displayName} (profiles ${g.ids.join(',')})`); } catch (_) {}
            }
          }
          for (const [key, roleId] of Object.entries(ROLE_IDS)) {
            if (member.roles.cache.has(roleId) && !desiredOffice.has(key)) {
              try { await member.roles.remove(roleId, 'Auto-remove via /update roles (not needed by any profile)'); removed++; changeLogs.push(`- ${ROLE_NAMES[key]} -> ${member.user?.tag || member.displayName} (profiles ${g.ids.join(',')})`); } catch (_) {}
            }
          }

          const desiredRegions = new Set(g.regions);
          for (const rk of desiredRegions) {
            const rid = REGION_ROLE_IDS[rk]; if (rid && !member.roles.cache.has(rid)) {
              try { await member.roles.add(rid, 'Auto-assign region via /update roles'); applied++; changeLogs.push(`+ ${REGION_NAMES[rk]} Region -> ${member.user?.tag || member.displayName} (profiles ${g.ids.join(',')})`); } catch (_) {}
            }
          }
          for (const [rk, rid] of Object.entries(REGION_ROLE_IDS)) {
            if (member.roles.cache.has(rid) && !desiredRegions.has(rk)) {
              try { await member.roles.remove(rid, 'Auto-remove region via /update roles (not needed by any profile)'); removed++; changeLogs.push(`- ${REGION_NAMES[rk]} Region -> ${member.user?.tag || member.displayName} (profiles ${g.ids.join(',')})`); } catch (_) {}
            }
          }
        }

        // Emit detailed change logs in chunks to avoid 2000-char limit
        const rolesSecs2 = Math.round((Date.now() - rolesStart2) / 1000);
        const summary = `Role update completed in ${rolesSecs2}s. Matched ${matched}, applied ${applied}, removed ${removed}, skipped ${skipped}.`;
        if (changeLogs.length === 0) {
          await interaction.followUp(summary);
        } else {
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

          await interaction.followUp(summary);
          for (const chunk of chunks) {
            await interaction.followUp('```\n' + chunk + '\n```');
          }
        }
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








