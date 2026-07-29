import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createProjectStore, closeShared } = require('../lib/projectStore.cjs')
const { createMcpRuntime, readMcpLogs, getMcpStatus, getMcpConfig } = require('../lib/mcpRuntime.cjs')
const { mountStudioApi, createStudioServices } = require('../lib/studioApi.cjs')
const express = require('express')
const request = require('supertest')

describe('projectStore + mcpRuntime + studio API', () => {
  let tmpDir
  let store

  beforeEach(() => {
    closeShared()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gss-store-'))
    store = createProjectStore({ dataDir: tmpDir, fresh: true })
  })

  afterEach(() => {
    try { store?.close?.() } catch { /* ignore */ }
    closeShared()
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // Windows may keep a brief lock on sqlite wal files
    }
  })

  it('creates projects with data folders and CRUD works', () => {
    const project = store.createProject({
      name: '温宁',
      characterName: 'wenning',
      description: 'demo',
      params: { layout: { canvasWidth: 256 } },
    })
    expect(project.id).toMatch(/^proj_/)
    expect(fs.existsSync(path.join(tmpDir, 'projects', project.id, 'sources'))).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, 'projects', project.id, 'exports'))).toBe(true)

    const listed = store.listProjects()
    expect(listed).toHaveLength(1)
    expect(listed[0].name).toBe('温宁')

    const updated = store.updateProject(project.id, { notes: 'ready' })
    expect(updated.notes).toBe('ready')

    const bundle = store.getProjectBundle(project.id)
    expect(bundle.project.characterName).toBe('wenning')
    expect(bundle.assets).toEqual([])
  })

  it('persists action clips, semantic markers, and review state for a source video', () => {
    const project = store.createProject({ name: 'action review' })
    const sourcePath = path.join(tmpDir, 'action.mp4')
    fs.writeFileSync(sourcePath, 'video bytes')
    const asset = store.addAsset(project.id, {
      kind: 'video',
      role: 'source',
      filePath: sourcePath,
      originalName: 'action.mp4',
      mimeType: 'video/mp4',
    })

    const attack = store.createActionClip(project.id, {
      assetId: asset.id,
      name: 'attack_loop_SE',
      startFrame: 0,
      endFrame: 60,
      loop: true,
    })
    const idle = store.createActionClip(project.id, {
      assetId: asset.id,
      name: 'idle_loop_SE',
      startFrame: 80,
      endFrame: 120,
      loop: true,
      status: 'needs_review',
    })
    expect(store.listActionClips(project.id, { assetId: asset.id })).toHaveLength(2)
    expect(idle.status).toBe('needs_review')

    const windup = store.addActionMarker(attack.id, { frame: 30, type: 'windup_end', label: 'startup done' })
    const hit = store.addActionMarker(attack.id, { frame: 45, type: 'hit', payload: { damageMultiplier: 1 } })
    expect(store.getActionClipBundle(attack.id).markers.map(marker => marker.frame)).toEqual([30, 45])
    expect(hit.payload.damageMultiplier).toBe(1)

    const approved = store.updateActionClip(attack.id, { status: 'approved' })
    expect(approved.status).toBe('approved')
    expect(approved.version).toBe(2)
    expect(() => store.addActionMarker(attack.id, { frame: 60, type: 'hit' })).toThrow(/inside the clip range/)
    expect(() => store.addActionMarker(attack.id, { frame: 40, type: 'unknown' })).toThrow(/marker type is invalid/)
    expect(() => store.updateActionClip(attack.id, { endFrame: 0 })).toThrow(/end frame/)

    const bundle = store.getProjectBundle(project.id)
    expect(bundle.clips.map(clip => clip.id)).toContain(attack.id)
    expect(store.deleteActionMarker(windup.id)).toBe(true)
    expect(store.getActionClipBundle(attack.id).markers).toHaveLength(1)
  })

  it('supports collab task claim/complete and messages', () => {
    const project = store.createProject({ name: 'collab' })
    const task = store.createTask(project.id, {
      title: 'Export walk SE',
      priority: 'high',
      payload: { action: 'walk', direction: 'SE' },
    })
    expect(task.status).toBe('open')

    const claimed = store.claimNextTask({ workerId: 'agent-a' })
    expect(claimed.id).toBe(task.id)
    expect(claimed.status).toBe('claimed')
    expect(claimed.claimedBy).toBe('agent-a')

    const done = store.completeTask(task.id, {
      result: { outputPath: 'x.zip' },
      message: 'exported',
      author: 'agent-a',
    })
    expect(done.status).toBe('done')
    expect(done.result.outputPath).toBe('x.zip')

    const messages = store.listMessages(project.id)
    expect(messages.some((m) => m.body === 'exported')).toBe(true)
  })

  it('records MCP runtime logs and status', async () => {
    const runtime = createMcpRuntime({ dataDir: tmpDir, toolCount: 3, heartbeatIntervalMs: 50 })
    await runtime.start()
    await runtime.record({
      type: 'tool',
      phase: 'end',
      tool: 'list_projects',
      message: 'ok list_projects',
      durationMs: 12,
    })
    await runtime.touch({ lastTool: 'list_projects' })

    const logs = await readMcpLogs({ dataDir: tmpDir, limit: 20 })
    expect(logs.length).toBeGreaterThanOrEqual(2)
    expect(logs.some((l) => l.tool === 'list_projects')).toBe(true)

    const status = await getMcpStatus({ dataDir: tmpDir })
    expect(status.connected).toBe(true)
    expect(status.activeSessionCount).toBe(1)

    const config = getMcpConfig({ dataDir: tmpDir })
    expect(config.serverName).toBe('greenscreen-studio')
    expect(config.env.GSS_DATA_DIR).toBe(tmpDir)

    await runtime.stop('test done')
    const after = await getMcpStatus({ dataDir: tmpDir, now: Date.now() + 60_000 })
    expect(after.connected).toBe(false)
  })

  it('exposes HTTP project and collab APIs', async () => {
    const app = express()
    app.use(express.json())
    closeShared()
    const mounted = mountStudioApi(app, { dataDir: tmpDir, fresh: true, disableTailer: true })

    const createRes = await request(app)
      .post('/api/projects')
      .send({ name: 'API Project', characterName: 'hero' })
    expect(createRes.status).toBe(201)
    expect(createRes.body.id).toBeTruthy()
    const projectId = createRes.body.id

    const listRes = await request(app).get('/api/projects')
    expect(listRes.status).toBe(200)
    expect(listRes.body.projects.some((p) => p.id === projectId)).toBe(true)

    const sourcePath = path.join(tmpDir, 'source.mp4')
    fs.writeFileSync(sourcePath, 'video bytes')
    const asset = mounted.store.addAsset(projectId, {
      kind: 'video',
      role: 'source',
      filePath: sourcePath,
      originalName: 'source.mp4',
      mimeType: 'video/mp4',
    })
    const contentRes = await request(app).get(`/api/projects/${projectId}/assets/${asset.id}/content`)
    expect(contentRes.status).toBe(200)
    expect(contentRes.headers['content-type']).toContain('video/mp4')
    expect(contentRes.body.toString()).toBe('video bytes')
    const missingAssetRes = await request(app).get(`/api/projects/${projectId}/assets/missing/content`)
    expect(missingAssetRes.status).toBe(404)

    const taskRes = await request(app)
      .post(`/api/projects/${projectId}/tasks`)
      .send({ title: 'Tune keying', priority: 'normal' })
    expect(taskRes.status).toBe(201)

    const claimRes = await request(app)
      .post('/api/collab/tasks/claim-next')
      .send({ workerId: 'codex' })
    expect(claimRes.status).toBe(200)
    expect(claimRes.body.claimed).toBe(true)
    expect(claimRes.body.task.title).toBe('Tune keying')

    const statusRes = await request(app).get('/api/mcp/status')
    expect(statusRes.status).toBe(200)
    expect(statusRes.body).toHaveProperty('connected')

    const logsRes = await request(app).get('/api/mcp/logs')
    expect(logsRes.status).toBe(200)
    expect(Array.isArray(logsRes.body.logs)).toBe(true)
    expect(logsRes.body.logs.length).toBeGreaterThan(0)

    const configRes = await request(app).get('/api/mcp/config')
    expect(configRes.status).toBe(200)
    expect(configRes.body.formats.json).toContain('greenscreen-studio')

    mounted.tailer?.stop?.()
    mounted.store?.close?.()
  })
})
