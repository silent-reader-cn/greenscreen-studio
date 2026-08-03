/**
 * 绿幕抠像算法 — 前后端共享
 *
 * 接收 ImageData，返回抠像后的 ImageData（RGBA，绿幕区域 alpha=0）
 * 同一份代码前端 Canvas 预览和后端 node-canvas 导出共用，保证所见即所得。
 *
 * 多算法支持（algorithm 字段切换，详见 docs/chroma-key-algorithms-research.md）：
 *   classic     经典距离：RGB 距离 + 羽化（旧行为，兼容默认）
 *   vlahos      色差抠像：绿色超出量线性导出 alpha，半透明波纹最好
 *   chroma      色度距离（OBS/FFmpeg）：CbCr 平面距离，对亮度不均渐变最鲁棒
 *   saturation  饱和度比（Blender Keying）：主通道自适应，导出级质量
 *
 * 公共参数：
 *   keyColor:        [r, g, b]  键控色，默认 [0, 255, 0] 纯绿
 *   keyColor2:       [r, g, b]  渐变键色第二端点（gradientKey 开启时生效）
 *   gradientKey:     bool       双色渐变键色：沿画面亮度轴在 keyColor↔keyColor2 间插值
 *   spillSuppression:0-100      去溢强度（按主通道自适应的 limiter）
 *   feather:         0-100      边缘羽化，alpha 过渡柔和度
 *   edgeShrink:      0-50       边缘收缩，向内收掉杂边
 *
 * vlahos 专有：
 *   keyBalance:      20-150 (→0.2-1.5)  G 比 R/B 多多少算绿
 *   clipBlack/clipWhite: 0-100           alpha 黑白点裁剪（去底噪/压实前景）
 * chroma 专有：
 *   similarity:      0-100      色度相似度阈值
 *   spill:           0-100      去溢过渡带宽度（独立于 alpha 的去饱和）
 * saturation 专有：
 *   keyBalance:      0-100 (→0-1)  中值/最小值通道权重
 */

/**
 * 计算两个颜色在 RGB 空间的距离（归一化到 0-1）
 */
function colorDistance(r1, g1, b1, r2, g2, b2) {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt(dr * dr + dg * dg + db * db) / 441.67295593; // sqrt(255^2*3)
}

export const KEYING_ALGORITHMS = ['classic', 'vlahos', 'chroma', 'saturation'];

export function normalizeKeyingAlgorithm(value) {
  return KEYING_ALGORITHMS.includes(value) ? value : 'classic';
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// 球形色度坐标（色度方向 = rgb/luma）：亮度无关，低饱和度颜色自然聚拢。
// 相比 OBS 的 BT.601 CbCr 平面距离，纯绿与暗绿/灰的距离更小、动态范围更均匀，
// similarity 滑块在全量程内有效。
// Rec.709 亮度
const luma709 = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function rgbToChromaDir(r, g, b, out) {
  const l = luma709(r, g, b) + 1e-6;
  out[0] = r / l;
  out[1] = g / l;
  out[2] = b / l;
  return out;
}

/**
 * 双色渐变键色：把 keyColor 钉在帧内最亮像素、keyColor2 钉在最暗像素，
 * 沿「最亮→最暗」空间轴逐像素插值出 K(x)。对线性光照渐变几乎零成本。
 * 分析在 1/4 分辨率网格上进行，返回预乘系数，逐像素热点只需 2 mul + 3 lerp。
 */
function prepareGradientKey(data, width, height, keyColor, keyColor2) {
  const step = Math.max(1, Math.floor(Math.min(width, height) / 4));
  let minL = Infinity, maxL = -Infinity;
  let minX = 0, minY = 0, maxX = 0, maxY = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      const l = luma709(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255);
      if (l < minL) { minL = l; minX = x; minY = y; }
      if (l > maxL) { maxL = l; maxX = x; maxY = y; }
    }
  }
  const dx = minX - maxX;
  const dy = minY - maxY;
  const denom = dx * dx + dy * dy;
  if (denom < 1 || maxL - minL < 0.01) return null; // 无有效亮度梯度 → 退回全局键色
  const k0 = [keyColor[0] / 255, keyColor[1] / 255, keyColor[2] / 255];
  const k1 = [keyColor2[0] / 255, keyColor2[1] / 255, keyColor2[2] / 255];
  return { ax: maxX, ay: maxY, dx, dy, denom, k0, k1 };
}

function gradientKeyAt(grad, x, y, out) {
  const t = clamp01(((x - grad.ax) * grad.dx + (y - grad.ay) * grad.dy) / grad.denom);
  out[0] = grad.k0[0] + (grad.k1[0] - grad.k0[0]) * t;
  out[1] = grad.k0[1] + (grad.k1[1] - grad.k0[1]) * t;
  out[2] = grad.k0[2] + (grad.k1[2] - grad.k0[2]) * t;
  return out;
}

/**
 * 主通道自适应 despill 限制器（Blender Keying 思路）：
 * 找出键色的主通道（绿幕=G），把该通道压向其余两通道的加权均值。
 * limit 0..1，weightedAvg = lerp(max(other), avg(other), 0.5) 介于两者之间。
 */
function applySpillLimit(out, i, r, g, b, kr, kg, kb, limit) {
  let primary = 0;
  if (kg >= kr && kg >= kb) primary = 1;
  else if (kb >= kr && kb >= kg) primary = 2;
  const channels = [r, g, b];
  const p = channels[primary];
  const o1 = channels[(primary + 1) % 3];
  const o2 = channels[(primary + 2) % 3];
  const weightedAvg = (Math.max(o1, o2) + (o1 + o2) / 2) / 2;
  if (p > weightedAvg) {
    channels[primary] = p - (p - weightedAvg) * limit;
    out[i] = channels[0];
    out[i + 1] = channels[1];
    out[i + 2] = channels[2];
  }
}

/**
 * 核心抠像函数
 * @param {ImageData} imageData - 输入图像数据
 * @param {Object} params - 抠像参数
 * @returns {ImageData} - 抠像后的图像数据（新对象，不修改原图）
 */
export function applyKeying(imageData, params) {
  const {
    algorithm = 'classic',
    keyColor = [0, 255, 0],
    keyColor2 = [0, 180, 0],
    gradientKey = false,
    tolerance = 30,
    spillSuppression = 40,
    feather = 15,
    edgeShrink = 0,
    keyBalance,
    clipBlack = 0,
    clipWhite = 100,
    similarity = 20,
    spill = 50,
  } = params;

  const { data, width, height } = imageData;
  // 创建输出数据（深拷贝）
  const out = new Uint8ClampedArray(data);

  const [kr, kg, kb] = keyColor;
  const algo = normalizeKeyingAlgorithm(algorithm);

  // 双色渐变键色（vlahos/chroma/saturation 支持；classic 保持单键色旧行为）
  const grad = gradientKey && algo !== 'classic'
    ? prepareGradientKey(data, width, height, keyColor, keyColor2)
    : null;
  const kBuf = [keyColor[0] / 255, keyColor[1] / 255, keyColor[2] / 255];
  const keyDirGlobal = rgbToChromaDir(kBuf[0], kBuf[1], kBuf[2], [0, 0, 0]);
  const keyDirBuf = [0, 0, 0];
  const pixDirBuf = [0, 0, 0];

  // classic 参数映射（旧行为保持不变）
  const tolDist = (tolerance / 100) * 0.5;
  const featherWidth = (feather / 100) * 0.15;
  const shrinkPixels = Math.round(edgeShrink);

  // vlahos 参数映射
  const vb = (keyBalance ?? 80) / 80;                     // 默认 1.0
  const satBalance = (keyBalance ?? 50) / 100;            // saturation 档用
  // chroma 参数映射
  const sim = (similarity / 100) * 0.5;                   // 0-0.5 色度方向距离
  const smooth = 0.01 + (feather / 100) * 0.3;            // alpha 斜坡宽度
  const spillRange = 0.05 + (spill / 100) * 0.45;         // 去饱和斜坡宽度

  // clip black/white（vlahos/chroma/saturation 公共）
  const cBlack = (clipBlack / 100) * 0.5;
  const cWhite = 1 - ((100 - clipWhite) / 100) * 0.5;
  const clipRange = Math.max(0.02, cWhite - cBlack);

  const k1 = 80 / 255;   // vlahos 绿色超出量满量程
  const k2 = 220 / 255;  // 超出量饱和上限

  // ===== Pass 1: 逐像素计算 alpha =====
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = data[i] / 255;
      const g = data[i + 1] / 255;
      const b = data[i + 2] / 255;

      let keyDir = keyDirGlobal;
      if (grad) {
        gradientKeyAt(grad, x, y, kBuf);
        if (algo === 'chroma') {
          rgbToChromaDir(kBuf[0], kBuf[1], kBuf[2], keyDirBuf);
          keyDir = keyDirBuf;
        }
      }

      let alpha;
      if (algo === 'vlahos') {
        // Vlahos 色差：alpha 由「主通道超出量」线性导出，天然支持半透明
        const excess = g - vb * Math.max(r, b);
        const t = clamp01((excess - k1) / (k2 - k1));
        alpha = 1 - Math.pow(t, 0.85);
      } else if (algo === 'chroma') {
        // 色度方向距离：亮度无关，对光照渐变鲁棒；1.5 次幂斜坡出部分 alpha
        rgbToChromaDir(r, g, b, pixDirBuf);
        const d0 = pixDirBuf[0] - keyDir[0];
        const d1 = pixDirBuf[1] - keyDir[1];
        const d2 = pixDirBuf[2] - keyDir[2];
        const dist = Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2) / 2; // 归一化到 ~0-1
        const baseMask = dist - sim;
        alpha = Math.pow(clamp01(baseMask / smooth), 1.5);
        // OBS 式去溢：越接近键色越去饱和（独立于 alpha）
        if (spill > 0) {
          const spillVal = Math.pow(clamp01(baseMask / spillRange), 1.5);
          const desat = luma709(r, g, b);
          const nr = desat + (r - desat) * spillVal;
          const ng = desat + (g - desat) * spillVal;
          const nb = desat + (b - desat) * spillVal;
          out[i] = Math.round(clamp01(nr) * 255);
          out[i + 1] = Math.round(clamp01(ng) * 255);
          out[i + 2] = Math.round(clamp01(nb) * 255);
        }
      } else if (algo === 'saturation') {
        // Blender Keying 饱和度比：主通道自适应，饱和度域线性出 alpha
        // kBuf 已是当前像素键色（0-1，gradientKey 开启时逐像素插值）
        const kc = kBuf;
        const primary = kc[1] >= kc[0] && kc[1] >= kc[2] ? 1 : (kc[2] >= kc[0] ? 2 : 0);
        const satOf = (c0, c1, c2) => {
          const ch = [c0, c1, c2];
          const p = ch[primary];
          const others = [ch[(primary + 1) % 3], ch[(primary + 2) % 3]].sort((m, n) => n - m);
          const wa = others[0] + (others[1] - others[0]) * satBalance;
          return (p - wa) * Math.abs(1 - wa);
        };
        const satKey = satOf(kc[0], kc[1], kc[2]);
        const satIn = satOf(r, g, b);
        if (satIn < 0) alpha = 1;
        else if (satKey <= 1e-6 || satIn >= satKey) alpha = 0;
        else alpha = 1 - satIn / satKey;
      } else {
        // classic：RGB 距离 + 羽化（旧行为）
        const dist = colorDistance(data[i], data[i + 1], data[i + 2], kr, kg, kb);
        if (dist < tolDist) {
          alpha = 0;
        } else if (dist > tolDist + featherWidth) {
          alpha = 255 / 255;
        } else {
          alpha = (dist - tolDist) / featherWidth;
        }
        out[i + 3] = Math.round(clamp01(alpha) * 255);
        continue;
      }

      // 新算法公共：clip black/white 重塑 alpha
      if (algo !== 'classic' && (cBlack > 0 || clipWhite < 100)) {
        alpha = clamp01((alpha - cBlack) / clipRange);
      }
      out[i + 3] = Math.round(clamp01(alpha) * 255);
    }
  }

  // ===== Pass 2: 去绿溢（limiter，主通道自适应）=====
  if (spillSuppression > 0) {
    const spillFactor = spillSuppression / 100; // 0-1
    for (let i = 0; i < out.length; i += 4) {
      const a = out[i + 3];
      if (a === 0) continue; // 跳过透明像素
      applySpillLimit(out, i, out[i], out[i + 1], out[i + 2], kr, kg, kb, spillFactor);
    }
  }

  // ===== Pass 3: 边缘收缩（可选）=====
  if (shrinkPixels > 0) {
    erodeAlpha(out, width, height, shrinkPixels);
  }

  // 返回纯数据对象（不依赖 ImageData 构造器，前后端通用）
  return { data: out, width, height };
}



/**
 * Alpha 通道侵蚀（向内收缩边缘）
 */
function erodeAlpha(data, width, height, radius) {
  const original = new Uint8ClampedArray(data);
  const r = radius;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4 + 3; // alpha index

      // 侵蚀只会修改半透明边缘。完全不透明像素按当前算法不会
      // 被改写，完全透明像素也已经是目标值；提前跳过可避免对整张
      // 画面的大多数像素反复扫描圆形邻域，保证滑块实时反馈。
      if (original[idx] === 255 || original[idx] === 0) continue;

      // 检查周围 radius 范围内是否有透明像素
      let hasTransparent = false;
      for (let dy = -r; dy <= r && !hasTransparent; dy++) {
        for (let dx = -r; dx <= r && !hasTransparent; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          // 只检查圆形范围
          if (dx * dx + dy * dy > r * r) continue;
          const nidx = (ny * width + nx) * 4 + 3;
          if (original[nidx] < 128) {
            hasTransparent = true;
          }
        }
      }

      // 如果附近有透明像素，当前像素也变透明（侵蚀）
      if (hasTransparent) {
        data[idx] = 0;
      }
    }
  }
}

/**
 * 自动裁剪：找到 alpha > threshold 的 bounding box，裁掉透明边缘
 * 用于去掉原图中绿幕区域的干扰，让缩放基准是人物本身而非整张原图
 *
 * @param {Object} keyedData - 抠像后的数据 {data, width, height}
 * @param {number} threshold - alpha 阈值，默认 10
 * @returns {Object} 裁剪后的数据 {data, width, height}
 */
export function autoCropKeyed(keyedData, threshold = 10) {
  return autoCropKeyedWithBounds(keyedData, threshold).imageData;
}

export function cropKeyedToBounds(keyedData, bounds, threshold = 10) {
  return cropKeyedToBoundsWithMetadata(keyedData, bounds, threshold).imageData;
}

export function expandBoundsToSourceCenter(bounds, sourceWidth, sourceHeight, axes = {}) {
  if (!bounds) return null;
  const width = Math.round(Number(sourceWidth));
  const height = Math.round(Number(sourceHeight));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { ...bounds };
  }

  const normalized = {
    minX: Math.max(0, Math.min(width - 1, Math.floor(bounds.minX))),
    minY: Math.max(0, Math.min(height - 1, Math.floor(bounds.minY))),
    maxX: Math.max(0, Math.min(width - 1, Math.ceil(bounds.maxX))),
    maxY: Math.max(0, Math.min(height - 1, Math.ceil(bounds.maxY))),
  };
  if (normalized.maxX < normalized.minX || normalized.maxY < normalized.minY) return null;

  const useX = axes.x !== false;
  const useY = axes.y !== false;
  const centeredX = useX
    ? expandAxisBoundsToCenter(normalized.minX, normalized.maxX, width)
    : { min: normalized.minX, max: normalized.maxX };
  const centeredY = useY
    ? expandAxisBoundsToCenter(normalized.minY, normalized.maxY, height)
    : { min: normalized.minY, max: normalized.maxY };

  return {
    minX: centeredX.min,
    minY: centeredY.min,
    maxX: centeredX.max,
    maxY: centeredY.max,
  };
}

function expandAxisBoundsToCenter(min, max, size) {
  const center = (size - 1) / 2;
  const radius = Math.max(center - min, max - center);
  return {
    min: Math.max(0, Math.floor(center - radius)),
    max: Math.min(size - 1, Math.ceil(center + radius)),
  };
}

/**
 * 自动裁剪并返回裁剪边界元数据。
 *
 * @param {Object} keyedData - 抠像后的数据 {data, width, height}
 * @param {number} threshold - alpha 阈值，默认 10
 * @returns {{imageData:Object,crop:Object}}
 */
export function autoCropKeyedWithBounds(keyedData, threshold = 10) {
  const bounds = findAlphaBounds(keyedData, threshold);
  return cropKeyedToBoundsWithMetadata(keyedData, bounds, threshold);
}

export function cropKeyedToBoundsWithMetadata(keyedData, bounds, threshold = 10) {
  const { data, width, height } = keyedData;

  // 全透明或极小区域，不裁剪
  if (!bounds) {
    return {
      imageData: keyedData,
      crop: {
        applied: false,
        x: 0,
        y: 0,
        width,
        height,
        sourceWidth: width,
        sourceHeight: height,
        alphaThreshold: threshold,
        reason: 'no_foreground',
      },
    };
  }

  const minX = Math.max(0, Math.min(width - 1, Math.floor(bounds.minX)));
  const minY = Math.max(0, Math.min(height - 1, Math.floor(bounds.minY)));
  const maxX = Math.max(0, Math.min(width - 1, Math.ceil(bounds.maxX)));
  const maxY = Math.max(0, Math.min(height - 1, Math.ceil(bounds.maxY)));
  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;
  const cropped = new Uint8ClampedArray(cropW * cropH * 4);

  for (let y = 0; y < cropH; y++) {
    for (let x = 0; x < cropW; x++) {
      const srcIdx = ((y + minY) * width + (x + minX)) * 4;
      const dstIdx = (y * cropW + x) * 4;
      cropped[dstIdx] = data[srcIdx];
      cropped[dstIdx + 1] = data[srcIdx + 1];
      cropped[dstIdx + 2] = data[srcIdx + 2];
      cropped[dstIdx + 3] = data[srcIdx + 3];
    }
  }

  return {
    imageData: { data: cropped, width: cropW, height: cropH },
    crop: {
      applied: cropW !== width || cropH !== height,
      x: minX,
      y: minY,
      width: cropW,
      height: cropH,
      sourceWidth: width,
      sourceHeight: height,
      alphaThreshold: threshold,
    },
  };
}

/**
 * 找到 alpha 大于阈值的包围盒。
 */
export function findAlphaBounds(keyedData, threshold = 10) {
  const { data, width, height } = keyedData;
  let minX = width, minY = height, maxX = 0, maxY = 0;
  let found = false;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha > threshold) {
        found = true;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  return found ? { minX, minY, maxX, maxY } : null;
}

/**
 * 计算抠像后残留前景像素的 Y 轴高度。
 */
export function measureAlphaHeight(keyedData, threshold = 10) {
  const bounds = findAlphaBounds(keyedData, threshold);
  return bounds ? bounds.maxY - bounds.minY + 1 : 0;
}

/**
 * 清理抠像后残留的标记点和孤立前景组件。
 *
 * 默认不启用任何破坏性清理；调用方需要显式开启对应选项。
 */
export function cleanupKeyed(keyedData, params = {}) {
  const cleanup = normalizeCleanupParams(params);
  const out = new Uint8ClampedArray(keyedData.data);
  const imageData = { data: out, width: keyedData.width, height: keyedData.height };
  const stats = {
    enabled: cleanup.removePaleGreenMarkers || cleanup.removeSmallComponents || cleanup.keepLargestComponent,
    alphaThreshold: cleanup.alphaThreshold,
    foregroundPixelsBefore: countForeground(out, cleanup.alphaThreshold),
    paleGreenPixelsRemoved: 0,
    foregroundPixelsAfterPaleGreen: 0,
    componentsFound: 0,
    largestComponentPixels: 0,
    componentsRemoved: 0,
    componentPixelsRemoved: 0,
    componentsKept: 0,
    foregroundPixelsAfter: 0,
  };

  if (cleanup.removePaleGreenMarkers) {
    stats.paleGreenPixelsRemoved = removePaleGreenMarkerPixels(out, keyedData.width, keyedData.height, cleanup);
  }
  stats.foregroundPixelsAfterPaleGreen = countForeground(out, cleanup.alphaThreshold);

  if (cleanup.removeSmallComponents || cleanup.keepLargestComponent) {
    const componentStats = cleanupComponents(out, keyedData.width, keyedData.height, cleanup);
    stats.componentsFound = componentStats.componentsFound;
    stats.largestComponentPixels = componentStats.largestComponentPixels;
    stats.componentsRemoved = componentStats.componentsRemoved;
    stats.componentPixelsRemoved = componentStats.componentPixelsRemoved;
    stats.componentsKept = componentStats.componentsKept;
  }

  stats.foregroundPixelsAfter = countForeground(out, cleanup.alphaThreshold);
  return { imageData, stats };
}

function normalizeCleanupParams(params = {}) {
  const alphaThreshold = positiveInt(params.alphaThreshold, 10);
  return {
    removePaleGreenMarkers: params.removePaleGreenMarkers === true || params.removePaleGreen === true,
    removeSmallComponents: params.removeSmallComponents === true,
    keepLargestComponent: params.keepLargestComponent === true,
    minComponentPixels: positiveInt(params.minComponentPixels, 64),
    alphaThreshold,
    paleGreenMinGreen: positiveInt(params.paleGreenMinGreen, 140),
    paleGreenMinRedBlue: positiveInt(params.paleGreenMinRedBlue, 70),
    paleGreenDominance: positiveInt(params.paleGreenDominance, 20),
    paleGreenMaxRedBlueDelta: positiveInt(params.paleGreenMaxRedBlueDelta, 90),
  };
}

function removePaleGreenMarkerPixels(data, width, height, cleanup) {
  let removed = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if (data[idx + 3] <= cleanup.alphaThreshold) continue;

      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      if (isPaleGreenMarker(r, g, b, cleanup)) {
        data[idx + 3] = 0;
        removed++;
      }
    }
  }
  return removed;
}

function isPaleGreenMarker(r, g, b, cleanup) {
  return (
    g >= cleanup.paleGreenMinGreen &&
    r >= cleanup.paleGreenMinRedBlue &&
    b >= cleanup.paleGreenMinRedBlue &&
    g - r >= cleanup.paleGreenDominance &&
    g - b >= cleanup.paleGreenDominance &&
    Math.abs(r - b) <= cleanup.paleGreenMaxRedBlueDelta
  );
}

function cleanupComponents(data, width, height, cleanup) {
  const visited = new Uint8Array(width * height);
  const components = [];

  for (let pixel = 0; pixel < width * height; pixel++) {
    if (visited[pixel] || data[pixel * 4 + 3] <= cleanup.alphaThreshold) continue;

    const pixels = [];
    const queue = [pixel];
    visited[pixel] = 1;

    for (let qi = 0; qi < queue.length; qi++) {
      const current = queue[qi];
      pixels.push(current);
      const x = current % width;
      const y = Math.floor(current / width);
      const neighbors = [
        x > 0 ? current - 1 : -1,
        x < width - 1 ? current + 1 : -1,
        y > 0 ? current - width : -1,
        y < height - 1 ? current + width : -1,
      ];

      for (const next of neighbors) {
        if (next < 0 || visited[next] || data[next * 4 + 3] <= cleanup.alphaThreshold) continue;
        visited[next] = 1;
        queue.push(next);
      }
    }

    components.push({ pixels, size: pixels.length });
  }

  let largestIndex = -1;
  let largestComponentPixels = 0;
  components.forEach((component, index) => {
    if (component.size > largestComponentPixels) {
      largestComponentPixels = component.size;
      largestIndex = index;
    }
  });

  let componentsRemoved = 0;
  let componentPixelsRemoved = 0;
  let componentsKept = 0;

  components.forEach((component, index) => {
    const isLargest = index === largestIndex;
    const shouldRemove = cleanup.keepLargestComponent
      ? !isLargest
      : cleanup.removeSmallComponents && component.size < cleanup.minComponentPixels;

    if (!shouldRemove) {
      componentsKept++;
      return;
    }

    for (const pixel of component.pixels) {
      data[pixel * 4 + 3] = 0;
    }
    componentsRemoved++;
    componentPixelsRemoved += component.size;
  });

  return {
    componentsFound: components.length,
    largestComponentPixels,
    componentsRemoved,
    componentPixelsRemoved,
    componentsKept,
  };
}

function countForeground(data, threshold) {
  let count = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > threshold) count++;
  }
  return count;
}

/**
 * 将抠像后的人物合成到绿幕画布上（居中 + 等比缩放）
 *
 * @param {Object} ctx - canvas 2d context（已创建好目标尺寸）
 * @param {ImageData} keyedImageData - 抠像后的人物 ImageData
 * @param {Object} layout - 布局参数
 *   canvasWidth, canvasHeight: 目标画布尺寸
 *   personWidth, personHeight: 人物目标框尺寸
 *   bgColor: [r, g, b] 兜底绿幕底色
 * @param {Object} sourceCanvas - 临时 canvas，用于持有 keyedImageData
 * @param {number[]} backgroundColor - 合成底色，通常使用键控色 keyColor
 */
export function composeToCanvas(ctx, keyedImageData, layout, tempCanvas, backgroundColor) {
  const { canvasWidth, canvasHeight, bgColor } = layout;
  const fillColor = backgroundColor || bgColor || [0, 255, 0];

  // 1. 填充绿幕底色
  ctx.fillStyle = `rgb(${fillColor[0]}, ${fillColor[1]}, ${fillColor[2]})`;
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  return drawKeyedToCanvas(ctx, keyedImageData, layout, tempCanvas);
}

/**
 * 将抠像后的人物绘制到画布上，并按 layout.anchor 放置。
 */
export function drawKeyedToCanvas(ctx, keyedImageData, layout, tempCanvas) {
  // 1. 将 keyedImageData 放到临时 canvas 上
  // 适配两种输入：纯对象 {data,width,height} 或 ImageData 实例
  const srcW = keyedImageData.width;
  const srcH = keyedImageData.height;
  tempCanvas.width = srcW;
  tempCanvas.height = srcH;
  const tempCtx = tempCanvas.getContext('2d');

  // 统一转换为 ImageData 后 putImageData
  const imgData = tempCtx.createImageData(srcW, srcH);
  imgData.data.set(keyedImageData.data);
  tempCtx.putImageData(imgData, 0, 0);

  const placement = computePlacement(srcW, srcH, layout);

  ctx.drawImage(tempCanvas, placement.offsetX, placement.offsetY, placement.scaledW, placement.scaledH);

  return placement;
}

/**
 * 计算人物在输出画布中的位置。
 *
 * anchor:
 *   - center: 保持旧行为，人物居中于整张输出画布
 *   - bottom_center: 人物底部贴齐输出画布底部，水平居中
 *   - feet: 人物脚底贴齐居中安全区底部，适合游戏角色统一基准线
 *
 * scale:
 *   - 默认 fit_box：scale = min(personW/srcW, personH/srcH)，随裁切框尺寸变化
 *   - sourceCharacterHeight > 0：scale = personHeight / sourceCharacterHeight
 *     用户填写源画面中「人物站立身高」像素，跨段视频共用同一尺度；
 *     裁切框 padding / Y 轴漂浮只改变位置与出框，不改变人物身高
 */
export function computePlacement(srcW, srcH, layout) {
  const {
    canvasWidth,
    canvasHeight,
    personWidth = canvasWidth,
    personHeight = canvasHeight,
    anchor = 'center',
    anchorOffset = {},
    sourceCharacterHeight = 0,
  } = layout;
  const { scale, scaleMode, sourceCharacterHeight: lockedHeight } = resolveLayoutScale(
    srcW,
    srcH,
    personWidth,
    personHeight,
    sourceCharacterHeight,
  );
  const scaledW = Math.round(srcW * scale);
  const scaledH = Math.round(srcH * scale);
  const safeArea = {
    x: Math.round((canvasWidth - personWidth) / 2),
    y: Math.round((canvasHeight - personHeight) / 2),
    width: personWidth,
    height: personHeight,
  };

  let offsetX;
  let offsetY;
  if (anchor === 'bottom_center') {
    offsetX = Math.round((canvasWidth - scaledW) / 2);
    offsetY = canvasHeight - scaledH;
  } else if (anchor === 'feet') {
    offsetX = safeArea.x + Math.round((personWidth - scaledW) / 2);
    offsetY = safeArea.y + personHeight - scaledH;
  } else {
    offsetX = Math.round((canvasWidth - scaledW) / 2);
    offsetY = Math.round((canvasHeight - scaledH) / 2);
  }

  const offset = {
    x: Number.isFinite(Number(anchorOffset.x)) ? Math.round(Number(anchorOffset.x)) : 0,
    y: Number.isFinite(Number(anchorOffset.y)) ? Math.round(Number(anchorOffset.y)) : 0,
  };
  offsetX += offset.x;
  offsetY += offset.y;

  return {
    scaledW,
    scaledH,
    offsetX,
    offsetY,
    scale,
    scaleMode,
    sourceCharacterHeight: lockedHeight,
    anchor: ['center', 'bottom_center', 'feet'].includes(anchor) ? anchor : 'center',
    anchorOffset: offset,
    safeArea,
  };
}

/**
 * 解析布局缩放倍率。
 * sourceCharacterHeight > 0 时按源人物身高锁定；否则 fit 进 person 框。
 */
export function resolveLayoutScale(srcW, srcH, personWidth, personHeight, sourceCharacterHeight = 0) {
  const lockedHeight = Number(sourceCharacterHeight);
  if (Number.isFinite(lockedHeight) && lockedHeight > 0 && personHeight > 0) {
    return {
      scale: personHeight / lockedHeight,
      scaleMode: 'source_character_height',
      sourceCharacterHeight: lockedHeight,
    };
  }

  const safeSrcW = Math.max(1, Number(srcW) || 1);
  const safeSrcH = Math.max(1, Number(srcH) || 1);
  return {
    scale: Math.min(personWidth / safeSrcW, personHeight / safeSrcH),
    scaleMode: 'fit_box',
    sourceCharacterHeight: 0,
  };
}

function positiveInt(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.max(1, Math.round(number));
}
