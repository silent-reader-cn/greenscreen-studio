/**
 * server.cjs API 端点测试
 *
 * 使用 supertest 对 Express app 做 HTTP 级别的测试。
 * 关键依赖（canvas、multer、videoProcessor）mock 掉以避免需要真实文件和图像处理库。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import fs from 'fs'
import { createRequire } from 'module'

const nodeRequire = createRequire(import.meta.url)

// Mock videoProcessor for all tests in this file
vi.mock('../../videoProcessor.cjs', () => ({
  processVideo: vi.fn(),
  probeVideo: vi.fn().mockResolvedValue({
    width: 1920, height: 1080, fps: 30, duration: 10,
    frameCount: 300, hasAudio: true,
  }),
  exportSpriteSheet: vi.fn(),
  exportGodotSpriteFrames: vi.fn(),
  selectSpriteFrames: vi.fn(),
  buildGodotAnimatedSpriteScene: vi.fn(),
  findLoopEndFrame: vi.fn().mockResolvedValue({
    candidates: [{ frame: 120, score: 5 }, { frame: 200, score: 12 }],
    scores: [{ frame: 2, score: 10 }, { frame: 3, score: 15 }],
  }),
  dHashRaw: vi.fn(),
  hammingDistance: vi.fn(),
  pickLoopCandidates: vi.fn(),
}))

// ===== /api/health 端点 =====

describe('GET /api/health', () => {
  let app

  beforeEach(async () => {
    vi.resetModules()
    // Mock videoProcessor — server 引用它
    vi.doMock('../videoProcessor.cjs', () => ({
      processVideo: vi.fn(),
      probeVideo: vi.fn().mockResolvedValue({
        width: 1920, height: 1080, fps: 30, duration: 10,
        frameCount: 300, hasAudio: true,
      }),
      exportSpriteSheet: vi.fn(),
      findLoopEndFrame: vi.fn(),
      dHashRaw: vi.fn(),
      hammingDistance: vi.fn(),
      pickLoopCandidates: vi.fn(),
    }))

    const mod = await import('../../server.cjs')
    app = mod.app
  })

  it('返回 200 和 status ok', async () => {
    const res = await request(app).get('/api/health')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
    expect(res.body).toHaveProperty('time')
  })
})

// ===== POST /api/export 端点 =====

describe('POST /api/export', () => {
  let app

  beforeEach(async () => {
    vi.resetModules()
    vi.doMock('../../videoProcessor.cjs', () => ({
      processVideo: vi.fn(),
      probeVideo: vi.fn(),
      exportSpriteSheet: vi.fn(),
    }))

    const mod = await import('../../server.cjs')
    app = mod.app
  })

  it('无文件时返回 400', async () => {
    const res = await request(app)
      .post('/api/export')
      .field('params', JSON.stringify({
        keying: {},
        layout: { canvasWidth: 100, canvasHeight: 100, personWidth: 80, personHeight: 80, autoCrop: true },
        mode: 'greenscreen',
      }))
    expect(res.status).toBe(400)
    expect(res.body).toHaveProperty('error')
  })
})

// ===== POST /api/video/upload 端点 =====

describe('POST /api/video/upload', () => {
  let app

  beforeEach(async () => {
    vi.resetModules()
    vi.doMock('../../videoProcessor.cjs', () => ({
      processVideo: vi.fn(),
      probeVideo: vi.fn().mockResolvedValue({
        width: 1920, height: 1080, fps: 30, duration: 10,
        frameCount: 300, hasAudio: true,
      }),
      exportSpriteSheet: vi.fn(),
      findLoopEndFrame: vi.fn(),
      dHashRaw: vi.fn(),
      hammingDistance: vi.fn(),
      pickLoopCandidates: vi.fn(),
    }))

    const mod = await import('../../server.cjs')
    app = mod.app
  })

  it('无文件时返回 400', async () => {
    const res = await request(app)
      .post('/api/video/upload')
    expect(res.status).toBe(400)
    expect(res.body).toHaveProperty('error')
  })
})

// ===== GET /api/video/progress/:taskId =====

describe('GET /api/video/progress/:taskId', () => {
  let app

  beforeEach(async () => {
    vi.resetModules()
    vi.doMock('../../videoProcessor.cjs', () => ({
      processVideo: vi.fn(),
      probeVideo: vi.fn(),
      exportSpriteSheet: vi.fn(),
    }))

    const mod = await import('../../server.cjs')
    app = mod.app
  })

  it('不存在的 taskId 返回 404', async () => {
    const res = await request(app)
      .get('/api/video/progress/nonexistent-task')
    expect(res.status).toBe(404)
    expect(res.body).toHaveProperty('error')
  })
})

// ===== GET /api/video/download/:jobId =====

describe('GET /api/video/download/:jobId', () => {
  let app

  beforeEach(async () => {
    vi.resetModules()
    vi.doMock('../../videoProcessor.cjs', () => ({
      processVideo: vi.fn(),
      probeVideo: vi.fn(),
      exportSpriteSheet: vi.fn(),
    }))

    const mod = await import('../../server.cjs')
    app = mod.app
  })

  it('不存在的 jobId 返回 404', async () => {
    const res = await request(app)
      .get('/api/video/download/bad-job')
    expect(res.status).toBe(404)
    expect(res.body).toHaveProperty('error')
  })
})

// ===== GET /api/video/preview/:jobId =====

describe('GET /api/video/preview/:jobId', () => {
  let app

  beforeEach(async () => {
    vi.resetModules()
    vi.doMock('../../videoProcessor.cjs', () => ({
      processVideo: vi.fn(),
      probeVideo: vi.fn(),
      exportSpriteSheet: vi.fn(),
    }))

    const mod = await import('../../server.cjs')
    app = mod.app
  })

  it('不存在的 jobId 返回 404', async () => {
    const res = await request(app)
      .get('/api/video/preview/bad-job')
    expect(res.status).toBe(404)
    expect(res.body).toHaveProperty('error')
  })
})

// ===== POST /api/video/find-loop-end =====

describe('POST /api/video/find-loop-end', () => {
  let app

  beforeEach(async () => {
    const mod = await import('../../server.cjs')
    app = mod.app
  })

  it('不存在的 jobId 返回 404', async () => {
    const res = await request(app)
      .post('/api/video/find-loop-end')
      .send({ jobId: 'nonexistent', startFrame: 10 })
    expect(res.status).toBe(404)
    expect(res.body).toHaveProperty('error')
  })

  it('下载完成后仍保留视频 job 以便继续检测下一个片段', async () => {
    const fakeVideoProcessor = {
      probeVideo: vi.fn().mockResolvedValue({
        width: 1920,
        height: 1080,
        fps: 30,
        duration: 10,
        frameCount: 300,
        hasAudio: true,
      }),
      processVideo: vi.fn(async (inputPath, outputPath, params, onProgress) => {
        onProgress?.(1, 1)
        fs.writeFileSync(outputPath, Buffer.from('fake-video-output'))
        return { frameCount: 60 }
      }),
      exportSpriteSheet: vi.fn(),
      findLoopEndFrame: vi.fn().mockResolvedValue({
        candidates: [{ frame: 180, score: 4 }],
        scores: [{ frame: 180, score: 4 }],
      }),
      dHashRaw: vi.fn(),
      hammingDistance: vi.fn(),
      pickLoopCandidates: vi.fn(),
    }

    const serverPath = nodeRequire.resolve('../server.cjs')
    const videoProcessorPath = nodeRequire.resolve('../videoProcessor.cjs')
    delete nodeRequire.cache[serverPath]
    delete nodeRequire.cache[videoProcessorPath]
    nodeRequire.cache[videoProcessorPath] = {
      id: videoProcessorPath,
      filename: videoProcessorPath,
      loaded: true,
      exports: fakeVideoProcessor,
      children: [],
      paths: [],
    }

    const { app: freshApp } = nodeRequire('../server.cjs')

    const uploadRes = await request(freshApp)
      .post('/api/video/upload')
      .attach('video', Buffer.from('fake-video-input'), 'clip.mp4')
    expect(uploadRes.status).toBe(200)

    const jobId = uploadRes.body.jobId
    const params = {
      keying: {},
      layout: {},
      mode: 'transparent',
    }

    const processRes = await request(freshApp)
      .post('/api/video/process')
      .send({
        jobId,
        params,
        format: 'webm',
        range: { startFrame: 0, endFrame: 60 },
      })
    expect(processRes.status).toBe(200)

    let progressRes
    for (let i = 0; i < 10; i += 1) {
      progressRes = await request(freshApp).get(`/api/video/progress/${processRes.body.taskId}`)
      if (progressRes.body.status === 'done') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(progressRes.body.status).toBe('done')

    const downloadRes = await request(freshApp).get(`/api/video/download/${jobId}`)
    expect(downloadRes.status).toBe(200)

    const detectRes = await request(freshApp)
      .post('/api/video/find-loop-end')
      .send({
        jobId,
        startFrame: 61,
        params,
    })
    expect(detectRes.status).toBe(200)
    expect(detectRes.body.candidates[0].frame).toBe(180)
    expect(fakeVideoProcessor.findLoopEndFrame).toHaveBeenCalledWith(
      expect.any(String),
      61,
      30,
      300,
      expect.objectContaining({
        params,
        sourceWidth: 1920,
        sourceHeight: 1080,
      })
    )

    await request(freshApp).delete(`/api/video/${jobId}`)
  })
})

describe('POST /api/video/export-godot-spriteframes', () => {
  it('returns 404 for an unknown job', async () => {
    const mod = await import('../../server.cjs')
    const res = await request(mod.app)
      .post('/api/video/export-godot-spriteframes')
      .send({
        jobId: 'nonexistent',
        spriteParams: { frameWidth: 256, frameHeight: 256, framesPerRow: 8 },
      })

    expect(res.status).toBe(404)
    expect(res.body).toHaveProperty('error', 'job not found')
  })

  it('writes and serves a Godot bundle plus individual artifacts', async () => {
    const fakeVideoProcessor = {
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
      dHashRaw: vi.fn(),
      hammingDistance: vi.fn(),
      pickLoopCandidates: vi.fn(),
      selectSpriteFrames: vi.fn().mockImplementation((selection) => {
        if (Array.isArray(selection.frames) && selection.frames.length > 0) {
          return {
            frames: [...selection.frames],
            range: selection.range || { startFrame: 0, endFrame: 300 },
            frameCount: selection.frames.length,
          }
        }
        return {
          frames: [0, 3, 6],
          range: selection.range || { startFrame: 0, endFrame: 9 },
          frameCount: 3,
        }
      }),
      exportGodotSpriteFrames: vi.fn(async (frameJobs, params, spriteParams, options, onProgress) => {
        onProgress?.(frameJobs.length, frameJobs.length)
        return {
          buffer: Buffer.from('fake-atlas'),
          tres: '[gd_resource type="SpriteFrames" format=3]\n',
          frameCount: frameJobs.length,
          atlasDimensions: { width: 512, height: 512 },
          frames: frameJobs.map((job) => ({ ...job, region: { x: 0, y: 0, width: 256, height: 256 } })),
          animations: options.animations.map(animation => ({
            ...animation,
            frameCount: frameJobs.filter(job => job.animationName === animation.name).length,
          })),
          cleanup: { frames: frameJobs.length },
          warnings: [],
        }
      }),
      buildGodotAnimatedSpriteScene: vi.fn(({ spriteFramesResourcePath, animationName, frameHeight }) => [
        '[gd_scene load_steps=2 format=3]',
        '',
        `[ext_resource type="SpriteFrames" path="${spriteFramesResourcePath}" id="1_sprite_frames"]`,
        '',
        '[node name="AnimatedSprite2D" type="AnimatedSprite2D"]',
        'sprite_frames = ExtResource("1_sprite_frames")',
        `animation = &"${animationName}"`,
        `offset = Vector2(0, ${-frameHeight / 2})`,
        '',
      ].join('\n')),
    }

    const serverPath = nodeRequire.resolve('../server.cjs')
    const videoProcessorPath = nodeRequire.resolve('../videoProcessor.cjs')
    delete nodeRequire.cache[serverPath]
    delete nodeRequire.cache[videoProcessorPath]
    nodeRequire.cache[videoProcessorPath] = {
      id: videoProcessorPath,
      filename: videoProcessorPath,
      loaded: true,
      exports: fakeVideoProcessor,
      children: [],
      paths: [],
    }
    const { app: freshApp } = nodeRequire('../server.cjs')

    const uploadRes = await request(freshApp)
      .post('/api/video/upload')
      .attach('video', Buffer.from('fake-video-input'), 'clip.mp4')
    expect(uploadRes.status).toBe(200)

    const exportRes = await request(freshApp)
      .post('/api/video/export-godot-spriteframes')
      .send({
        jobId: uploadRes.body.jobId,
        params: { keying: {}, layout: { sourceCharacterHeight: 520 } },
        spriteParams: { frameWidth: 256, frameHeight: 256, framesPerRow: 8, range: { startFrame: 0, endFrame: 9 } },
        godot: { animationName: 'idle', safeAreaWidth: 160, safeAreaHeight: 160, fps: 12, loop: true },
      })

    expect(exportRes.status).toBe(200)
    expect(exportRes.body.frameCount).toBe(3)
    expect(exportRes.body.artifacts).toEqual(expect.objectContaining({
      bundle: expect.objectContaining({ filename: expect.stringMatching(/\.zip$/) }),
      atlas: expect.objectContaining({ filename: expect.stringMatching(/_atlas\.png$/) }),
      spriteframes: expect.objectContaining({ filename: expect.stringMatching(/\.tres$/) }),
      scene: expect.objectContaining({ filename: expect.stringMatching(/\.tscn$/) }),
      metadata: expect.objectContaining({ filename: expect.stringMatching(/_metadata\.json$/) }),
    }))
    expect(fakeVideoProcessor.exportGodotSpriteFrames).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        mode: 'transparent',
        layout: expect.objectContaining({
          canvasWidth: 256,
          canvasHeight: 256,
          personWidth: 160,
          personHeight: 160,
          anchor: 'feet',
          sourceCharacterHeight: 520,
        }),
      }),
      { frameWidth: 256, frameHeight: 256, framesPerRow: 8 },
      expect.objectContaining({ fps: 12 }),
      expect.any(Function)
    )
    expect(fakeVideoProcessor.buildGodotAnimatedSpriteScene).toHaveBeenCalledWith(expect.objectContaining({
      animationName: 'idle',
      frameHeight: 256,
      spriteFramesResourcePath: expect.stringMatching(/^res:\/\/godot_.*\.tres$/),
    }))

    const multiExportRes = await request(freshApp)
      .post('/api/video/export-godot-spriteframes')
      .send({
        jobId: uploadRes.body.jobId,
        params: { keying: {}, layout: { sourceCharacterHeight: 520 } },
        spriteParams: { frameWidth: 256, frameHeight: 256, framesPerRow: 8 },
        godot: {
          safeAreaWidth: 160,
          safeAreaHeight: 160,
          fps: 12,
          animations: [
            { name: 'idle', frames: [0, 3, 6], fps: 8, loop: true },
            { name: 'attack', frames: [30, 34], fps: 16, loop: false },
          ],
        },
      })

    expect(multiExportRes.status).toBe(200)
    expect(multiExportRes.body.frameCount).toBe(5)
    expect(multiExportRes.body.animationName).toBeNull()
    expect(multiExportRes.body.animations).toEqual([
      expect.objectContaining({ name: 'idle', fps: 8, loop: true, frameCount: 3 }),
      expect.objectContaining({ name: 'attack', fps: 16, loop: false, frameCount: 2 }),
    ])
    const multiCall = fakeVideoProcessor.exportGodotSpriteFrames.mock.calls.at(-1)
    expect(multiCall[0].map(job => ({
      atlasIndex: job.atlasIndex,
      animationName: job.animationName,
      animationFrameIndex: job.animationFrameIndex,
      sourceFrameIndex: job.sourceFrameIndex,
    }))).toEqual([
      { atlasIndex: 0, animationName: 'idle', animationFrameIndex: 0, sourceFrameIndex: 0 },
      { atlasIndex: 1, animationName: 'idle', animationFrameIndex: 1, sourceFrameIndex: 3 },
      { atlasIndex: 2, animationName: 'idle', animationFrameIndex: 2, sourceFrameIndex: 6 },
      { atlasIndex: 3, animationName: 'attack', animationFrameIndex: 0, sourceFrameIndex: 30 },
      { atlasIndex: 4, animationName: 'attack', animationFrameIndex: 1, sourceFrameIndex: 34 },
    ])
    expect(multiCall[3].animations).toEqual([
      { name: 'idle', fps: 8, loop: true },
      { name: 'attack', fps: 16, loop: false },
    ])

    const mirrorExportRes = await request(freshApp)
      .post('/api/video/export-godot-spriteframes')
      .send({
        jobId: uploadRes.body.jobId,
        params: { keying: {}, layout: { sourceCharacterHeight: 520 } },
        spriteParams: { frameWidth: 256, frameHeight: 256, framesPerRow: 8 },
        godot: {
          safeAreaWidth: 160,
          safeAreaHeight: 160,
          fps: 12,
          animations: [
            { name: 'walk_SE', frames: [0, 3, 6], fps: 10, loop: true },
            { name: 'walk_SW', mirrorOf: 'walk_SE', fps: 10, loop: true },
          ],
        },
      })

    expect(mirrorExportRes.status).toBe(200)
    expect(mirrorExportRes.body.frameCount).toBe(6)
    expect(mirrorExportRes.body.animations).toEqual([
      expect.objectContaining({ name: 'walk_SE', fps: 10, loop: true, frameCount: 3 }),
      expect.objectContaining({ name: 'walk_SW', fps: 10, loop: true, frameCount: 3 }),
    ])
    const mirrorCall = fakeVideoProcessor.exportGodotSpriteFrames.mock.calls.at(-1)
    expect(mirrorCall[0].map(job => ({
      atlasIndex: job.atlasIndex,
      animationName: job.animationName,
      animationFrameIndex: job.animationFrameIndex,
      sourceFrameIndex: job.sourceFrameIndex,
      flipH: job.flipH,
    }))).toEqual([
      { atlasIndex: 0, animationName: 'walk_SE', animationFrameIndex: 0, sourceFrameIndex: 0, flipH: false },
      { atlasIndex: 1, animationName: 'walk_SE', animationFrameIndex: 1, sourceFrameIndex: 3, flipH: false },
      { atlasIndex: 2, animationName: 'walk_SE', animationFrameIndex: 2, sourceFrameIndex: 6, flipH: false },
      { atlasIndex: 3, animationName: 'walk_SW', animationFrameIndex: 0, sourceFrameIndex: 0, flipH: true },
      { atlasIndex: 4, animationName: 'walk_SW', animationFrameIndex: 1, sourceFrameIndex: 3, flipH: true },
      { atlasIndex: 5, animationName: 'walk_SW', animationFrameIndex: 2, sourceFrameIndex: 6, flipH: true },
    ])
    expect(mirrorCall[3].animations).toEqual([
      { name: 'walk_SE', fps: 10, loop: true },
      { name: 'walk_SW', fps: 10, loop: true },
    ])

    const secondUploadRes = await request(freshApp)
      .post('/api/video/upload')
      .attach('video', Buffer.from('fake-video-input-ne'), 'clip-ne.mp4')
    expect(secondUploadRes.status).toBe(200)

    const multiSourceExportRes = await request(freshApp)
      .post('/api/video/export-godot-spriteframes')
      .send({
        jobId: uploadRes.body.jobId,
        params: { keying: {}, layout: { sourceCharacterHeight: 520 } },
        spriteParams: { frameWidth: 256, frameHeight: 256, framesPerRow: 8 },
        godot: {
          safeAreaWidth: 160,
          safeAreaHeight: 160,
          fps: 12,
          animations: [
            { name: 'walk_SE', jobId: uploadRes.body.jobId, frames: [0, 3], fps: 10, loop: true },
            { name: 'walk_NE', jobId: secondUploadRes.body.jobId, frames: [1, 4], fps: 10, loop: true },
            { name: 'walk_SW', mirrorOf: 'walk_SE', fps: 10, loop: true },
            { name: 'walk_NW', mirrorOf: 'walk_NE', fps: 10, loop: true },
          ],
        },
      })

    expect(multiSourceExportRes.status).toBe(200)
    expect(multiSourceExportRes.body.frameCount).toBe(8)
    expect(multiSourceExportRes.body.animations).toEqual([
      expect.objectContaining({ name: 'walk_SE', frameCount: 2 }),
      expect.objectContaining({ name: 'walk_NE', frameCount: 2 }),
      expect.objectContaining({ name: 'walk_SW', frameCount: 2 }),
      expect.objectContaining({ name: 'walk_NW', frameCount: 2 }),
    ])
    const multiSourceCall = fakeVideoProcessor.exportGodotSpriteFrames.mock.calls.at(-1)
    expect(multiSourceCall[0].map(job => ({
      animationName: job.animationName,
      sourceFrameIndex: job.sourceFrameIndex,
      flipH: job.flipH,
      inputPath: job.inputPath,
    }))).toEqual([
      expect.objectContaining({ animationName: 'walk_SE', sourceFrameIndex: 0, flipH: false }),
      expect.objectContaining({ animationName: 'walk_SE', sourceFrameIndex: 3, flipH: false }),
      expect.objectContaining({ animationName: 'walk_NE', sourceFrameIndex: 1, flipH: false }),
      expect.objectContaining({ animationName: 'walk_NE', sourceFrameIndex: 4, flipH: false }),
      expect.objectContaining({ animationName: 'walk_SW', sourceFrameIndex: 0, flipH: true }),
      expect.objectContaining({ animationName: 'walk_SW', sourceFrameIndex: 3, flipH: true }),
      expect.objectContaining({ animationName: 'walk_NW', sourceFrameIndex: 1, flipH: true }),
      expect.objectContaining({ animationName: 'walk_NW', sourceFrameIndex: 4, flipH: true }),
    ])
    // SE/SW share one source path, NE/NW share the other.
    expect(new Set(multiSourceCall[0].filter(j => j.animationName === 'walk_SE' || j.animationName === 'walk_SW').map(j => j.inputPath)).size).toBe(1)
    expect(new Set(multiSourceCall[0].filter(j => j.animationName === 'walk_NE' || j.animationName === 'walk_NW').map(j => j.inputPath)).size).toBe(1)
    expect(multiSourceCall[0][0].inputPath).not.toBe(multiSourceCall[0][2].inputPath)

    const metadataRes = await request(freshApp)
      .get(`/api/video/godot-artifact/${uploadRes.body.jobId}/metadata`)
    expect(metadataRes.status).toBe(200)
    const metadata = JSON.parse(metadataRes.text)
    expect(metadata.animationNames).toEqual(['walk_SE', 'walk_NE', 'walk_SW', 'walk_NW'])
    expect(metadata.selections.map(item => ({
      animationName: item.animationName,
      mirroredFrom: item.mirroredFrom,
      flipH: item.flipH,
      jobId: item.jobId,
    }))).toEqual([
      { animationName: 'walk_SE', mirroredFrom: null, flipH: false, jobId: uploadRes.body.jobId },
      { animationName: 'walk_NE', mirroredFrom: null, flipH: false, jobId: secondUploadRes.body.jobId },
      { animationName: 'walk_SW', mirroredFrom: 'walk_SE', flipH: true, jobId: null },
      { animationName: 'walk_NW', mirroredFrom: 'walk_NE', flipH: true, jobId: null },
    ])
    expect(metadata.scene).toEqual(expect.objectContaining({
      defaultAnimation: 'walk_SE',
      anchor: 'feet',
    }))

    for (const artifact of ['bundle', 'atlas', 'spriteframes', 'scene', 'metadata']) {
      const artifactRes = await request(freshApp)
        .get(`/api/video/godot-artifact/${uploadRes.body.jobId}/${artifact}`)
      expect(artifactRes.status).toBe(200)
      expect(artifactRes.headers['content-disposition']).toContain('attachment')
    }

    const bundleRes = await request(freshApp)
      .get(`/api/video/godot-artifact/${uploadRes.body.jobId}/bundle`)
      .buffer(true)
      .parse((res, callback) => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => callback(null, Buffer.concat(chunks)))
      })
    expect(bundleRes.body.subarray(0, 2).toString('utf8')).toBe('PK')
    expect(bundleRes.body.includes(Buffer.from(multiSourceExportRes.body.artifacts.scene.filename))).toBe(true)
    expect(bundleRes.body.includes(Buffer.from(multiSourceExportRes.body.artifacts.spriteframes.filename))).toBe(true)
    expect(multiSourceExportRes.body.artifacts.bundle.filename).toMatch(/\.zip$/)

    const sceneRes = await request(freshApp)
      .get(`/api/video/godot-artifact/${uploadRes.body.jobId}/scene`)
    const sceneText = sceneRes.body.toString('utf8')
    expect(sceneText).toContain('[node name="AnimatedSprite2D" type="AnimatedSprite2D"]')
    expect(sceneText).toContain('path="res://')
    expect(sceneText).toContain('offset = Vector2(0, -128)')

    await request(freshApp).delete(`/api/video/${uploadRes.body.jobId}`)
    await request(freshApp).delete(`/api/video/${secondUploadRes.body.jobId}`)
  })
})
