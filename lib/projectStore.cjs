/**
 * SQLite project store for Greenscreen Studio.
 * Uses Node's built-in node:sqlite (DatabaseSync).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const {
  getDataDir,
  getDbPath,
  ensureDataLayout,
  ensureProjectDirs,
  getProjectSubdir,
} = require('./paths.cjs');

const PROJECT_STATUSES = new Set(['active', 'archived']);
const ASSET_KINDS = new Set(['image', 'video', 'export', 'godot_bundle', 'spritesheet', 'other']);
const ASSET_ROLES = new Set(['source', 'export', 'preview', 'artifact', 'note']);
const JOB_STATUSES = new Set(['queued', 'running', 'done', 'error', 'cancelled']);
const TASK_STATUSES = new Set(['open', 'claimed', 'in_progress', 'needs_review', 'done', 'blocked', 'cancelled']);
const TASK_PRIORITIES = new Set(['high', 'normal', 'low']);
const CLIP_STATUSES = new Set(['draft', 'needs_review', 'approved', 'exported', 'verified_in_game', 'rejected']);
const MARKER_TYPES = new Set([
  'clip_start',
  'clip_end',
  'loop_start',
  'loop_end',
  'windup_end',
  'active_start',
  'hit',
  'active_end',
  'recovery_start',
  'cancel_open',
  'sfx',
  'vfx',
  'camera',
  'note',
]);

let sharedDb = null;
let sharedDbPath = null;

function nowIso() {
  return new Date().toISOString();
}

function createId(prefix = 'id') {
  if (typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function parseJson(value, fallback = null) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function toJson(value) {
  if (value == null) return null;
  return JSON.stringify(value);
}

function toFrame(value, fallback = 0) {
  const frame = Math.round(Number(value));
  return Number.isFinite(frame) && frame >= 0 ? frame : fallback;
}

function normalizeClipStatus(status, fallback = 'draft') {
  return CLIP_STATUSES.has(status) ? status : fallback;
}

function normalizeMarkerType(type, fallback = 'note') {
  return MARKER_TYPES.has(type) ? type : fallback;
}

function openDatabase(options = {}) {
  const dataDir = ensureDataLayout(options.dataDir || getDataDir());
  const dbPath = options.dbPath || getDbPath(dataDir);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return { db, dataDir, dbPath };
}

function getStore(options = {}) {
  const dataDir = ensureDataLayout(options.dataDir || getDataDir());
  const dbPath = options.dbPath || getDbPath(dataDir);
  if (options.db) {
    migrate(options.db);
    return { db: options.db, dataDir, dbPath };
  }
  if (!options.fresh && sharedDb && sharedDbPath === dbPath) {
    return { db: sharedDb, dataDir, dbPath };
  }
  const opened = openDatabase({ dataDir, dbPath });
  if (!options.fresh) {
    sharedDb = opened.db;
    sharedDbPath = opened.dbPath;
  }
  return opened;
}

function closeShared() {
  if (sharedDb) {
    try { sharedDb.close(); } catch { /* ignore */ }
    sharedDb = null;
    sharedDbPath = null;
  }
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      character_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      params_json TEXT,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'source',
      path TEXT NOT NULL,
      original_name TEXT NOT NULL DEFAULT '',
      mime_type TEXT NOT NULL DEFAULT '',
      meta_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      progress_json TEXT,
      request_json TEXT,
      result_json TEXT,
      error TEXT,
      source TEXT NOT NULL DEFAULT 'api',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS action_clips (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      start_frame INTEGER NOT NULL,
      end_frame INTEGER NOT NULL,
      loop INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      params_json TEXT,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS action_markers (
      id TEXT PRIMARY KEY,
      clip_id TEXT NOT NULL,
      frame INTEGER NOT NULL,
      type TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      payload_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(clip_id) REFERENCES action_clips(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS collab_tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      assignee TEXT NOT NULL DEFAULT 'ai',
      priority TEXT NOT NULL DEFAULT 'normal',
      payload_json TEXT,
      result_json TEXT,
      claimed_by TEXT,
      claimed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS collab_messages (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT,
      author TEXT NOT NULL,
      body TEXT NOT NULL,
      meta_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY(task_id) REFERENCES collab_tasks(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_assets_project ON assets(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_clips_asset ON action_clips(asset_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_clips_project ON action_clips(project_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_markers_clip ON action_markers(clip_id, frame);
    CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON collab_tasks(project_id, status, priority, updated_at);
    CREATE INDEX IF NOT EXISTS idx_messages_project ON collab_messages(project_id, created_at);
  `);
}

function mapProject(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    characterName: row.character_name || '',
    status: row.status,
    params: parseJson(row.params_json, {}),
    notes: row.notes || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAsset(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    role: row.role,
    path: row.path,
    originalName: row.original_name || '',
    mimeType: row.mime_type || '',
    meta: parseJson(row.meta_json, {}),
    createdAt: row.created_at,
  };
}

function mapJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id || null,
    kind: row.kind,
    status: row.status,
    progress: parseJson(row.progress_json, null),
    request: parseJson(row.request_json, null),
    result: parseJson(row.result_json, null),
    error: row.error || null,
    source: row.source || 'api',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapActionClip(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    assetId: row.asset_id,
    name: row.name,
    status: row.status,
    startFrame: row.start_frame,
    endFrame: row.end_frame,
    loop: Boolean(row.loop),
    version: row.version,
    params: parseJson(row.params_json, {}),
    notes: row.notes || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapActionMarker(row) {
  if (!row) return null;
  return {
    id: row.id,
    clipId: row.clip_id,
    frame: row.frame,
    type: row.type,
    label: row.label || '',
    payload: parseJson(row.payload_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description || '',
    status: row.status,
    assignee: row.assignee || 'ai',
    priority: row.priority || 'normal',
    payload: parseJson(row.payload_json, {}),
    result: parseJson(row.result_json, null),
    claimedBy: row.claimed_by || null,
    claimedAt: row.claimed_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id || null,
    author: row.author,
    body: row.body,
    meta: parseJson(row.meta_json, {}),
    createdAt: row.created_at,
  };
}

function createProjectStore(options = {}) {
  const { db, dataDir, dbPath } = getStore(options);
  let closed = false;

  function close() {
    if (closed) return;
    closed = true;
    try { db.close(); } catch { /* ignore */ }
    if (sharedDb === db) {
      sharedDb = null;
      sharedDbPath = null;
    }
  }

  function listProjects({ status = 'active', includeArchived = false } = {}) {
    let rows;
    if (includeArchived || status === 'all') {
      rows = db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all();
    } else {
      rows = db.prepare('SELECT * FROM projects WHERE status = ? ORDER BY updated_at DESC').all(status);
    }
    return rows.map(mapProject);
  }

  function getProject(id, { withCounts = false } = {}) {
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    const project = mapProject(row);
    if (!project || !withCounts) return project;
    const assets = db.prepare('SELECT COUNT(*) AS c FROM assets WHERE project_id = ?').get(id).c;
    const jobs = db.prepare('SELECT COUNT(*) AS c FROM jobs WHERE project_id = ?').get(id).c;
    const openTasks = db.prepare(
      "SELECT COUNT(*) AS c FROM collab_tasks WHERE project_id = ? AND status IN ('open','claimed','in_progress','needs_review','blocked')"
    ).get(id).c;
    return {
      ...project,
      counts: {
        assets: Number(assets) || 0,
        jobs: Number(jobs) || 0,
        openTasks: Number(openTasks) || 0,
      },
    };
  }

  function createProject({ name, description = '', characterName = '', params = {}, notes = '' } = {}) {
    const trimmed = String(name || '').trim();
    if (!trimmed) {
      const err = new Error('project name is required');
      err.code = 'PROJECT_NAME_REQUIRED';
      throw err;
    }
    const id = createId('proj');
    const ts = nowIso();
    db.prepare(`
      INSERT INTO projects (id, name, description, character_name, status, params_json, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)
    `).run(
      id,
      trimmed,
      String(description || ''),
      String(characterName || ''),
      toJson(params || {}),
      String(notes || ''),
      ts,
      ts,
    );
    ensureProjectDirs(id, dataDir);
    return getProject(id, { withCounts: true });
  }

  function updateProject(id, patch = {}) {
    const current = getProject(id);
    if (!current) return null;
    const next = {
      name: patch.name != null ? String(patch.name).trim() || current.name : current.name,
      description: patch.description != null ? String(patch.description) : current.description,
      characterName: patch.characterName != null ? String(patch.characterName) : current.characterName,
      status: patch.status && PROJECT_STATUSES.has(patch.status) ? patch.status : current.status,
      params: patch.params != null ? patch.params : current.params,
      notes: patch.notes != null ? String(patch.notes) : current.notes,
    };
    const ts = nowIso();
    db.prepare(`
      UPDATE projects
      SET name = ?, description = ?, character_name = ?, status = ?, params_json = ?, notes = ?, updated_at = ?
      WHERE id = ?
    `).run(
      next.name,
      next.description,
      next.characterName,
      next.status,
      toJson(next.params || {}),
      next.notes,
      ts,
      id,
    );
    return getProject(id, { withCounts: true });
  }

  function deleteProject(id, { purgeFiles = true } = {}) {
    const current = getProject(id);
    if (!current) return false;
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    if (purgeFiles) {
      const dir = path.join(dataDir, 'projects', id);
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return true;
  }

  function touchProject(id) {
    db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(nowIso(), id);
  }

  function listAssets(projectId, { role = null, kind = null } = {}) {
    let sql = 'SELECT * FROM assets WHERE project_id = ?';
    const args = [projectId];
    if (role) {
      sql += ' AND role = ?';
      args.push(role);
    }
    if (kind) {
      sql += ' AND kind = ?';
      args.push(kind);
    }
    sql += ' ORDER BY created_at DESC';
    return db.prepare(sql).all(...args).map(mapAsset);
  }

  function addAsset(projectId, {
    kind = 'other',
    role = 'source',
    filePath,
    originalName = '',
    mimeType = '',
    meta = {},
    copyIntoProject = false,
  } = {}) {
    if (!getProject(projectId)) {
      const err = new Error('project not found');
      err.code = 'PROJECT_NOT_FOUND';
      throw err;
    }
    if (!filePath) {
      const err = new Error('asset path is required');
      err.code = 'ASSET_PATH_REQUIRED';
      throw err;
    }
    const safeKind = ASSET_KINDS.has(kind) ? kind : 'other';
    const safeRole = ASSET_ROLES.has(role) ? role : 'source';
    let finalPath = path.resolve(filePath);
    if (copyIntoProject) {
      ensureProjectDirs(projectId, dataDir);
      const sub = safeRole === 'source' ? 'sources' : safeRole === 'export' ? 'exports' : 'artifacts';
      const destDir = getProjectSubdir(projectId, sub, dataDir);
      const base = originalName || path.basename(finalPath);
      const dest = path.join(destDir, `${Date.now()}_${base.replace(/[^\w.\-()+]+/g, '_')}`);
      fs.copyFileSync(finalPath, dest);
      finalPath = dest;
    }
    const id = createId('asset');
    const ts = nowIso();
    db.prepare(`
      INSERT INTO assets (id, project_id, kind, role, path, original_name, mime_type, meta_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      projectId,
      safeKind,
      safeRole,
      finalPath,
      originalName || path.basename(finalPath),
      mimeType || '',
      toJson(meta || {}),
      ts,
    );
    touchProject(projectId);
    return mapAsset(db.prepare('SELECT * FROM assets WHERE id = ?').get(id));
  }

  function getActionClip(id) {
    return mapActionClip(db.prepare('SELECT * FROM action_clips WHERE id = ?').get(id));
  }

  function listActionClips(projectId, { assetId = null, status = null } = {}) {
    let sql = 'SELECT * FROM action_clips WHERE project_id = ?';
    const args = [projectId];
    if (assetId) {
      sql += ' AND asset_id = ?';
      args.push(assetId);
    }
    if (status) {
      sql += ' AND status = ?';
      args.push(status);
    }
    sql += ' ORDER BY updated_at DESC, created_at DESC';
    return db.prepare(sql).all(...args).map(mapActionClip);
  }

  function listActionMarkers(clipId) {
    return db.prepare('SELECT * FROM action_markers WHERE clip_id = ? ORDER BY frame ASC, created_at ASC').all(clipId).map(mapActionMarker);
  }

  function getActionClipBundle(id) {
    const clip = getActionClip(id);
    if (!clip) return null;
    return { clip, markers: listActionMarkers(id) };
  }

  function createActionClip(projectId, {
    assetId,
    name,
    startFrame = 0,
    endFrame,
    loop = false,
    status = 'draft',
    params = {},
    notes = '',
  } = {}) {
    if (!getProject(projectId)) {
      const err = new Error('project not found');
      err.code = 'PROJECT_NOT_FOUND';
      throw err;
    }
    const asset = mapAsset(db.prepare('SELECT * FROM assets WHERE id = ? AND project_id = ?').get(assetId, projectId));
    if (!asset || asset.kind !== 'video') {
      const err = new Error('clip source must be a project video asset');
      err.code = 'CLIP_SOURCE_ASSET_INVALID';
      throw err;
    }
    const trimmedName = String(name || '').trim();
    if (!trimmedName) {
      const err = new Error('clip name is required');
      err.code = 'CLIP_NAME_REQUIRED';
      throw err;
    }
    const start = toFrame(startFrame);
    const end = toFrame(endFrame, start);
    if (end <= start) {
      const err = new Error('clip end frame must be greater than start frame');
      err.code = 'CLIP_RANGE_INVALID';
      throw err;
    }
    const id = createId('clip');
    const ts = nowIso();
    db.prepare(`
      INSERT INTO action_clips (
        id, project_id, asset_id, name, status, start_frame, end_frame,
        loop, version, params_json, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    `).run(
      id,
      projectId,
      assetId,
      trimmedName,
      normalizeClipStatus(status),
      start,
      end,
      loop ? 1 : 0,
      toJson(params || {}),
      String(notes || ''),
      ts,
      ts,
    );
    touchProject(projectId);
    return getActionClip(id);
  }

  function updateActionClip(id, patch = {}) {
    const current = getActionClip(id);
    if (!current) return null;
    const start = patch.startFrame !== undefined ? toFrame(patch.startFrame, current.startFrame) : current.startFrame;
    const end = patch.endFrame !== undefined ? toFrame(patch.endFrame, current.endFrame) : current.endFrame;
    if (end <= start) {
      const err = new Error('clip end frame must be greater than start frame');
      err.code = 'CLIP_RANGE_INVALID';
      throw err;
    }
    const next = {
      name: patch.name != null ? String(patch.name).trim() || current.name : current.name,
      status: patch.status != null ? normalizeClipStatus(patch.status, current.status) : current.status,
      start,
      end,
      loop: patch.loop != null ? Boolean(patch.loop) : current.loop,
      params: patch.params !== undefined ? patch.params : current.params,
      notes: patch.notes != null ? String(patch.notes) : current.notes,
      version: current.version + 1,
    };
    const ts = nowIso();
    db.prepare(`
      UPDATE action_clips
      SET name = ?, status = ?, start_frame = ?, end_frame = ?, loop = ?,
          version = ?, params_json = ?, notes = ?, updated_at = ?
      WHERE id = ?
    `).run(
      next.name,
      next.status,
      next.start,
      next.end,
      next.loop ? 1 : 0,
      next.version,
      toJson(next.params || {}),
      next.notes,
      ts,
      id,
    );
    touchProject(current.projectId);
    return getActionClip(id);
  }

  function deleteActionClip(id) {
    const current = getActionClip(id);
    if (!current) return false;
    db.prepare('DELETE FROM action_clips WHERE id = ?').run(id);
    touchProject(current.projectId);
    return true;
  }

  function addActionMarker(clipId, { frame, type = 'note', label = '', payload = {} } = {}) {
    const clip = getActionClip(clipId);
    if (!clip) {
      const err = new Error('clip not found');
      err.code = 'CLIP_NOT_FOUND';
      throw err;
    }
    const markerFrame = toFrame(frame, -1);
    if (markerFrame < clip.startFrame || markerFrame >= clip.endFrame) {
      const err = new Error('marker frame must be inside the clip range');
      err.code = 'MARKER_FRAME_OUTSIDE_CLIP';
      throw err;
    }
    if (!MARKER_TYPES.has(type)) {
      const err = new Error('marker type is invalid');
      err.code = 'MARKER_TYPE_INVALID';
      throw err;
    }
    const id = createId('marker');
    const ts = nowIso();
    db.prepare(`
      INSERT INTO action_markers (id, clip_id, frame, type, label, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, clipId, markerFrame, type, String(label || ''), toJson(payload || {}), ts, ts);
    touchProject(clip.projectId);
    return mapActionMarker(db.prepare('SELECT * FROM action_markers WHERE id = ?').get(id));
  }

  function updateActionMarker(id, patch = {}) {
    const current = mapActionMarker(db.prepare('SELECT * FROM action_markers WHERE id = ?').get(id));
    if (!current) return null;
    const clip = getActionClip(current.clipId);
    const frame = patch.frame !== undefined ? toFrame(patch.frame, current.frame) : current.frame;
    if (frame < clip.startFrame || frame >= clip.endFrame) {
      const err = new Error('marker frame must be inside the clip range');
      err.code = 'MARKER_FRAME_OUTSIDE_CLIP';
      throw err;
    }
    if (patch.type != null && !MARKER_TYPES.has(patch.type)) {
      const err = new Error('marker type is invalid');
      err.code = 'MARKER_TYPE_INVALID';
      throw err;
    }
    const ts = nowIso();
    db.prepare(`
      UPDATE action_markers
      SET frame = ?, type = ?, label = ?, payload_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      frame,
      patch.type != null ? patch.type : current.type,
      patch.label != null ? String(patch.label) : current.label,
      toJson(patch.payload !== undefined ? patch.payload : current.payload),
      ts,
      id,
    );
    touchProject(clip.projectId);
    return mapActionMarker(db.prepare('SELECT * FROM action_markers WHERE id = ?').get(id));
  }

  function deleteActionMarker(id) {
    const marker = mapActionMarker(db.prepare('SELECT * FROM action_markers WHERE id = ?').get(id));
    if (!marker) return false;
    const clip = getActionClip(marker.clipId);
    db.prepare('DELETE FROM action_markers WHERE id = ?').run(id);
    if (clip) touchProject(clip.projectId);
    return true;
  }

  function createJob({
    projectId = null,
    kind,
    status = 'queued',
    progress = null,
    request = null,
    result = null,
    error = null,
    source = 'api',
    id = null,
  } = {}) {
    if (!kind) throw new Error('job kind is required');
    const jobId = id || createId('job');
    const ts = nowIso();
    const safeStatus = JOB_STATUSES.has(status) ? status : 'queued';
    db.prepare(`
      INSERT INTO jobs (id, project_id, kind, status, progress_json, request_json, result_json, error, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      jobId,
      projectId || null,
      kind,
      safeStatus,
      toJson(progress),
      toJson(request),
      toJson(result),
      error || null,
      source || 'api',
      ts,
      ts,
    );
    if (projectId) touchProject(projectId);
    return getJob(jobId);
  }

  function getJob(id) {
    return mapJob(db.prepare('SELECT * FROM jobs WHERE id = ?').get(id));
  }

  function updateJob(id, patch = {}) {
    const current = getJob(id);
    if (!current) return null;
    const next = {
      status: patch.status && JOB_STATUSES.has(patch.status) ? patch.status : current.status,
      progress: patch.progress !== undefined ? patch.progress : current.progress,
      result: patch.result !== undefined ? patch.result : current.result,
      error: patch.error !== undefined ? patch.error : current.error,
      request: patch.request !== undefined ? patch.request : current.request,
      projectId: patch.projectId !== undefined ? patch.projectId : current.projectId,
    };
    const ts = nowIso();
    db.prepare(`
      UPDATE jobs
      SET status = ?, progress_json = ?, result_json = ?, error = ?, request_json = ?, project_id = ?, updated_at = ?
      WHERE id = ?
    `).run(
      next.status,
      toJson(next.progress),
      toJson(next.result),
      next.error,
      toJson(next.request),
      next.projectId,
      ts,
      id,
    );
    if (next.projectId) touchProject(next.projectId);
    return getJob(id);
  }

  function listJobs({ projectId = null, status = null, limit = 50 } = {}) {
    const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
    let sql = 'SELECT * FROM jobs WHERE 1=1';
    const args = [];
    if (projectId) {
      sql += ' AND project_id = ?';
      args.push(projectId);
    }
    if (status) {
      sql += ' AND status = ?';
      args.push(status);
    }
    sql += ' ORDER BY updated_at DESC LIMIT ?';
    args.push(safeLimit);
    return db.prepare(sql).all(...args).map(mapJob);
  }

  function listTasks(projectId, { status = null, limit = 100 } = {}) {
    const safeLimit = Math.min(200, Math.max(1, Number(limit) || 100));
    let sql = 'SELECT * FROM collab_tasks WHERE project_id = ?';
    const args = [projectId];
    if (status) {
      if (Array.isArray(status)) {
        sql += ` AND status IN (${status.map(() => '?').join(',')})`;
        args.push(...status);
      } else {
        sql += ' AND status = ?';
        args.push(status);
      }
    }
    sql += ` ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, updated_at DESC LIMIT ?`;
    args.push(safeLimit);
    return db.prepare(sql).all(...args).map(mapTask);
  }

  function getTask(id) {
    return mapTask(db.prepare('SELECT * FROM collab_tasks WHERE id = ?').get(id));
  }

  function createTask(projectId, {
    title,
    description = '',
    assignee = 'ai',
    priority = 'normal',
    payload = {},
    status = 'open',
  } = {}) {
    if (!getProject(projectId)) {
      const err = new Error('project not found');
      err.code = 'PROJECT_NOT_FOUND';
      throw err;
    }
    const trimmed = String(title || '').trim();
    if (!trimmed) {
      const err = new Error('task title is required');
      err.code = 'TASK_TITLE_REQUIRED';
      throw err;
    }
    const id = createId('task');
    const ts = nowIso();
    db.prepare(`
      INSERT INTO collab_tasks (
        id, project_id, title, description, status, assignee, priority,
        payload_json, result_json, claimed_by, claimed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
    `).run(
      id,
      projectId,
      trimmed,
      String(description || ''),
      TASK_STATUSES.has(status) ? status : 'open',
      String(assignee || 'ai'),
      TASK_PRIORITIES.has(priority) ? priority : 'normal',
      toJson(payload || {}),
      ts,
      ts,
    );
    touchProject(projectId);
    return getTask(id);
  }

  function updateTask(id, patch = {}) {
    const current = getTask(id);
    if (!current) return null;
    const next = {
      title: patch.title != null ? String(patch.title).trim() || current.title : current.title,
      description: patch.description != null ? String(patch.description) : current.description,
      status: patch.status && TASK_STATUSES.has(patch.status) ? patch.status : current.status,
      assignee: patch.assignee != null ? String(patch.assignee) : current.assignee,
      priority: patch.priority && TASK_PRIORITIES.has(patch.priority) ? patch.priority : current.priority,
      payload: patch.payload !== undefined ? patch.payload : current.payload,
      result: patch.result !== undefined ? patch.result : current.result,
      claimedBy: patch.claimedBy !== undefined ? patch.claimedBy : current.claimedBy,
      claimedAt: patch.claimedAt !== undefined ? patch.claimedAt : current.claimedAt,
    };
    const ts = nowIso();
    db.prepare(`
      UPDATE collab_tasks
      SET title = ?, description = ?, status = ?, assignee = ?, priority = ?,
          payload_json = ?, result_json = ?, claimed_by = ?, claimed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      next.title,
      next.description,
      next.status,
      next.assignee,
      next.priority,
      toJson(next.payload),
      toJson(next.result),
      next.claimedBy,
      next.claimedAt,
      ts,
      id,
    );
    touchProject(current.projectId);
    return getTask(id);
  }

  function claimNextTask({
    projectId = null,
    workerId = 'ai',
    statuses = ['open'],
  } = {}) {
    const safeStatuses = (statuses || ['open']).filter((s) => TASK_STATUSES.has(s));
    const useStatuses = safeStatuses.length ? safeStatuses : ['open'];
    let sql = `
      SELECT * FROM collab_tasks
      WHERE status IN (${useStatuses.map(() => '?').join(',')})
    `;
    const args = [...useStatuses];
    if (projectId) {
      sql += ' AND project_id = ?';
      args.push(projectId);
    }
    sql += `
      ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, created_at ASC
      LIMIT 1
    `;
    const row = db.prepare(sql).get(...args);
    if (!row) return null;
    const ts = nowIso();
    db.prepare(`
      UPDATE collab_tasks
      SET status = 'claimed', claimed_by = ?, claimed_at = ?, updated_at = ?
      WHERE id = ? AND status = ?
    `).run(String(workerId || 'ai'), ts, ts, row.id, row.status);
    const claimed = getTask(row.id);
    if (claimed) touchProject(claimed.projectId);
    return claimed;
  }

  function completeTask(id, { result = null, status = 'done', message = null, author = 'ai' } = {}) {
    const task = updateTask(id, {
      status: TASK_STATUSES.has(status) ? status : 'done',
      result,
    });
    if (!task) return null;
    if (message) {
      addMessage(task.projectId, {
        taskId: task.id,
        author,
        body: message,
        meta: { type: 'task_complete' },
      });
    }
    return task;
  }

  function listMessages(projectId, { taskId = null, limit = 100 } = {}) {
    const safeLimit = Math.min(300, Math.max(1, Number(limit) || 100));
    let sql = 'SELECT * FROM collab_messages WHERE project_id = ?';
    const args = [projectId];
    if (taskId) {
      sql += ' AND task_id = ?';
      args.push(taskId);
    }
    sql += ' ORDER BY created_at ASC LIMIT ?';
    args.push(safeLimit);
    return db.prepare(sql).all(...args).map(mapMessage);
  }

  function addMessage(projectId, { taskId = null, author = 'human', body = '', meta = {} } = {}) {
    if (!getProject(projectId)) {
      const err = new Error('project not found');
      err.code = 'PROJECT_NOT_FOUND';
      throw err;
    }
    const text = String(body || '').trim();
    if (!text) {
      const err = new Error('message body is required');
      err.code = 'MESSAGE_BODY_REQUIRED';
      throw err;
    }
    const id = createId('msg');
    const ts = nowIso();
    db.prepare(`
      INSERT INTO collab_messages (id, project_id, task_id, author, body, meta_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, taskId || null, String(author || 'human'), text, toJson(meta || {}), ts);
    touchProject(projectId);
    return mapMessage(db.prepare('SELECT * FROM collab_messages WHERE id = ?').get(id));
  }

  function getProjectBundle(id) {
    const project = getProject(id, { withCounts: true });
    if (!project) return null;
    return {
      project,
      assets: listAssets(id),
      clips: listActionClips(id),
      jobs: listJobs({ projectId: id, limit: 30 }),
      tasks: listTasks(id, { limit: 50 }),
      messages: listMessages(id, { limit: 100 }),
    };
  }

  function getOverview() {
    const projects = listProjects({ includeArchived: true });
    const activeJobs = listJobs({ status: 'running', limit: 20 });
    const openTasks = db.prepare(`
      SELECT * FROM collab_tasks
      WHERE status IN ('open','claimed','in_progress','needs_review','blocked')
      ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, updated_at DESC
      LIMIT 30
    `).all().map(mapTask);
    return {
      dataDir,
      dbPath,
      projectCount: projects.length,
      activeProjectCount: projects.filter((p) => p.status === 'active').length,
      projects: projects.slice(0, 20),
      activeJobs,
      openTasks,
    };
  }

  return {
    dataDir,
    dbPath,
    db,
    close,
    listProjects,
    getProject,
    createProject,
    updateProject,
    deleteProject,
    listAssets,
    addAsset,
    getActionClip,
    getActionClipBundle,
    listActionClips,
    listActionMarkers,
    createActionClip,
    updateActionClip,
    deleteActionClip,
    addActionMarker,
    updateActionMarker,
    deleteActionMarker,
    createJob,
    getJob,
    updateJob,
    listJobs,
    listTasks,
    getTask,
    createTask,
    updateTask,
    claimNextTask,
    completeTask,
    listMessages,
    addMessage,
    getProjectBundle,
    getOverview,
  };
}

module.exports = {
  createProjectStore,
  openDatabase,
  getStore,
  closeShared,
  createId,
  nowIso,
  PROJECT_STATUSES,
  ASSET_KINDS,
  ASSET_ROLES,
  JOB_STATUSES,
  TASK_STATUSES,
  TASK_PRIORITIES,
};
