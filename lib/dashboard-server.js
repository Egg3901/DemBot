const http = require('node:http');
const os = require('node:os');
const { getStatus, markHeartbeat } = require('./status-tracker');
const fs = require('node:fs');
const path = require('node:path');

const HTML_REFRESH_SECONDS = Number(process.env.STATUS_REFRESH_SECONDS || 20);
const SSE_BROADCAST_INTERVAL_MS = Number(process.env.SSE_BROADCAST_INTERVAL_MS || 5000);

// Keep track of connected SSE clients
const sseClients = new Set();

const escapeHtml = (str = '') =>
  String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const formatDuration = (ms) => {
  if (!ms || Number.isNaN(ms)) return 'N/A';
  const totalSeconds = Math.floor(ms / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600) % 24;
  const days = Math.floor(totalSeconds / 86400);
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours || days) parts.push(`${hours}h`);
  if (minutes || hours || days) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
};

const formatTimestamp = (ts) => {
  if (!ts) return 'N/A';
  try {
    return new Date(ts).toLocaleString();
  } catch (_) {
    return ts;
  }
};

const formatMeta = (meta) => {
  if (meta === null || meta === undefined) return '';
  if (typeof meta === 'string') return meta;
  if (typeof meta === 'number' || typeof meta === 'boolean') return String(meta);
  try {
    return JSON.stringify(meta, null, 2);
  } catch (_) {
    try { return JSON.stringify(String(meta)); } catch (_) { return String(meta); }
  }
};

const getSharedStyle = () => {
  const match = renderHtml.toString().match(/<style>[\s\S]*?<\/style>/);
  return match ? match[0].replace('<style>', '').replace('</style>', '') : '';
};

const buildQueryString = (state, overrides = {}) => {
  const params = new URLSearchParams();
  const merged = { ...state, ...overrides };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined || value === null || value === '') continue;
    if (key === 'page' && (Number(value) || 0) <= 1) continue;
    params.set(key, value);
  }
  const str = params.toString();
  return str ? `?${str}` : '';
};

const renderPagination = (state, currentPage, totalPages) => {
  if (totalPages <= 1) return '';
  const parts = ['<div class="pagination">', `<span class="page-info">Page ${currentPage} of ${totalPages}</span>`];
  const createLink = (label, page, { disabled = false, current = false } = {}) => {
    if (disabled) return `<span class="page-link disabled">${label}</span>`;
    if (current) return `<span class="page-link active">${label}</span>`;
    return `<a class="page-link" href="${buildQueryString(state, { page })}">${label}</a>`;
  };

  parts.push(createLink('Prev', Math.max(1, currentPage - 1), { disabled: currentPage === 1 }));

  const pages = new Set([1, totalPages, currentPage, currentPage - 1, currentPage + 1, currentPage - 2, currentPage + 2]);
  const ordered = Array.from(pages)
    .filter((p) => p >= 1 && p <= totalPages)
    .sort((a, b) => a - b);

  let lastPage = null;
  for (const page of ordered) {
    if (lastPage && page - lastPage > 1) {
      parts.push('<span class="page-link disabled">&#8230;</span>');
    }
    parts.push(createLink(String(page), page, { current: page === currentPage }));
    lastPage = page;
  }

  parts.push(createLink('Next', Math.min(totalPages, currentPage + 1), { disabled: currentPage === totalPages }));
  parts.push('</div>');
  return parts.join('');
};

const renderTopCard = (title, items, valueFormatter) => `
  <section class="card">
    <header class="card-header">
      <div>
        <p class="eyebrow">Highlights</p>
        <h2>${escapeHtml(title)}</h2>
      </div>
      <div class="badge-stack"><span class="pill pill-neutral">Top ${items.length}</span></div>
    </header>
    <ul class="striped-list">
      ${items
        .map(
          (item, index) =>
            `<li><span>${index + 1}. ${escapeHtml(item.name || 'Unknown')}</span><span>${escapeHtml(valueFormatter(item))}</span></li>`,
        )
        .join('')}
    </ul>
  </section>
`;

const formatLastSeen = (profile) => {
  if (profile.lastOnlineText) return profile.lastOnlineText;
  if (typeof profile.lastOnlineDays === 'number') {
    if (profile.lastOnlineDays === 0) return 'Today';
    return `${profile.lastOnlineDays} day(s) ago`;
  }
  return 'Unknown';
};

const EXTRA_DASHBOARD_STYLE = `
        .grid-two {
          display: grid;
          gap: 1.4rem;
          grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
          margin-bottom: 1.6rem;
        }
        .striped-list {
          list-style: none;
          padding: 0;
          margin: 0;
        }
        .striped-list li {
          display: flex;
          justify-content: space-between;
          padding: 0.45rem 0;
          border-bottom: 1px solid rgba(148, 163, 184, 0.18);
        }
        .striped-list li:last-child {
          border-bottom: none;
        }
        .filter-bar {
          display: flex;
          flex-wrap: wrap;
          gap: 1rem;
          align-items: flex-end;
          margin-bottom: 1.2rem;
        }
        .filter-bar label {
          display: flex;
          flex-direction: column;
          gap: 0.4rem;
          font-size: 0.82rem;
          color: rgba(148, 163, 184, 0.85);
        }
        .filter-bar select {
          min-width: 150px;
          padding: 0.42rem 0.55rem;
          border-radius: 10px;
          border: 1px solid rgba(148, 163, 184, 0.22);
          background: rgba(15, 25, 50, 0.7);
          color: #e2e8f0;
        }
        .filter-bar button {
          padding: 0.5rem 1.05rem;
          border-radius: 10px;
          border: none;
          background: radial-gradient(circle at top left, rgba(196, 181, 253, 0.95), rgba(139, 92, 246, 0.82));
          color: #0f172a;
          font-weight: 600;
          cursor: pointer;
          box-shadow: 0 12px 26px rgba(99, 102, 241, 0.32);
        }
        .filter-bar button:hover {
          filter: brightness(1.05);
        }
        .filter-tag {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          padding: 0.25rem 0.7rem;
          border-radius: 999px;
          background: rgba(59, 130, 246, 0.18);
          color: rgba(191, 219, 254, 0.9);
          font-size: 0.8rem;
          margin-right: 0.5rem;
        }
        .pagination {
          display: flex;
          flex-wrap: wrap;
          gap: 0.55rem;
          align-items: center;
          margin-top: 1.4rem;
        }
        .pagination .page-info {
          color: rgba(148, 163, 184, 0.8);
          margin-right: 0.35rem;
        }
        .pagination .page-link {
          padding: 0.35rem 0.75rem;
          border-radius: 8px;
          border: 1px solid rgba(148, 163, 184, 0.22);
          text-decoration: none;
          color: rgba(226, 232, 240, 0.9);
          font-size: 0.88rem;
        }
        .pagination .page-link:hover {
          background: rgba(63, 94, 251, 0.22);
        }
        .pagination .page-link.active {
          background: rgba(139, 92, 246, 0.3);
          border-color: rgba(139, 92, 246, 0.6);
          color: #f8fafc;
        }
        .pagination .page-link.disabled {
          opacity: 0.45;
          pointer-events: none;
        }
        .placeholder-card {
          text-align: center;
          padding: 2.2rem;
          color: rgba(148, 163, 184, 0.85);
        }
        .placeholder-card h3 {
          margin: 0 0 0.6rem;
          color: rgba(248, 250, 252, 0.95);
        }
        .auth-actions {
          margin-top: 1.5rem;
          padding-top: 1.5rem;
          border-top: 1px solid rgba(148, 163, 184, 0.18);
        }
        .auth-actions h4 {
          margin: 0 0 1rem;
          color: rgba(248, 250, 252, 0.95);
          font-size: 1rem;
          letter-spacing: 0.05em;
          text-transform: uppercase;
        }
        .auth-timeline {
          list-style: none;
          padding: 0;
          margin: 0;
        }
        .auth-step {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          margin-bottom: 0.75rem;
          padding: 0.5rem;
          border-radius: 8px;
          background: rgba(9, 11, 26, 0.5);
        }
        .auth-step.success {
          background: rgba(56, 189, 248, 0.1);
          border: 1px solid rgba(56, 189, 248, 0.3);
        }
        .auth-step.error {
          background: rgba(252, 70, 107, 0.1);
          border: 1px solid rgba(252, 70, 107, 0.3);
        }
        .step-dot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .step-dot.success {
          background: rgba(56, 189, 248, 1);
          box-shadow: 0 0 8px rgba(56, 189, 248, 0.5);
        }
        .step-dot.error {
          background: rgba(252, 70, 107, 1);
          box-shadow: 0 0 8px rgba(252, 70, 107, 0.5);
        }
        .step-info {
          flex: 1;
        }
        .step-info strong {
          display: block;
          color: rgba(248, 250, 252, 0.95);
          font-size: 0.9rem;
        }
        .step-time {
          display: block;
          color: rgba(148, 163, 184, 0.7);
          font-size: 0.75rem;
          margin-top: 0.25rem;
        }
        .step-url {
          display: block;
          color: rgba(139, 92, 246, 0.8);
          font-size: 0.75rem;
          margin-top: 0.25rem;
          word-break: break-all;
        }
        .user-info {
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
        }
        .user-info strong {
          color: rgba(248, 250, 252, 0.95);
        }
        .user-info .muted {
          font-size: 0.75rem;
          color: rgba(148, 163, 184, 0.7);
        }
`;
const renderBotStatus = (bot, metrics) => {
  const statusBadge = bot.ready
    ? '<span class="pill pill-ok">Online</span>'
    : '<span class="pill pill-warn">Offline</span>';
  const loginMessage = bot.loginError
    ? `<div class="card-alert">Login error: ${escapeHtml(bot.loginError.message)}</div>`
    : '';
  return `
    <section class="card">
      <header class="card-header">
        <div>
          <p class="eyebrow">Realtime health</p>
          <h2>Bot Status</h2>
        </div>
        ${statusBadge}
      </header>
      <ul class="stat-grid">
        <li>
          <p class="stat-label">Ready Since</p>
          <p class="stat-value"><span id="stat-readyAt">${formatTimestamp(bot.readyAt)}</span></p>
        </li>
        <li>
          <p class="stat-label">Last Heartbeat</p>
          <p class="stat-value"><span id="stat-heartbeat">${formatTimestamp(bot.lastHeartbeat)}</span></p>
        </li>
        <li>
          <p class="stat-label">Uptime</p>
          <p class="stat-value"><span id="stat-uptime">${formatDuration(bot.uptimeMs)}</span></p>
        </li>
        <li>
          <p class="stat-label">Host</p>
          <p class="stat-value">${escapeHtml(os.hostname())}</p>
        </li>
        <li>
          <p class="stat-label">Load (1m)</p>
          <p class="stat-value"><span id="stat-load1">${metrics?.samples?.length ? (metrics.samples[metrics.samples.length - 1].load1 || 0).toFixed(2) : '—'}</span></p>
        </li>
        <li>
          <p class="stat-label">Memory (RSS)</p>
          <p class="stat-value"><span id="stat-rss">${metrics?.samples?.length ? (metrics.samples[metrics.samples.length - 1].rssMB + ' MB') : '—'}</span></p>
        </li>
      </ul>
      ${loginMessage}
    </section>
  `;
};

// Simple sparkline generator for arrays of numbers
const buildSparklinePath = (values, width = 280, height = 60, padding = 4) => {
  if (!Array.isArray(values) || values.length === 0) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const innerW = width - padding * 2;
  const innerH = height - padding * 2;
  const stepX = innerW / Math.max(1, values.length - 1);
  const points = values.map((v, i) => {
    const x = padding + i * stepX;
    const y = padding + innerH - ((v - min) / range) * innerH;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  return `M${points.join(' L')}`;
};

const renderMetricsTrends = (metrics) => {
  const samples = Array.isArray(metrics?.samples) ? metrics.samples : [];
  const lastN = samples.slice(-60); // ~last hour if sampled per minute
  const cmdSeries = lastN.map((s, i, arr) => {
    if (i === 0) return 0;
    const prev = arr[i - 1].cmdCountTotal || 0;
    const cur = s.cmdCountTotal || 0;
    return Math.max(0, cur - prev);
  }).slice(1);
  const rssSeries = lastN.map(s => s.rssMB || 0);
  const loadSeries = lastN.map(s => Number(s.load1 || 0));

  const cmdPath = buildSparklinePath(cmdSeries);
  const rssPath = buildSparklinePath(rssSeries);
  const loadPath = buildSparklinePath(loadSeries);

  const cmdLatest = cmdSeries.length ? cmdSeries[cmdSeries.length - 1] : 0;
  const rssLatest = rssSeries.length ? rssSeries[rssSeries.length - 1] : 0;
  const loadLatest = loadSeries.length ? loadSeries[loadSeries.length - 1] : 0;

  return `
    <section class="card">
      <header class="card-header">
        <div>
          <p class="eyebrow">Runtime trends</p>
          <h2>Performance</h2>
        </div>
        <div class="badge-stack">
          <span class="pill pill-neutral">Live</span>
        </div>
      </header>
      <div class="grid-three">
        <div>
          <p class="stat-label">Commands/min (last ~hour)</p>
          <svg id="spark-cmd" viewBox="0 0 280 60" width="100%" height="60" preserveAspectRatio="none">
            <path d="${cmdPath}" fill="none" stroke="rgba(56,189,248,0.9)" stroke-width="2" />
          </svg>
          <p class="stat-value"><span id="spark-cmd-latest">${cmdLatest}</span> rpm</p>
        </div>
        <div>
          <p class="stat-label">Memory RSS (MB)</p>
          <svg id="spark-rss" viewBox="0 0 280 60" width="100%" height="60" preserveAspectRatio="none">
            <path d="${rssPath}" fill="none" stroke="rgba(139,92,246,0.9)" stroke-width="2" />
          </svg>
          <p class="stat-value"><span id="spark-rss-latest">${rssLatest}</span> MB</p>
        </div>
        <div>
          <p class="stat-label">Load (1m)</p>
          <svg id="spark-load" viewBox="0 0 280 60" width="100%" height="60" preserveAspectRatio="none">
            <path d="${loadPath}" fill="none" stroke="rgba(252,70,107,0.9)" stroke-width="2" />
          </svg>
          <p class="stat-value"><span id="spark-load-latest">${loadLatest.toFixed ? loadLatest.toFixed(2) : loadLatest}</span></p>
        </div>
      </div>
    </section>
  `;
};

const renderPPUSAAuthStatus = (auth) => {
  const statusBadge = auth.status === 'success'
    ? '<span class="pill pill-ok">Authenticated</span>'
    : auth.status === 'error'
    ? '<span class="pill pill-warn">Auth Failed</span>'
    : auth.status === 'pending'
    ? '<span class="pill pill-neutral">Authenticating</span>'
    : '<span class="pill pill-neutral">Unknown</span>';

  const errorMessage = auth.error
    ? `<div class="card-alert card-alert--subtle">Error: ${escapeHtml(auth.error.message)}</div>`
    : '';

  const currentStep = auth.currentStep
    ? `<li>
        <p class="stat-label">Current Step</p>
        <p class="stat-value">${escapeHtml(auth.currentStep)}</p>
      </li>`
    : '';

  const actions = Array.isArray(auth.actions) ? auth.actions.slice(-5) : []; // Show last 5 actions
  const actionsList = actions.length > 0
    ? `<div class="auth-actions">
        <h4>Recent Steps</h4>
        <ul class="auth-timeline">
          ${actions.map(action => `
            <li class="auth-step ${action.success ? 'success' : 'error'}">
              <div class="step-dot ${action.success ? 'success' : 'error'}"></div>
              <div class="step-info">
                <strong>${escapeHtml(action.step)}</strong>
                <span class="step-time">${formatTimestamp(action.timestamp)}</span>
                ${action.finalUrl ? `<div class="step-url">${escapeHtml(action.finalUrl)}</div>` : ''}
              </div>
            </li>
          `).join('')}
        </ul>
      </div>`
    : '';

  return `
    <section class="card">
      <header class="card-header">
        <div>
          <p class="eyebrow">PPUSA Authentication</p>
          <h2>Login Status</h2>
        </div>
        ${statusBadge}
      </header>
      <ul class="stat-grid">
        <li>
          <p class="stat-label">Last Attempt</p>
          <p class="stat-value">${formatTimestamp(auth.lastAttempt)}</p>
        </li>
        <li>
          <p class="stat-label">Last Success</p>
          <p class="stat-value">${formatTimestamp(auth.lastSuccess)}</p>
        </li>
        ${currentStep}
      </ul>
      ${errorMessage}
      ${actionsList}
    </section>
  `;
};

const renderUserLeaderboard = (users) => {
  if (!users.length) {
    return `
      <section class="card">
        <header class="card-header">
          <div>
            <p class="eyebrow">User activity</p>
            <h2>Command Leaderboard</h2>
          </div>
        </header>
        <p class="muted">No user activity recorded yet.</p>
      </section>
    `;
  }

  const topUsers = users.slice(0, 10); // Top 10 users
  const totalCommands = users.reduce((sum, user) => sum + user.commandCount, 0);

  const rows = topUsers.map((user, index) => {
    const topCommand = user.commands.length > 0 ? user.commands[0] : null;
    return `
      <tr>
        <td>${index + 1}</td>
        <td>
          <div class="user-info">
            <strong>${escapeHtml(user.username || `User ${user.userId.slice(-4)}`)}</strong>
            <span class="muted">${user.userId}</span>
          </div>
        </td>
        <td>${user.commandCount}</td>
        <td>${topCommand ? `${escapeHtml(topCommand.name)} (${topCommand.count})` : '—'}</td>
        <td>${formatTimestamp(user.lastActivity)}</td>
      </tr>
    `;
  }).join('');

  return `
    <section class="card">
      <header class="card-header">
        <div>
          <p class="eyebrow">User activity</p>
          <h2>Command Leaderboard</h2>
        </div>
        <div class="badge-stack">
          <span class="pill pill-neutral">${totalCommands} total commands</span>
          <span class="pill pill-ok">${users.length} active users</span>
        </div>
      </header>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Rank</th>
              <th>User</th>
              <th>Total Commands</th>
              <th>Top Command</th>
              <th>Last Activity</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
    </section>
  `;
};

const renderActivityCard = (title, stats, party) => `
  <section class="card">
    <header class="card-header">
      <div>
        <p class="eyebrow">Activity Analysis</p>
        <h2>${escapeHtml(title)}</h2>
      </div>
    </header>
    <ul class="stat-grid">
      <li>
        <p class="stat-label">Total Members</p>
        <p class="stat-value">${stats.count}</p>
      </li>
      <li>
        <p class="stat-label">Avg Days Since Online</p>
        <p class="stat-value">${stats.avgOnlineDays} days</p>
      </li>
      <li>
        <p class="stat-label">Online &lt; 3 Days</p>
        <p class="stat-value">${stats.recentCount}</p>
      </li>
      <li>
        <p class="stat-label">Online &lt; 5 Days</p>
        <p class="stat-value">${stats.activeCount}</p>
      </li>
    </ul>
  </section>
`;

const renderCommandTable = (commands) => {
  if (!commands.length) {
    return `
      <section class="card">
        <header class="card-header">
          <div>
            <p class="eyebrow">Command activity</p>
            <h2>Commands</h2>
          </div>
        </header>
        <p class="muted">No commands have been invoked yet.</p>
      </section>
    `;
  }

  const totals = commands.reduce(
    (acc, cmd) => {
      acc.runs += cmd.runCount;
      acc.errors += cmd.errorCount;
      acc.success += cmd.successCount;
      if (cmd.lastErrorAt) acc.latestError = acc.latestError
        ? (new Date(acc.latestError.timestamp) > new Date(cmd.lastErrorAt) ? acc.latestError : { name: cmd.name, timestamp: cmd.lastErrorAt })
        : { name: cmd.name, timestamp: cmd.lastErrorAt };
      return acc;
    },
    { runs: 0, errors: 0, success: 0, latestError: null },
  );

  const rows = commands
    .map((cmd) => {
      const errorClass = cmd.lastErrorAt ? ' class="row-warn"' : '';
      const healthBadge = cmd.errorCount
        ? `<span class="pill pill-warn">${cmd.errorCount} error${cmd.errorCount === 1 ? '' : 's'}</span>`
        : '<span class="pill pill-ok">Healthy</span>';
      return `
        <tr${errorClass}>
          <td>${escapeHtml(cmd.name)}</td>
          <td>${cmd.runCount}</td>
          <td>${cmd.successCount}</td>
          <td>${cmd.errorCount}</td>
          <td>${formatTimestamp(cmd.lastRunAt)}</td>
          <td>${formatTimestamp(cmd.lastSuccessAt)}</td>
          <td>${formatTimestamp(cmd.lastErrorAt)}</td>
          <td>
            <div class="cell-stack">
              ${healthBadge}
              ${cmd.lastErrorMessage ? `<span class="muted">${escapeHtml(cmd.lastErrorMessage)}</span>` : ''}
            </div>
          </td>
        </tr>
      `;
    })
    .join('');

  return `
    <section class="card">
      <header class="card-header">
        <div>
          <p class="eyebrow">Command activity</p>
          <h2>Commands</h2>
        </div>
        <div class="badge-stack">
          <span class="pill pill-neutral">${totals.runs} total runs</span>
          <span class="pill pill-ok">${totals.success} success</span>
          <span class="pill pill-warn">${totals.errors} errors</span>
        </div>
      </header>
      <div style="margin-bottom:0.8rem">
        <input id="cmd-filter" type="text" placeholder="Filter commands (press /)" style="width:100%;max-width:320px;padding:0.5rem;border-radius:8px;border:1px solid rgba(148,163,184,0.3);background:rgba(15,25,50,0.7);color:#e2e8f0;" />
      </div>
      ${
        totals.latestError
          ? `<div class="card-alert card-alert--subtle">
              Latest error: ${escapeHtml(totals.latestError.name)} at ${formatTimestamp(totals.latestError.timestamp)}
            </div>`
          : ''
      }
      <div class="table-scroll">
        <table id="commands-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Runs</th>
              <th>Success</th>
              <th>Errors</th>
              <th>Last Run</th>
              <th>Last Success</th>
              <th>Last Error</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
    </section>
  `;
};

const renderErrorLog = (errors) => {
  if (!errors.length) return '';
  const items = errors
    .map(
      (err) => `
        <article class="timeline-item">
          <header>
            <div class="timeline-dot"></div>
            <div>
              <strong>${escapeHtml(err.command)}</strong>
              <span class="muted">${formatTimestamp(err.timestamp)}</span>
            </div>
          </header>
          <pre>${escapeHtml(err.message)}</pre>
          ${
            err.meta
              ? `<details><summary>Details</summary><pre>${escapeHtml(formatMeta(err.meta))}</pre></details>`
              : ''
          }
          ${err.stack ? `<details><summary>Stack trace</summary><pre>${escapeHtml(err.stack)}</pre></details>` : ''}
        </article>
      `,
    )
    .join('');

  return `
    <section class="card">
      <header class="card-header">
        <div>
          <p class="eyebrow">Latest exceptions</p>
          <h2>Recent Errors</h2>
        </div>
      </header>
      ${items}
    </section>
  `;
};

const renderHtml = () => {
  const data = getStatus();
  const refreshMeta = HTML_REFRESH_SECONDS > 0
    ? `<meta http-equiv="refresh" content="${HTML_REFRESH_SECONDS}">`
    : '';

  return `<!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="utf-8">
      ${refreshMeta}
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>DemBot Dashboard</title>
      <style>
        :root {
          color-scheme: light dark;
          font-family: "Poppins", "Inter", system-ui, -apple-system, sans-serif;
          background-color: #090b1a;
          color: #f8fafc;
        }
        body {
          margin: 0;
          min-height: 100vh;
          display: flex;
          justify-content: center;
          padding: 3rem 1.5rem;
          background:
            radial-gradient(140% 80% at 0% 0%, rgba(252, 70, 107, 0.35) 0%, transparent 65%),
            radial-gradient(90% 90% at 100% 0%, rgba(63, 94, 251, 0.28) 15%, transparent 75%),
            linear-gradient(135deg, #050814 0%, #0e1329 55%, #121736 100%);
        }
        main {
          width: min(1120px, 100%);
        }
        header.page-header {
          position: relative;
          overflow: hidden;
          border-radius: 18px;
          padding: 2.4rem 2rem;
          margin-bottom: 2.75rem;
          background: linear-gradient(135deg, rgba(63, 94, 251, 0.85), rgba(252, 70, 107, 0.92));
          box-shadow: 0 24px 45px rgba(15, 23, 42, 0.5);
        }
        header.page-header::after {
          content: "";
          position: absolute;
          inset: 0;
          background: radial-gradient(circle at 20% 20%, rgba(255, 255, 255, 0.35), transparent 55%);
          opacity: 0.35;
        }
        header.page-header > div {
          position: relative;
          z-index: 1;
        }
        header.page-header h1 {
          margin: 0;
          font-size: clamp(2rem, 2vw + 1.25rem, 2.75rem);
          letter-spacing: 0.05em;
          text-transform: uppercase;
        }
        header.page-header p {
          margin: 0.45rem 0 0;
          color: rgba(248, 250, 252, 0.82);
        }
        .badge-dot {
          display: inline-flex;
          align-items: center;
          gap: 0.45rem;
          padding: 0.45rem 0.85rem;
          background: rgba(15, 23, 42, 0.35);
          border-radius: 999px;
          font-size: 0.85rem;
          color: rgba(248, 250, 252, 0.88);
        }
        .tabs {
          display: inline-flex;
          background: rgba(9, 11, 26, 0.82);
          padding: 0.4rem;
          border-radius: 12px;
          border: 1px solid rgba(148, 163, 184, 0.2);
          margin-bottom: 1.9rem;
          gap: 0.4rem;
          position: relative;
          z-index: 2;
        }
        .tabs a {
          text-decoration: none;
          color: rgba(226, 232, 240, 0.82);
          font-weight: 600;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          font-size: 0.78rem;
          padding: 0.55rem 1.05rem;
          border-radius: 9px;
          transition: all 0.2s ease;
        }
        .tabs a:hover {
          color: #f8fafc;
          background: rgba(63, 94, 251, 0.22);
        }
        .tabs a.active {
          color: #0b1220;
          background: radial-gradient(circle at top left, rgba(196, 181, 253, 0.95), rgba(139, 92, 246, 0.82));
          box-shadow: 0 12px 26px rgba(99, 102, 241, 0.35);
        }
        .card {
          position: relative;
          margin-bottom: 2.1rem;
          padding: 1.9rem;
          border-radius: 18px;
          background: rgba(9, 11, 26, 0.92);
          border: 1px solid rgba(148, 163, 184, 0.16);
          box-shadow:
            0 20px 45px rgba(6, 11, 38, 0.55),
            inset 0 0 0 1px rgba(255, 255, 255, 0.02);
        }
        .card::before {
          content: "";
          position: absolute;
          inset: 0;
          border-radius: inherit;
          padding: 1px;
          background: linear-gradient(135deg, rgba(63, 94, 251, 0.6), rgba(252, 70, 107, 0.6));
          -webkit-mask:
            linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
          -webkit-mask-composite: xor;
          mask-composite: exclude;
          opacity: 0.55;
          pointer-events: none;
        }
        .card-header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 1.75rem;
          margin-bottom: 1.6rem;
        }
        .card-header h2 {
          margin: 0;
          font-size: 1.35rem;
          letter-spacing: 0.05em;
          text-transform: uppercase;
        }
        .eyebrow {
          text-transform: uppercase;
          letter-spacing: 0.28em;
          font-size: 0.7rem;
          color: rgba(129, 140, 248, 0.9);
          margin: 0 0 0.35rem;
        }
        .muted {
          color: rgba(148, 163, 184, 0.85);
        }
        .pill {
          display: inline-flex;
          align-items: center;
          gap: 0.45rem;
          font-size: 0.78rem;
          font-weight: 600;
          padding: 0.45rem 0.85rem;
          border-radius: 999px;
          letter-spacing: 0.05em;
          text-transform: uppercase;
        }
        .pill-ok {
          background: rgba(56, 189, 248, 0.16);
          color: #bae6fd;
          border: 1px solid rgba(56, 189, 248, 0.45);
        }
        .pill-warn {
          background: rgba(248, 113, 113, 0.15);
          color: #fecaca;
          border: 1px solid rgba(248, 113, 113, 0.4);
        }
        .pill-neutral {
          background: rgba(148, 163, 184, 0.16);
          color: #e2e8f0;
          border: 1px solid rgba(148, 163, 184, 0.26);
        }
        .badge-stack {
          display: flex;
          flex-wrap: wrap;
          gap: 0.6rem;
          justify-content: flex-end;
        }
        .table-scroll {
          overflow-x: auto;
          border-radius: 14px;
          border: 1px solid rgba(148, 163, 184, 0.18);
          background: rgba(10, 12, 22, 0.75);
        }
        table {
          width: 100%;
          border-collapse: collapse;
          min-width: 640px;
        }
        th, td {
          text-align: left;
          padding: 0.85rem 1.05rem;
          border-bottom: 1px solid rgba(148, 163, 184, 0.1);
          vertical-align: top;
        }
        th {
          font-size: 0.78rem;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          color: rgba(148, 163, 184, 0.7);
        }
        tbody tr:hover {
          background: rgba(63, 94, 251, 0.12);
        }
        tr.row-warn {
          background: rgba(252, 70, 107, 0.18);
        }
        .cell-stack {
          display: flex;
          flex-direction: column;
          gap: 0.35rem;
        }
        .card-alert {
          margin-bottom: 1.3rem;
          padding: 0.85rem 1.05rem;
          border-radius: 12px;
          background: rgba(252, 70, 107, 0.12);
          color: rgba(254, 215, 226, 0.95);
          border: 1px solid rgba(252, 70, 107, 0.35);
        }
        .card-alert--subtle {
          background: rgba(63, 94, 251, 0.12);
          color: rgba(191, 219, 254, 0.95);
          border-color: rgba(63, 94, 251, 0.35);
        }
        .stat-grid {
          list-style: none;
          padding: 0;
          margin: 0;
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
          gap: 1.2rem;
        }
        .stat-label {
          margin: 0;
          font-size: 0.78rem;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          color: rgba(148, 163, 184, 0.7);
        }
        .stat-value {
          margin: 0.4rem 0 0;
          font-size: 1.1rem;
          color: #f8fafc;
        }
        .timeline-item {
          position: relative;
          padding-left: 2rem;
          margin-bottom: 1.7rem;
        }
        .timeline-item:last-child {
          margin-bottom: 0;
        }
        .timeline-item header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 0.6rem;
          gap: 0.9rem;
        }
        .timeline-dot {
          position: absolute;
          left: 0.35rem;
          top: 0.45rem;
          width: 14px;
          height: 14px;
          border-radius: 50%;
          background: radial-gradient(circle, rgba(252, 70, 107, 1) 0%, rgba(252, 70, 107, 0.2) 70%);
          box-shadow: 0 0 16px rgba(252, 70, 107, 0.55);
        }
        .timeline-item::before {
          content: "";
          position: absolute;
          left: 0.97rem;
          top: 1.4rem;
          bottom: -1.7rem;
          width: 1px;
          background: linear-gradient(to bottom, rgba(252, 70, 107, 0.5), transparent);
        }
        .timeline-item:last-child::before {
          display: none;
        }
        pre {
          margin: 0;
          white-space: pre-wrap;
          word-break: break-word;
          font-family: "JetBrains Mono", "SFMono-Regular", ui-monospace, Menlo, Consolas, "Liberation Mono", "Courier New", monospace;
          background: rgba(8, 11, 26, 0.85);
          padding: 0.75rem 0.9rem;
          border-radius: 10px;
          border: 1px solid rgba(148, 163, 184, 0.18);
        }
        details {
          margin-top: 0.8rem;
        }
        details summary {
          cursor: pointer;
          color: rgba(196, 181, 253, 0.95);
        }
        @media (max-width: 720px) {
          body {
            padding: 2.25rem 1rem;
          }
          header.page-header {
            padding: 1.85rem 1.6rem;
          }
          header.page-header h1 {
            font-size: 1.9rem;
          }
          .card-header {
            flex-direction: column;
            align-items: flex-start;
          }
          .badge-stack {
            justify-content: flex-start;
          }
          .table-scroll {
            margin: 0 -0.75rem;
          }
          table {
            min-width: 520px;
          }
        }
      </style>
    </head>
    <body>
      <main>
        <nav class="tabs">
          <a class="active" href="/">Overview</a>
          <a href="/stats">Stats</a>
        </nav>
        <header class="page-header">
          <div>
            <span class="badge-dot">DemBot Monitoring</span>
            <h1>Operations Dashboard</h1>
            <p>Live view of bot health, command throughput, and recent issues.</p>
          </div>
        </header>
        ${renderBotStatus(data.bot, data.metrics)}
        ${renderPPUSAAuthStatus(data.ppusaAuth)}
        ${renderMetricsTrends(data.metrics)}
        ${renderUserLeaderboard(data.users)}
        ${renderCommandTable(data.commands)}
        ${renderErrorLog(data.errors)}
      </main>
      <script>
        (function(){
          try {
            var es = new EventSource('/events');
            es.onmessage = function(evt){
              try {
                var payload = JSON.parse(evt.data);
                if (payload && payload.metrics && payload.bot) {
                  // Update basic stats
                  var el;
                  if ((el = document.getElementById('stat-uptime'))) el.textContent = payload.bot.uptimeMs ? (function(ms){
                    var s = Math.floor(ms/1000); var d = Math.floor(s/86400); s%=86400; var h=Math.floor(s/3600); s%=3600; var m=Math.floor(s/60); s%=60; var parts=[]; if(d)parts.push(d+'d'); if(d||h)parts.push(h+'h'); if(d||h||m)parts.push(m+'m'); parts.push(s+'s'); return parts.join(' ');
                  })(payload.bot.uptimeMs) : 'N/A';
                  if ((el = document.getElementById('stat-heartbeat'))) el.textContent = payload.bot.lastHeartbeat || 'N/A';
                  if ((el = document.getElementById('stat-readyAt'))) el.textContent = payload.bot.readyAt || 'N/A';
                  if (payload.metrics.samples && payload.metrics.samples.length) {
                    var last = payload.metrics.samples[payload.metrics.samples.length-1];
                    if ((el = document.getElementById('stat-rss'))) el.textContent = (last.rssMB||0) + ' MB';
                    if ((el = document.getElementById('stat-load1'))) el.textContent = (Number(last.load1||0)).toFixed(2);

                    // Update sparklines
                    function slPath(values){
                      if (!values || !values.length) return '';
                      var min=Math.min.apply(null, values), max=Math.max.apply(null, values), range=(max-min)||1, w=280, h=60, p=4, innerW=w-p*2, innerH=h-p*2, step=innerW/Math.max(1, values.length-1), pts=[];
                      for (var i=0;i<values.length;i++){ var x=p+i*step; var y=p+innerH-((values[i]-min)/range)*innerH; pts.push(x.toFixed(2)+","+y.toFixed(2)); }
                      return 'M'+pts.join(' L');
                    }
                    var samples = payload.metrics.samples.slice(-60);
                    var cmdSeries = samples.map(function(s,i,a){ if(!i) return 0; var prev=a[i-1].cmdCountTotal||0; var cur=s.cmdCountTotal||0; return Math.max(0, cur-prev); }).slice(1);
                    var rssSeries = samples.map(function(s){ return s.rssMB||0; });
                    var loadSeries = samples.map(function(s){ return Number(s.load1||0); });
                    var e;
                    if ((e=document.querySelector('#spark-cmd path'))) e.setAttribute('d', slPath(cmdSeries));
                    if ((e=document.querySelector('#spark-rss path'))) e.setAttribute('d', slPath(rssSeries));
                    if ((e=document.querySelector('#spark-load path'))) e.setAttribute('d', slPath(loadSeries));
                    if ((e=document.getElementById('spark-cmd-latest'))) e.textContent = cmdSeries.length ? cmdSeries[cmdSeries.length-1] : 0;
                    if ((e=document.getElementById('spark-rss-latest'))) e.textContent = rssSeries.length ? rssSeries[rssSeries.length-1] : 0;
                    if ((e=document.getElementById('spark-load-latest'))) {
                      var lv = loadSeries.length ? loadSeries[loadSeries.length-1] : 0; e.textContent = Number(lv).toFixed(2);
                    }
                  }
                }
              } catch(_){ /* ignore */ }
            };
          } catch(_){ /* SSE not supported */ }
        })();

        // Commands table quick filter and shortcut
        (function(){
          var input = document.getElementById('cmd-filter');
          var table = document.getElementById('commands-table');
          function apply(){
            if (!table) return;
            var q = (input && input.value || '').toLowerCase();
            var rows = table.querySelectorAll('tbody tr');
            rows.forEach(function(row){
              var name = (row.cells[0] && row.cells[0].textContent || '').toLowerCase();
              row.style.display = !q || name.indexOf(q) !== -1 ? '' : 'none';
            });
          }
          if (input) input.addEventListener('input', apply);
          document.addEventListener('keydown', function(e){
            if (e.key === '/' && document.activeElement !== input) {
              e.preventDefault(); if (input) { input.focus(); input.select(); }
            }
          });
        })();
      </script>
    </body>
  </html>`;
const getSharedStyle = () => {
  const match = renderHtml.toString().match(/<style>[\s\S]*?<\/style>/);
  return match ? match[0].replace('<style>', '').replace('</style>', '') : '';
};
};

function readProfiles() {
  try {
    const p = path.join(process.cwd(), 'data', 'profiles.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) { return null; }
}

function parseMoney(str) { if (!str) return 0; const n = Number(String(str).replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? n : 0; }

const renderStatsPage = (queryParams = {}) => {
  const db = readProfiles();
  const allProfiles = db?.profiles ? Object.values(db.profiles) : [];

  // Parse query parameters
  const filterParty = queryParams.party || 'all';
  const searchQuery = queryParams.search || '';
  const activityFilter = queryParams.activity || 'all'; // 'all', 'recent' (<3 days), 'active' (<5 days)
  const page = Math.max(1, parseInt(queryParams.page) || 1);
  const cashPage = Math.max(1, parseInt(queryParams.cash_page) || 1);
  const esPage = Math.max(1, parseInt(queryParams.es_page) || 1);
  const ppPage = Math.max(1, parseInt(queryParams.pp_page) || 1);
  const topPer = Math.max(1, parseInt(queryParams.top_per) || 3);

  // Filter profiles based on party and activity
  const profiles = allProfiles.filter(p => {
    // Party filter
    if (filterParty !== 'all') {
      const party = (p.party || '').toLowerCase();
      if (filterParty === 'dem' && !party.includes('democrat')) return false;
      if (filterParty === 'gop' && !party.includes('republican')) return false;
    }

    // Activity filter
    if (activityFilter !== 'all') {
      const lastOnlineDays = p.lastOnlineDays;
      if (lastOnlineDays === null || lastOnlineDays === undefined) return false;

      if (activityFilter === 'recent' && lastOnlineDays >= 3) return false; // <3 days
      if (activityFilter === 'active' && lastOnlineDays >= 5) return false;  // <5 days
    }

    return true;
  });

  // Search filter
  const filteredProfiles = searchQuery
    ? profiles.filter(p =>
        (p.name || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        (p.discord || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        (p.state || '').toLowerCase().includes(searchQuery.toLowerCase())
      )
    : profiles;

  // Sorting controls for users table
  const sortField = (queryParams.sort || 'cash').toLowerCase();
  const sortDir = (queryParams.dir || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';

  const compare = (a, b) => {
    const dir = sortDir === 'asc' ? 1 : -1;
    const byString = (x, y) => x.localeCompare(y) * dir;
    const byNum = (x, y) => (x - y) * dir;
    switch (sortField) {
      case 'name':
        return byString(String(a.name || ''), String(b.name || ''));
      case 'party':
        return byString(String(a.party || ''), String(b.party || ''));
      case 'state':
        return byString(String(a.state || ''), String(b.state || ''));
      case 'position':
        return byString(String(a.position || ''), String(b.position || ''));
      case 'last': // last seen text
        return byString(String(a.lastOnlineText || ''), String(b.lastOnlineText || ''));
      case 'es': {
        const aES = Number(String(a.es || '0').replace(/[^0-9.]/g, '')) || 0;
        const bES = Number(String(b.es || '0').replace(/[^0-9.]/g, '')) || 0;
        return byNum(aES, bES);
      }
      case 'cash': {
        const aCash = parseMoney(a.cash);
        const bCash = parseMoney(b.cash);
        return byNum(aCash, bCash);
      }
      default: { // fallback: cash then ES as before
        const aCash = parseMoney(a.cash);
        const bCash = parseMoney(b.cash);
        if (aCash !== bCash) return byNum(aCash, bCash);
        const aES = Number(String(a.es || '0').replace(/[^0-9.]/g, '')) || 0;
        const bES = Number(String(b.es || '0').replace(/[^0-9.]/g, '')) || 0;
        return byNum(aES, bES);
      }
    }
  };

  // Sort and paginate
  const sortedProfiles = filteredProfiles.sort(compare);

  const perPage = 10;
  const startIndex = (page - 1) * perPage;
  const endIndex = startIndex + perPage;
  const paginatedProfiles = sortedProfiles.slice(startIndex, endIndex);
  const totalPages = Math.ceil(sortedProfiles.length / perPage);

  // Calculate average online times by party
  const calculatePartyStats = (partyFilter) => {
    const partyProfiles = allProfiles.filter(p => {
      if (partyFilter === 'all') return true;
      const party = (p.party || '').toLowerCase();
      if (partyFilter === 'dem') return party.includes('democrat');
      if (partyFilter === 'gop') return party.includes('republican');
      return false;
    });

    const validProfiles = partyProfiles.filter(p => p.lastOnlineDays !== null && p.lastOnlineDays !== undefined);
    const avgOnlineDays = validProfiles.length > 0
      ? validProfiles.reduce((sum, p) => sum + (p.lastOnlineDays || 0), 0) / validProfiles.length
      : 0;

    return {
      count: partyProfiles.length,
      avgOnlineDays: Math.round(avgOnlineDays * 10) / 10, // Round to 1 decimal
      recentCount: partyProfiles.filter(p => p.lastOnlineDays !== null && p.lastOnlineDays !== undefined && p.lastOnlineDays < 3).length,
      activeCount: partyProfiles.filter(p => p.lastOnlineDays !== null && p.lastOnlineDays !== undefined && p.lastOnlineDays < 5).length
    };
  };

  const demStats = calculatePartyStats('dem');
  const gopStats = calculatePartyStats('gop');
  const allStats = calculatePartyStats('all');

  // Unique Discords count (by non-empty discord handle, case-insensitive)
  const uniqueDiscords = (() => {
    const set = new Set();
    for (const p of allProfiles) {
      const handle = (p.discord || '').trim().toLowerCase();
      if (handle) set.add(handle);
    }
    return set.size;
  })();

  // Calculate top stats (full lists) and helpers
  const getPageSlice = (items, pageNum, per) => {
    const start = (pageNum - 1) * per;
    return items.slice(start, start + per);
  };

  const topCashAll = sortedProfiles.map(p => ({
    name: p.name || 'Unknown',
    cash: parseMoney(p.cash),
    party: p.party || 'Unknown',
    state: p.state || 'Unknown'
  }));

  const topESAll = sortedProfiles
    .slice()
    .sort((a, b) => {
      const aES = Number(String(a.es || '0').replace(/[^0-9.]/g, '')) || 0;
      const bES = Number(String(b.es || '0').replace(/[^0-9.]/g, '')) || 0;
      return bES - aES;
    })
    .map(p => ({
      name: p.name || 'Unknown',
      es: Number(String(p.es || '0').replace(/[^0-9.]/g, '')) || 0,
      party: p.party || 'Unknown',
      state: p.state || 'Unknown'
    }));

  const topPPAll = sortedProfiles
    .slice()
    .sort((a, b) => {
      const aPP = parseMoney(a.cash) + (Number(String(a.es || '0').replace(/[^0-9.]/g, '')) || 0);
      const bPP = parseMoney(b.cash) + (Number(String(b.es || '0').replace(/[^0-9.]/g, '')) || 0);
      return bPP - aPP;
    })
    .map(p => ({
      name: p.name || 'Unknown',
      pp: parseMoney(p.cash) + (Number(String(p.es || '0').replace(/[^0-9.]/g, '')) || 0),
      party: p.party || 'Unknown',
      state: p.state || 'Unknown'
    }));

  const renderMiniPagination = (pager) => {
    if (!pager || pager.totalPages <= 1) return '';
    const params = new URLSearchParams(queryParams);
    params.delete('page');
    const baseParams = new URLSearchParams();
    for (const [k, v] of params.entries()) {
      if (k !== pager.queryKey && k !== 'top_per') baseParams.set(k, v);
    }
    const mkHref = (n) => `?${baseParams.toString()}&${pager.queryKey}=${n}&top_per=${pager.per}`;
    const prev = pager.current > 1
      ? `<a class="page-link" href="${mkHref(pager.current - 1)}">Prev</a>`
      : '<span class="page-link disabled">Prev</span>';
    const cur = `<span class="page-link active">${pager.current}</span>`;
    const next = pager.current < pager.totalPages
      ? `<a class="page-link" href="${mkHref(pager.current + 1)}">Next</a>`
      : '<span class="page-link disabled">Next</span>';
    return `<div class="pagination" style="margin-top:0.8rem">${prev}${cur}${next}</div>`;
  };

  // Slices for current pages
  const cashTotalPages = Math.max(1, Math.ceil(topCashAll.length / topPer));
  const esTotalPages = Math.max(1, Math.ceil(topESAll.length / topPer));
  const ppTotalPages = Math.max(1, Math.ceil(topPPAll.length / topPer));
  const topCash = getPageSlice(topCashAll, Math.min(cashPage, cashTotalPages), topPer);
  const topES = getPageSlice(topESAll, Math.min(esPage, esTotalPages), topPer);
  const topPP = getPageSlice(topPPAll, Math.min(ppPage, ppTotalPages), topPer);

  // Render top cards
  const renderTopCard = (title, items, valueKey, formatValue, pager) => `
    <section class="card">
      <header class="card-header">
        <div>
          <p class="eyebrow">Leaderboard</p>
          <h2>${escapeHtml(title)}</h2>
        </div>
      </header>
      <ul class="striped-list">
        ${items.map((item, i) => `
          <li>
            <span>${i + 1 + (pager ? (pager.current - 1) * pager.per : 0)}. ${escapeHtml(item.name)}</span>
            <span>${formatValue(item[valueKey])}</span>
          </li>
        `).join('')}
      </ul>
      ${renderMiniPagination(pager)}
    </section>
  `;

  // Render user table
  const userRows = paginatedProfiles.map(p => {
    const profileUrl = p.discord ? `https://discord.com/users/${p.discord}` : '#';
    const watchKey = (p.discord || p.name || '').replace(/"/g, '');
    const lastDays = typeof p.lastOnlineDays === 'number' ? p.lastOnlineDays : '';
    return `
      <tr data-watch-key="${escapeHtml(watchKey)}" data-last-days="${escapeHtml(String(lastDays))}">
        <td>
          <div class="user-info">
            <div>
              <button class="watch-btn" title="Toggle watch">☆</button>
              <strong>${p.discord ? `<a href="${profileUrl}" target="_blank">${escapeHtml(p.name || 'Unknown')}</a>` : escapeHtml(p.name || 'Unknown')}</strong>
            </div>
            <span class="muted">@${escapeHtml(p.discord || 'N/A')}</span>
          </div>
        </td>
        <td>${escapeHtml(p.party || 'Unknown')}</td>
        <td>${escapeHtml(p.state || 'Unknown')}</td>
        <td>${escapeHtml(p.position || 'Unknown')}</td>
        <td>${escapeHtml(p.cash || '$0')}</td>
        <td>${escapeHtml(p.es || '0')}</td>
        <td>${escapeHtml(p.co || '0%')}</td>
        <td>${escapeHtml(p.nr || '0%')}</td>
        <td>${formatLastSeen(p)}</td>
      </tr>
    `;
  }).join('');

  const refreshMeta = HTML_REFRESH_SECONDS > 0 ? `<meta http-equiv="refresh" content="${HTML_REFRESH_SECONDS}">` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  ${refreshMeta}
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DemBot Stats</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: "Poppins", "Inter", system-ui, -apple-system, sans-serif;
      background-color: #090b1a;
      color: #f8fafc;
    }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      padding: 3rem 1.5rem;
      background:
        radial-gradient(140% 80% at 0% 0%, rgba(252, 70, 107, 0.35) 0%, transparent 65%),
        radial-gradient(90% 90% at 100% 0%, rgba(63, 94, 251, 0.28) 15%, transparent 75%),
        linear-gradient(135deg, #050814 0%, #0e1329 55%, #121736 100%);
    }
    main {
      width: min(1400px, 100%);
    }
    .tabs {
      display: inline-flex;
      background: rgba(9, 11, 26, 0.82);
      padding: 0.4rem;
      border-radius: 12px;
      border: 1px solid rgba(148, 163, 184, 0.2);
      margin-bottom: 1.9rem;
      gap: 0.4rem;
    }
    .tabs a {
      text-decoration: none;
      color: rgba(226, 232, 240, 0.82);
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      font-size: 0.78rem;
      padding: 0.55rem 1.05rem;
      border-radius: 9px;
      transition: all 0.2s ease;
    }
    .tabs a:hover {
      color: #f8fafc;
      background: rgba(63, 94, 251, 0.22);
    }
    .tabs a.active {
      color: #0b1220;
      background: radial-gradient(circle at top left, rgba(196, 181, 253, 0.95), rgba(139, 92, 246, 0.82));
      box-shadow: 0 12px 26px rgba(99, 102, 241, 0.35);
    }
    .page-header {
      position: relative;
      overflow: hidden;
      border-radius: 18px;
      padding: 2.4rem 2rem;
      margin-bottom: 2.75rem;
      background: linear-gradient(135deg, rgba(63, 94, 251, 0.85), rgba(252, 70, 107, 0.92));
      box-shadow: 0 24px 45px rgba(15, 23, 42, 0.5);
    }
    .page-header h1 {
      margin: 0;
      font-size: clamp(2rem, 2vw + 1.25rem, 2.75rem);
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }
    .page-header p {
      margin: 0.45rem 0 0;
      color: rgba(248, 250, 252, 0.82);
    }
    .card {
      position: relative;
      margin-bottom: 2.1rem;
      padding: 1.9rem;
      border-radius: 18px;
      background: rgba(9, 11, 26, 0.92);
      border: 1px solid rgba(148, 163, 184, 0.16);
      box-shadow: 0 20px 45px rgba(6, 11, 38, 0.55);
    }
    .card-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 1.75rem;
      margin-bottom: 1.6rem;
    }
    .card-header h2 {
      margin: 0;
      font-size: 1.35rem;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }
    .eyebrow {
      text-transform: uppercase;
      letter-spacing: 0.28em;
      font-size: 0.7rem;
      color: rgba(129, 140, 248, 0.9);
      margin: 0 0 0.35rem;
    }
    .controls {
      display: flex;
      gap: 1rem;
      margin-bottom: 1.5rem;
      flex-wrap: wrap;
    }
    .filter-controls {
      display: flex;
      gap: 1rem;
      align-items: center;
      flex-wrap: wrap;
    }
    .filter-controls label {
      color: rgba(226, 232, 240, 0.9);
      font-size: 0.85rem;
    }
    .filter-controls select {
      padding: 0.5rem;
      border-radius: 8px;
      border: 1px solid rgba(148, 163, 184, 0.3);
      background: rgba(15, 25, 50, 0.7);
      color: #e2e8f0;
    }
    .search-input {
      flex: 1;
      min-width: 200px;
      padding: 0.5rem;
      border-radius: 8px;
      border: 1px solid rgba(148, 163, 184, 0.3);
      background: rgba(15, 25, 50, 0.7);
      color: #e2e8f0;
    }
    .grid-three {
      display: grid;
      gap: 1.4rem;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      margin-bottom: 1.6rem;
    }
    .striped-list {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    .striped-list li {
      display: flex;
      justify-content: space-between;
      padding: 0.45rem 0;
      border-bottom: 1px solid rgba(148, 163, 184, 0.18);
    }
    .striped-list li:last-child {
      border-bottom: none;
    }
    .table-scroll {
      overflow-x: auto;
      border-radius: 14px;
      border: 1px solid rgba(148, 163, 184, 0.18);
      background: rgba(10, 12, 22, 0.75);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 800px;
    }
    th, td {
      text-align: left;
      padding: 0.85rem 1.05rem;
      border-bottom: 1px solid rgba(148, 163, 184, 0.1);
      vertical-align: top;
    }
    th {
      font-size: 0.78rem;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: rgba(148, 163, 184, 0.7);
    }
    tbody tr:hover {
      background: rgba(63, 94, 251, 0.12);
    }
    .user-info a {
      color: rgba(139, 92, 246, 0.9);
      text-decoration: none;
    }
    .user-info a:hover {
      text-decoration: underline;
    }
    .pagination {
      display: flex;
      gap: 0.5rem;
      justify-content: center;
      margin-top: 1.5rem;
    }
    .pagination a, .pagination span {
      padding: 0.5rem 0.75rem;
      border-radius: 8px;
      border: 1px solid rgba(148, 163, 184, 0.3);
      text-decoration: none;
      color: rgba(226, 232, 240, 0.9);
      background: rgba(15, 25, 50, 0.7);
    }
    .pagination .active {
      background: rgba(139, 92, 246, 0.3);
      border-color: rgba(139, 92, 246, 0.6);
      color: #f8fafc;
    }
    .pagination .disabled {
      opacity: 0.5;
      pointer-events: none;
    }
    .muted {
      color: rgba(148, 163, 184, 0.85);
    }
    .watch-btn {
      margin-right: 0.5rem;
      background: transparent;
      border: 1px solid rgba(148, 163, 184, 0.3);
      color: rgba(226, 232, 240, 0.9);
      border-radius: 6px;
      cursor: pointer;
      padding: 0.1rem 0.4rem;
      font-size: 0.85rem;
    }
    .watch-btn.active {
      background: rgba(252, 211, 77, 0.25);
      border-color: rgba(252, 211, 77, 0.6);
      color: #fde68a;
    }
    tr.row-watch {
      background: rgba(252, 211, 77, 0.12);
    }
    .watch-controls {
      display: flex;
      gap: 1rem;
      align-items: center;
      flex-wrap: wrap;
      margin-top: 0.6rem;
    }
    .watch-controls input[type="number"] {
      width: 80px;
      padding: 0.35rem 0.5rem;
      border-radius: 8px;
      border: 1px solid rgba(148, 163, 184, 0.3);
      background: rgba(15, 25, 50, 0.7);
      color: #e2e8f0;
    }
    .card-alert.info {
      background: rgba(63, 94, 251, 0.12);
      color: rgba(191, 219, 254, 0.95);
      border-color: rgba(63, 94, 251, 0.35);
    }
  </style>
</head>
<body>
  <main>
    <nav class="tabs">
      <a href="/">Overview</a>
      <a class="active" href="/stats">Stats</a>
    </nav>
    <header class="page-header">
      <div>
        <h1>Power Play USA Statistics</h1>
        <p>Player rankings, party data, and user profiles</p>
      </div>
    </header>

    <!-- Top Cards (with independent pagination) -->
    <div class="grid-three">
      ${renderTopCard('Top Cash', topCash, 'cash', v => `$${v.toLocaleString()}`,{ current: cashPage, totalPages: cashTotalPages, per: topPer, queryKey: 'cash_page' })}
      ${renderTopCard('Top ES', topES, 'es', v => v.toLocaleString(),{ current: esPage, totalPages: esTotalPages, per: topPer, queryKey: 'es_page' })}
      ${renderTopCard('Top Political Power', topPP, 'pp', v => v.toLocaleString(),{ current: ppPage, totalPages: ppTotalPages, per: topPer, queryKey: 'pp_page' })}
    </div>

    <!-- Activity Cards -->
    <div class="grid-three">
      ${renderActivityCard('Democratic Party', demStats, 'dem')}
      ${renderActivityCard('Republican Party', gopStats, 'gop')}
      ${renderActivityCard('All Parties', allStats, 'all')}
    </div>

    <!-- Controls -->
    <div class="card">
      <div class="controls">
        <div class="filter-controls">
          <label>Filter by Party:</label>
          <select id="partyFilter">
            <option value="all" ${filterParty === 'all' ? 'selected' : ''}>All</option>
            <option value="dem" ${filterParty === 'dem' ? 'selected' : ''}>Democratic</option>
            <option value="gop" ${filterParty === 'gop' ? 'selected' : ''}>Republican</option>
          </select>
          <label>Activity Status:</label>
          <select id="activityFilter">
            <option value="all" ${activityFilter === 'all' ? 'selected' : ''}>All Players</option>
            <option value="recent" ${activityFilter === 'recent' ? 'selected' : ''}>Online &lt; 3 Days</option>
            <option value="active" ${activityFilter === 'active' ? 'selected' : ''}>Online &lt; 5 Days</option>
          </select>
          <label>Top Per Card:</label>
          <select id="topPer">
            <option value="3" ${topPer === 3 ? 'selected' : ''}>3</option>
            <option value="5" ${topPer === 5 ? 'selected' : ''}>5</option>
            <option value="10" ${topPer === 10 ? 'selected' : ''}>10</option>
          </select>
          <label>Sort Users By:</label>
          <select id="sortField">
            <option value="cash" ${sortField === 'cash' ? 'selected' : ''}>Cash</option>
            <option value="es" ${sortField === 'es' ? 'selected' : ''}>ES</option>
            <option value="name" ${sortField === 'name' ? 'selected' : ''}>Name</option>
            <option value="party" ${sortField === 'party' ? 'selected' : ''}>Party</option>
            <option value="state" ${sortField === 'state' ? 'selected' : ''}>State</option>
            <option value="position" ${sortField === 'position' ? 'selected' : ''}>Position</option>
            <option value="last" ${sortField === 'last' ? 'selected' : ''}>Last Seen (text)</option>
          </select>
          <select id="sortDir">
            <option value="desc" ${sortDir === 'desc' ? 'selected' : ''}>Desc</option>
            <option value="asc" ${sortDir === 'asc' ? 'selected' : ''}>Asc</option>
          </select>
          <label>Search:</label>
          <input type="text" class="search-input" id="searchInput" placeholder="Search by name, discord, or state..." value="${escapeHtml(searchQuery)}">
          <button onclick="applyFilters()">Apply</button>
        </div>
      </div>
    </div>

    <!-- User Table -->
    <div class="card">
      <header class="card-header">
        <div>
          <p class="eyebrow">Players</p>
          <h2>User Directory</h2>
        </div>
        <div class="badge-stack">
          <span class="pill pill-neutral">${sortedProfiles.length} total accounts</span>
          <span class="pill pill-ok">${uniqueDiscords} unique Discords</span>
        </div>
      </header>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Party</th>
              <th>State</th>
              <th>Position</th>
              <th>Cash</th>
              <th>ES</th>
              <th>CO</th>
              <th>NR</th>
              <th>Last Seen</th>
            </tr>
          </thead>
          <tbody>
            ${userRows || '<tr><td colspan="9" class="muted">No players found matching criteria</td></tr>'}
          </tbody>
        </table>
      </div>

      <!-- Pagination -->
      ${renderStatsPagination(page, totalPages, queryParams)}
    </div>
  </main>

  <script>
    function applyFilters() {
      const partyFilter = document.getElementById('partyFilter').value;
      const activityFilter = document.getElementById('activityFilter').value;
      const topPer = document.getElementById('topPer').value;
      const sortField = document.getElementById('sortField').value;
      const sortDir = document.getElementById('sortDir').value;
      const searchInput = document.getElementById('searchInput').value;
      const currentUrl = new URL(window.location);

      if (partyFilter !== 'all') {
        currentUrl.searchParams.set('party', partyFilter);
      } else {
        currentUrl.searchParams.delete('party');
      }

      if (activityFilter !== 'all') {
        currentUrl.searchParams.set('activity', activityFilter);
      } else {
        currentUrl.searchParams.delete('activity');
      }

      if (topPer && Number(topPer) !== 3) {
        currentUrl.searchParams.set('top_per', topPer);
      } else {
        currentUrl.searchParams.delete('top_per');
      }

      if (sortField && sortField !== 'cash') {
        currentUrl.searchParams.set('sort', sortField);
      } else {
        currentUrl.searchParams.delete('sort');
      }
      if (sortDir && sortDir !== 'desc') {
        currentUrl.searchParams.set('dir', sortDir);
      } else {
        currentUrl.searchParams.delete('dir');
      }

      if (searchInput.trim()) {
        currentUrl.searchParams.set('search', searchInput.trim());
      } else {
        currentUrl.searchParams.delete('search');
      }

      window.location.href = currentUrl.pathname + currentUrl.search;
    }

    document.getElementById('searchInput').addEventListener('keypress', function(e) {
      if (e.key === 'Enter') {
        applyFilters();
      }
    });
    
    // Watchlist handling
    (function(){
      var TABLE = document.querySelector('table tbody');
      if (!TABLE) return;
      var STORAGE_KEY = 'ppusa.watchlist';
      var SETTINGS_KEY = 'ppusa.watchlist.settings';
      function loadList(){
        try { return JSON.parse(localStorage.getItem(STORAGE_KEY)||'[]'); } catch(_) { return []; }
      }
      function saveList(list){
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch(_) {}
      }
      function loadSettings(){
        try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)||'{}'); } catch(_) { return {}; }
      }
      function saveSettings(s){
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch(_) {}
      }
      function setWatchActive(btn, active){
        if (!btn) return; btn.classList.toggle('active', !!active); btn.textContent = active ? '★' : '☆';
      }
      function refreshRows(){
        var list = loadList();
        var settings = loadSettings();
        var only = !!settings.only;
        var thr = Number(settings.threshold || 3);
        var alerts = [];
        var rows = TABLE.querySelectorAll('tr');
        rows.forEach(function(row){
          var key = row.getAttribute('data-watch-key')||'';
          var isWatched = list.indexOf(key) !== -1;
          row.classList.toggle('row-watch', isWatched);
          var btn = row.querySelector('.watch-btn');
          setWatchActive(btn, isWatched);
          if (only && !isWatched) {
            row.style.display = 'none';
          } else {
            row.style.display = '';
          }
          if (isWatched) {
            var days = Number(row.getAttribute('data-last-days')||'');
            if (Number.isFinite(days) && days >= thr) {
              var nameEl = row.querySelector('strong');
              alerts.push((nameEl?nameEl.textContent:'Unknown')+' inactive '+days+'d');
            }
          }
        });
        var alertBox = document.getElementById('watch-alerts');
        if (alertBox) {
          if (alerts.length) {
            alertBox.style.display = '';
            alertBox.textContent = 'Watch alerts: '+alerts.join(', ');
          } else {
            alertBox.style.display = 'none';
            alertBox.textContent = '';
          }
        }
      }
      TABLE.addEventListener('click', function(e){
        var btn = e.target.closest('.watch-btn');
        if (!btn) return;
        var row = btn.closest('tr');
        var key = row.getAttribute('data-watch-key');
        if (!key) return;
        var list = loadList();
        var idx = list.indexOf(key);
        if (idx === -1) list.push(key); else list.splice(idx,1);
        saveList(list);
        refreshRows();
      });
      // Inject controls into the filters card
      var filtersCard = document.querySelector('.card .controls');
      if (filtersCard) {
        var wrap = document.createElement('div');
        wrap.className = 'watch-controls';
        wrap.innerHTML = '\n          <label>Watch threshold (days): <input id="watch-threshold" type="number" min="1" step="1" value="3" /></label>\n          <label><input id="watch-only" type="checkbox" /> Show watchlist only</label>\n          <div id="watch-alerts" class="card-alert info" style="display:none"></div>\n        ';
        filtersCard.appendChild(wrap);
        var settings = loadSettings();
        var thrEl = wrap.querySelector('#watch-threshold');
        var onlyEl = wrap.querySelector('#watch-only');
        if (settings.threshold) thrEl.value = settings.threshold;
        if (settings.only) onlyEl.checked = true;
        thrEl.addEventListener('change', function(){ var s = loadSettings(); s.threshold = Number(thrEl.value)||3; saveSettings(s); refreshRows(); });
        onlyEl.addEventListener('change', function(){ var s = loadSettings(); s.only = !!onlyEl.checked; saveSettings(s); refreshRows(); });
      }
      refreshRows();
    })();

    // Filter presets (save/apply)
    (function(){
      var PRESETS_KEY = 'ppusa.stats.presets';
      function loadPresets(){ try { return JSON.parse(localStorage.getItem(PRESETS_KEY)||'{}'); } catch(_) { return {}; } }
      function savePresets(map){ try { localStorage.setItem(PRESETS_KEY, JSON.stringify(map)); } catch(_) {} }
      function buildUI(){
        var controls = document.querySelector('.card .controls');
        if (!controls) return;
        var wrap = document.createElement('div');
        wrap.className = 'watch-controls';
        wrap.innerHTML = '\n          <label>Preset name: <input id="preset-name" type="text" placeholder="e.g., Dem recent"/></label>\n          <button id="preset-save">Save preset</button>\n          <label>Presets: <select id="preset-select"></select></label>\n          <button id="preset-apply">Apply</button>\n          <button id="preset-delete">Delete</button>\n        ';
        controls.appendChild(wrap);
        return wrap;
      }
      function refreshSelect(root){
        var presets = loadPresets();
        var sel = root.querySelector('#preset-select');
        if (!sel) return;
        var keys = Object.keys(presets).sort();
        sel.innerHTML = keys.map(function(k){ return '<option value="'+k+'">'+k+'</option>'; }).join('');
      }
      var ui = buildUI();
      if (!ui) return;
      refreshSelect(ui);
      ui.querySelector('#preset-save').addEventListener('click', function(){
        var name = (ui.querySelector('#preset-name').value||'').trim();
        if (!name) return;
        var url = new URL(window.location.href);
        var search = url.search || '?';
        var presets = loadPresets();
        presets[name] = search;
        savePresets(presets);
        refreshSelect(ui);
      });
      ui.querySelector('#preset-apply').addEventListener('click', function(){
        var sel = ui.querySelector('#preset-select');
        var name = sel && sel.value; if (!name) return;
        var presets = loadPresets();
        var search = presets[name]; if (!search) return;
        window.location.href = window.location.pathname + search;
      });
      ui.querySelector('#preset-delete').addEventListener('click', function(){
        var sel = ui.querySelector('#preset-select');
        var name = sel && sel.value; if (!name) return;
        var presets = loadPresets();
        delete presets[name];
        savePresets(presets);
        refreshSelect(ui);
      });
    })();
  </script>
</body>
</html>`;
};

function getPartyActivitySnapshot() {
  const db = readProfiles();
  const allProfiles = db?.profiles ? Object.values(db.profiles) : [];

  const calc = (filter) => {
    const partyProfiles = allProfiles.filter(p => {
      if (filter === 'all') return true;
      const party = (p.party || '').toLowerCase();
      if (filter === 'dem') return party.includes('democrat');
      if (filter === 'gop') return party.includes('republican');
      return false;
    });
    const valid = partyProfiles.filter(p => p.lastOnlineDays !== null && p.lastOnlineDays !== undefined);
    const avg = valid.length ? valid.reduce((s, p) => s + (p.lastOnlineDays || 0), 0) / valid.length : 0;
    return {
      count: partyProfiles.length,
      avgOnlineDays: Math.round(avg * 10) / 10,
      recentCount: partyProfiles.filter(p => p.lastOnlineDays != null && p.lastOnlineDays < 3).length,
      activeCount: partyProfiles.filter(p => p.lastOnlineDays != null && p.lastOnlineDays < 5).length,
    };
  };

  return {
    updatedAt: db?.updatedAt || null,
    dem: calc('dem'),
    gop: calc('gop'),
    all: calc('all'),
  };
}

function renderStatsPagination(currentPage, totalPages, queryParams = {}) {
  if (totalPages <= 1) return '';

  const pages = [];
  for (let i = Math.max(1, currentPage - 2); i <= Math.min(totalPages, currentPage + 2); i++) {
    pages.push(i);
  }

  // Build query string from current params
  const queryString = Object.keys(queryParams)
    .filter(key => queryParams[key] && key !== 'page')
    .map(key => `${key}=${encodeURIComponent(queryParams[key])}`)
    .join('&');

  const baseUrl = queryString ? `?${queryString}&page=` : '?page=';

  return `
    <div class="pagination">
      ${currentPage > 1 ? `<a href="${baseUrl}${currentPage - 1}">Previous</a>` : '<span class="disabled">Previous</span>'}
      ${pages.map(p => `<a href="${baseUrl}${p}" class="${p === currentPage ? 'active' : ''}">${p}</a>`).join('')}
      ${currentPage < totalPages ? `<a href="${baseUrl}${currentPage + 1}">Next</a>` : '<span class="disabled">Next</span>'}
    </div>
  `;
}

function startDashboardServer({ port = 3000, host = '0.0.0.0' } = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`retry: 5000\n\n`);
      const client = { res };
      sseClients.add(client);
      // Send initial snapshot
      try { res.write(`data: ${JSON.stringify(getStatus())}\n\n`); } catch (_) {}
      req.on('close', () => { try { sseClients.delete(client); } catch(_) {} });
      return;
    }

    if (url.pathname === '/stats') {
      const queryParams = Object.fromEntries(url.searchParams);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderStatsPage(queryParams));
      return;
    }

    if (url.pathname === '/status.json') {
      const payload = JSON.stringify(getStatus());
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(payload);
      return;
    }

    if (url.pathname === '/stats.json') {
      const payload = JSON.stringify(getPartyActivitySnapshot());
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(payload);
      return;
    }

    if (url.pathname === '/heartbeat') {
      markHeartbeat();
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderHtml());
  });

  server.listen(port, host, () => {
    console.log(`🌐 Dashboard listening on http://${host}:${port}`);
  });

  server.on('error', (err) => {
    console.error('Dashboard server error:', err);
  });

  // Broadcast status periodically to SSE clients
  const ticker = setInterval(() => {
    if (!sseClients.size) return;
    const payload = JSON.stringify(getStatus());
    for (const { res } of sseClients) {
      try { res.write(`data: ${payload}\n\n`); } catch (_) { /* ignore */ }
    }
  }, SSE_BROADCAST_INTERVAL_MS);
  ticker.unref?.();

  return server;
}

module.exports = { startDashboardServer };
