const http = require('node:http');
const os = require('node:os');
const { getStatus, markHeartbeat } = require('./status-tracker');
const fs = require('node:fs');
const path = require('node:path');

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
        <li>
          <p class="stat-label">Load (1m)</p>
          <p class="stat-value">${metrics?.samples?.length ? (metrics.samples[metrics.samples.length - 1].load1 || 0).toFixed(2) : '—'}</p>
        </li>
        <li>
          <p class="stat-label">Memory (RSS)</p>
          <p class="stat-value">${metrics?.samples?.length ? (metrics.samples[metrics.samples.length - 1].rssMB + ' MB') : '—'}</p>
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
          letter-spacing: 0.08em;
          text-transform: uppercase;
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
        ${renderCommandTable(data.commands)}
        ${renderErrorLog(data.errors)}
      </main>
    </body>
  </html>`;
};

function readProfiles() {
  try {
    const p = path.join(process.cwd(), 'data', 'profiles.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) { return null; }
}

function parseMoney(str) { if (!str) return 0; const n = Number(String(str).replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? n : 0; }

const renderStatsPage = () => {
  const db = readProfiles();
  const profiles = db?.profiles ? Object.values(db.profiles) : [];
  const byParty = profiles.reduce((acc, p) => { const k = (p.party || 'Unknown'); if (!acc[k]) acc[k] = { count: 0, cash: 0, list: [] }; acc[k].count++; acc[k].cash += parseMoney(p.cash); acc[k].list.push(p); return acc; }, {});
  const all = profiles;
  const topBy = (arr, key, mapVal=(x)=>x)=> arr.map(p=>({p,v:mapVal(p[key])})).sort((a,b)=> (b.v||0)-(a.v||0)).slice(0,10).map(o=>o.p);
  const topCash = topBy(all, 'cash', parseMoney);
  const topES = topBy(all, 'es', v=>Number(String(v).replace(/[^0-9.]/g,'')));
  const listPos = (re)=> all.filter(p=> re.test(p.position||''));
  const senators = listPos(/Senator/i).slice(0,100);
  const governors = listPos(/Governor/i).slice(0,100);
  const reps = listPos(/Representative/i).slice(0,100);
  const renderList = (title, arr, val)=> `<section class="card"><header class="card-header"><div><p class="eyebrow">Ranking</p><h2>${escapeHtml(title)}</h2></div></header><div class="table-scroll"><table><thead><tr><th>#</th><th>Name</th><th>Party</th><th>State</th><th>Value</th></tr></thead><tbody>${arr.map((p,i)=>`<tr><td>${i+1}</td><td>${escapeHtml(p.name||'')}</td><td>${escapeHtml(p.party||'')}</td><td>${escapeHtml(p.state||'')}</td><td>${escapeHtml(val(p))}</td></tr>`).join('')}</tbody></table></div></section>`;
  const partyCards = Object.entries(byParty).map(([k,v])=> `<section class="card"><header class="card-header"><div><p class="eyebrow">Party</p><h2>${escapeHtml(k)}</h2></div><div class="badge-stack"><span class="pill pill-neutral">${v.count} members</span><span class="pill pill-ok">$${v.cash.toLocaleString()}</span></div></header></section>`).join('');
  const refreshMeta = HTML_REFRESH_SECONDS > 0 ? `<meta http-equiv="refresh" content="${HTML_REFRESH_SECONDS}">` : '';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">${refreshMeta}<meta name="viewport" content="width=device-width, initial-scale=1"><title>DemBot Stats</title></head><body><main><nav class="tabs"><a href="/">Overview</a><a class="active" href="/stats">Stats</a></nav><header class="page-header"><div><span class="badge-dot">DemBot Monitoring</span><h1>Statistics</h1><p>Derived from profiles.json</p></div></header>${partyCards}${renderList('Top Cash', topCash, p=>String(p.cash||''))}${renderList('Top ES', topES, p=>String(p.es||''))}${renderList('Senators', senators, ()=>'-')}${renderList('Governors', governors, ()=>'-')}${renderList('Representatives', reps, ()=>'-')}</main></body></html>`;
};

function startDashboardServer({ port = 3000, host = '0.0.0.0' } = {}) {
  const server = http.createServer((req, res) => {
    if (req.url === '/stats') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(renderStatsPage()); return; }
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
