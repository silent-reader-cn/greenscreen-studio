/**
 * server.cjs API 端点测试
 *
 * 使用 supertest 对 Express app 做 HTTP 级别的测试。
 * 关键依赖（canvas、multer、videoProcessor）mock 掉以避免需要真实文件和图像处理库。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'

// ===== /api/health 端点 =====

describe('GET /api/health', () => {
  let app

  beforeEach(async () => {
    vi.resetModules()
    // Mock videoProcessor — server 引用它
    vi.doMock('../../videoProcessor.cjs', () => ({
      processVideo: vi.fn(),
      probeVideo: vi.fn().mockResolvedValue({
        width: 1920, height: 1080, fps: 30, duration: 10,
        frameCount: 300, hasAudio: true,
      }),
      exportSpriteSheet: vi.fn(),
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
