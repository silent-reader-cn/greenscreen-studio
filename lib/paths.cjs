/**
 * Shared data-directory layout for Greenscreen Studio.
 *
 * Layout:
 *   data/
 *     greenscreen.db
 *     projects/<id>/{sources,exports,artifacts}/
 *     mcp-sessions/
 *     mcp-events.ndjson
 *
 * Override with GSS_DATA_DIR (HTTP / Electron / MCP share the same root).
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function getDataDir() {
  if (process.env.GSS_DATA_DIR) return path.resolve(process.env.GSS_DATA_DIR);
  return path.join(PROJECT_ROOT, 'data');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function getDbPath(dataDir = getDataDir()) {
  return path.join(dataDir, 'greenscreen.db');
}

function getProjectsRoot(dataDir = getDataDir()) {
  return path.join(dataDir, 'projects');
}

function getProjectDir(projectId, dataDir = getDataDir()) {
  return path.join(getProjectsRoot(dataDir), String(projectId));
}

function getProjectSubdir(projectId, subdir, dataDir = getDataDir()) {
  return path.join(getProjectDir(projectId, dataDir), subdir);
}

function getMcpSessionsDir(dataDir = getDataDir()) {
  return path.join(dataDir, 'mcp-sessions');
}

function getMcpLogPath(dataDir = getDataDir()) {
  return path.join(dataDir, 'mcp-events.ndjson');
}

function getMcpEntry() {
  return path.join(PROJECT_ROOT, 'mcp', 'server.mjs');
}

function ensureDataLayout(dataDir = getDataDir()) {
  ensureDir(dataDir);
  ensureDir(getProjectsRoot(dataDir));
  ensureDir(getMcpSessionsDir(dataDir));
  return dataDir;
}

function ensureProjectDirs(projectId, dataDir = getDataDir()) {
  const root = ensureDir(getProjectDir(projectId, dataDir));
  ensureDir(path.join(root, 'sources'));
  ensureDir(path.join(root, 'exports'));
  ensureDir(path.join(root, 'artifacts'));
  return root;
}

module.exports = {
  PROJECT_ROOT,
  getDataDir,
  ensureDir,
  getDbPath,
  getProjectsRoot,
  getProjectDir,
  getProjectSubdir,
  getMcpSessionsDir,
  getMcpLogPath,
  getMcpEntry,
  ensureDataLayout,
  ensureProjectDirs,
};
