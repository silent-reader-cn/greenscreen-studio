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

// ===== dHashRaw =====

describe('dHashRaw', () => {
  let dHashRaw

  beforeEach(async () => {
    vi.resetModules()
    const mod = await import('../../videoProcessor.cjs')
    dHashRaw = mod.dHashRaw
  })

  it('对全黑和全白帧返回不同的哈希', () => {
    const w = 3, h = 2 // 3×2 → 2×2=4 bits → 1 byte
    // 全黑: 所有亮度=0 → 相邻相比左<右? 0<0=false → 全部 bit=0
    const black = Buffer.alloc(w * h * 4, 0)
    const hBlack = dHashRaw(black, w, h)
    expect(hBlack.every(b => b === 0)).toBe(true)

    // 全白: 所有亮度=255 → 相邻相比左<右? 255<255=false → 全部 bit=0
    const white = Buffer.alloc(w * h * 4, 255)
    const hWhite = dHashRaw(white, w, h)
    expect(hWhite.every(b => b === 0)).toBe(true)
  })

  it('对渐变图像产生非零哈希', () => {
    const w = 3, h = 2
    const buf = Buffer.alloc(w * h * 4, 0)
    // 创建从左到右渐变的像素
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        buf[i] = x * 80     // R 递增
        buf[i + 1] = x * 80 // G 递增
        buf[i + 2] = x * 80 // B 递增
        buf[i + 3] = 255    // A
      }
    }
    const hash = dHashRaw(buf, w, h)
    // 渐变中左<右，所有 bit 应为 1
    expect(hash[0]).toBe(0b1111)
  })

  it('256-bit 哈希正确计算', () => {
    const w = 5, h = 4 // 4×4=16 bits = 2 bytes
    const buf = Buffer.alloc(w * h * 4, 0)
    // 左半边暗、右半边亮
    // 每行相邻比较: x=0(暗) vs x=1(暗)→相等→0; x=1(暗) vs x=2(亮)→左<右→1; x=2 vs x=3→相等→0; x=3 vs x=4→相等→0
    // 每行结果: 0b0100
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        buf[i] = x < 2 ? 50 : 200
        buf[i + 1] = x < 2 ? 50 : 200
        buf[i + 2] = x < 2 ? 50 : 200
        buf[i + 3] = 255
      }
    }
    const hash = dHashRaw(buf, w, h)
    // dHashRaw 大端序: 先写的位在最后一个字节
    // 4行 × 4位 = 16位 → 2字节
    // 每行 0b0100 → 字节内: 0b00100010 = 34
    expect(hash[0]).toBe(0b00100010) // 行 2-3
    expect(hash[1]).toBe(0b00100010) // 行 0-1
  })
})

// ===== hammingDistance =====

describe('hammingDistance', () => {
  let hammingDistance

  beforeEach(async () => {
    vi.resetModules()
    const mod = await import('../../videoProcessor.cjs')
    hammingDistance = mod.hammingDistance
  })

  it('相同哈希距离为 0', () => {
    const a = Buffer.from([0b10101010, 0b11110000])
    const b = Buffer.from([0b10101010, 0b11110000])
    expect(hammingDistance(a, b)).toBe(0)
  })

  it('完全相反哈希距离等于总位数', () => {
    const a = Buffer.from([0b00000000, 0b00000000])
    const b = Buffer.from([0b11111111, 0b11111111])
    expect(hammingDistance(a, b)).toBe(16)
  })

  it('逐位正确计算差异', () => {
    const a = Buffer.from([0b00001111])
    const b = Buffer.from([0b01011010])
    // XOR = 01010101 → 4 个 1
    expect(hammingDistance(a, b)).toBe(4)
  })

  it('256-bit 哈希正确计算', () => {
    const a = Buffer.alloc(32, 0x00)
    const b = Buffer.alloc(32, 0x00)
    b[0] = 0b10101010
    // 4 个 1
    expect(hammingDistance(a, b)).toBe(4)
  })
})

// ===== pickLoopCandidates =====

describe('pickLoopCandidates', () => {
  let pickLoopCandidates

  beforeEach(async () => {
    vi.resetModules()
    const mod = await import('../../videoProcessor.cjs')
    pickLoopCandidates = mod.pickLoopCandidates
  })

  it('空数组返回空', () => {
    expect(pickLoopCandidates([], { minSpacing: 12, maxCandidates: 5, startFrame: 0, endFrame: 100 })).toEqual([])
  })

  it('选出全局最低分候选', () => {
    const scores = [
      { frame: 10, score: 50 },
      { frame: 20, score: 30 },
      { frame: 30, score: 80 },
    ]
    const result = pickLoopCandidates(scores, { minSpacing: 12, maxCandidates: 5, startFrame: 0, endFrame: 100 })
    expect(result[0].frame).toBe(20) // 最低分
  })

  it('minSpacing 筛掉太近的帧', () => {
    // 构造一条有多处局部极小值的分数曲线
    const scores = [
      { frame: 2, score: 50 },
      { frame: 20, score: 5 },  // 局部极小，窗口0最佳
      { frame: 22, score: 15 },
      { frame: 28, score: 10 }, // 局部极小，但距20=8 < minSpacing=12
      { frame: 35, score: 20 },
      { frame: 50, score: 12 }, // 局部极小，窗口1
      { frame: 55, score: 25 },
      { frame: 80, score: 8 },  // 局部极小，窗口2（有后帧支撑）
      { frame: 85, score: 20 },
    ]
    const result = pickLoopCandidates(scores, { minSpacing: 12, maxCandidates: 5, startFrame: 0, endFrame: 100 })
    const frames = result.map(r => r.frame)
    expect(frames).toContain(20)
    expect(frames).not.toContain(28) // 距20=8 < 12，被筛掉
    expect(frames).toContain(50)
    expect(frames).toContain(80)
  })

  it('窗口分区保证候选覆盖全范围', () => {
    // 用锯齿波产生多组局部极小值
    const scores = []
    for (let f = 2; f < 240; f++) {
      // f%80 使每80帧一个周期，周期内先降后升 → 谷底为局部极小
      const cycle = f % 80
      scores.push({ frame: f, score: cycle < 40 ? 40 - cycle : cycle - 40 })
    }
    const result = pickLoopCandidates(scores, { minSpacing: 12, maxCandidates: 5, startFrame: 0, endFrame: 239 })
    // 应有不超过5个候选
    expect(result.length).toBeLessThanOrEqual(5)
    expect(result.length).toBeGreaterThanOrEqual(2)
    // 候选应覆盖不同区域
    const frames = result.map(r => r.frame)
    const spread = Math.max(...frames) - Math.min(...frames)
    expect(spread).toBeGreaterThan(50)
  })

  it('最多返回 maxCandidates 个', () => {
    const scores = []
    for (let f = 2; f < 100; f++) {
      scores.push({ frame: f, score: f % 10 })
    }
    const result = pickLoopCandidates(scores, { minSpacing: 5, maxCandidates: 3, startFrame: 0, endFrame: 99 })
    expect(result.length).toBeLessThanOrEqual(3)
  })

  it('跳过紧邻起始帧的帧', () => {
    const scores = [
      { frame: 1, score: 0 },
      { frame: 50, score: 100 },
    ]
    const result = pickLoopCandidates(scores, { minSpacing: 12, maxCandidates: 5, startFrame: 0, endFrame: 100 })
    // frame 1 紧邻 startFrame=0，应被跳过
    expect(result.some(r => r.frame === 1)).toBe(false)
  })
})
