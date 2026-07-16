/**
 * 绿幕抠像算法 — 前后端共享
 *
 * 接收 ImageData，返回抠像后的 ImageData（RGBA，绿幕区域 alpha=0）
 * 同一份代码前端 Canvas 预览和后端 node-canvas 导出共用，保证所见即所得。
 *
 * 参数说明：
 *   keyColor:        [r, g, b]  键控色，默认 [0, 255, 0] 纯绿
 *   tolerance:       0-100      色容差，越大扣得越多
 *   spillSuppression:0-100      去绿溢强度，去除边缘绿色污染
 *   feather:         0-100      边缘羽化，alpha 过渡柔和度
 *   edgeShrink:      0-50       边缘收缩，向内收掉杂边
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

/**
 * 核心抠像函数
 * @param {ImageData} imageData - 输入图像数据
 * @param {Object} params - 抠像参数
 * @returns {ImageData} - 抠像后的图像数据（新对象，不修改原图）
 */
export function applyKeying(imageData, params) {
  const {
    keyColor = [0, 255, 0],
    tolerance = 30,
    spillSuppression = 40,
    feather = 15,
    edgeShrink = 0,
  } = params;

  const { data, width, height } = imageData;
  // 创建输出数据（深拷贝）
  const out = new Uint8ClampedArray(data);

  const [kr, kg, kb] = keyColor;

  // 将参数映射到算法内部范围
  // tolerance 0-100 → 色彩距离阈值 0.0-0.5
  const tolDist = (tolerance / 100) * 0.5;
  // feather 0-100 → 过渡带宽度（在距离空间）
  const featherWidth = (feather / 100) * 0.15;
  // edgeShrink 0-50 → 像素收缩数（后面处理）
  const shrinkPixels = Math.round(edgeShrink);

  // ===== Pass 1: 逐像素计算 alpha =====
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    const dist = colorDistance(r, g, b, kr, kg, kb);

    let alpha;
    if (dist < tolDist) {
      // 完全是绿幕 → 完全透明
      alpha = 0;
    } else if (dist > tolDist + featherWidth) {
      // 远离绿幕 → 完全不透明
      alpha = 255;
    } else {
      // 过渡带 → 线性插值
      const t = (dist - tolDist) / featherWidth;
      alpha = Math.round(t * 255);
    }

    out[i + 3] = alpha;
  }

  // ===== Pass 2: 去绿溢 =====
  // 对所有非完全透明的像素，抑制绿色通道
  if (spillSuppression > 0) {
    const spillFactor = spillSuppression / 100; // 0-1
    for (let i = 0; i < out.length; i += 4) {
      const a = out[i + 3];
      if (a === 0) continue; // 跳过透明像素

      const r = out[i];
      const g = out[i + 1];
      const b = out[i + 2];

      // 如果 G 是最大通道且有溢出（g > max(r,b)），压低 G
      const maxRB = Math.max(r, b);
      if (g > maxRB) {
        // 将 G 向 max(r,b) 拉近，拉多少由 spillFactor 决定
        const excess = g - maxRB;
        out[i + 1] = Math.round(g - excess * spillFactor);
      }
    }
  }

  // ===== Pass 3: 边缘收缩（可选）=====
  // 向内侵蚀 alpha 通道，去掉边缘杂色
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
      if (hasTransparent && original[idx] < 255) {
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
 */
export function computePlacement(srcW, srcH, layout) {
  const {
    canvasWidth,
    canvasHeight,
    personWidth = canvasWidth,
    personHeight = canvasHeight,
    anchor = 'center',
    anchorOffset = {},
  } = layout;
  const scale = Math.min(personWidth / srcW, personHeight / srcH);
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
    anchor: ['center', 'bottom_center', 'feet'].includes(anchor) ? anchor : 'center',
    anchorOffset: offset,
    safeArea,
  };
}

function positiveInt(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.max(1, Math.round(number));
}
