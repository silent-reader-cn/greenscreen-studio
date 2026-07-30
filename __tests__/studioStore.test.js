import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createProjectStore, closeShared, ACTION_CLIP_EXPORT_TASK_TYPE } = require('../lib/projectStore.cjs')
const { createMcpRuntime, readMcpLogs, getMcpStatus, getMcpConfig } = require('../lib/mcpRuntime.cjs')
const { mountStudioApi, createStudioServices } = require('../lib/studioApi.cjs')
const express = require('express')
const request = require('supertest')

function saveCurrentReviewChecks(store, clipId, overrides = {}) {
  const clip = store.getActionClip(clipId)
  return store.setActionClipReviewChecks(clipId, {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    clip: {
      id: clip.id,
      version: clip.version,
      status: clip.status,
      startFrame: clip.startFrame,
      endFrame: clip.endFrame,
      loop: clip.loop,
    },
    summary: { status: 'pass', warningCount: 0, passCount: 5, skippedCount: 0 },
    checks: [],
    ...overrides,
  })
}

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
    })
    expect(store.listActionClips(project.id, { assetId: asset.id })).toHaveLength(2)
    expect(idle.status).toBe('draft')

    const windup = store.addActionMarker(attack.id, { frame: 30, type: 'windup_end', label: 'startup done' })
    const hit = store.addActionMarker(attack.id, { frame: 45, type: 'hit', payload: { damageMultiplier: 1 } })
    expect(store.getActionClipBundle(attack.id).markers.map(marker => marker.frame)).toEqual([30, 45])
    expect(hit.payload.damageMultiplier).toBe(1)
    const movedWindup = store.updateActionMarker(windup.id, { frame: 32, label: 'startup adjusted' })
    expect(movedWindup).toMatchObject({ frame: 32, type: 'windup_end', label: 'startup adjusted' })
    expect(() => store.addActionMarker(attack.id, { frame: 60, type: 'hit' })).toThrow(/inside the clip range/)
    expect(() => store.addActionMarker(attack.id, { frame: 40, type: 'unknown' })).toThrow(/marker type is invalid/)
    expect(() => store.updateActionClip(attack.id, { endFrame: 0 })).toThrow(/end frame/)
    expect(() => store.updateActionClip(attack.id, { endFrame: 40 })).toThrow(/exclude existing markers/)

    expect(() => store.createActionClip(project.id, {
      assetId: asset.id,
      name: 'invalid_approved',
      startFrame: 120,
      endFrame: 140,
      status: 'approved',
    })).toThrow(/start in draft/)
    const submitted = store.updateActionClip(attack.id, { status: 'needs_review' })
    expect(submitted.status).toBe('needs_review')
    expect(() => store.updateActionClip(attack.id, { status: 'approved' })).toThrow(/review checks/)
    saveCurrentReviewChecks(store, attack.id)
    expect(() => store.updateActionClip(attack.id, { status: 'approved', endFrame: 61 })).toThrow(/review checks/)
    const approved = store.updateActionClip(attack.id, { status: 'approved' })
    expect(approved.status).toBe('approved')
    expect(approved.reviewChecks).toMatchObject({ clip: { id: attack.id, version: submitted.version } })
    expect(approved.version).toBe(3)
    expect(() => store.addActionMarker(attack.id, { frame: 50, type: 'note' })).toThrow(/return to review/)
    expect(() => store.updateActionMarker(hit.id, { frame: 50 })).toThrow(/return to review/)
    expect(() => store.updateActionClip(attack.id, { name: 'approved_mutation' })).toThrow(/return to review/)
    expect(() => store.updateActionClip(attack.id, { status: 'verified_in_game' })).toThrow(/cannot move/)
    expect(store.updateActionClip(attack.id, { status: 'exported' }).status).toBe('exported')
    expect(store.updateActionClip(attack.id, { status: 'verified_in_game' }).status).toBe('verified_in_game')
    expect(store.updateActionClip(idle.id, { status: 'needs_review' }).status).toBe('needs_review')
    expect(store.updateActionClip(idle.id, { status: 'rejected' }).status).toBe('rejected')
    expect(store.updateActionClip(idle.id, { status: 'draft' }).status).toBe('draft')

    const bundle = store.getProjectBundle(project.id)
    expect(bundle.clips.map(clip => clip.id)).toContain(attack.id)
    expect(store.updateActionClip(attack.id, { status: 'needs_review' }).status).toBe('needs_review')
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

  it('queues and claims action clip export tasks only for current approved snapshots', () => {
    const project = store.createProject({ name: 'export gate' })
    const sourcePath = path.join(tmpDir, 'source.mp4')
    fs.writeFileSync(sourcePath, 'video bytes')
    const asset = store.addAsset(project.id, {
      kind: 'video',
      role: 'source',
      filePath: sourcePath,
      originalName: 'source.mp4',
      mimeType: 'video/mp4',
    })
    const clip = store.createActionClip(project.id, {
      assetId: asset.id,
      name: 'attack_SE',
      startFrame: 10,
      endFrame: 30,
      loop: false,
    })
    const marker = store.addActionMarker(clip.id, { frame: 18, type: 'hit', payload: { hitbox: 'slash_a' } })
    expect(() => store.createActionClipExportTask(project.id, { clipId: clip.id })).toThrow(/approved clips/)

    store.updateActionClip(clip.id, { status: 'needs_review' })
    saveCurrentReviewChecks(store, clip.id)
    const approved = store.updateActionClip(clip.id, { status: 'approved' })
    const task = store.createActionClipExportTask(project.id, {
      clipId: clip.id,
      priority: 'high',
      request: { target: 'godot' },
    })
    expect(task.payload).toMatchObject({
      type: ACTION_CLIP_EXPORT_TASK_TYPE,
      schemaVersion: 1,
      clipId: clip.id,
      clip: { id: clip.id, status: 'approved', version: approved.version, startFrame: 10, endFrame: 30 },
      request: { target: 'godot' },
    })
    expect(task.payload.markers).toEqual([expect.objectContaining({ id: marker.id, frame: 18, payload: { hitbox: 'slash_a' } })])
    expect(() => store.updateTask(task.id, { payload: { ...task.payload, extra: true } })).toThrow(/immutable/)

    const claimed = store.claimNextTask({ workerId: 'agent-export' })
    expect(claimed.id).toBe(task.id)
    expect(claimed.payload.clip.status).toBe('approved')
    expect(claimed.claimedBy).toBe('agent-export')

    const staleClip = store.createActionClip(project.id, {
      assetId: asset.id,
      name: 'recovery_SE',
      startFrame: 40,
      endFrame: 55,
    })
    store.addActionMarker(staleClip.id, { frame: 44, type: 'note', payload: { before: true } })
    store.updateActionClip(staleClip.id, { status: 'needs_review' })
    saveCurrentReviewChecks(store, staleClip.id)
    store.updateActionClip(staleClip.id, { status: 'approved' })
    const staleTask = store.createActionClipExportTask(project.id, { clipId: staleClip.id, priority: 'high' })
    store.updateActionClip(staleClip.id, { status: 'needs_review' })
    store.addActionMarker(staleClip.id, { frame: 45, type: 'sfx', payload: { sound: 'slash' } })
    saveCurrentReviewChecks(store, staleClip.id)
    store.updateActionClip(staleClip.id, { status: 'approved' })
    const fallbackTask = store.createTask(project.id, { title: 'General follow-up', priority: 'normal' })

    const next = store.claimNextTask({ workerId: 'agent-export' })
    expect(next.id).toBe(fallbackTask.id)
    expect(store.getTask(staleTask.id)).toMatchObject({
      status: 'cancelled',
      result: { code: 'TASK_EXPORT_SNAPSHOT_STALE' },
    })
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

    const clipRes = await request(app)
      .post(`/api/projects/${projectId}/clips`)
      .send({ assetId: asset.id, name: 'attack_SE', startFrame: 20, endFrame: 60, loop: false })
    expect(clipRes.status).toBe(201)
    expect(clipRes.body.startFrame).toBe(20)
    const clipId = clipRes.body.id

    const markerRes = await request(app)
      .post(`/api/projects/${projectId}/clips/${clipId}/markers`)
      .send({ frame: 45, type: 'hit', label: 'damage 1', payload: { hitbox: 'slash_a' } })
    expect(markerRes.status).toBe(201)
    expect(markerRes.body.type).toBe('hit')

    const movedMarkerRes = await request(app)
      .patch(`/api/projects/${projectId}/clips/${clipId}/markers/${markerRes.body.id}`)
      .send({ frame: 50, label: 'damage adjusted', payload: { hitbox: 'slash_b' } })
    expect(movedMarkerRes.status).toBe(200)
    expect(movedMarkerRes.body).toMatchObject({ frame: 50, label: 'damage adjusted', payload: { hitbox: 'slash_b' } })

    const clipBundleRes = await request(app).get(`/api/projects/${projectId}/clips/${clipId}`)
    expect(clipBundleRes.status).toBe(200)
    expect(clipBundleRes.body.markers).toHaveLength(1)
    const excludedMarkerRangeRes = await request(app)
      .patch(`/api/projects/${projectId}/clips/${clipId}`)
      .send({ endFrame: 50 })
    expect(excludedMarkerRangeRes.status).toBe(400)
    expect(excludedMarkerRangeRes.body.code).toBe('CLIP_RANGE_EXCLUDES_MARKERS')
    const invalidMarkerRes = await request(app)
      .post(`/api/projects/${projectId}/clips/${clipId}/markers`)
      .send({ frame: 60, type: 'hit' })
    expect(invalidMarkerRes.status).toBe(400)
    const invalidInitialStatusRes = await request(app)
      .post(`/api/projects/${projectId}/clips`)
      .send({ assetId: asset.id, name: 'invalid_approved', startFrame: 90, endFrame: 100, status: 'approved' })
    expect(invalidInitialStatusRes.status).toBe(400)
    expect(invalidInitialStatusRes.body.code).toBe('CLIP_STATUS_INITIAL_INVALID')
    const skippedApprovalRes = await request(app)
      .patch(`/api/projects/${projectId}/clips/${clipId}`)
      .send({ status: 'approved' })
    expect(skippedApprovalRes.status).toBe(409)
    expect(skippedApprovalRes.body.code).toBe('CLIP_STATUS_TRANSITION_INVALID')
    const submittedClipRes = await request(app)
      .patch(`/api/projects/${projectId}/clips/${clipId}`)
      .send({ status: 'needs_review' })
    expect(submittedClipRes.status).toBe(200)
    expect(submittedClipRes.body.status).toBe('needs_review')
    const missingChecksRes = await request(app)
      .patch(`/api/projects/${projectId}/clips/${clipId}`)
      .send({ status: 'approved' })
    expect(missingChecksRes.status).toBe(409)
    expect(missingChecksRes.body.code).toBe('CLIP_REVIEW_CHECKS_REQUIRED')
    saveCurrentReviewChecks(mounted.store, clipId)
    const approvedClipRes = await request(app)
      .patch(`/api/projects/${projectId}/clips/${clipId}`)
      .send({ status: 'approved' })
    expect(approvedClipRes.status).toBe(200)
    expect(approvedClipRes.body.status).toBe('approved')
    const exportTaskRes = await request(app)
      .post(`/api/projects/${projectId}/clips/${clipId}/export-task`)
      .send({ request: { target: 'godot' } })
    expect(exportTaskRes.status).toBe(201)
    expect(exportTaskRes.body.payload).toMatchObject({
      type: ACTION_CLIP_EXPORT_TASK_TYPE,
      clipId,
      clip: { status: 'approved' },
      request: { target: 'godot' },
    })
    const mutateExportPayloadRes = await request(app)
      .patch(`/api/collab/tasks/${exportTaskRes.body.id}`)
      .send({ payload: { ...exportTaskRes.body.payload, clipId: 'replacement' } })
    expect(mutateExportPayloadRes.status).toBe(409)
    expect(mutateExportPayloadRes.body.code).toBe('TASK_EXPORT_PAYLOAD_IMMUTABLE')
    const exportClaimRes = await request(app)
      .post('/api/collab/tasks/claim-next')
      .send({ workerId: 'codex-export' })
    expect(exportClaimRes.status).toBe(200)
    expect(exportClaimRes.body.claimed).toBe(true)
    expect(exportClaimRes.body.task.id).toBe(exportTaskRes.body.id)
    const lockedMarkerRes = await request(app)
      .post(`/api/projects/${projectId}/clips/${clipId}/markers`)
      .send({ frame: 55, type: 'note' })
    expect(lockedMarkerRes.status).toBe(409)
    expect(lockedMarkerRes.body.code).toBe('CLIP_REVIEW_LOCKED')
    const lockedClipEditRes = await request(app)
      .patch(`/api/projects/${projectId}/clips/${clipId}`)
      .send({ name: 'mutated_after_approval' })
    expect(lockedClipEditRes.status).toBe(409)
    expect(lockedClipEditRes.body.code).toBe('CLIP_REVIEW_LOCKED')
    const exportedClipRes = await request(app)
      .patch(`/api/projects/${projectId}/clips/${clipId}`)
      .send({ status: 'exported' })
    expect(exportedClipRes.body.status).toBe('exported')
    const verifiedClipRes = await request(app)
      .patch(`/api/projects/${projectId}/clips/${clipId}`)
      .send({ status: 'verified_in_game' })
    expect(verifiedClipRes.body.status).toBe('verified_in_game')

    const otherClipRes = await request(app)
      .post(`/api/projects/${projectId}/clips`)
      .send({ assetId: asset.id, name: 'recovery_SE', startFrame: 60, endFrame: 90 })
    const otherMarkerRes = await request(app)
      .post(`/api/projects/${projectId}/clips/${otherClipRes.body.id}/markers`)
      .send({ frame: 70, type: 'note', label: 'unchanged' })
    const crossClipPatchRes = await request(app)
      .patch(`/api/projects/${projectId}/clips/${clipId}/markers/${otherMarkerRes.body.id}`)
      .send({ frame: 30, label: 'must not change' })
    expect(crossClipPatchRes.status).toBe(404)
    const otherClipBundleRes = await request(app)
      .get(`/api/projects/${projectId}/clips/${otherClipRes.body.id}`)
    expect(otherClipBundleRes.body.markers[0]).toMatchObject({ frame: 70, label: 'unchanged' })

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
