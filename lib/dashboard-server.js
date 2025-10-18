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
  if (!ms || Number.isNaN(ms)) return '—';
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
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString();
  } catch (_) {
    return ts;
  }
};

const renderBotStatus = (bot) => {
  const statusBadge = bot.ready ? '🟢 Ready' : '🔴 Offline';
  const loginMessage = bot.loginError ? `<div class="warning">⚠️ Login error: ${escapeHtml(bot.loginError.message)}</div>` : '';
  return `
    <section>
      <h2>Bot Status</h2>
      <ul class="summary">
        <li><span>Status</span><strong>${statusBadge}</strong></li>
        <li><span>Ready Since</span><strong>${formatTimestamp(bot.readyAt)}</strong></li>
        <li><span>Last Heartbeat</span><strong>${formatTimestamp(bot.lastHeartbeat)}</strong></li>
        <li><span>Uptime</span><strong>${formatDuration(bot.uptimeMs)}</strong></li>
        <li><span>Host</span><strong>${os.hostname()}</strong></li>
      </ul>
      ${loginMessage}
    </section>
  `;
};

const renderCommandTable = (commands) => {
  if (!commands.length) {
    return `
      <section>
        <h2>Commands</h2>
        <p>No commands have been invoked yet.</p>
      </section>
    `;
  }

  const rows = commands
    .map((cmd) => {
      const errorClass = cmd.lastErrorAt ? ' class="has-error"' : '';
      return `
        <tr${errorClass}>
          <td>${escapeHtml(cmd.name)}</td>
          <td>${cmd.runCount}</td>
          <td>${cmd.successCount}</td>
          <td>${cmd.errorCount}</td>
          <td>${formatTimestamp(cmd.lastRunAt)}</td>
          <td>${formatTimestamp(cmd.lastSuccessAt)}</td>
          <td>${formatTimestamp(cmd.lastErrorAt)}</td>
          <td>${escapeHtml(cmd.lastErrorMessage || '')}</td>
        </tr>
      `;
    })
    .join('');

  return `
    <section>
      <h2>Commands</h2>
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
              <th>Last Error Message</th>
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
        <article>
          <header>
            <strong>${escapeHtml(err.command)}</strong>
            <span>${formatTimestamp(err.timestamp)}</span>
          </header>
          <pre>${escapeHtml(err.message)}</pre>
          ${err.stack ? `<details><summary>Stack Trace</summary><pre>${escapeHtml(err.stack)}</pre></details>` : ''}
        </article>
      `,
    )
    .join('');

  return `
    <section>
      <h2>Recent Errors</h2>
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
          font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
          background-color: #10131a;
          color: #e2e8f0;
        }
        body {
          margin: 0;
          padding: 2rem;
          max-width: 1100px;
        }
        h1 {
          margin-top: 0;
        }
        section {
          margin-bottom: 2rem;
          padding: 1.5rem;
          border-radius: 12px;
          background: #1f2937;
          box-shadow: inset 0 0 0 1px rgba(255,255,255,0.05);
        }
        .summary {
          list-style: none;
          padding: 0;
          margin: 0;
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
          gap: 0.5rem 1rem;
        }
        .summary li {
          display: flex;
          justify-content: space-between;
          gap: 1rem;
          padding: 0.35rem 0.5rem;
          border-radius: 6px;
          background: rgba(15, 23, 42, 0.6);
        }
        .summary span {
          color: #94a3b8;
        }
        .warning {
          margin-top: 1rem;
          padding: 0.75rem 1rem;
          background: rgba(234, 179, 8, 0.1);
          border-left: 4px solid #f59e0b;
          border-radius: 6px;
        }
        .table-scroll {
          overflow-x: auto;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          min-width: 600px;
        }
        th, td {
          text-align: left;
          padding: 0.6rem 0.75rem;
          border-bottom: 1px solid rgba(148, 163, 184, 0.2);
          vertical-align: top;
        }
        tr.has-error {
          background: rgba(220, 38, 38, 0.12);
        }
        article {
          padding: 0.75rem 1rem;
          border-radius: 8px;
          background: rgba(239, 68, 68, 0.12);
          margin-bottom: 0.75rem;
        }
        article header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 0.5rem;
          color: #fca5a5;
        }
        pre {
          margin: 0;
          white-space: pre-wrap;
          word-break: break-word;
          font-family: ui-monospace, SFMono-Regular, SFMono, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
          background: rgba(15, 23, 42, 0.6);
          padding: 0.5rem;
          border-radius: 6px;
        }
        details {
          margin-top: 0.5rem;
        }
      </style>
    </head>
    <body>
      <h1>DemBot Dashboard</h1>
      ${renderBotStatus(data.bot)}
      ${renderCommandTable(data.commands)}
      ${renderErrorLog(data.errors)}
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

