const { performance } = require('node:perf_hooks');
const fs = require('node:fs');
const path = require('node:path');

const MAX_ERROR_LOG = 50;
const PERSIST_PATH = path.join(process.cwd(), 'data', 'status.json');
const METRIC_SAMPLES_MAX = 1440; // store up to 24h at 1/min

let readyPerf = null;

const status = {
  bot: {
    ready: false,
    readyAt: null,
    loginError: null,
    uptimeMs: 0,
    lastHeartbeat: null,
  },
  commands: new Map(),
  errors: [],
  metrics: {
    samples: [], // { ts, rssMB, heapMB, load1, cmdCountTotal }
    cmdCountTotal: 0,
  },
};

const nowIso = () => new Date().toISOString();

function markHeartbeat() {
  status.bot.lastHeartbeat = nowIso();
  if (readyPerf !== null) status.bot.uptimeMs = Math.max(0, Math.round(performance.now() - readyPerf));
}

function markBotReady() {
  status.bot.ready = true;
  status.bot.readyAt = nowIso();
  status.bot.loginError = null;
  readyPerf = performance.now();
  status.bot.uptimeMs = 0;
  markHeartbeat();
}

function markBotLoginError(error) {
  status.bot.ready = false;
  status.bot.loginError = {
    message: error?.message ?? String(error),
    timestamp: nowIso(),
  };
  readyPerf = null;
  status.bot.uptimeMs = 0;
  markHeartbeat();
}

function ensureCommand(name) {
  if (!status.commands.has(name)) {
    status.commands.set(name, {
      name,
      runCount: 0,
      successCount: 0,
      errorCount: 0,
      lastRunAt: null,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastErrorMessage: null,
    });
  }
  return status.commands.get(name);
}

function recordCommandSuccess(name) {
  const entry = ensureCommand(name);
  entry.runCount += 1;
  entry.successCount += 1;
  entry.lastRunAt = nowIso();
  entry.lastSuccessAt = entry.lastRunAt;
  entry.lastErrorMessage = null;
  status.metrics.cmdCountTotal += 1;
  markHeartbeat();
}

function recordCommandError(name, error) {
  const entry = ensureCommand(name);
  entry.runCount += 1;
  entry.errorCount += 1;
  entry.lastRunAt = nowIso();
  entry.lastErrorAt = entry.lastRunAt;
  entry.lastErrorMessage = error?.message ?? String(error);

  status.errors.unshift({
    command: name,
    message: entry.lastErrorMessage,
    stack: error?.stack ?? null,
    timestamp: entry.lastErrorAt,
  });
  if (status.errors.length > MAX_ERROR_LOG) status.errors.length = MAX_ERROR_LOG;
  markHeartbeat();
}

function ensureDataDir() {
  const dir = path.dirname(PERSIST_PATH);
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
}

function loadPersisted() {
  try {
    ensureDataDir();
    if (!fs.existsSync(PERSIST_PATH)) return;
    const raw = fs.readFileSync(PERSIST_PATH, 'utf8');
    const saved = JSON.parse(raw);
    if (saved?.commands && Array.isArray(saved.commands)) {
      status.commands = new Map();
      for (const c of saved.commands) {
        status.commands.set(c.name, { ...c });
      }
    }
    if (Array.isArray(saved.errors)) status.errors = saved.errors.slice(0, MAX_ERROR_LOG);
    if (saved.metrics) status.metrics = { samples: saved.metrics.samples?.slice(-METRIC_SAMPLES_MAX) || [], cmdCountTotal: saved.metrics.cmdCountTotal || 0 };
  } catch (_) {}
}

function persistNow() {
  try {
    ensureDataDir();
    const commands = Array.from(status.commands.values()).sort((a, b) => a.name.localeCompare(b.name));
    const payload = {
      commands,
      errors: status.errors,
      metrics: { samples: status.metrics.samples.slice(-METRIC_SAMPLES_MAX), cmdCountTotal: status.metrics.cmdCountTotal },
      bot: status.bot,
      savedAt: nowIso(),
    };
    fs.writeFileSync(PERSIST_PATH, JSON.stringify(payload, null, 2));
  } catch (_) {}
}

function sampleRuntime(osModule = require('node:os')) {
  try {
    const mem = process.memoryUsage();
    const rssMB = Math.round((mem.rss || 0) / (1024 * 1024));
    const heapMB = Math.round((mem.heapUsed || 0) / (1024 * 1024));
    const [l1] = osModule.loadavg ? osModule.loadavg() : [0];
    const point = { ts: nowIso(), rssMB, heapMB, load1: Number(l1 || 0), cmdCountTotal: status.metrics.cmdCountTotal };
    status.metrics.samples.push(point);
    if (status.metrics.samples.length > METRIC_SAMPLES_MAX) status.metrics.samples.shift();
  } catch (_) {}
}

function getStatus() {
  const commands = Array.from(status.commands.values())
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    bot: { ...status.bot },
    commands,
    errors: [...status.errors],
    metrics: { ...status.metrics, samples: status.metrics.samples.slice(-120) },
  };
}

module.exports = {
  markBotReady,
  markBotLoginError,
  markHeartbeat,
  recordCommandSuccess,
  recordCommandError,
  getStatus,
  persistNow,
  loadPersisted,
  sampleRuntime,
};

// Initialize: load persisted state and set up persistence on interval and process exit
try { loadPersisted(); } catch (_) {}
setInterval(() => { try { persistNow(); } catch (_) {} }, 60_000).unref();
['SIGINT', 'SIGTERM', 'beforeExit', 'exit'].forEach((evt) => {
  try {
    process.on(evt, () => {
      try { persistNow(); } catch (_) {}
    });
  } catch (_) {}
});
