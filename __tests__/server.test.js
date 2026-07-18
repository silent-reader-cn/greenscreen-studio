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
