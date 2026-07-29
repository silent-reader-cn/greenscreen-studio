/**
 * MCP session heartbeat + NDJSON event log for Greenscreen Studio.
 * Shared by HTTP API (status panel) and the stdio MCP server.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const {
  getDataDir,
  ensureDataLayout,
  getMcpSessionsDir,
  getMcpLogPath,
  getMcpEntry,
  PROJECT_ROOT,
} = require('./paths.cjs');

const HEARTBEAT_TIMEOUT_MS = 15000;
const DEFAULT_LOG_LIMIT = 100;
const MAX_LOG_LIMIT = 200;
const MAX_STRING_LENGTH = 1200;

function safeJson(value, depth = 0) {
  if (depth > 5) return '[truncated]';
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}...[truncated]`
      : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 30).map((item) => safeJson(item, depth + 1));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 40)
        .map(([key, item]) => [key, safeJson(item, depth + 1)]),
    );
  }
  return String(value);
}

function latestTimestamp(values) {
  return values
    .filter(Boolean)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function getMcpConfig({ dataDir = getDataDir() } = {}) {
  const serverName = 'greenscreen-studio';
  const command = process.execPath;
  const args = [getMcpEntry()];
  const env = { GSS_DATA_DIR: dataDir };
  if (process.versions.electron || process.env.ELECTRON_RUN_AS_NODE === '1') {
    env.ELECTRON_RUN_AS_NODE = '1';
  }

  const serverConfig = { command, args, env };
  const json = JSON.stringify({
    mcpServers: {
      [serverName]: serverConfig,
    },
  }, null, 2);
  const envLines = Object.entries(env)
    .map(([key, value]) => `${key} = ${tomlString(value)}`)
    .join('\n');
  const codex = [
    `[mcp_servers.${serverName}]`,
    `command = ${tomlString(command)}`,
    `args = [${args.map(tomlString).join(', ')}]`,
    '',
    `[mcp_servers.${serverName}.env]`,
    envLines,
  ].join('\n');

  return {
    serverName,
    command,
    args,
    env,
    entry: getMcpEntry(),
    projectRoot: PROJECT_ROOT,
    dataDir,
    formats: { json, codex },
  };
}

function createMcpRuntime({
  dataDir = getDataDir(),
  pid = process.pid,
  toolCount = 0,
  heartbeatIntervalMs = 5000,
  onEvent = null,
} = {}) {
  ensureDataLayout(dataDir);
  const startedAt = new Date().toISOString();
  const sessionId = `${pid}-${Date.now()}`;
  const filePath = path.join(getMcpSessionsDir(dataDir), `${sessionId}.json`);
  let sequence = 0;
  let heartbeatTimer = null;
  let queue = Promise.resolve();
  let state = {
    sessionId,
    pid,
    connected: true,
    startedAt,
    lastSeenAt: startedAt,
    lastActivityAt: null,
    lastTool: null,
    toolCount,
  };

  function enqueue(operation) {
    queue = queue.then(operation, operation);
    return queue;
  }

  function writeState(patch = {}) {
    state = { ...state, ...patch };
    const snapshot = { ...state };
    return enqueue(async () => {
      await fsp.mkdir(getMcpSessionsDir(dataDir), { recursive: true });
      await fsp.writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf8');
    });
  }

  function record({
    level = 'info',
    type = 'lifecycle',
    phase = null,
    tool = null,
    message,
    durationMs = null,
    projectId = null,
    taskId = null,
    jobId = null,
    dataChanged = false,
    details = null,
  }) {
    const timestamp = new Date().toISOString();
    const entry = {
      id: `${sessionId}-${timestamp}-${sequence++}`,
      timestamp,
      sessionId,
      level,
      type,
      phase,
      tool,
      message,
      durationMs,
      projectId,
      taskId,
      jobId,
      dataChanged,
      details: safeJson(details),
    };
    return enqueue(async () => {
      await fsp.mkdir(dataDir, { recursive: true });
      await fsp.appendFile(getMcpLogPath(dataDir), `${JSON.stringify(entry)}\n`, 'utf8');
      if (typeof onEvent === 'function') {
        try { onEvent(entry); } catch { /* ignore listener errors */ }
      }
    }).then(() => entry);
  }

  async function start() {
    await writeState();
    await record({ message: 'MCP client connected' });
    heartbeatTimer = setInterval(() => {
      void writeState({ lastSeenAt: new Date().toISOString() });
    }, heartbeatIntervalMs);
    heartbeatTimer.unref?.();
  }

  async function touch(patch = {}) {
    const now = new Date().toISOString();
    await writeState({ lastSeenAt: now, lastActivityAt: now, ...patch });
  }

  async function stop(reason = 'client disconnected') {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    const stoppedAt = new Date().toISOString();
    await writeState({ connected: false, lastSeenAt: stoppedAt, stoppedAt });
    await record({ message: reason });
  }

  return { sessionId, start, stop, touch, record, getState: () => ({ ...state }) };
}

async function readMcpLogs({ dataDir = getDataDir(), limit = DEFAULT_LOG_LIMIT } = {}) {
  const safeLimit = Math.min(MAX_LOG_LIMIT, Math.max(1, Number(limit) || DEFAULT_LOG_LIMIT));
  try {
    const content = await fsp.readFile(getMcpLogPath(dataDir), 'utf8');
    return content
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean)
      .slice(-safeLimit);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function listSessionFiles(dataDir = getDataDir()) {
  const dir = getMcpSessionsDir(dataDir);
  try {
    const names = await fsp.readdir(dir);
    const sessions = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = await fsp.readFile(path.join(dir, name), 'utf8');
        sessions.push(JSON.parse(raw));
      } catch {
        // ignore corrupt session files
      }
    }
    return sessions;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function getMcpStatus({ dataDir = getDataDir(), now = Date.now() } = {}) {
  const sessions = await listSessionFiles(dataDir);
  const live = sessions.filter((session) => {
    if (!session?.connected) return false;
    const last = Date.parse(session.lastSeenAt || session.startedAt || 0);
    return Number.isFinite(last) && (now - last) <= HEARTBEAT_TIMEOUT_MS;
  });
  const lastSeenAt = latestTimestamp(sessions.map((s) => s.lastSeenAt || s.startedAt));
  const lastActivityAt = latestTimestamp(sessions.map((s) => s.lastActivityAt).filter(Boolean));
  const lastTool = live.map((s) => s.lastTool).filter(Boolean).at(-1)
    || sessions.map((s) => s.lastTool).filter(Boolean).at(-1)
    || null;

  return {
    state: live.length > 0 ? 'connected' : 'disconnected',
    connected: live.length > 0,
    activeSessionCount: live.length,
    sessionCount: sessions.length,
    lastSeenAt,
    lastActivityAt,
    lastTool,
    toolCount: live.reduce((sum, s) => sum + (Number(s.toolCount) || 0), 0) || sessions.at(-1)?.toolCount || 0,
    sessions: live.map((s) => ({
      sessionId: s.sessionId,
      pid: s.pid,
      startedAt: s.startedAt,
      lastSeenAt: s.lastSeenAt,
      lastActivityAt: s.lastActivityAt || null,
      lastTool: s.lastTool || null,
    })),
  };
}

/**
 * Lightweight process-local event bus for SSE fan-out.
 * MCP stdio processes write NDJSON; HTTP server tails + also emits its own API events.
 */
function createEventBus() {
  const listeners = new Set();
  return {
    publish(event) {
      for (const listener of listeners) {
        try { listener(event); } catch { /* ignore */ }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    listenerCount() {
      return listeners.size;
    },
  };
}

/**
 * Tail mcp-events.ndjson and publish new lines.
 * Useful when MCP runs as a separate process.
 */
function startMcpLogTailer({
  dataDir = getDataDir(),
  onEvent,
  intervalMs = 1000,
} = {}) {
  ensureDataLayout(dataDir);
  const logPath = getMcpLogPath(dataDir);
  let offset = 0;
  let buffer = '';
  let timer = null;
  let stopped = false;
  const seen = new Set();

  async function tick() {
    if (stopped) return;
    try {
      const stat = await fsp.stat(logPath).catch((err) => {
        if (err.code === 'ENOENT') return null;
        throw err;
      });
      if (!stat) return;
      if (stat.size < offset) {
        offset = 0;
        buffer = '';
      }
      if (stat.size === offset) return;
      const fh = await fsp.open(logPath, 'r');
      try {
        const length = stat.size - offset;
        const buf = Buffer.alloc(length);
        await fh.read(buf, 0, length, offset);
        offset = stat.size;
        buffer += buf.toString('utf8');
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let entry;
          try { entry = JSON.parse(line); } catch { continue; }
          if (entry?.id && seen.has(entry.id)) continue;
          if (entry?.id) {
            seen.add(entry.id);
            if (seen.size > 2000) {
              const first = seen.values().next().value;
              seen.delete(first);
            }
          }
          onEvent?.(entry);
        }
      } finally {
        await fh.close();
      }
    } catch {
      // swallow transient read errors
    }
  }

  timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref?.();
  void tick();

  return {
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

function appendHttpEvent(dataDir, entry) {
  ensureDataLayout(dataDir);
  const full = {
    id: entry.id || `http-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: entry.timestamp || new Date().toISOString(),
    sessionId: entry.sessionId || 'http',
    level: entry.level || 'info',
    type: entry.type || 'http',
    phase: entry.phase || null,
    tool: entry.tool || null,
    message: entry.message || '',
    durationMs: entry.durationMs ?? null,
    projectId: entry.projectId || null,
    taskId: entry.taskId || null,
    jobId: entry.jobId || null,
    dataChanged: Boolean(entry.dataChanged),
    details: safeJson(entry.details || null),
  };
  fs.appendFileSync(getMcpLogPath(dataDir), `${JSON.stringify(full)}\n`, 'utf8');
  return full;
}

module.exports = {
  HEARTBEAT_TIMEOUT_MS,
  DEFAULT_LOG_LIMIT,
  MAX_LOG_LIMIT,
  safeJson,
  getMcpConfig,
  createMcpRuntime,
  readMcpLogs,
  getMcpStatus,
  listSessionFiles,
  createEventBus,
  startMcpLogTailer,
  appendHttpEvent,
};
