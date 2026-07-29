/**
 * HTTP routes for project management, MCP status/logs, and AI collaboration.
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const {
  createProjectStore,
} = require('./projectStore.cjs');
const {
  getMcpConfig,
  readMcpLogs,
  getMcpStatus,
  appendHttpEvent,
  createEventBus,
  startMcpLogTailer,
} = require('./mcpRuntime.cjs');
const {
  getDataDir,
  ensureProjectDirs,
  getProjectSubdir,
} = require('./paths.cjs');

function createStudioServices(options = {}) {
  const dataDir = options.dataDir || getDataDir();
  const store = options.store || createProjectStore({
    dataDir,
    fresh: Boolean(options.fresh),
    dbPath: options.dbPath,
  });
  const bus = options.bus || createEventBus();
  const tailer = options.disableTailer
    ? null
    : startMcpLogTailer({
      dataDir,
      onEvent: (entry) => bus.publish({ channel: 'mcp-log', entry }),
    });

  function emit(entry) {
    const full = appendHttpEvent(dataDir, entry);
    bus.publish({ channel: 'mcp-log', entry: full });
    if (full.dataChanged) {
      bus.publish({ channel: 'data-changed', entry: full });
    }
    return full;
  }

  return { dataDir, store, bus, tailer, emit };
}

function createProjectsRouter(services) {
  const router = express.Router();
  const { store, emit } = services;

  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        try {
          const projectId = req.params.id;
          ensureProjectDirs(projectId, services.dataDir);
          cb(null, getProjectSubdir(projectId, 'sources', services.dataDir));
        } catch (err) {
          cb(err);
        }
      },
      filename: (req, file, cb) => {
        const safe = String(file.originalname || 'upload.bin').replace(/[^\w.\-()+]+/g, '_');
        cb(null, `${Date.now()}_${safe}`);
      },
    }),
    limits: { fileSize: 500 * 1024 * 1024 },
  });

  router.get('/', (req, res) => {
    try {
      const includeArchived = req.query.includeArchived === '1' || req.query.includeArchived === 'true';
      res.json({
        dataDir: store.dataDir,
        projects: store.listProjects({ includeArchived }),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/overview', (req, res) => {
    try {
      res.json(store.getOverview());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/', (req, res) => {
    try {
      const project = store.createProject({
        name: req.body?.name,
        description: req.body?.description,
        characterName: req.body?.characterName,
        params: req.body?.params,
        notes: req.body?.notes,
      });
      emit({
        type: 'project',
        message: `Created project ${project.name}`,
        projectId: project.id,
        dataChanged: true,
        details: { action: 'create', name: project.name },
      });
      res.status(201).json(project);
    } catch (err) {
      const status = err.code === 'PROJECT_NAME_REQUIRED' ? 400 : 500;
      res.status(status).json({ error: err.message, code: err.code });
    }
  });

  router.get('/:id', (req, res) => {
    try {
      const bundle = store.getProjectBundle(req.params.id);
      if (!bundle) return res.status(404).json({ error: 'not found' });
      res.json(bundle);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.patch('/:id', (req, res) => {
    try {
      const project = store.updateProject(req.params.id, req.body || {});
      if (!project) return res.status(404).json({ error: 'not found' });
      emit({
        type: 'project',
        message: `Updated project ${project.name}`,
        projectId: project.id,
        dataChanged: true,
        details: { action: 'update' },
      });
      res.json(project);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/:id', (req, res) => {
    try {
      const ok = store.deleteProject(req.params.id, {
        purgeFiles: req.query.purgeFiles !== '0' && req.query.purgeFiles !== 'false',
      });
      if (!ok) return res.status(404).json({ error: 'not found' });
      emit({
        type: 'project',
        message: `Deleted project ${req.params.id}`,
        projectId: req.params.id,
        dataChanged: true,
        details: { action: 'delete' },
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/:id/assets', (req, res) => {
    try {
      if (!store.getProject(req.params.id)) return res.status(404).json({ error: 'not found' });
      res.json({
        assets: store.listAssets(req.params.id, {
          role: req.query.role || null,
          kind: req.query.kind || null,
        }),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Resolve a local file only through a project-scoped asset id. Never accept a
  // browser-provided path here, otherwise this would become a local-file reader.
  router.get('/:id/assets/:assetId/content', (req, res) => {
    try {
      if (!store.getProject(req.params.id)) return res.status(404).json({ error: 'not found' });
      const asset = store.listAssets(req.params.id).find((item) => item.id === req.params.assetId);
      if (!asset) return res.status(404).json({ error: 'asset not found' });
      const filePath = path.resolve(asset.path);
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'asset file not found' });
      if (asset.mimeType) res.type(asset.mimeType);
      res.sendFile(filePath);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/:id/assets', upload.single('file'), (req, res) => {
    try {
      if (!store.getProject(req.params.id)) return res.status(404).json({ error: 'not found' });
      let filePath = req.body?.path;
      let originalName = req.body?.originalName || '';
      let mimeType = req.body?.mimeType || '';
      if (req.file) {
        filePath = req.file.path;
        originalName = req.file.originalname || originalName;
        mimeType = req.file.mimetype || mimeType;
      }
      const asset = store.addAsset(req.params.id, {
        kind: req.body?.kind || 'other',
        role: req.body?.role || 'source',
        filePath,
        originalName,
        mimeType,
        meta: req.body?.meta ? (typeof req.body.meta === 'string' ? JSON.parse(req.body.meta) : req.body.meta) : {},
        copyIntoProject: !req.file && req.body?.copyIntoProject === true,
      });
      emit({
        type: 'asset',
        message: `Added asset ${asset.originalName || asset.id}`,
        projectId: req.params.id,
        dataChanged: true,
        details: { assetId: asset.id, kind: asset.kind, role: asset.role },
      });
      res.status(201).json(asset);
    } catch (err) {
      const status = ['PROJECT_NOT_FOUND', 'ASSET_PATH_REQUIRED'].includes(err.code) ? 400 : 500;
      res.status(status).json({ error: err.message, code: err.code });
    }
  });

  router.get('/:id/jobs', (req, res) => {
    try {
      if (!store.getProject(req.params.id)) return res.status(404).json({ error: 'not found' });
      res.json({
        jobs: store.listJobs({
          projectId: req.params.id,
          status: req.query.status || null,
          limit: req.query.limit,
        }),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/:id/tasks', (req, res) => {
    try {
      if (!store.getProject(req.params.id)) return res.status(404).json({ error: 'not found' });
      res.json({
        tasks: store.listTasks(req.params.id, {
          status: req.query.status || null,
          limit: req.query.limit,
        }),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/:id/tasks', (req, res) => {
    try {
      const task = store.createTask(req.params.id, req.body || {});
      emit({
        type: 'collab',
        message: `Created task ${task.title}`,
        projectId: req.params.id,
        taskId: task.id,
        dataChanged: true,
        details: { action: 'create_task', priority: task.priority },
      });
      res.status(201).json(task);
    } catch (err) {
      const status = ['PROJECT_NOT_FOUND', 'TASK_TITLE_REQUIRED'].includes(err.code) ? 400 : 500;
      res.status(status).json({ error: err.message, code: err.code });
    }
  });

  router.get('/:id/messages', (req, res) => {
    try {
      if (!store.getProject(req.params.id)) return res.status(404).json({ error: 'not found' });
      res.json({
        messages: store.listMessages(req.params.id, {
          taskId: req.query.taskId || null,
          limit: req.query.limit,
        }),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/:id/messages', (req, res) => {
    try {
      const message = store.addMessage(req.params.id, {
        taskId: req.body?.taskId,
        author: req.body?.author || 'human',
        body: req.body?.body,
        meta: req.body?.meta,
      });
      emit({
        type: 'collab',
        message: `Message from ${message.author}`,
        projectId: req.params.id,
        taskId: message.taskId,
        dataChanged: true,
        details: { action: 'message', author: message.author },
      });
      res.status(201).json(message);
    } catch (err) {
      const status = ['PROJECT_NOT_FOUND', 'MESSAGE_BODY_REQUIRED'].includes(err.code) ? 400 : 500;
      res.status(status).json({ error: err.message, code: err.code });
    }
  });

  return router;
}

function createCollabRouter(services) {
  const router = express.Router();
  const { store, emit } = services;

  router.get('/tasks', (req, res) => {
    try {
      const overview = store.getOverview();
      res.json({ openTasks: overview.openTasks, activeJobs: overview.activeJobs });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/tasks/claim-next', (req, res) => {
    try {
      const task = store.claimNextTask({
        projectId: req.body?.projectId || null,
        workerId: req.body?.workerId || 'ai',
        statuses: req.body?.statuses,
      });
      if (!task) return res.json({ claimed: false, task: null });
      emit({
        type: 'collab',
        message: `Claimed task ${task.title}`,
        projectId: task.projectId,
        taskId: task.id,
        dataChanged: true,
        details: { action: 'claim', workerId: task.claimedBy },
      });
      res.json({ claimed: true, task, project: store.getProject(task.projectId, { withCounts: true }) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.patch('/tasks/:id', (req, res) => {
    try {
      const task = store.updateTask(req.params.id, req.body || {});
      if (!task) return res.status(404).json({ error: 'not found' });
      emit({
        type: 'collab',
        message: `Updated task ${task.title}`,
        projectId: task.projectId,
        taskId: task.id,
        dataChanged: true,
        details: { action: 'update_task', status: task.status },
      });
      res.json(task);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/tasks/:id/complete', (req, res) => {
    try {
      const task = store.completeTask(req.params.id, {
        result: req.body?.result,
        status: req.body?.status || 'done',
        message: req.body?.message,
        author: req.body?.author || 'ai',
      });
      if (!task) return res.status(404).json({ error: 'not found' });
      emit({
        type: 'collab',
        message: `Completed task ${task.title}`,
        projectId: task.projectId,
        taskId: task.id,
        dataChanged: true,
        details: { action: 'complete_task', status: task.status },
      });
      res.json(task);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

function createMcpHttpRouter(services) {
  const router = express.Router();
  const { dataDir, bus } = services;

  router.get('/config', (req, res) => {
    try {
      res.json(getMcpConfig({ dataDir }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/status', async (req, res) => {
    try {
      res.json(await getMcpStatus({ dataDir }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/logs', async (req, res) => {
    try {
      const logs = await readMcpLogs({ dataDir, limit: req.query.limit });
      res.json({ logs });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/events', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (eventName, payload) => {
      res.write(`event: ${eventName}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    send('ready', { ok: true, time: new Date().toISOString() });

    try {
      const status = await getMcpStatus({ dataDir });
      send('status', status);
      const logs = await readMcpLogs({ dataDir, limit: 30 });
      send('logs', { logs });
    } catch (err) {
      send('error', { message: err.message });
    }

    const unsubscribe = bus.subscribe((event) => {
      if (event.channel === 'mcp-log') send('log', event.entry);
      if (event.channel === 'data-changed') send('data-changed', event.entry);
      if (event.channel === 'status') send('status', event.payload);
    });

    const heartbeat = setInterval(() => {
      res.write(`: ping ${Date.now()}\n\n`);
    }, 15000);
    heartbeat.unref?.();

    const statusTimer = setInterval(async () => {
      try {
        const status = await getMcpStatus({ dataDir });
        send('status', status);
      } catch {
        // ignore
      }
    }, 5000);
    statusTimer.unref?.();

    req.on('close', () => {
      unsubscribe();
      clearInterval(heartbeat);
      clearInterval(statusTimer);
    });
  });

  return router;
}

function mountStudioApi(app, options = {}) {
  const services = createStudioServices(options);
  app.use('/api/projects', createProjectsRouter(services));
  app.use('/api/collab', createCollabRouter(services));
  app.use('/api/mcp', createMcpHttpRouter(services));

  // Expose jobs list globally too
  app.get('/api/jobs', (req, res) => {
    try {
      res.json({
        jobs: services.store.listJobs({
          projectId: req.query.projectId || null,
          status: req.query.status || null,
          limit: req.query.limit,
        }),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return services;
}

module.exports = {
  createStudioServices,
  createProjectsRouter,
  createCollabRouter,
  createMcpHttpRouter,
  mountStudioApi,
};
