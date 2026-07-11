/**
 * keying.js 核心算法单元测试
 *
 * 覆盖：colorDistance, applyKeying, autoCropKeyed, composeToCanvas
 * 算法涉及逐像素计算，使用小尺寸合成图验证边界条件。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { applyKeying, autoCropKeyed, composeToCanvas } from '../keying.js'

// ===== 测试工具函数 =====

/** 创建纯色 ImageData-like 对象 */
function createSolidImage(w, h, r, g, b, a = 255) {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r
    data[i + 1] = g
    data[i + 2] = b
    data[i + 3] = a
  }
  return { data, width: w, height: h }
}

/** 创建棋盘格图案（相邻像素不同颜色），用于测试局部细节 */
function createCheckerImage(w, h) {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const isEven = (x + y) % 2 === 0
      data[i] = isEven ? 0 : 255     // R
      data[i + 1] = isEven ? 255 : 0 // G
      data[i + 2] = 0                // B
      data[i + 3] = 255              // A
    }
  }
  return { data, width: w, height: h }
}

// ===== applyKeying 基础功能测试 =====

describe('applyKeying', () => {
  it('纯绿幕 (0,255,0) 像素应变为完全透明', () => {
    const img = createSolidImage(4, 4, 0, 255, 0) // 全绿
    const result = applyKeying(img, { tolerance: 30, feather: 15, spillSuppression: 0, edgeShrink: 0 })

    // 所有像素 alpha 应为 0
    for (let i = 3; i < result.data.length; i += 4) {
      expect(result.data[i]).toBe(0)
    }
    expect(result.width).toBe(4)
    expect(result.height).toBe(4)
  })

  it('远离绿色的像素应保持完全不透明', () => {
    const img = createSolidImage(4, 4, 255, 0, 0) // 纯红
    const result = applyKeying(img, { tolerance: 1, feather: 1 })

    for (let i = 3; i < result.data.length; i += 4) {
      expect(result.data[i]).toBe(255)
    }
  })

  it('不修改原始输入数据（不可变）', () => {
    const img = createSolidImage(4, 4, 0, 255, 0)
    const original = new Uint8ClampedArray(img.data)
    applyKeying(img, { tolerance: 30 })

    // 对比原始数据
    expect(img.data).toEqual(original)
  })

  it('tolerance=0 时只有精确匹配的绿幕才变透明', () => {
    const w = 4, h = 4
    const data = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        data[i] = 0
        // 渐进绿色：第一行纯绿，最后一行接近纯绿
        data[i + 1] = 255 - y * 10
        data[i + 2] = 0
        data[i + 3] = 255
      }
    }
    const img = { data, width: w, height: h }
    const result = applyKeying(img, { tolerance: 0, feather: 0 })

    // 只有 y=0 纯绿行透明
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4 + 3
        if (y === 0) {
          expect(result.data[i]).toBe(0)
        } else {
          expect(result.data[i]).toBe(255)
        }
      }
    }
  })

  it('大 tolerance 值应捕获更大范围的绿色', () => {
    const img = createSolidImage(4, 4, 10, 245, 10) // 浅绿
    const resultLow = applyKeying(img, { tolerance: 5, feather: 0 })
    const resultHigh = applyKeying(img, { tolerance: 50, feather: 0 })

    // tolerance 5 应该不够覆盖，alpha 仍为 255
    expect(resultLow.data[3]).toBe(255)
    // tolerance 50 应该覆盖，alpha 为 0
    expect(resultHigh.data[3]).toBe(0)
  })

  it('feather 产生过渡带 alpha（半透明像素）', () => {
    // 构造 3 个精心选取的像素，使它们分别落在：
    //   完全绿幕 | 过渡带 | 完全不透明
    // keyColor=[0,255,0], tolerance=25→tolDist=0.125
    // feather=30→featherWidth=0.045, 过渡带=[0.125, 0.170]
    const w = 3, h = 1
    const data = new Uint8ClampedArray(w * h * 4)
    // dist of (0,255,0)=0.000 < 0.125 → 透明
    // dist of (0,232,0)=0.052 → 0.052<0.125 → 透明（在容差内）
    // dist of (0,232,0)=|255-232|=23 → 23/441.67=0.052
    // 需要 dist 在 0.125~0.170 之间
    // 选 (0,200,0): dist = |255-200|=55, 55/441.67=0.1245 → 刚好在容差边缘附近
    // 选 (0,190,0): dist = 65/441.67=0.147 → 在过渡带!
    // 选 (0,160,0): dist = 95/441.67=0.215 > 0.170 → 完全不透明
    const pixels = [
      [0, 255, 0],   // dist=0.000  → 绿幕（透明）
      [0, 190, 0],   // dist=0.147  → 过渡带（半透明）
      [0, 100, 0],   // dist=0.351  → 不透明
    ]
    for (let x = 0; x < w; x++) {
      data[x * 4] = pixels[x][0]
      data[x * 4 + 1] = pixels[x][1]
      data[x * 4 + 2] = pixels[x][2]
      data[x * 4 + 3] = 255
    }
    const img = { data, width: w, height: h }
    const result = applyKeying(img, { tolerance: 25, feather: 30, spillSuppression: 0 })

    // pixel 0: dist=0 < tolDist(0.125) → alpha=0
    expect(result.data[0 + 3]).toBe(0)
    // pixel 1: dist=0.147 在过渡带内 → alpha 介于 0~255 之间
    const alphaMid = result.data[4 + 3]
    expect(alphaMid).toBeGreaterThan(0)
    expect(alphaMid).toBeLessThan(255)
    // pixel 2: dist=0.351 > tolDist+featherWidth(0.170) → alpha=255
    expect(result.data[8 + 3]).toBe(255)
    // 距离越远 alpha 越大（pixel2 > pixel1）
    expect(result.data[8 + 3]).toBeGreaterThan(result.data[4 + 3])
  })

  it('spillSuppression 抑制绿色通道', () => {
    const img = createSolidImage(4, 4, 50, 200, 50) // 偏绿
    const resultNoSpill = applyKeying(img, { tolerance: 10, spillSuppression: 0 })
    const resultSpill = applyKeying(img, { tolerance: 10, spillSuppression: 100 })

    // spillSuppression=0 => g 不变
    expect(resultNoSpill.data[1]).toBe(200)
    // spillSuppression=100 => g 被压到 max(r,b)=50
    expect(resultSpill.data[1]).toBe(50)
  })

  it('spillSuppression 对非绿色像素无影响', () => {
    const img = createSolidImage(4, 4, 200, 50, 50) // 偏红，绿色是三个通道中最小的
    const result = applyKeying(img, { tolerance: 5, spillSuppression: 100 })

    // 绿色没被压（因为它已经是 min 通道了）
    expect(result.data[1]).toBe(50)
  })

  it('edgeShrink 方向正确', () => {
    // 构造一个 8x8 图像：中心 4x4 是人物，四周是绿幕
    const w = 8, h = 8
    const data = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        const isCenter = x >= 2 && x < 6 && y >= 2 && y < 6
        if (isCenter) {
          data[i] = 200; data[i + 1] = 100; data[i + 2] = 50; data[i + 3] = 255
        } else {
          data[i] = 0; data[i + 1] = 255; data[i + 2] = 0; data[i + 3] = 255
        }
      }
    }
    const img = { data, width: w, height: h }

    const resultShrink = applyKeying(img, { tolerance: 30, edgeShrink: 1 })
    const resultNoShrink = applyKeying(img, { tolerance: 30, edgeShrink: 0 })

    // edgeShrink 应该让边缘的 alpha 被侵蚀，导致总透明/半透明像素增多
    const countTransparent = (d) => {
      let cnt = 0
      for (let i = 3; i < d.length; i += 4) {
        if (d[i] === 0) cnt++
      }
      return cnt
    }
    expect(countTransparent(resultShrink.data)).toBeGreaterThanOrEqual(
      countTransparent(resultNoShrink.data)
    )
  })

  it('默认参数能正常执行不抛异常', () => {
    const img = createCheckerImage(8, 8)
    expect(() => applyKeying(img, {})).not.toThrow()
    const result = applyKeying(img, {})
    expect(result.data).toBeDefined()
    expect(result.width).toBe(8)
    expect(result.height).toBe(8)
  })

  it('处理 1x1 最小尺寸图像', () => {
    const img = createSolidImage(1, 1, 0, 255, 0)
    const result = applyKeying(img, { tolerance: 30 })
    expect(result.data[3]).toBe(0)
    expect(result.width).toBe(1)
    expect(result.height).toBe(1)
  })

  it('处理全透明输入像素', () => {
    const img = createSolidImage(4, 4, 0, 255, 0, 0) // 初始 alpha=0
    const result = applyKeying(img, { tolerance: 30 })
    // 绿幕区域 alpha 应保持 0
    expect(result.data[3]).toBe(0)
  })
})

// ===== autoCropKeyed 测试 =====

describe('autoCropKeyed', () => {
  it('当所有像素透明时返回原数据不做裁剪', () => {
    const img = createSolidImage(10, 10, 0, 0, 0, 0)
    const result = autoCropKeyed(img, 10)
    expect(result).toBe(img)
  })

  it('裁剪掉四周透明边缘', () => {
    // 8x8 图像，中心 4x4 不透明
    const w = 8, h = 8
    const data = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        const isSolid = x >= 2 && x < 6 && y >= 2 && y < 6
        data[i] = 100; data[i + 1] = 100; data[i + 2] = 100
        data[i + 3] = isSolid ? 255 : 0
      }
    }
    const img = { data, width: w, height: h }
    const result = autoCropKeyed(img, 10)

    expect(result.width).toBe(4)
    expect(result.height).toBe(4)
    // 所有像素 alpha 应为 255
    for (let i = 3; i < result.data.length; i += 4) {
      expect(result.data[i]).toBe(255)
    }
  })

  it('当没有透明边缘时不做裁剪', () => {
    const img = createSolidImage(4, 4, 100, 100, 100, 255)
    const result = autoCropKeyed(img, 10)

    expect(result.width).toBe(4)
    expect(result.height).toBe(4)
  })

  it('保留非透明区域的 RGB 数据正确', () => {
    const w = 6, h = 6
    const data = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        const isSolid = x >= 1 && x < 5 && y >= 1 && y < 5
        data[i] = x * 40
        data[i + 1] = y * 40
        data[i + 2] = 128
        data[i + 3] = isSolid ? 255 : 0
      }
    }
    const img = { data, width: w, height: h }
    const result = autoCropKeyed(img)

    expect(result.width).toBe(4)
    expect(result.height).toBe(4)

    // 检查 (0,0) 像素（原图中为 (1,1)）的颜色
    const idx = 0 // (0,0) in cropped = (1,1) in original
    expect(result.data[idx * 4]).toBe(1 * 40)     // R
    expect(result.data[idx * 4 + 1]).toBe(1 * 40)  // G
    expect(result.data[idx * 4 + 2]).toBe(128)     // B
    expect(result.data[idx * 4 + 3]).toBe(255)     // A
  })

  it('阈值参数影响裁剪边界', () => {
    // 4x4: 边缘像素 alpha=5（很低），中心 alpha=255
    const w = 4, h = 4
    const data = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        data[i] = 100; data[i + 1] = 100; data[i + 2] = 100
        // 边缘 alpha=5 低于阈值 10; 中心 alpha=255 高于阈值
        data[i + 3] = (x === 0 || y === 0 || x === 3 || y === 3) ? 5 : 255
      }
    }
    const img = { data, width: w, height: h }

    const resultLow = autoCropKeyed(img, 10)  // 阈值 10 > 5，裁掉半透明边缘
    const resultHigh = autoCropKeyed(img, 3)  // 阈值 3 < 5，保留半透明边缘

    expect(resultLow.width).toBe(2)
    expect(resultLow.height).toBe(2)
    expect(resultHigh.width).toBe(4)
    expect(resultHigh.height).toBe(4)
  })
})

// ===== composeToCanvas 测试 =====

describe('composeToCanvas', () => {
  /** 创建 mock Canvas 2D Context */
  function createMockContext() {
    let _fillStyle = ''
    const fillRectCalls = []
    const drawImageCalls = []
    return {
      get fillStyle() { return _fillStyle },
      set fillStyle(v) { _fillStyle = v },
      fillRect: (...args) => { fillRectCalls.push(args) },
      drawImage: (canvas, dx, dy, dw, dh) => { drawImageCalls.push([dx, dy, dw, dh]) },
      _getFillRectCalls: () => fillRectCalls,
      _getDrawImageCalls: () => drawImageCalls,
    }
  }

  /** 创建 mock tempCanvas */
  function createMockTempCanvas() {
    let w = 0, h = 0
    return {
      get width() { return w },
      set width(v) { w = v },
      get height() { return h },
      set height(v) { h = v },
      getContext: () => ({
        createImageData: (cw, ch) => ({
          data: new Uint8ClampedArray(cw * ch * 4),
          width: cw,
          height: ch,
        }),
        putImageData: () => {},
      }),
    }
  }

  it('按指定尺寸填充绿幕底色', () => {
    const ctx = createMockContext()
    const keyedImg = createSolidImage(10, 10, 100, 100, 100, 255)
    const layout = {
      canvasWidth: 100,
      canvasHeight: 100,
      personWidth: 80,
      personHeight: 80,
      bgColor: [0, 255, 0],
    }
    composeToCanvas(ctx, keyedImg, layout, createMockTempCanvas())

    const fillCalls = ctx._getFillRectCalls()
    expect(fillCalls.length).toBe(1)
    expect(fillCalls[0]).toEqual([0, 0, 100, 100])
    expect(ctx.fillStyle).toBe('rgb(0, 255, 0)')
  })

  it('传入背景色时优先使用该颜色作为合成底色', () => {
    const ctx = createMockContext()
    const keyedImg = createSolidImage(10, 10, 100, 100, 100, 255)
    const layout = {
      canvasWidth: 100,
      canvasHeight: 100,
      personWidth: 80,
      personHeight: 80,
      bgColor: [0, 255, 0],
    }
    composeToCanvas(ctx, keyedImg, layout, createMockTempCanvas(), [14, 210, 42])

    expect(ctx.fillStyle).toBe('rgb(14, 210, 42)')
  })

  it('等比缩放并居中绘制人物', () => {
    const ctx = createMockContext()
    const keyedImg = createSolidImage(20, 10, 100, 100, 100, 255) // 2:1
    const layout = {
      canvasWidth: 100,
      canvasHeight: 80,
      personWidth: 40,
      personHeight: 40,
      bgColor: [0, 0, 0],
    }
    const result = composeToCanvas(ctx, keyedImg, layout, createMockTempCanvas())

    // 缩放比: min(40/20, 40/10) = min(2, 4) = 2
    // scaledW = 20*2 = 40, scaledH = 10*2 = 20
    // offsetX = (100-40)/2 = 30, offsetY = (80-20)/2 = 30
    expect(result.scaledW).toBe(40)
    expect(result.scaledH).toBe(20)
    expect(result.offsetX).toBe(30)
    expect(result.offsetY).toBe(30)

    const drawCalls = ctx._getDrawImageCalls()
    expect(drawCalls.length).toBe(1)
    // drawImage 签名: (tempCanvas, offsetX, offsetY, scaledW, scaledH)
    // mock 只存了 [dx, dy, dw, dh]
    expect(drawCalls[0]).toEqual([30, 30, 40, 20])
  })
})
