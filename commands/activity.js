// commands/activity.js
// Report guild members with cached profiles showing 2-5 days of inactivity.

const { SlashCommandBuilder } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');

const MIN_DAYS = 2;
const MAX_DAYS = 5;

const loadProfiles = () => {
  const jsonPath = path.join(process.cwd(), 'data', 'profiles.json');
  if (!fs.existsSync(jsonPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (_) {
    return null;
  }
};

const normalizeHandle = (value) => (value ? String(value).toLowerCase() : '');

const addHandle = (map, key, member) => {
  const handle = normalizeHandle(key);
  if (!handle || map.has(handle)) return;
  map.set(handle, member);
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('activity')
    .setDescription('Show members with cached profiles 2-5 days offline')
    .addBooleanOption(opt =>
      opt
        .setName('general')
        .setDescription('If true, show overall activity snapshot by party from dashboard')
        .setRequired(false)
    ),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({ content: 'Run /activity inside the server.', ephemeral: true });
    }

    await interaction.deferReply();

    const general = interaction.options.getBoolean('general') || false;

    if (general) {
      try {
        const host = process.env.STATUS_HOST || process.env.DASHBOARD_HOST || '127.0.0.1';
        const port = Number(process.env.STATUS_PORT || process.env.DASHBOARD_PORT || 3000);
        const url = `http://${host}:${port}/stats.json`;
        const res = await fetch(url).catch(() => null);
        if (!res || !res.ok) {
          return interaction.editReply('Dashboard snapshot unavailable. Is the dashboard running?');
        }
        const data = await res.json();
        const lines = [];
        const render = (label, s) => `${label}: members ${s.count}, avg last online ${s.avgOnlineDays}d, <3d ${s.recentCount}, <5d ${s.activeCount}`;
        if (data?.dem) lines.push(`• ${render('Democratic', data.dem)}`);
        if (data?.gop) lines.push(`• ${render('Republican', data.gop)}`);
        if (data?.all) lines.push(`• ${render('All', data.all)}`);
        const embed = {
          title: 'Party Activity Snapshot',
          description: lines.join('\n') || 'No data',
          footer: { text: data?.updatedAt ? `profiles.json updated ${new Date(data.updatedAt).toLocaleString()}` : 'profiles.json' },
          timestamp: new Date().toISOString(),
        };
        return interaction.editReply({ embeds: [embed] });
      } catch (_) {
        return interaction.editReply('Failed to fetch dashboard snapshot.');
      }
    }

    const db = loadProfiles();
    if (!db?.profiles) {
      return interaction.editReply('profiles.json not found or unreadable. Run /update first.');
    }

    const profiles = Object.values(db.profiles);
    if (!profiles.length) {
      return interaction.editReply('profiles.json is empty. Run /update to populate it.');
    }

    const guild = interaction.guild;
    await guild.members.fetch();

    const handleToMember = new Map();
    guild.members.cache.forEach((member) => {
      addHandle(handleToMember, member.user?.username, member);
      addHandle(handleToMember, member.user?.globalName, member);
      addHandle(handleToMember, member.displayName, member);
    });

    const aggregated = new Map();

    for (const profile of profiles) {
      const handle = normalizeHandle(profile.discord);
      if (!handle) continue;
      const member = handleToMember.get(handle);
      if (!member) continue;
      const daysRaw = typeof profile.lastOnlineDays === 'number' ? profile.lastOnlineDays : null;
      const days = daysRaw !== null ? Math.floor(daysRaw) : null;
      if (days === null || days < MIN_DAYS || days > MAX_DAYS) continue;

      const key = member.id;
      if (!aggregated.has(key)) {
        aggregated.set(key, {
          member,
          maxDays: days,
          profiles: [],
        });
      }
      const record = aggregated.get(key);
      record.maxDays = Math.max(record.maxDays, days);
      record.profiles.push({
        id: profile.id,
        name: profile.name || 'Unknown',
        days,
        lastOnlineText: profile.lastOnlineText || null,
      });
    }

    if (!aggregated.size) {
      return interaction.editReply('No guild members found between 2-5 days offline.');
    }

    const rows = Array.from(aggregated.values()).sort((a, b) => {
      if (b.maxDays !== a.maxDays) return b.maxDays - a.maxDays;
      const aTag = a.member.user?.tag || a.member.displayName || a.member.id;
      const bTag = b.member.user?.tag || b.member.displayName || b.member.id;
      return aTag.localeCompare(bTag);
    });

    const lines = [];
    for (const row of rows.slice(0, 50)) {
      const profileParts = row.profiles
        .sort((a, b) => b.days - a.days)
        .slice(0, 3)
        .map((p) => {
          const seen = p.lastOnlineText || `${p.days} day(s) ago`;
          return `${p.name} (ID ${p.id}, ${seen})`;
        });
      if (row.profiles.length > 3) profileParts.push(`...${row.profiles.length - 3} more`);
      const label = row.member.user?.tag || row.member.displayName || row.member.id;
      lines.push(`• **${label}** — ${row.maxDays} day(s) offline\n   ${profileParts.join('; ')}`);
    }

    const embed = {
      title: 'Members idle 2-5 days',
      description: lines.join('\n'),
      footer: { text: 'Source: data/profiles.json (last scrape)' },
      timestamp: new Date().toISOString(),
    };

    return interaction.editReply({ embeds: [embed] });
  },
};
