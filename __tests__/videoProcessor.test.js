/**
 * videoProcessor.cjs 测试
 *
 * probeVideo 测试 — 使用 vi.spyOn 在全局层面 mock child_process.spawn
 * 因为 CJS 模块的 require() 不走 vitest 的 import 拦截机制。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import cp from 'child_process'

describe('probeVideo', () => {
  let probeVideo
  let spawnMock

  beforeEach(async () => {
    vi.resetModules()
    // 在全局层面 mock spawn
    spawnMock = vi.spyOn(cp, 'spawn').mockImplementation(() => {
      throw new Error('spawn mock not configured for this test')
    })
    const mod = await import('../../videoProcessor.cjs')
    probeVideo = mod.probeVideo
  })

  afterEach(() => {
    spawnMock.mockRestore()
  })

  it('成功解析 ffprobe JSON 输出（含音轨）', async () => {
    const ffprobeOutput = JSON.stringify({
      streams: [
        { codec_type: 'video', width: 1920, height: 1080, r_frame_rate: '30000/1001', codec_name: 'h264', nb_frames: '150' },
        { codec_type: 'audio', codec_name: 'aac' },
      ],
      format: { duration: '5.000' },
    })

    let closeCb
    const mockProcess = {
      stdout: { on: vi.fn((event, cb) => { if (event === 'data') setTimeout(() => cb(ffprobeOutput), 5) }) },
      stderr: { on: vi.fn() },
      on: vi.fn((event, cb) => { if (event === 'close') { closeCb = cb; setTimeout(() => cb(0), 10) } }),
    }
    spawnMock.mockReturnValue(mockProcess)

    const info = await probeVideo('/fake/video.mp4')

    expect(spawnMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['-show_streams', '-show_format'])
    )
    expect(info.width).toBe(1920)
    expect(info.height).toBe(1080)
    expect(info.fps).toBeCloseTo(29.97, 0)
    expect(info.frameCount).toBe(150)
    expect(info.duration).toBe(5)
    expect(info.hasAudio).toBe(true)
    expect(info.videoCodec).toBe('h264')
  })

  it('检测无音轨的视频', async () => {
    const ffprobeOutput = JSON.stringify({
      streams: [
        { codec_type: 'video', width: 640, height: 480, r_frame_rate: '25/1', codec_name: 'h264', nb_frames: '125' },
      ],
      format: { duration: '5.0' },
    })

    spawnMock.mockReturnValue({
      stdout: { on: vi.fn((event, cb) => { if (event === 'data') setTimeout(() => cb(ffprobeOutput), 5) }) },
      stderr: { on: vi.fn() },
      on: vi.fn((event, cb) => { if (event === 'close') setTimeout(() => cb(0), 10) }),
    })

    const info = await probeVideo('/fake/video_no_audio.mp4')

    expect(info.hasAudio).toBe(false)
    expect(info.width).toBe(640)
    expect(info.height).toBe(480)
    expect(info.fps).toBe(25)
  })

  it('ffprobe 退出码非零时 reject', async () => {
    spawnMock.mockReturnValue({
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn((event, cb) => { if (event === 'data') cb('error: file not found') }) },
      on: vi.fn((event, cb) => { if (event === 'close') setTimeout(() => cb(1), 10) }),
    })

    await expect(probeVideo('/fake/bad.mp4')).rejects.toThrow('ffprobe failed')
  })

  it('nb_frames 缺失时不崩溃', async () => {
    const ffprobeOutput = JSON.stringify({
      streams: [
        { codec_type: 'video', width: 100, height: 100, r_frame_rate: '30/1', codec_name: 'h264' },
      ],
      format: { duration: '10.0' },
    })

    spawnMock.mockReturnValue({
      stdout: { on: vi.fn((event, cb) => { if (event === 'data') setTimeout(() => cb(ffprobeOutput), 5) }) },
      stderr: { on: vi.fn() },
      on: vi.fn((event, cb) => { if (event === 'close') setTimeout(() => cb(0), 10) }),
    })

    const info = await probeVideo('/fake/no_nb_frames.mp4')
    expect(info.frameCount).toBeNull()
    expect(info.width).toBe(100)
    expect(info.fps).toBe(30)
  })
})
