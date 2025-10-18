const { performance } = require('node:perf_hooks');

const MAX_ERROR_LOG = 20;

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

function getStatus() {
  const commands = Array.from(status.commands.values())
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    bot: { ...status.bot },
    commands,
    errors: [...status.errors],
  };
}

module.exports = {
  markBotReady,
  markBotLoginError,
  markHeartbeat,
  recordCommandSuccess,
  recordCommandError,
  getStatus,
};
