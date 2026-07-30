import { describe, expect, it } from 'vitest'
import request from 'supertest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import AdmZip from 'adm-zip'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const godotPath = 'D:/godot/Godot_v4.6.3-stable_win64_console.exe'
const hasGodot = fs.existsSync(godotPath)
const { smokeGodotZip } = require('../godotSmoke.cjs')
const { closeShared, createProjectStore } = require('../lib/projectStore.cjs')

function binaryParser(response, callback) {
  const chunks = []
  response.on('data', (chunk) => chunks.push(chunk))
  response.on('end', () => callback(null, Buffer.concat(chunks)))
}

describe.skipIf(!hasGodot)('action asset review end-to-end', () => {
  it('persists an edited review clip, enforces checks, exports events, and imports the ZIP in Godot', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gss-action-review-e2e-'))
    const dataDir = path.join(workDir, 'data')
    const sourcePath = path.join(workDir, 'attack.mp4')
    const bundlePath = path.join(workDir, 'attack.zip')
    const previousDataDir = process.env.GSS_DATA_DIR
    const serverPath = require.resolve('../server.cjs')
    let studioServices
    let jobId

    const generated = spawnSync(ffmpegPath, [
      '-y',
      '-f', 'lavfi',
      '-i', 'color=c=0x00ff00:s=64x64:r=6:d=1',
      '-vf', 'drawbox=x=24:y=8:w=16:h=48:color=0x1e46dc:t=fill',
      '-an',
      '-pix_fmt', 'yuv420p',
      sourcePath,
    ], { encoding: 'utf8', windowsHide: true })
    expect(generated.status, generated.stderr).toBe(0)

    closeShared()
    delete require.cache[serverPath]
    process.env.GSS_DATA_DIR = dataDir

    try {
      const loaded = require('../server.cjs')
      const app = loaded.app
      studioServices = loaded.studioServices

      const projectRes = await request(app)
        .post('/api/projects')
        .send({ name: 'E2E Action Review', characterName: 'hero' })
      expect(projectRes.status).toBe(201)
      const projectId = projectRes.body.id

      const assetRes = await request(app)
        .post(`/api/projects/${projectId}/assets`)
        .field('kind', 'video')
        .field('role', 'source')
        .attach('file', sourcePath)
      expect(assetRes.status).toBe(201)
      const assetId = assetRes.body.id

      const uploadRes = await request(app)
        .post('/api/video/upload')
        .field('projectId', projectId)
        .field('assetId', assetId)
        .attach('video', sourcePath)
      expect(uploadRes.status).toBe(200)
      expect(uploadRes.body).toMatchObject({
        width: 64,
        height: 64,
        fps: 6,
        frameCount: 6,
        projectId,
        assetId,
      })
      jobId = uploadRes.body.jobId

      const clipRes = await request(app)
        .post(`/api/projects/${projectId}/clips`)
        .send({ assetId, name: 'attack_SE', startFrame: 0, endFrame: 6, loop: false })
      expect(clipRes.status).toBe(201)
      const clipId = clipRes.body.id

      const markerRes = await request(app)
        .post(`/api/projects/${projectId}/clips/${clipId}/markers`)
        .send({ frame: 2, type: 'active_start', label: 'damage opens', payload: { hitbox: 'slash_a' } })
      expect(markerRes.status).toBe(201)
      const markerId = markerRes.body.id

      const editedMarkerRes = await request(app)
        .patch(`/api/projects/${projectId}/clips/${clipId}/markers/${markerId}`)
        .send({ frame: 3, type: 'hit', label: 'impact', payload: { hitbox: 'slash_b', damage: 2 } })
      expect(editedMarkerRes.status).toBe(200)
      expect(editedMarkerRes.body).toMatchObject({
        frame: 3,
        type: 'hit',
        label: 'impact',
        payload: { hitbox: 'slash_b', damage: 2 },
      })

      const invalidMarkerRes = await request(app)
        .post(`/api/projects/${projectId}/clips/${clipId}/markers`)
        .send({ frame: 6, type: 'hit' })
      expect(invalidMarkerRes.status).toBe(400)
      expect(invalidMarkerRes.body.code).toBe('MARKER_FRAME_OUTSIDE_CLIP')

      const submittedRes = await request(app)
        .patch(`/api/projects/${projectId}/clips/${clipId}`)
        .send({ status: 'needs_review' })
      expect(submittedRes.status).toBe(200)

      const earlyApprovalRes = await request(app)
        .patch(`/api/projects/${projectId}/clips/${clipId}`)
        .send({ status: 'approved' })
      expect(earlyApprovalRes.status).toBe(409)
      expect(earlyApprovalRes.body.code).toBe('CLIP_REVIEW_CHECKS_REQUIRED')

      const processingParams = {
        keying: { keyColor: [0, 255, 0], tolerance: 40, feather: 5, spillSuppression: 50 },
        layout: { anchor: 'feet', sourceCenterAnchor: true },
      }
      const checksRes = await request(app)
        .post('/api/video/review-checks')
        .send({ jobId, clipId, params: processingParams })
      expect(checksRes.status).toBe(200)
      expect(checksRes.body).toMatchObject({
        clip: { id: clipId, version: submittedRes.body.version },
        summary: { status: 'pass', warningCount: 0, passCount: 4, skippedCount: 1 },
      })

      const approvedRes = await request(app)
        .patch(`/api/projects/${projectId}/clips/${clipId}`)
        .send({ status: 'approved' })
      expect(approvedRes.status).toBe(200)
      expect(approvedRes.body).toMatchObject({
        status: 'approved',
        reviewChecks: { clip: { id: clipId, version: submittedRes.body.version } },
      })

      const exportRes = await request(app)
        .post('/api/video/export-godot-spriteframes')
        .send({
          jobId,
          clipId,
          params: processingParams,
          spriteParams: {
            frameWidth: 64,
            frameHeight: 64,
            framesPerRow: 3,
            range: { startFrame: 0, endFrame: 6 },
            sampleEvery: 1,
          },
          godot: {
            characterName: 'hero',
            actionName: 'attack',
            animationName: 'attack_SE',
            fps: 6,
            loop: false,
            safeAreaWidth: 64,
            safeAreaHeight: 64,
          },
        })
      expect(exportRes.status, exportRes.body?.error).toBe(200)
      expect(exportRes.body.artifacts).toMatchObject({
        bundle: { filename: 'hero_attack_SE.zip' },
        events: { filename: 'events.json' },
        dispatcher: { filename: 'action_event_dispatcher.gd' },
      })

      const bundleRes = await request(app)
        .get(`/api/video/godot-artifact/${jobId}/bundle`)
        .buffer(true)
        .parse(binaryParser)
      expect(bundleRes.status).toBe(200)
      fs.writeFileSync(bundlePath, bundleRes.body)

      const zip = new AdmZip(bundleRes.body)
      const entries = zip.getEntries().map((entry) => entry.entryName)
      expect(entries).toEqual(expect.arrayContaining([
        'hero_attack_SE_atlas.png',
        'hero_attack_SE.tres',
        'hero_attack_SE.tscn',
        'hero_attack_SE_metadata.json',
        'events.json',
        'action_event_dispatcher.gd',
      ]))
      const events = JSON.parse(zip.readAsText('events.json'))
      expect(events.tracks[0]).toMatchObject({
        clip: { id: clipId, status: 'approved', range: { startFrame: 0, endFrame: 6 } },
        events: [{ id: markerId, type: 'hit', animationFrame: 3, payload: { hitbox: 'slash_b', damage: 2 } }],
        godotMethodTrack: { method: 'dispatch_action_event', targetNodePath: 'ActionEventDispatcher' },
      })

      const smoke = await smokeGodotZip({ bundlePath, godotPath, workDir })
      expect(smoke).toMatchObject({
        scenePath: 'hero_attack_SE.tscn',
        nodeType: 'AnimatedSprite2D',
        animation: 'attack_SE',
        eventsValidated: true,
        eventId: markerId,
        eventType: 'hit',
      })

      await request(app).delete(`/api/video/${jobId}`)
      jobId = null
      studioServices.tailer?.stop()
      studioServices.store.close()
      studioServices = null

      const reopened = createProjectStore({ dataDir })
      try {
        expect(reopened.getProjectBundle(projectId)).toMatchObject({
          project: { id: projectId, name: 'E2E Action Review' },
          clips: [{ id: clipId, status: 'approved', reviewChecks: { clip: { id: clipId } } }],
        })
        expect(reopened.getActionClipBundle(clipId)).toMatchObject({
          clip: { id: clipId, status: 'approved', reviewChecks: { clip: { id: clipId } } },
          markers: [{ id: markerId, frame: 3, type: 'hit', payload: { hitbox: 'slash_b', damage: 2 } }],
        })
      } finally {
        reopened.close()
      }
    } finally {
      if (jobId) {
        try {
          const activeApp = require('../server.cjs').app
          await request(activeApp).delete(`/api/video/${jobId}`)
        } catch { /* best-effort cleanup */ }
      }
      studioServices?.tailer?.stop()
      studioServices?.store?.close()
      closeShared()
      delete require.cache[serverPath]
      if (previousDataDir === undefined) delete process.env.GSS_DATA_DIR
      else process.env.GSS_DATA_DIR = previousDataDir
      fs.rmSync(workDir, { recursive: true, force: true })
    }
  }, 120_000)
})
