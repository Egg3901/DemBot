/**
 * Role Synchronization Utility
 * Handles Discord role management based on PPUSA profile data
 */

const { PermissionsBitField } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');

const ROLE_IDS = {
  gov: '1406063203313782865',
  sen: '1406063162306072607',
  rep: '1406063176281358337',
  cabinet: '1429342639907668048',
};

const ROLE_NAMES = { 
  gov: 'Governor', 
  sen: 'Senator', 
  rep: 'Representative', 
  cabinet: 'Cabinet' 
};

const PRIMARY_ROLE_IDS = {
  class1: '1429342413893271674',
  class2: '1429342467303542907',
  class3: '1429342498848768112',
  repelect: '1429342520222941287',
  govelect: '1429342557053255690',
};

const PRIMARY_ROLE_NAMES = {
  class1: 'Senate Class 1 (Election)',
  class2: 'Senate Class 2 (Election)',
  class3: 'Senate Class 3 (Election)',
  repelect: 'House (Election)',
  govelect: 'Governor (Election)'
};

const REGION_ROLE_IDS = {
  west: '1408854788472573952',
  south: '1408854801202155520',
  northeast: '1408854812597944330',
  rust_belt: '1408854830486913157',
};

const REGION_NAMES = { 
  west: 'West', 
  south: 'South', 
  northeast: 'Northeast', 
  rust_belt: 'Rust Belt' 
};

const INACTIVE_ROLE_ID = '1427236595345522708';
const OFFLINE_THRESHOLD_DAYS = 4;
const WARNING_THRESHOLD_DAYS = 3;

/**
 * Perform role synchronization
 * @param {Object} options - Role sync options
 * @param {Object} options.interaction - Discord interaction
 * @param {Object} options.guild - Discord guild
 * @param {Object} options.db - Profile database
 * @param {boolean} options.clearRoles - Whether to clear roles
 * @param {boolean} options.useFollowUpForStatus - Use followUp for status
 * @param {string} options.primaryAction - Primary action type
 */
async function performRoleSync({ 
  interaction, 
  guild, 
  db, 
  clearRoles = false, 
  useFollowUpForStatus = false, 
  primaryAction = 'both' 
}) {
  const profiles = db.profiles || {};
  if (!profiles || Object.keys(profiles).length === 0) {
    const msg = 'profiles.json is empty. Run /update (without roles) first to build the cache.';
    if (useFollowUpForStatus) await interaction.followUp(msg);
    else await interaction.editReply(msg);
    return;
  }

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
  const groups = new Map();

  // Group profiles by Discord handle
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
    const losRounded = los !== null ? Math.floor(los) : null;
    if (los !== null) {
      if (g.lastOnlineDays === null || los < g.lastOnlineDays) {
        g.lastOnlineDays = los;
        g.lastOnlineText = p.lastOnlineText || null;
      }
      g.offlineDetails.push({
        id: p.id,
        name: p.name || null,
        lastOnlineDays: los,
        lastOnlineDaysRounded: losRounded,
        lastOnlineText: p.lastOnlineText || null,
      });
    }
  }

  const rolesStart = Date.now();
  let applied = 0;
  let removed = 0;
  let skipped = 0;
  let matched = 0;

  // Process each group
  for (const g of groups.values()) {
    const member = guild.members.cache.find((m) =>
      (m.user?.username?.toLowerCase?.() === g.handle) ||
      (m.displayName?.toLowerCase?.() === g.handle) ||
      (m.user?.globalName?.toLowerCase?.() === g.handle)
    );
    if (!member) {
      skipped++;
      continue;
    }
    matched++;

    if (g.anyGop) {
      // Remove roles for Republican profiles
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
      // Apply roles for Democratic profiles
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

      // Apply region roles
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

      // Handle primary election roles
      try {
        const fs = require('node:fs');
        const path = require('node:path');
        const primariesPath = path.join(process.cwd(), 'data', 'primaries.json');
        let userPrimaryKeys = new Set();
        
        const usePrimariesSource = primaryAction !== 'add_from_races';
        const useRacesSource = primaryAction !== 'remove_non_primary';

        if (usePrimariesSource && fs.existsSync(primariesPath)) {
          const primariesDb = JSON.parse(fs.readFileSync(primariesPath, 'utf8'));
          const idx = primariesDb?.candidatesIndex || {};
          for (const pid of g.ids) {
            const entries = idx[String(pid)] || [];
            for (const ent of entries) {
              if (ent.party !== 'dem') continue;
              if (ent.race === 's1') userPrimaryKeys.add('class1');
              if (ent.race === 's2') userPrimaryKeys.add('class2');
              if (ent.race === 's3') userPrimaryKeys.add('class3');
              if (ent.race === 'rep') userPrimaryKeys.add('repelect');
              if (ent.race === 'gov') userPrimaryKeys.add('govelect');
            }
          }
        }

        const racesPath = path.join(process.cwd(), 'data', 'races.json');
        if (useRacesSource && fs.existsSync(racesPath)) {
          try {
            const racesDb = JSON.parse(fs.readFileSync(racesPath, 'utf8'));
            const rIdx = racesDb?.candidatesIndex || {};
            for (const pid of g.ids) {
              const rEntries = rIdx[String(pid)] || [];
              for (const ent of rEntries) {
                if (ent.party !== 'dem') continue;
                if (ent.status !== 'active') continue;
                if (ent.race === 's1') userPrimaryKeys.add('class1');
                if (ent.race === 's2') userPrimaryKeys.add('class2');
                if (ent.race === 's3') userPrimaryKeys.add('class3');
                if (ent.race === 'rep') userPrimaryKeys.add('repelect');
                if (ent.race === 'gov') userPrimaryKeys.add('govelect');
              }
            }
          } catch (_) {}
        }

        // Add missing primary roles
        if (primaryAction !== 'remove_non_primary') {
          for (const key of userPrimaryKeys) {
            const rid = PRIMARY_ROLE_IDS[key];
            if (!rid) continue;
            if (!member.roles.cache.has(rid)) {
              try {
                await member.roles.add(rid, 'Auto-assign primary election role via /update roles');
                applied++;
                changeLogs.push(`+ ${PRIMARY_ROLE_NAMES[key]} -> ${member.user?.tag || member.displayName} (profiles ${g.ids.join(',')}) [reason: active/in-progress primary]`);
              } catch (_) {}
            }
          }
        }

        // Remove primary roles not desired
        if (primaryAction !== 'add_from_races') {
          for (const [key, rid] of Object.entries(PRIMARY_ROLE_IDS)) {
            if (member.roles.cache.has(rid) && !userPrimaryKeys.has(key)) {
              try {
                await member.roles.remove(rid, 'Auto-remove primary election role via /update roles (not in primary)');
                removed++;
                changeLogs.push(`- ${PRIMARY_ROLE_NAMES[key]} -> ${member.user?.tag || member.displayName} (profiles ${g.ids.join(',')}) [reason: not in current primary]`);
              } catch (_) {}
            }
          }
        }
      } catch (_) {}
    }

    // Handle inactive role
    if (INACTIVE_ROLE_ID) {
      const offlineDetails = g.offlineDetails;
      const totalWithData = offlineDetails.length;
      const over4Raw = offlineDetails.filter((d) => d.lastOnlineDays > OFFLINE_THRESHOLD_DAYS);
      const hasActivityData = totalWithData > 0;
      const allOver4 = totalWithData > 0 && over4Raw.length === totalWithData;

      const hasInactive = member.roles.cache.has(INACTIVE_ROLE_ID);
      const shouldBeInactive = g.anyDem && allOver4;
      if (shouldBeInactive && !hasInactive) {
        const referenceDetail = over4Raw[0] || offlineDetails[0];
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
}

module.exports = {
  performRoleSync
};
