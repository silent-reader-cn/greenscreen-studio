import { describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import AdmZip from 'adm-zip'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)

function createFakeVideoProcessor() {
  return {
    probeVideo: vi.fn().mockResolvedValue({
      width: 1920,
      height: 1080,
      fps: 30,
      duration: 10,
      frameCount: 300,
      hasAudio: true,
    }),
    processVideo: vi.fn(),
    exportSpriteSheet: vi.fn(),
    findLoopEndFrame: vi.fn(),
    renderGodotClipPreview: vi.fn(),
    selectSpriteFrames: vi.fn((selection, totalFrames) => {
      const range = selection.range || { startFrame: 0, endFrame: totalFrames }
      const frames = Array.isArray(selection.frames) && selection.frames.length > 0
        ? [...selection.frames]
        : [range.startFrame, range.startFrame + 2, range.startFrame + 5, range.endFrame - 1]
          .filter((frame, index, values) => frame >= range.startFrame && frame < range.endFrame && values.indexOf(frame) === index)
      return {
        mode: Array.isArray(selection.frames) ? 'frames' : 'sample',
        frames,
        frameCount: frames.length,
        range,
        sampleEvery: selection.sampleEvery || 1,
        maxFrames: selection.maxFrames || null,
        ordering: 'ascending_source_frame',
        warnings: [],
      }
    }),
    exportGodotSpriteFrames: vi.fn(async (frameJobs, params, spriteParams, options, onProgress) => {
      onProgress?.(frameJobs.length, frameJobs.length)
      return {
        buffer: Buffer.from('fake-atlas'),
        tres: '[gd_resource type="SpriteFrames" format=3]\n',
        frameCount: frameJobs.length,
        atlasDimensions: { width: 256, height: 256 },
        frames: frameJobs,
        animations: options.animations.map((animation) => ({
          ...animation,
          frameCount: frameJobs.filter((frame) => frame.animationName === animation.name).length,
        })),
        cleanup: { frames: frameJobs.length },
        warnings: [],
      }
    }),
    buildGodotAnimatedSpriteScene: vi.fn(() => '[gd_scene format=3]\n'),
  }
}

function godotRequest(jobId, clipId, range) {
  return {
    jobId,
    clipId,
    params: { keying: {}, layout: {} },
    spriteParams: { frameWidth: 128, frameHeight: 128, framesPerRow: 4, range },
    godot: { animationName: 'attack', fps: 10, loop: false },
  }
}

describe('reviewed Godot event export', () => {
  it('enforces review identity and approval before serving events.json', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gss-events-server-'))
    const previousDataDir = process.env.GSS_DATA_DIR
    const serverPath = require.resolve('../server.cjs')
    const videoProcessorPath = require.resolve('../videoProcessor.cjs')
    delete require.cache[serverPath]
    delete require.cache[videoProcessorPath]
    require.cache[videoProcessorPath] = {
      id: videoProcessorPath,
      filename: videoProcessorPath,
      loaded: true,
      exports: createFakeVideoProcessor(),
      children: [],
      paths: [],
    }
    process.env.GSS_DATA_DIR = tempDir

    let studioServices
    let reviewedJobId
    let genericJobId
    try {
      const loaded = require('../server.cjs')
      const app = loaded.app
      studioServices = loaded.studioServices
      const sourcePath = path.join(tempDir, 'source.mp4')
      fs.writeFileSync(sourcePath, 'source')
      const project = studioServices.store.createProject({ name: 'Review Project' })
      const asset = studioServices.store.addAsset(project.id, {
        kind: 'video',
        role: 'source',
        filePath: sourcePath,
        originalName: 'source.mp4',
        mimeType: 'video/mp4',
      })
      const otherAsset = studioServices.store.addAsset(project.id, {
        kind: 'video',
        role: 'source',
        filePath: sourcePath,
        originalName: 'other.mp4',
        mimeType: 'video/mp4',
      })
      const approved = studioServices.store.createActionClip(project.id, {
        assetId: asset.id,
        name: 'attack',
        startFrame: 10,
        endFrame: 20,
        loop: false,
      })
      studioServices.store.addActionMarker(approved.id, {
        frame: 12,
        type: 'active_start',
        payload: { phase: 'active' },
      })
      studioServices.store.addActionMarker(approved.id, {
        frame: 14,
        type: 'hit',
        label: 'damage',
        payload: { hitbox: 'slash_a' },
      })
      studioServices.store.updateActionClip(approved.id, { status: 'needs_review' })
      studioServices.store.updateActionClip(approved.id, { status: 'approved' })
      const otherApproved = studioServices.store.createActionClip(project.id, {
        assetId: otherAsset.id,
        name: 'other_attack',
        startFrame: 50,
        endFrame: 60,
      })
      studioServices.store.updateActionClip(otherApproved.id, { status: 'needs_review' })
      studioServices.store.updateActionClip(otherApproved.id, { status: 'approved' })
      const draft = studioServices.store.createActionClip(project.id, {
        assetId: asset.id,
        name: 'draft',
        startFrame: 30,
        endFrame: 40,
      })

      const reviewedUpload = await request(app)
        .post('/api/video/upload')
        .field('projectId', project.id)
        .field('assetId', asset.id)
        .attach('video', Buffer.from('reviewed-video'), 'source.mp4')
      expect(reviewedUpload.status).toBe(200)
      expect(reviewedUpload.body).toMatchObject({ projectId: project.id, assetId: asset.id })
      reviewedJobId = reviewedUpload.body.jobId

      const invalidAssetUpload = await request(app)
        .post('/api/video/upload')
        .field('projectId', project.id)
        .field('assetId', 'missing_asset')
        .attach('video', Buffer.from('invalid-context-video'), 'source.mp4')
      expect(invalidAssetUpload.status).toBe(400)
      expect(invalidAssetUpload.body.code).toBe('VIDEO_REVIEW_ASSET_INVALID')

      const genericUpload = await request(app)
        .post('/api/video/upload')
        .attach('video', Buffer.from('generic-video'), 'generic.mp4')
      expect(genericUpload.status).toBe(200)
      genericJobId = genericUpload.body.jobId

      const missingContext = await request(app)
        .post('/api/video/export-godot-spriteframes')
        .send(godotRequest(genericJobId, approved.id, { startFrame: 10, endFrame: 20 }))
      expect(missingContext.status).toBe(409)
      expect(missingContext.body.code).toBe('CLIP_JOB_CONTEXT_REQUIRED')

      const notApproved = await request(app)
        .post('/api/video/export-godot-spriteframes')
        .send(godotRequest(reviewedJobId, draft.id, { startFrame: 30, endFrame: 40 }))
      expect(notApproved.status).toBe(409)
      expect(notApproved.body.code).toBe('CLIP_NOT_APPROVED')

      const wrongAsset = await request(app)
        .post('/api/video/export-godot-spriteframes')
        .send(godotRequest(reviewedJobId, otherApproved.id, { startFrame: 50, endFrame: 60 }))
      expect(wrongAsset.status).toBe(409)
      expect(wrongAsset.body.code).toBe('CLIP_JOB_CONTEXT_MISMATCH')

      const wrongRange = await request(app)
        .post('/api/video/export-godot-spriteframes')
        .send(godotRequest(reviewedJobId, approved.id, { startFrame: 11, endFrame: 20 }))
      expect(wrongRange.status).toBe(409)
      expect(wrongRange.body.code).toBe('CLIP_EXPORT_RANGE_MISMATCH')

      const exported = await request(app)
        .post('/api/video/export-godot-spriteframes')
        .send(godotRequest(reviewedJobId, approved.id, { startFrame: 10, endFrame: 20 }))
      expect(exported.status).toBe(200)
      expect(exported.body.artifacts.events).toEqual(expect.objectContaining({ filename: 'events.json' }))

      const eventsResponse = await request(app)
        .get(`/api/video/godot-artifact/${reviewedJobId}/events`)
      expect(eventsResponse.status).toBe(200)
      expect(eventsResponse.headers['content-disposition']).toContain('filename="events.json"')
      const events = JSON.parse(eventsResponse.text)
      expect(events.tracks).toHaveLength(1)
      expect(events.tracks[0].clip).toMatchObject({
        reviewed: true,
        id: approved.id,
        name: 'attack',
        status: 'approved',
        range: { startFrame: 10, endFrame: 20 },
      })
      expect(events.tracks[0].events).toEqual([
        expect.objectContaining({ sourceFrame: 12, animationFrame: 1, exactSourceFrame: true }),
        expect.objectContaining({
          sourceFrame: 14,
          animationFrame: 2,
          mappedSourceFrame: 15,
          exactSourceFrame: false,
          payload: { hitbox: 'slash_a' },
        }),
      ])

      const metadataResponse = await request(app)
        .get(`/api/video/godot-artifact/${reviewedJobId}/metadata`)
      expect(JSON.parse(metadataResponse.text).events).toEqual({
        resourcePath: 'res://events.json',
        schemaVersion: 1,
        trackCount: 1,
        eventCount: 2,
        reviewedClipId: approved.id,
      })

      const bundleResponse = await request(app)
        .get(`/api/video/godot-artifact/${reviewedJobId}/bundle`)
        .buffer(true)
        .parse((response, callback) => {
          const chunks = []
          response.on('data', (chunk) => chunks.push(chunk))
          response.on('end', () => callback(null, Buffer.concat(chunks)))
        })
      const entries = new AdmZip(bundleResponse.body).getEntries().map((entry) => entry.entryName)
      expect(entries).toContain('events.json')
      expect(entries.some((entry) => /_events\.json$/.test(entry) && entry !== 'events.json')).toBe(false)
    } finally {
      if (reviewedJobId) await request(require('../server.cjs').app).delete(`/api/video/${reviewedJobId}`)
      if (genericJobId) await request(require('../server.cjs').app).delete(`/api/video/${genericJobId}`)
      studioServices?.tailer?.stop()
      studioServices?.store?.close()
      delete require.cache[serverPath]
      delete require.cache[videoProcessorPath]
      if (previousDataDir === undefined) delete process.env.GSS_DATA_DIR
      else process.env.GSS_DATA_DIR = previousDataDir
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
