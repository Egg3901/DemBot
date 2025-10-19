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
      lastErrorMeta: null,
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
  entry.lastErrorMeta = null;
  status.metrics.cmdCountTotal += 1;
  markHeartbeat();
}

const metaReplacer = (_, value) => {
  if (value instanceof Error) {
    return { message: value.message, stack: value.stack };
  }
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    return Number.isFinite(asNumber) ? asNumber : value.toString();
  }
  if (value && typeof value === 'object' && typeof value.toJSON === 'function') {
    try { return value.toJSON(); } catch (_) { return String(value); }
  }
  return value;
};

function sanitizeMeta(meta) {
  if (meta === undefined || meta === null) return null;
  if (typeof meta === 'string' || typeof meta === 'number' || typeof meta === 'boolean') return meta;
  try {
    return JSON.parse(JSON.stringify(meta, metaReplacer));
  } catch (_) {
    try { return JSON.parse(JSON.stringify(String(meta))); } catch (_) { return String(meta); }
  }
}

function recordCommandError(name, error, meta) {
  const entry = ensureCommand(name);
  entry.runCount += 1;
  entry.errorCount += 1;
  entry.lastRunAt = nowIso();
  entry.lastErrorAt = entry.lastRunAt;
  entry.lastErrorMessage = error?.message ?? String(error);
  const cleanMeta = sanitizeMeta(meta);
  entry.lastErrorMeta = cleanMeta || null;

  status.errors.unshift({
    command: name,
    message: entry.lastErrorMessage,
    stack: error?.stack ?? null,
    meta: cleanMeta || null,
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
        status.commands.set(c.name, {
          ...c,
          lastErrorMeta: c.lastErrorMeta ?? null,
        });
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

// Ensure we persist on graceful shutdown, and also actually exit on signals
try {
  // Persist on normal exits triggered by the event loop draining
  process.on('beforeExit', () => { try { persistNow(); } catch (_) {} });
  // Persist on exit just before process termination
  process.on('exit', () => { try { persistNow(); } catch (_) {} });

  // If we install SIGINT/SIGTERM handlers, Node will NOT exit by default.
  // So we persist and then explicitly exit to restore expected Ctrl+C behavior.
  process.once('SIGINT', () => {
    try { persistNow(); } catch (_) {}
    try { process.exit(130); } catch (_) {}
  });
  process.once('SIGTERM', () => {
    try { persistNow(); } catch (_) {}
    try { process.exit(143); } catch (_) {}
  });
} catch (_) {}
