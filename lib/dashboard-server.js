const http = require('node:http');
const os = require('node:os');
const { getStatus, markHeartbeat } = require('./status-tracker');

const HTML_REFRESH_SECONDS = Number(process.env.STATUS_REFRESH_SECONDS || 20);

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

const renderBotStatus = (bot) => {
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
          <p class="stat-value">${formatTimestamp(bot.readyAt)}</p>
        </li>
        <li>
          <p class="stat-label">Last Heartbeat</p>
          <p class="stat-value">${formatTimestamp(bot.lastHeartbeat)}</p>
        </li>
        <li>
          <p class="stat-label">Uptime</p>
          <p class="stat-value">${formatDuration(bot.uptimeMs)}</p>
        </li>
        <li>
          <p class="stat-label">Host</p>
          <p class="stat-value">${escapeHtml(os.hostname())}</p>
        </li>
      </ul>
      ${loginMessage}
    </section>
  `;
};

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
      ${
        totals.latestError
          ? `<div class="card-alert card-alert--subtle">
              Latest error: ${escapeHtml(totals.latestError.name)} at ${formatTimestamp(totals.latestError.timestamp)}
            </div>`
          : ''
      }
      <div class="table-scroll">
        <table>
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
          font-family: "Segoe UI", "Inter", system-ui, -apple-system, sans-serif;
          background-color: #05060a;
          color: #e5e7eb;
        }
        body {
          margin: 0;
          min-height: 100vh;
          background: radial-gradient(circle at top left, rgba(79, 70, 229, 0.35), transparent 55%),
                      radial-gradient(circle at bottom right, rgba(16, 185, 129, 0.25), transparent 60%),
                      #05060a;
          display: flex;
          justify-content: center;
          padding: 3rem 1.5rem;
        }
        main {
          width: min(1100px, 100%);
        }
        header.page-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 1rem;
          margin-bottom: 2.5rem;
        }
        header.page-header h1 {
          margin: 0;
          font-size: clamp(1.75rem, 2vw + 1rem, 2.5rem);
        }
        header.page-header p {
          margin: 0.35rem 0 0;
          color: #94a3b8;
        }
        .badge-dot {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          padding: 0.4rem 0.75rem;
          background: rgba(148, 163, 184, 0.12);
          border-radius: 999px;
          font-size: 0.85rem;
          color: #e5e7eb;
        }
        .card {
          margin-bottom: 2rem;
          padding: 1.75rem;
          border-radius: 16px;
          background: rgba(15, 23, 42, 0.72);
          backdrop-filter: blur(18px);
          border: 1px solid rgba(148, 163, 184, 0.18);
          box-shadow: 0 20px 50px rgba(2, 6, 23, 0.35);
        }
        .card-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 1.5rem;
          margin-bottom: 1.5rem;
        }
        .card-header h2 {
          margin: 0;
        }
        .eyebrow {
          text-transform: uppercase;
          letter-spacing: 0.18em;
          font-size: 0.75rem;
          color: #6366f1;
          margin: 0 0 0.35rem;
        }
        .muted {
          color: #94a3b8;
        }
        .pill {
          display: inline-flex;
          align-items: center;
          gap: 0.45rem;
          font-size: 0.8rem;
          font-weight: 600;
          padding: 0.4rem 0.75rem;
          border-radius: 999px;
        }
        .pill-ok {
          background: rgba(34, 197, 94, 0.18);
          color: #bbf7d0;
          border: 1px solid rgba(34, 197, 94, 0.35);
        }
        .pill-warn {
          background: rgba(248, 113, 113, 0.12);
          color: #fecaca;
          border: 1px solid rgba(248, 113, 113, 0.35);
        }
        .pill-neutral {
          background: rgba(148, 163, 184, 0.16);
          color: #e5e7eb;
          border: 1px solid rgba(148, 163, 184, 0.2);
        }
        .badge-stack {
          display: flex;
          flex-wrap: wrap;
          gap: 0.5rem;
          justify-content: flex-end;
        }
        .table-scroll {
          overflow-x: auto;
          border-radius: 12px;
          border: 1px solid rgba(148, 163, 184, 0.12);
        }
        table {
          width: 100%;
          border-collapse: collapse;
          min-width: 600px;
          background: rgba(15, 23, 42, 0.85);
        }
        th, td {
          text-align: left;
          padding: 0.75rem 1rem;
          border-bottom: 1px solid rgba(148, 163, 184, 0.1);
          vertical-align: top;
        }
        tbody tr:hover {
          background: rgba(76, 29, 149, 0.12);
        }
        tr.row-warn {
          background: rgba(244, 63, 94, 0.12);
        }
        .cell-stack {
          display: flex;
          flex-direction: column;
          gap: 0.35rem;
        }
        .card-alert {
          margin-bottom: 1.25rem;
          padding: 0.8rem 1rem;
          border-radius: 10px;
          background: rgba(248, 113, 113, 0.12);
          color: #fecaca;
          border: 1px solid rgba(248, 113, 113, 0.3);
        }
        .card-alert--subtle {
          background: rgba(59, 130, 246, 0.12);
          color: #bfdbfe;
          border-color: rgba(59, 130, 246, 0.25);
        }
        .stat-grid {
          list-style: none;
          padding: 0;
          margin: 0;
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
          gap: 1rem;
        }
        .stat-label {
          margin: 0;
          font-size: 0.85rem;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: #94a3b8;
        }
        .stat-value {
          margin: 0.3rem 0 0;
          font-size: 1.05rem;
        }
        .timeline-item {
          position: relative;
          padding-left: 1.75rem;
          margin-bottom: 1.5rem;
        }
        .timeline-item:last-child {
          margin-bottom: 0;
        }
        .timeline-item header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 0.5rem;
          gap: 0.75rem;
        }
        .timeline-dot {
          position: absolute;
          left: 0.35rem;
          top: 0.4rem;
          width: 12px;
          height: 12px;
          border-radius: 50%;
          background: radial-gradient(circle, rgba(248, 113, 113, 1) 0%, rgba(248, 113, 113, 0.25) 60%);
          box-shadow: 0 0 12px rgba(248, 113, 113, 0.5);
        }
        .timeline-item::before {
          content: "";
          position: absolute;
          left: 0.9rem;
          top: 1.25rem;
          bottom: -1.5rem;
          width: 1px;
          background: linear-gradient(to bottom, rgba(148, 163, 184, 0.4), transparent);
        }
        .timeline-item:last-child::before {
          display: none;
        }
        pre {
          margin: 0;
          white-space: pre-wrap;
          word-break: break-word;
          font-family: ui-monospace, SFMono-Regular, SFMono, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
          background: rgba(15, 23, 42, 0.7);
          padding: 0.7rem;
          border-radius: 8px;
          border: 1px solid rgba(148, 163, 184, 0.12);
        }
        details {
          margin-top: 0.75rem;
        }
        details summary {
          cursor: pointer;
          color: #c4b5fd;
        }
        @media (max-width: 720px) {
          header.page-header {
            flex-direction: column;
            align-items: flex-start;
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
        <header class="page-header">
          <div>
            <span class="badge-dot">DemBot Monitoring</span>
            <h1>Operations Dashboard</h1>
            <p>Live view of bot health, command throughput, and recent issues.</p>
          </div>
        </header>
        ${renderBotStatus(data.bot)}
        ${renderCommandTable(data.commands)}
        ${renderErrorLog(data.errors)}
      </main>
    </body>
  </html>`;
};

function startDashboardServer({ port = 3000, host = '0.0.0.0' } = {}) {
  const server = http.createServer((req, res) => {
    if (req.url === '/status.json') {
      const payload = JSON.stringify(getStatus());
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(payload);
      return;
    }

    if (req.url === '/heartbeat') {
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

  return server;
}

module.exports = { startDashboardServer };
