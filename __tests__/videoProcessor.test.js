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

  it('严格排除 earlyFrameExclusion 窗口内的候选', () => {
    const scores = [
      { frame: 12, score: 1 },
      { frame: 24, score: 2 },
      { frame: 60, score: 5 },
    ]
    const result = pickLoopCandidates(scores, {
      minSpacing: 12,
      earlyFrameExclusion: 30,
      maxCandidates: 5,
      startFrame: 0,
      endFrame: 100,
    })
    expect(result.some(r => r.frame < 30)).toBe(false)
    expect(result[0].frame).toBe(60)
  })
})

describe('findLoopEndFrame cache reuse', () => {
  let findLoopEndFrame
  let spawnMock
  let spawnArgs

  beforeEach(async () => {
    vi.resetModules()
    spawnArgs = []
    spawnMock = vi.spyOn(cp, 'spawn').mockImplementation((command, args) => {
      spawnArgs.push(args)

      const framesIndex = args.indexOf('-frames:v')
      const frames = framesIndex >= 0 ? Number(args[framesIndex + 1]) : 1
      const vfIndex = args.indexOf('-vf')
      const vfArg = vfIndex >= 0 ? String(args[vfIndex + 1]) : ''
      const scaleMatch = vfArg.match(/scale=(\d+):(\d+)/)
      const scaleW = scaleMatch ? Number(scaleMatch[1]) : 3
      const scaleH = scaleMatch ? Number(scaleMatch[2]) : 2
      const frameBytes = scaleW * scaleH * 4
      const stdoutBuffer = Buffer.alloc(frameBytes * frames, 0)

      return {
        stdout: {
          on: vi.fn((event, cb) => {
            if (event === 'data') cb(stdoutBuffer)
          }),
        },
        stderr: {
          on: vi.fn(),
        },
        on: vi.fn((event, cb) => {
          if (event === 'close') cb(0)
        }),
      }
    })

    const mod = await import('../../videoProcessor.cjs')
    findLoopEndFrame = mod.findLoopEndFrame
  })

  afterEach(() => {
    spawnMock.mockRestore()
  })

  it('reuses cached hash ranges when the loop start moves forward', async () => {
    const options = {
      hashSize: 2,
      maxSearch: 4,
      minSpacing: 1,
      earlyFrameExclusion: 1,
      maxCandidates: 3,
    }

    const first = await findLoopEndFrame('/fake/video.mp4', 0, 1, 8, options)
    const second = await findLoopEndFrame('/fake/video.mp4', 1, 1, 8, options)

    expect(first.candidates.length).toBeGreaterThanOrEqual(1)
    expect(second.candidates.length).toBeGreaterThanOrEqual(1)

    const frameCounts = spawnArgs
      .filter(args => args.includes('-frames:v'))
      .map(args => Number(args[args.indexOf('-frames:v') + 1]))

    expect(frameCounts).toEqual([4, 1, 1])
  })
})

describe('scanStableVideoCrop cache reuse', () => {
  let scanStableVideoCrop
  let loadAlgorithms
  let spawnMock
  let spawnArgs

  beforeEach(async () => {
    vi.resetModules()
    spawnArgs = []
    spawnMock = vi.spyOn(cp, 'spawn').mockImplementation((command, args) => {
      spawnArgs.push(args)

      const framesIndex = args.indexOf('-frames:v')
      const frames = framesIndex >= 0 ? Number(args[framesIndex + 1]) : 1
      const frameBytes = 4
      const stdoutBuffer = Buffer.alloc(frameBytes * frames, 0)

      return {
        stdout: {
          on: vi.fn((event, cb) => {
            if (event === 'data') cb(stdoutBuffer)
          }),
        },
        stderr: {
          on: vi.fn(),
        },
        on: vi.fn((event, cb) => {
          if (event === 'close') cb(0)
        }),
      }
    })

    const mod = await import('../../videoProcessor.cjs')
    scanStableVideoCrop = mod.scanStableVideoCrop
    loadAlgorithms = mod.loadAlgorithms
    await loadAlgorithms()
  })

  afterEach(() => {
    spawnMock.mockRestore()
  })

  it('reuses cached alpha bounds when the selected range changes', async () => {
    const baseOptions = {
      totalFrames: 8,
      fps: 1,
      frameBytes: 4,
      srcW: 1,
      srcH: 1,
      params: {
        keying: { keyColor: [0, 255, 0], tolerance: 30, spillSuppression: 0, feather: 0 },
        cleanup: {},
        region: null,
      },
    }

    const first = await scanStableVideoCrop('/fake/crop.mp4', {
      ...baseOptions,
      startFrame: 0,
      endFrame: 4,
    })
    const second = await scanStableVideoCrop('/fake/crop.mp4', {
      ...baseOptions,
      startFrame: 2,
      endFrame: 6,
    })

    expect(first.scan.newlyScannedFrameCount).toBe(4)
    expect(second.scan.cachedFrameCount).toBe(2)
    expect(second.scan.newlyScannedFrameCount).toBe(2)

    const frameCounts = spawnArgs
      .filter(args => args.includes('-frames:v'))
      .map(args => Number(args[args.indexOf('-frames:v') + 1]))

    expect(frameCounts).toEqual([4, 2])
  })
})

describe('getVideoWorkerCount', () => {
  let getVideoWorkerCount
  const originalWorkers = process.env.GREENSCREEN_VIDEO_WORKERS
  const originalDisable = process.env.GREENSCREEN_DISABLE_WORKERS

  beforeEach(async () => {
    vi.resetModules()
    delete process.env.GREENSCREEN_VIDEO_WORKERS
    delete process.env.GREENSCREEN_DISABLE_WORKERS
    const mod = await import('../../videoProcessor.cjs')
    getVideoWorkerCount = mod.getVideoWorkerCount
  })

  afterEach(() => {
    if (originalWorkers == null) {
      delete process.env.GREENSCREEN_VIDEO_WORKERS
    } else {
      process.env.GREENSCREEN_VIDEO_WORKERS = originalWorkers
    }
    if (originalDisable == null) {
      delete process.env.GREENSCREEN_DISABLE_WORKERS
    } else {
      process.env.GREENSCREEN_DISABLE_WORKERS = originalDisable
    }
  })

  it('honors explicit worker count overrides and caps them to frame count', () => {
    process.env.GREENSCREEN_VIDEO_WORKERS = '3'
    expect(getVideoWorkerCount(10)).toBe(3)
    expect(getVideoWorkerCount(2)).toBe(2)
  })

  it('can be disabled through an environment flag', () => {
    process.env.GREENSCREEN_DISABLE_WORKERS = '1'
    expect(getVideoWorkerCount(100)).toBe(0)
  })
})

describe('selectSpriteFrames', () => {
  let selectSpriteFrames

  beforeEach(async () => {
    vi.resetModules()
    const mod = await import('../../videoProcessor.cjs')
    selectSpriteFrames = mod.selectSpriteFrames
  })

  it('normalizes exact frame lists into deterministic ascending order', () => {
    const selection = selectSpriteFrames({
      frames: [19, 0, 12, 12, 6],
      range: { startFrame: 0, endFrame: 20 },
    }, 40)

    expect(selection.mode).toBe('frames')
    expect(selection.frames).toEqual([0, 6, 12, 19])
    expect(selection.ordering).toBe('ascending_source_frame')
    expect(selection.warnings).toContain('Duplicate frame indexes were removed from the explicit frame list.')
  })

  it('samples a bounded range and applies maxFrames over that range', () => {
    const selection = selectSpriteFrames({
      range: { startFrame: 5, endFrame: 20 },
      sampleEvery: 4,
      maxFrames: 3,
    }, 40)

    expect(selection.mode).toBe('sample')
    expect(selection.frames).toEqual([5, 9, 13])
    expect(selection.range).toEqual({ startFrame: 5, endFrame: 20 })
  })
})

describe('buildEncoderArgs', () => {
  let buildEncoderArgs

  beforeEach(async () => {
    vi.resetModules()
    const mod = await import('../../videoProcessor.cjs')
    buildEncoderArgs = mod.buildEncoderArgs
  })

  it('encodes GIF exports as looping full-frame animations', () => {
    const { encoderArgs } = buildEncoderArgs(
      'out.gif',
      'transparent',
      { canvasWidth: 320, canvasHeight: 240 },
      12,
      null
    )

    expect(encoderArgs).toContain('-an')
    expect(encoderArgs).toContain('-loop')
    expect(encoderArgs[encoderArgs.indexOf('-loop') + 1]).toBe('0')
    expect(encoderArgs).toContain('-gifflags')
    expect(encoderArgs[encoderArgs.indexOf('-gifflags') + 1]).toBe('0')
    expect(encoderArgs.join(' ')).toContain('paletteuse')
  })
})

describe('stable video auto-crop helpers', () => {
  let mergeAlphaBounds
  let cropKeyedToBounds
  let createLoopHashLayout

  beforeEach(async () => {
    vi.resetModules()
    const mod = await import('../../videoProcessor.cjs')
    mergeAlphaBounds = mod.mergeAlphaBounds
    cropKeyedToBounds = mod.cropKeyedToBounds
    createLoopHashLayout = mod.createLoopHashLayout
  })

  it('merges per-frame alpha bounds into one union box', () => {
    let union = null
    union = mergeAlphaBounds(union, { minX: 10, minY: 8, maxX: 20, maxY: 30 })
    union = mergeAlphaBounds(union, { minX: 4, minY: 12, maxX: 24, maxY: 28 })
    union = mergeAlphaBounds(union, { minX: 12, minY: 2, maxX: 18, maxY: 36 })

    expect(union).toEqual({ minX: 4, minY: 2, maxX: 24, maxY: 36 })
  })

  it('crops keyed frame data to a fixed union box', () => {
    const width = 5
    const height = 4
    const data = new Uint8ClampedArray(width * height * 4)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4
        data[i] = x
        data[i + 1] = y
        data[i + 2] = x + y
        data[i + 3] = 255
      }
    }

    const result = cropKeyedToBounds(
      { data, width, height },
      { minX: 1, minY: 1, maxX: 3, maxY: 2 },
      10,
      { strategy: 'video_union' }
    )

    expect(result.imageData.width).toBe(3)
    expect(result.imageData.height).toBe(2)
    expect(result.crop).toMatchObject({
      applied: true,
      x: 1,
      y: 1,
      width: 3,
      height: 2,
      sourceWidth: 5,
      sourceHeight: 4,
      strategy: 'video_union',
    })

    const firstPixel = Array.from(result.imageData.data.slice(0, 4))
    const lastPixelStart = (result.imageData.width * result.imageData.height - 1) * 4
    const lastPixel = Array.from(result.imageData.data.slice(lastPixelStart, lastPixelStart + 4))
    expect(firstPixel).toEqual([1, 1, 2, 255])
    expect(lastPixel).toEqual([3, 2, 5, 255])
  })

  it('keeps the original keyed frame when the union scan found no foreground', () => {
    const imageData = {
      data: new Uint8ClampedArray(2 * 2 * 4),
      width: 2,
      height: 2,
    }

    const result = cropKeyedToBounds(imageData, null, 10, { strategy: 'video_union' })

    expect(result.imageData).toBe(imageData)
    expect(result.crop).toMatchObject({
      applied: false,
      reason: 'no_foreground',
      strategy: 'video_union',
      width: 2,
      height: 2,
    })
  })

  it('keeps loop-detection hashes foreground-focused when export auto-crop is off', () => {
    const layout = {
      canvasWidth: 512,
      canvasHeight: 512,
      personWidth: 320,
      personHeight: 420,
      autoCrop: false,
      anchor: 'feet',
    }

    const hashLayout = createLoopHashLayout(layout)

    expect(hashLayout).toMatchObject({
      canvasWidth: 512,
      canvasHeight: 512,
      personWidth: 320,
      personHeight: 420,
      autoCrop: true,
      anchor: 'feet',
    })
    expect(layout.autoCrop).toBe(false)
  })
})
